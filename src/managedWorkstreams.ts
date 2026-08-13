/**
 * Flat managed Workstreams: the pure, store-level logic behind the three
 * coordinator tools (coordinator.ts wires these to MCP tool() calls and adds
 * the caller-side revision-checked audit event). Kept separate from
 * coordinator.ts so it is testable without an Agent SDK run — the same
 * pattern as conclusion.ts's `conclusionEvidenceLabels`.
 *
 * Flat, not a tree (kernel rule 1): `managedBy` is a single pointer set once
 * at creation; nothing here ever resolves a chain (a manager's manager).
 * Directions are durable input, never authority (kernel rule 9): they carry
 * no ability to touch the target's assignments, execution safety, constraints, or
 * approvals, and neither write path here touches humanInterventions.
 */

import type { ManagerDirection, WorkstreamCore, WorkstreamDoc } from './types.js';
import { arrive, createWorkstream, load, newId } from './store.js';
import { virtualNow } from './clock.js';
import {
  executionSafetyConfig,
  isLegacyDollarBudgetAttention,
  newExecutionSafety,
  type ExecutionSafetyConfig,
} from './executionSafety.js';

export class ManagedWorkstreamError extends Error {}

export interface CreateManagedWorkstreamArgs {
  slug: string;
  title: string;
  objective: string;
  successCriteria: string[];
  constraints: string[];
  tags: string[];
  executionWindowSeconds?: number;
  maxModelStarts?: number;
  sendsRequireApproval?: boolean;
  /** Stable identity of the external thing the new workstream stands for. */
  sourceKey?: string;
}

/**
 * Builds the new workstream's core fields from ONLY these explicit,
 * zod-validated args — never the calling workstream's decisions, events, or
 * projection — so leakage of the manager's own text into the new stream is
 * structurally impossible, not just a convention. Seeds the first wake
 * exactly like the `weaver create` CLI path (cli.ts, `case 'create'`).
 */
