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
import { diffPrintoutFields, writeJournalReceipt } from './printoutJournal.js';
import type { Id, Iso } from './types.js';
import type { PrintoutFieldDelta } from './types.js';

export type PolicyEffectKind = 'add_verification' | 'narrow_authority' | 'advisory';

export interface PolicyEvidence {
  workstreamSlug: string;
  passId: Id;
  note: string;
  /** True when the matching workstream succeeded on this point without a further human intervention. */
  interventionFree: boolean;
  at: Iso;
}

/**
 * Where a policy came from. Live learning cites the workstream, pass, and
 * steering that corrected the coordinator; `weaver backfill` cites the
 * pre-Weaver source (a rules file + heading, or a transcript session + quote).
 * Both variants land in 'shadow' and earn 'active' through the same evidence
 * loop — backfill seeds candidates, never trust.
 */
export type PolicyProvenance =
  | {
      workstreamSlug: string;
      passId: Id;
      steeringId?: Id;
      interventionSummary: string;
    }
  | {
      source: 'backfill:rules' | 'backfill:sessions' | 'seed';
      /** "path § heading" for rules files; "session <id>" for transcripts;
       * "<author>" for an imported team seed. */
      ref: string;
      interventionSummary: string;
    };

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
  provenance: PolicyProvenance;
  evidence: PolicyEvidence[];
  supersededBy?: Id;
  createdAt: Iso;
}

export interface PolicyStore {
  schemaVersion: 1;
  revision: number;
  policies: PolicyRecord[];
}

export interface PolicyMutationReceipt {
  revision: number;
  at: Iso;
  changes: { id: Id; fields: PrintoutFieldDelta[] }[];
}

function storePath(): string {
  return path.join(weaverHome(), 'policies.json');
}

export function policyPrintoutJournalDir(): string {
  return path.join(weaverHome(), '.printout', 'policies');
}

