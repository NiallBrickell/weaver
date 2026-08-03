/**
 * The learning layer: scoped policies derived from operator interventions.
 * (Design ported from the relay experiment's learning contract.)
 *
 * The unit of learning is a typed episode — the course the coordinator
 * proposed, the human intervention that corrected it, the adopted course,
 * the actions that followed, and the evaluated outcome. An episode may yield
 * a POLICY CANDIDATE: a scoped, plain-language rule with provenance.
 *
 * Hard rules, enforced structurally:
 *  - A policy's effect may only ADD VERIFICATION, NARROW AUTHORITY, or ADVISE.
 *    Effects that would spend, send, merge, contact, or otherwise widen
 *    authority are unrepresentable — authority is never learned.
 *  - A policy starts in 'shadow': it may shape a matching workstream's plan,
 *    but every application must be cited (applied_policy_ids on a decision)
 *    so its effect is attributable and inspectable.
 *  - Promotion to 'active' requires recorded evidence: a matching workstream
 *    that applied the policy and succeeded without further intervention on
 *    the same point. "Stored a memory" is not learning; a changed-for-an-
 *    inspectable-reason next plan is.
 *
 * This store is the substrate the RL framing needs later: episodes are
 * trajectories, policies are the action space, interventions-per-successful-
 * outcome is the reward. Optimizing proposal/application comes after the
 * bookkeeping is trustworthy — never before.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { newId, weaverHome } from './store.js';
import type { Id, Iso } from './types.js';

export type PolicyEffectKind = 'add_verification' | 'narrow_authority' | 'advisory';

export interface PolicyEvidence {
  workstreamSlug: string;
  passId: Id;
  note: string;
  /** True when the matching workstream succeeded on this point without a further human intervention. */
  interventionFree: boolean;
  at: Iso;
}

export interface PolicyRecord {
  id: Id;
  /** Plain-language statement of the rule. */
  statement: string;
  /** Matches workstreams sharing at least one tag. */
  scope: { tags: string[] };
  effect: { kind: PolicyEffectKind; description: string };
  /** Structural invariant — never true; kept explicit so readers see the contract. */
  widensAuthority: false;
  status: 'shadow' | 'active' | 'superseded';
  provenance: {
    workstreamSlug: string;
    passId: Id;
    steeringId?: Id;
    interventionSummary: string;
  };
  evidence: PolicyEvidence[];
  supersededBy?: Id;
  createdAt: Iso;
}

interface PolicyStore {
  schemaVersion: 1;
  revision: number;
  policies: PolicyRecord[];
}

function storePath(): string {
  return path.join(weaverHome(), 'policies.json');
}

export function loadPolicies(): PolicyStore {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as PolicyStore;
  } catch {
    return { schemaVersion: 1, revision: 0, policies: [] };
  }
}

function writePolicies(store: PolicyStore): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  const tmp = `${storePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, storePath());
}

function mutatePolicies(fn: (store: PolicyStore) => void): PolicyStore {
  const store = loadPolicies();
  fn(store);
  store.revision += 1;
  writePolicies(store);
  return store;
}

/** Policies whose scope shares at least one tag with the workstream (shadow + active). */
export function matchPolicies(tags: string[]): PolicyRecord[] {
  return loadPolicies().policies.filter(
    (p) =>
      p.status !== 'superseded' &&
      p.scope.tags.some((t) => tags.includes(t)),
  );
}

export function proposePolicy(args: {
  statement: string;
  tags: string[];
  effectKind: PolicyEffectKind;
  effectDescription: string;
  workstreamSlug: string;
  passId: Id;
  steeringId?: Id;
  interventionSummary: string;
}): PolicyRecord {
  const record: PolicyRecord = {
    id: newId('pol'),
    statement: args.statement,
    scope: { tags: args.tags },
    effect: { kind: args.effectKind, description: args.effectDescription },
    widensAuthority: false,
    status: 'shadow',
    provenance: {
      workstreamSlug: args.workstreamSlug,
      passId: args.passId,
      ...(args.steeringId ? { steeringId: args.steeringId } : {}),
      interventionSummary: args.interventionSummary,
    },
    evidence: [],
    createdAt: new Date().toISOString(),
  };
  mutatePolicies((s) => s.policies.push(record));
  return record;
}

/**
 * Record outcome evidence for a policy. Promotion is earned, not asserted:
 * shadow → active only when evidence shows a matching workstream applied the
 * policy and needed no further intervention on the same point.
 */
export function recordPolicyOutcome(args: {
  policyId: Id;
  workstreamSlug: string;
  passId: Id;
  note: string;
  interventionFree: boolean;
}): PolicyRecord {
  let updated: PolicyRecord | undefined;
  mutatePolicies((s) => {
    const p = s.policies.find((x) => x.id === args.policyId);
    if (!p) throw new Error(`no policy ${args.policyId}`);
    if (p.status === 'superseded') throw new Error(`${p.id} is superseded by ${p.supersededBy}`);
    p.evidence.push({
      workstreamSlug: args.workstreamSlug,
      passId: args.passId,
      note: args.note,
      interventionFree: args.interventionFree,
      at: new Date().toISOString(),
    });
    if (p.status === 'shadow' && args.interventionFree) {
      p.status = 'active';
    }
    updated = p;
  });
  return updated!;
}

/** Replace a policy that turned out wrong; lineage kept, like decisions. */
export function supersedePolicy(oldId: Id, replacement: Omit<Parameters<typeof proposePolicy>[0], never>): PolicyRecord {
  const next = proposePolicy(replacement);
  mutatePolicies((s) => {
    const old = s.policies.find((x) => x.id === oldId);
    if (!old) throw new Error(`no policy ${oldId}`);
    old.status = 'superseded';
    old.supersededBy = next.id;
  });
  return next;
}

export function renderPoliciesForProjection(policies: PolicyRecord[]): string {
  if (!policies.length) return '';
  const lines = policies.map((p) => {
    const ev = p.evidence.length
      ? ` evidence=${p.evidence.length} (${p.evidence.filter((e) => e.interventionFree).length} intervention-free)`
      : ' unproven';
    return `- ${p.id} [${p.status}/${p.effect.kind}] "${p.statement}" — ${p.effect.description} (learned from ${p.provenance.workstreamSlug};${ev})`;
  });
  return [
    ``,
    `Learned policies matching this workstream's tags:`,
    ...lines,
    `A policy can only add verification, narrow authority, or advise — never widen what you may do. When you apply one, cite its id in applied_policy_ids on the decision that applies it, so its effect stays attributable. If one proves wrong for this workstream, say so in a decision rather than silently ignoring it; if it helped, record_policy_outcome with what happened.`,
  ].join('\n');
}
