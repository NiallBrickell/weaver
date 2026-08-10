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

import * as path from 'node:path';
import { virtualNow } from './clock.js';
import { getStore, load, mutatePolicies, newId, weaverHome } from './store.js';
import type { Id, Iso } from './types.js';
import type { PrintoutFieldDelta } from './types.js';

export type PolicyEffectKind = 'add_verification' | 'narrow_authority' | 'advisory';

export interface PolicyEvidence {
  workstreamSlug: string;
  passId: Id;
  note: string;
  /** True when the matching workstream succeeded on this point without a further human intervention. */
  interventionFree: boolean;
  /**
   * The decision (in `workstreamSlug`) that applied this policy, citing it in
   * `appliedPolicyIds`. Required for evidence recorded under the integrity
   * model: only an outcome that points at a genuine application can qualify a
   * promotion. LEGACY rows written before this field existed lack it — they
   * are preserved verbatim and load fine, but count as "unverifiable under the
   * new version" and never qualify a shadow → active promotion.
   */
  applyingDecisionId?: Id;
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
  /**
   * Set when negative evidence arrives — a matching workstream still needed a
   * human correction on this policy's point. A contested policy STOPS
   * rendering as ordinary active guidance in the projection (it moves under a
   * distinct "under review, do not treat as active guidance" heading) until a
   * human resolves it. Contest is a flag BESIDE status, never a status change:
   * negative evidence never auto-demotes or auto-supersedes. Resolution is
   * explicit — supersession (with lineage) or `reviewClearPolicy`. Positive
   * evidence never silently un-contests.
   */
  contested?: { at: Iso; workstreamSlug: string; note: string };
  /** Lineage, exactly like decisions: the policy this one replaced. */
  supersedes?: Id;
  supersededBy?: Id;
  createdAt: Iso;
}

export interface PolicyStore {
  schemaVersion: 1;
  revision: number;
  policies: PolicyRecord[];
}

/** The exact transition a policy write persisted, journaled receipt-first by
 * the backend (fs and pg alike) for operator printouts. */
export interface PolicyMutationReceipt {
  revision: number;
  at: Iso;
  changes: { id: Id; fields: PrintoutFieldDelta[] }[];
}

/** Where this machine's policy printout receipts live (fs sidecar). */
export function policyPrintoutJournalDir(): string {
  return path.join(weaverHome(), '.printout', 'policies');
}

/**
 * Reads go straight to the StateStore backend; every WRITE goes through the
 * shared layer's mutatePolicies (src/store.ts), which is concurrency-safe on
 * every backend — fs serializes same-machine processes with a lock, Postgres
 * runs a revision CAS with bounded retry so concurrent remote runners cannot
 * lose each other's writes. The mutator may therefore re-run against fresh
 * state after a conflict, like an arrive() mutator.
 */
export async function loadPolicies(): Promise<PolicyStore> {
  return getStore().loadPolicies();
}

/** Add a scope tag to a set of policies (idempotent). Used to reclassify —
 * e.g. marking session-backfilled rules that are really 'tool-dev' feedback
 * about Weaver itself, which seed export then excludes. */