export async function createManagedWorkstream(callingSlug: string, args: CreateManagedWorkstreamArgs): Promise<WorkstreamDoc> {
  if (args.slug === callingSlug) {
    throw new ManagedWorkstreamError('a workstream cannot manage itself');
  }
  // Structural backstop for at-least-once intake: a coordinator that looks at
  // the same tracker on every pass must not be able to open the same work
  // twice, whatever it believes it has already done. Uniqueness on sourceKey
  // is enforced ATOMICALLY at the store write (createWorkstream → the backend),
  // not by a scan-then-create here — two different slugs carrying the same key
  // cannot both land under a race. A conflict surfaces as SourceKeyConflictError
  // ('… already stands for …'), which the coordinator tool renders to the model.
  const core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'> = {
    slug: args.slug,
    title: args.title,
    objective: args.objective,
    tags: args.tags,
    successCriteria: args.successCriteria,
    constraints: args.constraints,
    ...(args.sourceKey ? { sourceKey: args.sourceKey } : {}),
    autonomy: { sendsRequireApproval: args.sendsRequireApproval ?? true },
    executionSafety: newExecutionSafety({
      ...(args.executionWindowSeconds !== undefined ? { windowSeconds: args.executionWindowSeconds } : {}),
      ...(args.maxModelStarts !== undefined ? { maxModelStarts: args.maxModelStarts } : {}),
    }),
    managedBy: { slug: callingSlug, sinceVirtual: virtualNow().toISOString() },
  };
  await createWorkstream(core);
  // The creation itself is the first wake — mirrors cli.ts `case 'create'`.
  await arrive(args.slug, (d, event) => {
    d.wakes.push({
      id: newId('wake'),
      reason: 'workstream created — establish direction and dispatch initial work',
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event('wake.scheduled', 'initial reconciliation wake');
  });
  return load(args.slug);
}

export interface ManagedWorkstreamSummary {
  slug: string;
  title: string;
  objective: string;
  status: WorkstreamCore['status'];
  successCriteria: string[];
  constraints: string[];
  tags: string[];
  executionSafety: ExecutionSafetyConfig;
  activity: { coordinatorPasses: number; sdkCostEstimateUsd: number };
  openAttention: { id: string; kind: string; summary: string }[];
  conclusion?: { summary: string; evidenceIds: string[]; atVirtual: string };
  recentEvents: { type: string; summary: string; atVirtual: string }[];
  /** Directions THIS manager sent to the target — never another manager's. */
  directionsSent: { id: string; body: string; atVirtual: string }[];
  /** The target's OWN notices (from workstreams it in turn manages, if any) —
   * its own single-level facts, never resolved further down the chain. */
  recentNotices: { id: string; kind: string; summary: string; fromWorkstreamSlug: string; receivedAtVirtual: string }[];
}

/**
 * Refuses unless the caller is the target's recorded manager. Returns a
 * bounded TYPED summary — never the raw decisions array and never a rendered
 * projection, so a manager cannot read its managed stream's full reasoning
 * transcript, only the facts this contract declares visible.
 */
export async function inspectManagedWorkstream(callingSlug: string, targetSlug: string): Promise<ManagedWorkstreamSummary> {
  const doc = await load(targetSlug);
  if (doc.workstream.managedBy?.slug !== callingSlug) {
    throw new ManagedWorkstreamError(`${callingSlug} does not manage '${targetSlug}'`);
  }
  const ws = doc.workstream;
  return {
    slug: ws.slug,
    title: ws.title,
    objective: ws.objective,
    status: ws.status,
    successCriteria: ws.successCriteria,
    constraints: ws.constraints,
    tags: ws.tags,
    executionSafety: executionSafetyConfig(ws),
    activity: { coordinatorPasses: doc.spend.coordinatorPasses, sdkCostEstimateUsd: doc.spend.totalCostUsd },
    openAttention: doc.attention
      .filter((a) => a.status === 'open' && !isLegacyDollarBudgetAttention(a))
      .map((a) => ({ id: a.id, kind: a.kind, summary: a.summary })),
    ...(ws.conclusion
      ? { conclusion: { summary: ws.conclusion.summary, evidenceIds: [...ws.conclusion.evidenceIds], atVirtual: ws.conclusion.atVirtual } }
      : {}),
    recentEvents: doc.events.slice(-10).map((e) => ({ type: e.type, summary: e.summary, atVirtual: e.atVirtual })),
    directionsSent: (doc.managerDirections ?? [])
      .filter((d) => d.fromWorkstreamSlug === callingSlug)
      .map((d) => ({ id: d.id, body: d.body, atVirtual: d.atVirtual })),
    recentNotices: (doc.managerNotices ?? []).slice(-10).map((n) => ({
      id: n.id,
      kind: n.kind,
      summary: n.summary,
      fromWorkstreamSlug: n.fromWorkstreamSlug,
      receivedAtVirtual: n.receivedAtVirtual,
    })),
  };
}

/**
 * Refuses unless the caller is the target's recorded manager. Writes ONLY
 * `message` as a ManagerDirection on the target — advisory text, exactly like
 * human Steering is advisory text: it cannot create assignments, adopt or
 * reject anything, or change the target's execution safety/constraints/approvals. The
 * target's own pass, under its own constraints, decides whether
 * and how to act on it. Target-first write (additive, no CAS needed); the
 * caller-side audit event is a separate revision-checked write the caller
 * (coordinator.ts) performs after this returns.
 */
export async function directManagedWorkstream(callingSlug: string, targetSlug: string, message: string): Promise<ManagerDirection> {
  const doc = await load(targetSlug);
  if (doc.workstream.managedBy?.slug !== callingSlug) {
    throw new ManagedWorkstreamError(`${callingSlug} does not manage '${targetSlug}'`);
  }
  const direction: ManagerDirection = {
    id: newId('dir'),
    fromWorkstreamSlug: callingSlug,
    body: message,
    atVirtual: virtualNow().toISOString(),
  };
  await arrive(targetSlug, (d, event) => {
    d.managerDirections = d.managerDirections ?? [];
    d.managerDirections.push(direction);
    d.wakes.push({
      id: newId('wake'),
      reason: `direction arrived from managing workstream ${callingSlug}`,
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event('manager.direction_received', `direction from ${callingSlug}: ${message.slice(0, 160)}`, [direction.id]);
  });
  return direction;
}