export function loadPolicies(): PolicyStore {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as PolicyStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read global policy store: ${error instanceof Error ? error.message : error}`);
    }
    return { schemaVersion: 1, revision: 0, policies: [] };
  }
}

function writePolicies(store: PolicyStore, receipt: PolicyMutationReceipt): void {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  writeJournalReceipt(policyPrintoutJournalDir(), receipt);
  const tmp = `${storePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  fs.renameSync(tmp, storePath());
}

/**
 * The policy store is GLOBAL (shared across workstreams), so with concurrent
 * ticks two processes can race the read-modify-write. A short mkdir spin-lock
 * serializes them; a holder that died is reclaimed after 10s.
 */
function withPolicyLock<T>(fn: () => T): T {
  const dir = `${storePath()}.lock`;
  // A missing home dir would make every mkdir below ENOENT — indistinguishable
  // from contention, so the spin would run out the clock on a fresh install.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch {
      try {
        if (fs.statSync(dir).mtimeMs < Date.now() - 10_000) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch { /* raced with the holder's release — retry */ }
      if (Date.now() > deadline) throw new Error('policy store lock timeout');
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin — writes are sub-ms */ }
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mutatePolicies(fn: (store: PolicyStore) => void): PolicyStore {
  return withPolicyLock(() => {
    const store = loadPolicies();
    const before = new Map(store.policies.map((policy) => [policy.id, structuredClone(policy)]));
    fn(store);
    store.revision += 1;
    const after = new Map(store.policies.map((policy) => [policy.id, policy]));
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .flatMap((id) => {
        const prior = before.get(id);
        const current = after.get(id);
        if (JSON.stringify(prior) === JSON.stringify(current)) return [];
        return [{ id, fields: diffPrintoutFields(prior, current) }];
      });
    writePolicies(store, { revision: store.revision, at: new Date().toISOString(), changes });
    return store;
  });
}

/** Add a scope tag to a set of policies (idempotent). Used to reclassify —
 * e.g. marking session-backfilled rules that are really 'tool-dev' feedback
 * about Weaver itself, which seed export then excludes. */
export function tagPolicies(ids: Id[], tag: string): number {
  let n = 0;
  mutatePolicies((store) => {
    for (const p of store.policies) {
      if (ids.includes(p.id) && !p.scope.tags.includes(tag)) {
        p.scope.tags.push(tag);
        n++;
      }
    }
  });
  return n;
}

/** One-line origin label for listings/projections, whichever provenance variant. */
export function policyOrigin(p: PolicyRecord): string {
  return 'workstreamSlug' in p.provenance ? p.provenance.workstreamSlug : p.provenance.ref;
}

// ---------------------------------------------------------------------------
// Team seeds: share learned practice, never trust or private context.

export interface SeedFile {
  weaverSeed: 1;
  author: string;
  exportedAt: Iso;
  policies: { statement: string; tags: string[]; effect: { kind: PolicyEffectKind; description: string }; origin: string }[];
}

/**
 * Export shareable practice. SANITIZED BY CONSTRUCTION: no ids, no evidence,
 * no intervention summaries (session-derived ones can quote private
 * transcripts), no absolute paths — just the statement, scope, effect, and a
 * short origin label. Superseded policies stay home: a rule the author
 * outgrew must not be seeded into a teammate.
 */
export function exportSeed(author: string): SeedFile {
  const sanitizeOrigin = (p: PolicyRecord): string => {
    const raw = policyOrigin(p);
    return raw.replace(/\/[^\s§]*\//g, (m) => m.split('/').filter(Boolean).pop() + '/').slice(0, 80);
  };
  return {
    weaverSeed: 1,
    author,
    exportedAt: new Date().toISOString(),
    policies: loadPolicies()
      .policies.filter((p) => p.status !== 'superseded')
      // 'tool-dev' scoped rules are feedback about building Weaver itself
      // (TUI complaints, harness architecture notes) — lessons for whoever
      // maintains Weaver, not "how this operator works". Exporting them made
      // v1 seeds read like a leaked bug tracker.
      .filter((p) => !p.scope.tags.includes('tool-dev'))
      .map((p) => ({
        statement: p.statement,
        tags: p.scope.tags,
        effect: p.effect,
        origin: sanitizeOrigin(p),
      })),
  };
}

/**
 * Import a teammate's seed. Every policy lands in SHADOW — the seed carries
 * the author's guardrails, never their trust; each rule earns active status
 * through the importer's own intervention-free evidence, and the importer's
 * corrections supersede seeded rules with visible lineage. Dedup by
 * normalized statement makes re-import a no-op.
 */
export function importSeed(seed: SeedFile, opts: { refuseAuthority: (text: string) => boolean }): {
  imported: number;
  skippedDuplicate: number;
  refused: string[];
} {
  const existing = new Set(loadPolicies().policies.map((p) => normalizeStatement(p.statement)));
  let imported = 0;
  let skippedDuplicate = 0;
  const refused: string[] = [];
  for (const p of seed.policies) {
    if (opts.refuseAuthority(p.statement)) {
      refused.push(p.statement.slice(0, 80));
      continue;
    }
    if (existing.has(normalizeStatement(p.statement))) {
      skippedDuplicate++;
      continue;
    }
    existing.add(normalizeStatement(p.statement));
    proposeBackfillPolicy({
      statement: p.statement,
      tags: p.tags,
      effectKind: p.effect.kind,
      effectDescription: p.effect.description,
      source: 'seed',
      ref: seed.author,
      interventionSummary: `seeded from ${seed.author}'s practice (${p.origin})`,
    });
    imported++;
  }
  return { imported, skippedDuplicate, refused };
}

/**
 * Dedup key for policy statements: markdown emphasis, case, whitespace, and
 * trailing punctuation don't make two rules different. Backfill keys on this
 * so re-running never duplicates a policy.
 */
export function normalizeStatement(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.!;:,]+$/, '')
    .trim();
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
 * Propose a policy seeded from pre-Weaver practice (`weaver backfill`).
 * Identical lifecycle to proposePolicy — shadow status, closed effect
 * vocabulary, widensAuthority: false — only the provenance variant differs.
 */
export function proposeBackfillPolicy(args: {
  statement: string;
  tags: string[];
  effectKind: PolicyEffectKind;
  effectDescription: string;
  source: 'backfill:rules' | 'backfill:sessions' | 'seed';
  ref: string;
  interventionSummary: string;
}): PolicyRecord {
  const record: PolicyRecord = {
    id: newId('pol'),
    statement: args.statement,
    scope: { tags: args.tags },
    effect: { kind: args.effectKind, description: args.effectDescription },
    widensAuthority: false,
    status: 'shadow',
    provenance: { source: args.source, ref: args.ref, interventionSummary: args.interventionSummary },
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
  // A large backfilled store must not drown the projection: active (earned)
  // policies always render; shadow candidates are capped, newest first, with
  // the omission stated — the full store stays inspectable via the CLI.
  const SHADOW_CAP = 25;
  const active = policies.filter((p) => p.status === 'active');
  const shadow = policies.filter((p) => p.status !== 'active');
  const shownShadow = shadow.slice(-SHADOW_CAP);
  const omitted = shadow.length - shownShadow.length;
  policies = [...active, ...shownShadow];
  const lines = policies.map((p) => {
    const ev = p.evidence.length
      ? ` evidence=${p.evidence.length} (${p.evidence.filter((e) => e.interventionFree).length} intervention-free)`
      : ' unproven';
    return `- ${p.id} [${p.status}/${p.effect.kind}] "${p.statement}" — ${p.effect.description} (learned from ${policyOrigin(p)};${ev})`;
  });
  return [
    ``,
    `Learned policies matching this workstream's tags:`,
    ...lines,
    ...(omitted > 0 ? [`(+${omitted} more shadow candidates not shown — the store is larger than this projection window)`] : []),
    `A policy can only add verification, narrow authority, or advise — never widen what you may do. When you apply one, cite its id in applied_policy_ids on the decision that applies it, so its effect stays attributable. If one proves wrong for this workstream, say so in a decision rather than silently ignoring it; if it helped, record_policy_outcome with what happened.`,
  ].join('\n');
}