export async function tagPolicies(ids: Id[], tag: string): Promise<number> {
  let n = 0;
  await mutatePolicies((store) => {
    n = 0; // the mutator may re-run against fresh state after a CAS conflict
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

/**
 * The workstream a live-learned policy came from (its proposing stream), or
 * undefined for backfill/seed policies, which have no source workstream.
 * Promotion requires intervention-free evidence from a DIFFERENT workstream
 * than this — a policy cannot certify itself on the same stream that proposed
 * it, and a backfilled policy (no source) is certified by any real workstream.
 */
export function policySourceWorkstream(p: PolicyRecord): string | undefined {
  return 'workstreamSlug' in p.provenance ? p.provenance.workstreamSlug : undefined;
}

// ---------------------------------------------------------------------------
// The authority firewall — a lexical gate applied wherever a policy STATEMENT
// enters the store (live proposal, backfill, seed import). It is ADDITIONAL to
// the structural `widensAuthority: false` shape-check: the closed effect
// vocabulary already makes a widening EFFECT unrepresentable, but plain-language
// statement TEXT can still read as conferring authority ("the workstream MAY
// merge its own PR ... only when CI is green"), and grant-shaped prose in the
// projection can influence a coordinator. A policy may ADVISE how to act under
// an existing grant ("only merge after CI passes"); it may never itself confer
// or assert the grant ("MAY merge", "is allowed to deploy").
const GRANT_VERBS = /\b(merge|send|spend|deploy|publish|bypass|force-?push|delete|approve)(s|ed|ing)?\b/i;
// Permission modals. When one governs a grant verb, the statement CONFERS
// authority and is refused even when hedged with "only"/"only when" — this is
// the case the older restricting-word escape missed ("MAY merge ... only when"
// slipped through because "only" read as restricting).
const PERMISSION = /\b(may|can|could|allowed|permitted|authori[sz]ed|entitled|cleared|free to|ok to|okay to|able to|has authority|have authority)\b/i;
// Restricting language that turns a BARE grant verb into advice about how to
// act under an existing grant ("only merge after CI passes", "never deploy on
// Friday"). It does NOT rescue a permission-modal grant.
const RESTRICTING = /\b(never|not|don'?t|do not|cannot|must not|avoid|refuse[sd]?|forbidden|only|require[sd]?|approval|ask|explicit)\b/i;

/**
 * True when a statement reads as GRANTING/ASSERTING authority rather than
 * advising under an existing one. Refused at every ingress; never converted —
 * turning "MAY merge" into "advice to merge" would smuggle the grant in the
 * back door (docs/learning.md). The gate is deliberately conservative: a
 * statement that names a permission modal beside a grant verb is refused even
 * if it reads advisorily, because an authority firewall must fail toward
 * refusal. Rephrase without the modal ("confirm CI before merging").
 */
export function grantsAuthority(text: string): boolean {
  if (!GRANT_VERBS.test(text)) return false;
  if (PERMISSION.test(text)) return true; // confers authority — hedging notwithstanding
  return !RESTRICTING.test(text);
}

/** Shared refusal used by every statement-ingress path. Throws with the reason. */
function refuseGrantText(statement: string, label = 'policy statement'): void {
  if (grantsAuthority(statement)) {
    throw new Error(
      `refused: ${label} reads as conferring authority ("${statement.slice(0, 80)}") — a policy may advise how to act under an existing grant, never assert the grant itself`,
    );
  }
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
export async function exportSeed(author: string): Promise<SeedFile> {
  const sanitizeOrigin = (p: PolicyRecord): string => {
    const raw = policyOrigin(p);
    return raw.replace(/\/[^\s§]*\//g, (m) => m.split('/').filter(Boolean).pop() + '/').slice(0, 80);
  };
  return {
    weaverSeed: 1,
    author,
    exportedAt: new Date().toISOString(),
    policies: (await loadPolicies())
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
export async function importSeed(seed: SeedFile, opts: { refuseAuthority: (text: string) => boolean }): Promise<{
  imported: number;
  skippedDuplicate: number;
  refused: string[];
}> {
  const existing = new Set((await loadPolicies()).policies.map((p) => normalizeStatement(p.statement)));
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
    await proposeBackfillPolicy({
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

/**
 * Validate `applied_policy_ids` cited on a decision in a workstream with
 * `wsTags`. Returns a human-readable error, or null when every citation is
 * sound: each id must resolve to an existing, NON-SUPERSEDED policy whose
 * scope tags intersect the workstream's. Enforced at decision-write time so
 * attribution can never dangle — a live decision that cited a nonexistent
 * policy id is exactly the defect this guards.
 */
export function validatePolicyCitations(ids: Id[], policies: PolicyRecord[], wsTags: string[]): string | null {
  for (const pid of ids) {
    const pol = policies.find((p) => p.id === pid);
    if (!pol) return `no policy ${pid} — cite only existing learned policies (see the projection's policy list)`;
    if (pol.status === 'superseded') return `${pid} is superseded by ${pol.supersededBy} — cite its replacement, not the retired policy`;
    if (!pol.scope.tags.some((t) => wsTags.includes(t))) {
      return `${pid} scope [${pol.scope.tags.join(', ')}] does not match this workstream's tags [${wsTags.join(', ')}] — a policy applies only where its tags say`;
    }
  }
  return null;
}

/** Policies whose scope shares at least one tag with the workstream (shadow + active). */
export async function matchPolicies(tags: string[]): Promise<PolicyRecord[]> {
  return (await loadPolicies()).policies.filter(
    (p) =>
      p.status !== 'superseded' &&
      p.scope.tags.some((t) => tags.includes(t)),
  );
}

export async function proposePolicy(args: {
  statement: string;
  tags: string[];
  effectKind: PolicyEffectKind;
  effectDescription: string;
  workstreamSlug: string;
  passId: Id;
  steeringId?: Id;
  interventionSummary: string;
}): Promise<PolicyRecord> {
  // Live proposals run the SAME authority-text firewall as import/backfill —
  // grant-shaped prose is refused at the door, not stored and rendered.
  refuseGrantText(args.statement);
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
  await mutatePolicies((s) => s.policies.push(record));
  return record;
}

/**
 * Propose a policy seeded from pre-Weaver practice (`weaver backfill`).
 * Identical lifecycle to proposePolicy — shadow status, closed effect
 * vocabulary, widensAuthority: false — only the provenance variant differs.
 */
export async function proposeBackfillPolicy(args: {
  statement: string;
  tags: string[];
  effectKind: PolicyEffectKind;
  effectDescription: string;
  source: 'backfill:rules' | 'backfill:sessions' | 'seed';
  ref: string;
  interventionSummary: string;
}): Promise<PolicyRecord> {
  refuseGrantText(args.statement);
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
  await mutatePolicies((s) => s.policies.push(record));
  return record;
}

/**
 * Record outcome evidence for a policy. Promotion is earned, attributable, AND
 * cross-workstream:
 *
 *  - The evidence must cite a REAL applying decision (`applyingDecisionId`) in
 *    the recording workstream, whose `appliedPolicyIds` actually names this
 *    policy, and which did not post-date the outcome. Evidence that cannot
 *    point at a genuine application is the exact unattributed influence the
 *    learning contract forbids, so it is rejected rather than stored.
 *  - shadow → active requires at least one intervention-free, decision-cited
 *    outcome from a DIFFERENT workstream than the policy's source. Evidence
 *    from the proposing stream alone keeps it shadow — a policy cannot certify
 *    itself on its own origin.
 *  - Negative evidence CONTESTS (see PolicyRecord.contested); it never demotes.
 */
export async function recordPolicyOutcome(args: {
  policyId: Id;
  workstreamSlug: string;
  passId: Id;
  applyingDecisionId: Id;
  note: string;
  interventionFree: boolean;
}): Promise<PolicyRecord> {
  // Validate the applying decision against the workstream doc BEFORE touching
  // the policy store. The two stores are deliberately not atomic across each
  // other (docs/learning.md), so this is a read-then-check: a real decision,
  // in this workstream, that actually cites the policy, and does not come
  // after the outcome.
  const doc = await load(args.workstreamSlug);
  const decision = doc.decisions.find((d) => d.id === args.applyingDecisionId);
  if (!decision) {
    throw new Error(
      `no decision ${args.applyingDecisionId} in '${args.workstreamSlug}' — outcome evidence must cite the decision that applied the policy`,
    );
  }
  if (!(decision.appliedPolicyIds ?? []).includes(args.policyId)) {
    throw new Error(
      `decision ${args.applyingDecisionId} does not cite policy ${args.policyId} in appliedPolicyIds — it cannot be this policy's applying decision`,
    );
  }
  const now = virtualNow().toISOString();
  if (decision.decidedAtVirtual > now) {
    throw new Error(
      `decision ${args.applyingDecisionId} post-dates this outcome — the applying decision must precede (or share the pass of) the outcome it justifies`,
    );
  }

  let updated: PolicyRecord | undefined;
  await mutatePolicies((s) => {
    const p = s.policies.find((x) => x.id === args.policyId);
    if (!p) throw new Error(`no policy ${args.policyId}`);
    if (p.status === 'superseded') throw new Error(`${p.id} is superseded by ${p.supersededBy}`);
    p.evidence.push({
      workstreamSlug: args.workstreamSlug,
      passId: args.passId,
      applyingDecisionId: args.applyingDecisionId,
      note: args.note,
      interventionFree: args.interventionFree,
      at: now,
    });
    if (!args.interventionFree) {
      // Negative evidence contests, never demotes: an active policy stops
      // reading as active guidance until a human supersedes it or clears the
      // review; a shadow policy stays shadow with the contest on record and
      // will not promote while contested.
      p.contested = { at: now, workstreamSlug: args.workstreamSlug, note: args.note };
    } else if (p.status === 'shadow' && !p.contested) {
      const source = policySourceWorkstream(p);
      // Qualifying = intervention-free AND decision-cited AND from a stream
      // other than the source. Legacy rows (no applyingDecisionId) never
      // qualify; source-stream evidence never qualifies.
      const qualifying = p.evidence.some(
        (e) => e.interventionFree && e.applyingDecisionId && e.workstreamSlug !== source,
      );
      if (qualifying) p.status = 'active';
    }
    updated = p;
  });
  return updated!;
}

/**
 * How to replace a policy: either the TEXT of a brand-new replacement
 * candidate, or the id of an EXISTING policy to link as the replacement
 * (link-only, no new record).
 */
export type PolicyReplacement =
  | { withExisting: Id }
  | {
      statement: string;
      tags: string[];
      effectKind: PolicyEffectKind;
      effectDescription: string;
      workstreamSlug: string;
      passId: Id;
      steeringId?: Id;
      interventionSummary: string;
    };

/**
 * Replace a policy that turned out wrong; lineage kept, like decisions.
 * Supersession (or an explicit review-clear) is the ONLY way to resolve a
 * contested policy.
 *
 * ATOMIC: the replacement record and BOTH lineage links (old.supersededBy,
 * new.supersedes) are written in a SINGLE policy-store mutation, so a crash
 * can never leave two active policies or a half-linked pair. Existence, status,
 * self, and cycle checks all run inside that one update.
 */
export async function supersedePolicy(oldId: Id, replacement: PolicyReplacement): Promise<PolicyRecord> {
  // Grant-text refusal for a brand-new replacement happens OUTSIDE the mutator
  // (the mutator may re-run on a CAS conflict; validation must not repeat/mutate).
  if (!('withExisting' in replacement)) refuseGrantText(replacement.statement, 'replacement statement');

  let next: PolicyRecord | undefined;
  await mutatePolicies((s) => {
    const old = s.policies.find((x) => x.id === oldId);
    if (!old) throw new Error(`no policy ${oldId}`);
    if (old.status === 'superseded') throw new Error(`${oldId} is already superseded by ${old.supersededBy}`);

    if ('withExisting' in replacement) {
      if (replacement.withExisting === oldId) throw new Error(`a policy cannot supersede itself (${oldId})`);
      const rep = s.policies.find((x) => x.id === replacement.withExisting);
      if (!rep) throw new Error(`no replacement policy ${replacement.withExisting}`);
      if (rep.status === 'superseded') {
        throw new Error(`replacement ${rep.id} is itself superseded (by ${rep.supersededBy}) — linking it would form a supersession cycle`);
      }
      // Cycle guard: linking old → rep must not close a loop back to old
      // through rep's existing supersededBy chain.
      if (supersededByChainReaches(s.policies, rep.id, oldId)) {
        throw new Error(`superseding ${oldId} with ${rep.id} would form a supersession cycle`);
      }
      old.status = 'superseded';
      old.supersededBy = rep.id;
      rep.supersedes = oldId;
      next = rep;
    } else {
      const created: PolicyRecord = {
        id: newId('pol'),
        statement: replacement.statement,
        scope: { tags: replacement.tags },
        effect: { kind: replacement.effectKind, description: replacement.effectDescription },
        widensAuthority: false,
        status: 'shadow',
        provenance: {
          workstreamSlug: replacement.workstreamSlug,
          passId: replacement.passId,
          ...(replacement.steeringId ? { steeringId: replacement.steeringId } : {}),
          interventionSummary: replacement.interventionSummary,
        },
        evidence: [],
        supersedes: oldId,
        createdAt: new Date().toISOString(),
      };
      s.policies.push(created);
      old.status = 'superseded';
      old.supersededBy = created.id;
      next = created;
    }
  });
  return next!;
}

/** Walk supersededBy links from `startId`; true if the chain reaches `targetId`. */
function supersededByChainReaches(policies: PolicyRecord[], startId: Id, targetId: Id): boolean {
  const seen = new Set<Id>();
  let cur = policies.find((p) => p.id === startId);
  while (cur?.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.supersededBy === targetId) return true;
    cur = policies.find((p) => p.id === cur!.supersededBy);
  }
  return false;
}

/**
 * Explicitly clear a contest after a human review found the policy still sound
 * (the negative evidence was situational, not a flaw). Resolution of a contest
 * happens ONLY here or via supersession — positive evidence never silently
 * un-contests. The evidence rows stay for the record.
 */
export async function reviewClearPolicy(policyId: Id, note: string): Promise<PolicyRecord> {
  let updated: PolicyRecord | undefined;
  await mutatePolicies((s) => {
    const p = s.policies.find((x) => x.id === policyId);
    if (!p) throw new Error(`no policy ${policyId}`);
    if (!p.contested) throw new Error(`${policyId} is not contested`);
    delete p.contested;
    updated = p;
  });
  return updated!;
}

export function renderPoliciesForProjection(policies: PolicyRecord[]): string {
  if (!policies.length) return '';
  // A large backfilled store must not drown the projection: active (earned)
  // policies always render; shadow candidates are capped, newest first, with
  // the omission stated — the full store stays inspectable via the CLI.
  // CONTESTED policies (unresolved negative evidence) are pulled out of the
  // ordinary guidance list into their own "under review" section so a
  // coordinator does not treat them as active guidance — whatever their status.
  const SHADOW_CAP = 25;
  const contested = policies.filter((p) => p.contested);
  const active = policies.filter((p) => p.status === 'active' && !p.contested);
  const shadow = policies.filter((p) => p.status !== 'active' && !p.contested);
  const shownShadow = shadow.slice(-SHADOW_CAP);
  const omitted = shadow.length - shownShadow.length;
  const line = (p: PolicyRecord): string => {
    const ev = p.evidence.length
      ? ` evidence=${p.evidence.length} (${p.evidence.filter((e) => e.interventionFree).length} intervention-free)`
      : ' unproven';
    return `- ${p.id} [${p.status}/${p.effect.kind}] "${p.statement}" — ${p.effect.description} (learned from ${policyOrigin(p)};${ev})`;
  };
  const out = [``, `Learned policies matching this workstream's tags:`];
  for (const p of [...active, ...shownShadow]) out.push(line(p));
  if (omitted > 0) {
    out.push(`(+${omitted} more shadow candidates not shown — the store is larger than this projection window)`);
  }
  if (contested.length) {
    out.push(``);
    out.push(
      `Contested — UNDER REVIEW, do not treat as active guidance. Each has recorded negative evidence (a matching workstream still needed correction on its point) and needs a human to supersede or clear it before it guides again:`,
    );
    for (const p of contested) {
      out.push(`${line(p)} — CONTESTED in ${p.contested!.workstreamSlug}: ${p.contested!.note.slice(0, 120)}`);
    }
  }
  out.push(
    `A policy can only add verification, narrow authority, or advise — never widen what you may do. When you apply one, cite its id in applied_policy_ids on the decision that applies it, so its effect stays attributable. If one proves wrong for this workstream, say so in a decision (or supersede_policy) rather than silently ignoring it; if it helped, record_policy_outcome with the applying decision.`,
  );
  return out.join('\n');
}
