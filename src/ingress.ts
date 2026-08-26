/**
 * External ingress — the two things a bot needs to keep its work in Weaver,
 * shared by the CLI and the HTTP adapter ([src/serve.ts](./serve.ts)).
 *
 * A "bot" (DevBot opening a PR, a UX bot watching the app over months) is an
 * external, disposable process; the durable memory of its work is a Workstream.
 * So a bot does two things against the shared fleet:
 *   1. register/find THE workstream that IS its piece of work — idempotent on a
 *      stable source key, because intake is at-least-once (the bot may retry);
 *   2. report what it observed.
 *
 * A report is an OBSERVATION, deliberately not steering. An observation is
 * untrusted input: it wakes the workstream and supplies evidence a coordinator
 * pass evaluates, but it cannot grant authority, complete work, or supersede
 * direction (kernel rules 7/9). Steering is the human's authority channel and
 * is NOT exposed to bots — a bot cannot be handed the human's hand.
 */

import { arrive, createWorkstream, findBySourceKey, listWorkstreams, load, newId, SourceKeyConflictError } from './store.js';
import { createWorkstreamUnderParent } from './managedWorkstreams.js';
import { sanitizeSlug } from './onboard.js';
import { virtualNow } from './clock.js';
import { newExecutionSafety } from './executionSafety.js';

export interface CreateWorkstreamRequest {
  /** Stable identity of the external thing this workstream exists for, e.g.
   * `devbot:pr:1957` or `ux:app`. The idempotency key for registration. */
  sourceKey: string;
  title: string;
  objective: string;
  /** Optional preferred slug; derived from title/sourceKey when omitted. */
  slug?: string;
  tags?: string[];
  successCriteria?: string[];
  constraints?: string[];
  executionWindowSeconds?: number;
  maxModelStarts?: number;
  /** Optional parent: create under an existing active Workstream through the
   * shared managed-creation path (single managedBy pointer, no inheritance,
   * source-key idempotency). A non-active or missing parent fails cleanly —
   * browser intake never runs a model, so this is intake validation, not a
   * judgment call. */
  under?: string;
}

export interface CreateOrGetResult {
  slug: string;
  id: string;
  /** false when this call resolved to a workstream that already held the key. */
  created: boolean;
}

/**
 * Idempotent on sourceKey: create the workstream, or return the existing one
 * that already holds this key. Uniqueness is enforced atomically at the store
 * (SourceKeyConflictError), so even two bots racing the same key land exactly
 * one workstream; the loser resolves to a GET. A bot's "make sure my workstream
 * exists" is therefore a safe no-op on every retry.
 */
export async function createOrGetWorkstream(req: CreateWorkstreamRequest): Promise<CreateOrGetResult> {
  const existingSlug = await findBySourceKey(req.sourceKey);
  if (existingSlug) {
    const doc = await load(existingSlug);
    return { slug: existingSlug, id: doc.workstream.id, created: false };
  }
  const taken = new Set(await listWorkstreams());
  const slug = sanitizeSlug(req.slug || req.title || req.sourceKey, taken);
  try {
    const doc = req.under
      // Browser composition reuses the SAME shared path as the coordinator's
      // create_workstream and the CLI's --under: one creation contract. The
      // parent precondition (exists + active) is enforced there; a clean
      // ManagedWorkstreamError surfaces to the requester.
      ? await createWorkstreamUnderParent(req.under, {
        slug,
        title: req.title,
        objective: req.objective,
        tags: req.tags ?? [],
        successCriteria: req.successCriteria ?? [],
        constraints: req.constraints ?? [],
        ...(req.sourceKey ? { sourceKey: req.sourceKey } : {}),
        ...(req.executionWindowSeconds !== undefined ? { executionWindowSeconds: req.executionWindowSeconds } : {}),
        ...(req.maxModelStarts !== undefined ? { maxModelStarts: req.maxModelStarts } : {}),
      })
      : await createWorkstream({
      slug,
      title: req.title,
      objective: req.objective,
      sourceKey: req.sourceKey,
      tags: req.tags ?? [],
      successCriteria: req.successCriteria ?? [],
      constraints: req.constraints ?? [],
      autonomy: { sendsRequireApproval: true },
      executionSafety: newExecutionSafety({
        ...(req.executionWindowSeconds !== undefined ? { windowSeconds: req.executionWindowSeconds } : {}),
        ...(req.maxModelStarts !== undefined ? { maxModelStarts: req.maxModelStarts } : {}),
      }),
    });
    // Creation is the first wake: direction needs establishing. The resident
    // runner (`weaver run`) picks it up — this adapter never runs a model.
    // (The managed path seeds this wake itself; the arrive() here is
    // idempotent-by-construction with it only in shape — skip the duplicate
    // when the shared managed path already seeded it.)
    if (!req.under) {
      await arrive(slug, (d, event) => {
        d.wakes.push({
          id: newId('wake'),
          reason: 'workstream created — establish direction and dispatch initial work',
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('wake.scheduled', 'initial reconciliation wake');
      });
    }
    return { slug, id: doc.workstream.id, created: true };
  } catch (e) {
    // Lost an at-least-once race to a concurrent creator: resolve to a GET.
    if (e instanceof SourceKeyConflictError) {
      const winner = await findBySourceKey(req.sourceKey);
      if (winner) {
        const doc = await load(winner);
        return { slug: winner, id: doc.workstream.id, created: false };
      }
    }
    throw e;
  }
}

export interface ObservationRequest {
  source: string;
  summary: string;
  /** Optional idempotency key for at-least-once delivery; a duplicate is a no-op. */
  ingressKey?: string;
}

export interface ObservationResult {
  id: string;
  duplicate: boolean;
}

/**
 * Record an observation and wake the workstream. Untrusted by construction: it
 * lands in typed state with provenance and a wake, and the next coordinator
 * pass evaluates it — it never mutates direction or completes work by itself.
 */
export async function recordObservation(slug: string, req: ObservationRequest): Promise<ObservationResult> {
  if (req.ingressKey) {
    const existing = (await load(slug)).observations.find((observation) => observation.ingressKey === req.ingressKey);
    if (existing) return { id: existing.id, duplicate: true };
  }
  let id = '';
  let duplicate = false;
  await arrive(slug, (d, event) => {
    const existing = req.ingressKey
      ? d.observations.find((observation) => observation.ingressKey === req.ingressKey)
      : undefined;
    if (existing) {
      id = existing.id;
      duplicate = true;
      return;
    }
    id = newId('obs');
    d.observations.push({
      id,
      ...(req.ingressKey ? { ingressKey: req.ingressKey } : {}),
      source: req.source,
      summary: req.summary,
      atVirtual: virtualNow().toISOString(),
    });
    d.wakes.push({
      id: newId('wake'),
      reason: `new observation from ${req.source}`,
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event('observation.arrived', `${id} [${req.source}] ${req.summary}`, [id]);
  });
  return { id, duplicate };
}
