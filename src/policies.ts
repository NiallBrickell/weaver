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
 * Two of those rules are about a policy the fleet LEARNED. The operator's own
 * standing rules are a different kind of thing, and treating them as candidates
 * to be proven cost real damage: a rule the operator wrote down ("never
 * squash-merge") sat unproven in shadow while a learned policy that had quietly
 * absorbed a `--squash` flag nobody chose accumulated evidence and outranked it
 * for nine days. So this store now separates three things that used to be one:
 *
 *  - DOCTRINE (`isDoctrine`) — a policy whose provenance shows the operator's
 *    OWN words are its source: a rules file they maintain, a transcript quote,
 *    or a steering directive the statement restates rather than elaborates. It
 *    binds without evidence and outranks learned policies where their scopes
 *    overlap. It still cannot widen authority; nothing can.
 *  - STATEMENT vs MECHANISM — the statement is the rule in the human's terms
 *    and is the only thing evidence promotes; the mechanism is the current HOW
 *    (commands, flags, thresholds), revisable at any time by anyone, and never
 *    something an outcome "proves".
 *  - REFRESH — doctrine is derived from a file the operator edits, so
 *    re-running `weaver backfill` updates it in place (src/backfill.ts) rather
 *    than leaving a stale copy beside the current text.
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
      /**
       * The human's own words that this statement restates, copied verbatim
       * from the cited steering record when the policy was proposed. Written
       * ONLY when the statement is a restatement of the directive rather than
       * an elaboration on it (`restatesDirective`), because that is precisely
       * what makes a live-learned policy DOCTRINE: the operator said it, and
       * the record still carries what they said so the claim stays checkable.
       */
      directiveQuote?: string;
      interventionSummary: string;
    }
  | {
      source: 'backfill:rules' | 'backfill:sessions' | 'seed';
      /** "path § heading" for rules files; "session <id>" for transcripts;
       * "<author>" for an imported team seed. */
      ref: string;
      /**
       * The operator's verbatim words the transcript path distilled this
       * candidate from. Rows written before this field existed keep the quote
       * inside `interventionSummary` (…session <id>: "<quote>"), which
       * `provenanceQuote` still reads — so a legacy session-backfilled policy
       * is classified the same way a fresh one is.
       */
      quote?: string;
      interventionSummary: string;
    };

export interface PolicyRecord {
  id: Id;
  /** Plain-language statement of the rule, in the human's terms — the WHAT.
   * This is the only text the evidence loop promotes, so it must contain
   * nothing the human did not choose. */
  statement: string;
  /**
   * The revisable HOW: the exact commands, flags, thresholds, and endpoints
   * that currently carry the statement out. Optional, and deliberately
   * separate — an execution detail that merely happened to work is not a rule
   * anyone agreed to, but folding it into the statement made every successful
   * run read as evidence FOR it. A merge policy that absorbed a `--squash`
   * flag nobody chose collected fifteen intervention-free outcomes that way,
   * none of which were about the flag. A mechanism is revisable by anyone at
   * any time (`revisePolicyMechanism`) without founder authority and without
   * touching the evidence, because revising HOW something is done is not
   * changing what was agreed.
   */
  mechanism?: string;
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
  contested?: {
    at: Iso;
    /** The workstream whose negative evidence contested it. Absent when the
     * contest came from a doctrine refresh rather than from a run — the
     * operator's rules file changed under a policy nobody re-examined. */
    workstreamSlug?: string;
    /** The doctrine policy whose refreshed statement contested this one. */
    byPolicyId?: Id;
    note: string;
  };
  /** Lineage, exactly like decisions: the policy this one replaced. */
  supersedes?: Id;
  supersededBy?: Id;
  /**
   * Why a policy was retired with no successor. A doctrine policy's source is
   * a section of the operator's rules file; when that section is gone the rule
   * is gone, and there is nothing to link as its replacement — so the record
   * says so in words instead of pointing at a policy that does not exist.
   */
  supersededReason?: string;
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
// Doctrine — the operator's own words, and what that changes.

/** The operator's verbatim words behind a backfilled candidate, if any. Fresh
 * rows carry them in `quote`; rows written before that field existed kept them
 * in the summary the transcript path composes (…session <id>: "<quote>"). */
function provenanceQuote(prov: Extract<PolicyProvenance, { source: string }>): string | undefined {
  if (prov.quote?.trim()) return prov.quote.trim();
  const legacy = /:\s*"([^"]{4,})"\s*$/.exec(prov.interventionSummary);
  return legacy?.[1];
}

/** Words too common to evidence that one sentence restates another. */
const RESTATEMENT_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'that', 'this', 'with', 'from', 'not', 'but', 'are', 'was',
  'when', 'what', 'why', 'how', 'all', 'any', 'its', 'it\'s', 'has', 'have', 'had', 'can', 'will',
  'should', 'would', 'must', 'just', 'get', 'got', 'use', 'using', 'into', 'than', 'then', 'them',
  'they', 'there', 'here', 'about', 'out', 'off', 'per', 'via', 'one', 'two', 'each', 'every',
]);

/** Fraction of a statement's content words that must come from the human's own
 * sentence for the statement to count as a restatement of it. */
const RESTATEMENT_COVERAGE = 0.6;

function contentWords(s: string): Set<string> {
  return new Set(
    normalizeStatement(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !RESTATEMENT_STOPWORDS.has(w)),
  );
}

/**
 * True when `statement` says what `directive` said, rather than building on it.
 *
 * The test is deliberately one-directional: nearly every content word of the
 * statement must already appear in the human's sentence. A distillation that
 * only tightens the wording passes; one that adds a command, a flag, a
 * threshold, or a condition the human never mentioned fails, because those
 * words have no source in what was said. That asymmetry is the whole point —
 * the classification must fail toward "this is the fleet's own idea", since
 * doctrine outranks learned policies and a wrongly-promoted elaboration would
 * inherit an authority its content never came from.
 */
export function restatesDirective(statement: string, directive: string): boolean {
  const stmt = contentWords(statement);
  if (!stmt.size) return false;
  const dir = contentWords(directive);
  if (!dir.size) return false;
  let covered = 0;
  for (const w of stmt) if (dir.has(w)) covered++;
  return covered / stmt.size >= RESTATEMENT_COVERAGE;
}

/**
 * DOCTRINE: this policy's text is the operator's, not the fleet's inference
 * about the operator. Derived from provenance on every read and never stored,
 * so no writer can assert it — a flag a coordinator could set would be exactly
 * the unearned authority the class exists to keep out, and a stored flag also
 * goes stale the moment provenance is corrected.
 *
 * Three provenances qualify:
 *  - `backfill:rules` — parsed from a rules file the operator maintains. The
 *    file IS their standing instruction; nothing about it is a guess.
 *  - `backfill:sessions` WITH a verbatim quote — the transcript path distilled
 *    a candidate from something the operator actually typed, and the quote is
 *    on the record to check it against. Without a quote there is nothing
 *    distinguishing it from a model's summary of a conversation, so it is not
 *    doctrine.
 *  - live learning WHERE the statement restates the cited steering directive
 *    (see `restatesDirective`) — the coordinator wrote the human's correction
 *    down rather than generalizing from it.
 *
 * A `seed` is explicitly NOT doctrine: it is a teammate's practice, and it
 * lands in the importer's store to earn trust the ordinary way.
 */
export function isDoctrine(p: PolicyRecord): boolean {
  const prov = p.provenance;
  if ('source' in prov) {
    if (prov.source === 'backfill:rules') return true;
    if (prov.source === 'backfill:sessions') return Boolean(provenanceQuote(prov));
    return false;
  }
  return Boolean(prov.directiveQuote && restatesDirective(p.statement, prov.directiveQuote));
}

/**
 * The scope tags on which a learned policy meets doctrine. Overlapping tags are
 * where the two could be read as governing the same work, and the projection
 * says at that point which one wins — a coordinator holding both should never
 * have to guess.
 */
export function doctrineOverlapTags(p: PolicyRecord, doctrine: PolicyRecord[]): string[] {
  const tags = new Set<string>();
  for (const d of doctrine) {
    for (const t of d.scope.tags) if (p.scope.tags.includes(t)) tags.add(t);
  }
  return [...tags];
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
  if (assertsPermission(text)) return true; // confers authority — hedging notwithstanding
  return !RESTRICTING.test(text);
}

/**
 * The narrower half of the same gate: text that says someone MAY do a thing.
 * A MECHANISM is held to this and not to the full statement gate, because the
 * two are refused for different reasons. A statement naming a bare grant verb
 * with nothing restricting it reads as direction to go and do it, so the
 * statement gate refuses that too. A mechanism is only ever read under an
 * authority the workstream already holds, and a literal `gh pr merge <n>
 * --merge` is exactly the kind of thing it exists to carry — refusing it would
 * push that detail back into the statement, which is the defect this whole
 * separation was built to fix. What a mechanism may never do is confer: "may
 * merge", "is allowed to deploy" is a grant wherever it is written.
 */
export function assertsPermission(text: string): boolean {
  return GRANT_VERBS.test(text) && PERMISSION.test(text);
}

/** Shared refusal used by every statement-ingress path. Throws with the reason. */
function refuseGrantText(statement: string, label = 'policy statement'): void {
  if (grantsAuthority(statement)) {
    throw new Error(
      `refused: ${label} reads as conferring authority ("${statement.slice(0, 80)}") — a policy may advise how to act under an existing grant, never assert the grant itself`,
    );
  }
}

/** Ingress gate for mechanism text (see `assertsPermission`). */
function refuseMechanismGrant(mechanism: string): void {
  if (assertsPermission(mechanism)) {
    throw new Error(
      `refused: mechanism reads as conferring authority ("${mechanism.slice(0, 80)}") — a mechanism describes HOW a permitted act is carried out (the exact command, flag, threshold), never that it is permitted`,
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
 *
 * Mechanisms stay home too, and not only for privacy: a mechanism is the how
 * that works on the author's machine, in their repos, against the tool versions
 * they have. Shipping it would land a stale command in a teammate's store as
 * though it were part of the rule — the exact confusion the field exists to
 * end. The importer's own runs supply their own mechanism.
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
    if (pol.status === 'superseded') {
      // A doctrine policy retired because its rules section vanished has no
      // successor to point at, so the reason IS the lineage.
      return pol.supersededBy
        ? `${pid} is superseded by ${pol.supersededBy} — cite its replacement, not the retired policy`
        : `${pid} is retired${pol.supersededReason ? ` (${pol.supersededReason})` : ''} — it no longer applies, so nothing may cite it`;
    }
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
  /** The execution detail that carried it out this time — never folded into
   * the statement. See PolicyRecord.mechanism. */
  mechanism?: string;
  tags: string[];
  effectKind: PolicyEffectKind;
  effectDescription: string;
  workstreamSlug: string;
  passId: Id;
  steeringId?: Id;
  /** The steering record's own text, so the store can check whether this
   * statement restates the human's directive (doctrine) or builds on it. */
  directiveQuote?: string;
  interventionSummary: string;
}): Promise<PolicyRecord> {
  // Live proposals run the SAME authority-text firewall as import/backfill —
  // grant-shaped prose is refused at the door, not stored and rendered.
  refuseGrantText(args.statement);
  if (args.mechanism) refuseMechanismGrant(args.mechanism);
  const record: PolicyRecord = {
    id: newId('pol'),
    statement: args.statement,
    ...(args.mechanism ? { mechanism: args.mechanism } : {}),
    scope: { tags: args.tags },
    effect: { kind: args.effectKind, description: args.effectDescription },
    widensAuthority: false,
    status: 'shadow',
    provenance: {
      workstreamSlug: args.workstreamSlug,
      passId: args.passId,
      ...(args.steeringId ? { steeringId: args.steeringId } : {}),
      ...(args.directiveQuote ? { directiveQuote: args.directiveQuote } : {}),
      interventionSummary: args.interventionSummary,
    },
    evidence: [],
    createdAt: new Date().toISOString(),
  };
  await mutatePolicies((s) => s.policies.push(record));
  return record;
}

/**
 * Revise the HOW without touching the WHAT. A mechanism records what currently
 * works — a command, a flag, an endpoint, a threshold — and the world changes
 * it without anyone's permission: a flag is renamed, a repo disables an option,
 * an API version moves. So this needs no founder authority and no supersession
 * ceremony, and it deliberately leaves `evidence` alone: outcomes were recorded
 * about the statement, and a policy that has been carried out fifteen times has
 * not been "proven" about the flag it happened to use.
 */
export async function revisePolicyMechanism(policyId: Id, mechanism: string): Promise<PolicyRecord> {
  const next = mechanism.trim();
  if (next) refuseMechanismGrant(next);
  let updated: PolicyRecord | undefined;
  await mutatePolicies((s) => {
    const p = s.policies.find((x) => x.id === policyId);
    if (!p) throw new Error(`no policy ${policyId}`);
    if (p.status === 'superseded') {
      throw new Error(`${policyId} is superseded${p.supersededBy ? ` by ${p.supersededBy}` : ''} — revise the policy that replaced it`);
    }
    if (next) p.mechanism = next;
    else delete p.mechanism;
    updated = p;
  });
  return updated!;
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
  /** The operator's verbatim words (transcript path) — what makes a
   * session-sourced candidate doctrine rather than a model's paraphrase. */
  quote?: string;
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
    provenance: {
      source: args.source,
      ref: args.ref,
      ...(args.quote ? { quote: args.quote } : {}),
      interventionSummary: args.interventionSummary,
    },
    evidence: [],
    createdAt: new Date().toISOString(),
  };
  await mutatePolicies((s) => s.policies.push(record));
  return record;
}

// ---------------------------------------------------------------------------
// Doctrine refresh: the operator edits the rules file, the store follows.

/** One rules-file rule whose text changed since it was backfilled. */
export interface RulesRefreshUpdate {
  id: Id;
  statement: string;
  effectKind: PolicyEffectKind;
  effectDescription: string;
}

export interface RulesRefreshResult {
  updated: { id: Id; before: string; after: string; contested: Id[] }[];
  moved: { id: Id; ref: string }[];
  retired: { id: Id; statement: string; reason: string }[];
}

/**
 * Apply a planned refresh of rules-file doctrine in ONE policy-store mutation
 * (src/backfill.ts plans it; the matching is pure and testable there).
 *
 * Two things happen here that do not happen anywhere else in this file.
 *
 * The statement of an EXISTING policy is rewritten in place, keeping its id and
 * createdAt. That is right for doctrine specifically: the rule is the operator's
 * section of their rules file, the section is still there, and they edited its
 * wording. Rewriting keeps every citation that already points at it valid, and
 * the change is journaled by the store's mutation receipt like any other write,
 * so "what did this text used to say" stays answerable.
 *
 * And a changed doctrine statement CONTESTS every non-doctrine policy sharing
 * one of its scope tags. The blast radius is deliberate: a learned policy was
 * inferred while the old wording was in force, so the fleet does not know which
 * inferences the new wording invalidates — and the failure that motivated this
 * was precisely a learned policy quietly outliving the rule it contradicted.
 * Contest is not demotion (nothing is deleted, no status moves); it means "stop
 * treating this as settled guidance until someone reconciles it with what the
 * operator now says", which a human resolves with review-clear or supersession,
 * or a coordinator resolves by citing the doctrine. Policies already contested
 * keep their original contest — they are out of guidance either way, and
 * overwriting would erase why they first came under review.
 */
export async function applyRulesRefresh(args: {
  updates: RulesRefreshUpdate[];
  /** A rule whose words did not change but whose section did — the provenance
   * ref follows the text, so the next refresh still recognizes it. Nothing is
   * contested: a heading rename changes no instruction. */
  moves?: { id: Id; ref: string }[];
  retire: { id: Id; reason: string }[];
}): Promise<RulesRefreshResult> {
  // Validation outside the mutator: it may re-run against fresh state after a
  // CAS conflict, so it must stay free of throwing checks that can mutate.
  for (const u of args.updates) refuseGrantText(u.statement, `refreshed rule for ${u.id}`);

  const result: RulesRefreshResult = { updated: [], moved: [], retired: [] };
  await mutatePolicies((s) => {
    result.updated = [];
    result.moved = [];
    result.retired = [];
    const now = new Date().toISOString();
    for (const u of args.updates) {
      const p = s.policies.find((x) => x.id === u.id);
      if (!p || p.status === 'superseded') continue;
      const before = p.statement;
      if (normalizeStatement(before) === normalizeStatement(u.statement)) continue;
      p.statement = u.statement;
      p.effect = { kind: u.effectKind, description: u.effectDescription };
      const contested: Id[] = [];
      for (const other of s.policies) {
        if (other.id === p.id || other.status === 'superseded' || other.contested) continue;
        if (isDoctrine(other)) continue;
        if (!other.scope.tags.some((t) => p.scope.tags.includes(t))) continue;
        other.contested = {
          at: now,
          byPolicyId: p.id,
          note: `contested by refreshed doctrine ${p.id} ("${u.statement.slice(0, 160)}") — this policy was learned while the operator's rule read differently; reconcile it with the current rule (cite the doctrine) or supersede it`,
        };
        contested.push(other.id);
      }
      result.updated.push({ id: p.id, before, after: u.statement, contested });
    }
    for (const m of args.moves ?? []) {
      const p = s.policies.find((x) => x.id === m.id);
      if (!p || p.status === 'superseded' || !('ref' in p.provenance)) continue;
      p.provenance.ref = m.ref;
      result.moved.push({ id: p.id, ref: m.ref });
    }
    for (const r of args.retire) {
      const p = s.policies.find((x) => x.id === r.id);
      if (!p || p.status === 'superseded') continue;
      p.status = 'superseded';
      p.supersededReason = r.reason;
      result.retired.push({ id: p.id, statement: p.statement, reason: r.reason });
    }
  });
  return result;
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
      mechanism?: string;
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
  if (!('withExisting' in replacement)) {
    refuseGrantText(replacement.statement, 'replacement statement');
    if (replacement.mechanism) refuseMechanismGrant(replacement.mechanism);
  }

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
        ...(replacement.mechanism ? { mechanism: replacement.mechanism } : {}),
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
  // policies always render; doctrine and shadow candidates are capped, newest
  // first, with the omission stated — the full store stays inspectable via the
  // CLI. CONTESTED learned policies (unresolved negative evidence) are pulled
  // out of the ordinary guidance list into their own "under review" section so
  // a coordinator does not treat them as active guidance — whatever their
  // status.
  //
  // DOCTRINE RENDERS FIRST, and renders whether or not anything has proven it.
  // Ordering is the surface where precedence becomes real: a coordinator reads
  // top-down under a token budget, and the nine-day failure this fixes was a
  // coordinator acting on a learned policy while the operator's own rule sat
  // below it, unproven, indistinguishable from an untested guess.
  const DOCTRINE_CAP = 25;
  const SHADOW_CAP = 25;
  const doctrine = policies.filter(isDoctrine);
  const learned = policies.filter((p) => !isDoctrine(p));
  const contested = learned.filter((p) => p.contested);
  const active = learned.filter((p) => p.status === 'active' && !p.contested);
  const shadow = learned.filter((p) => p.status !== 'active' && !p.contested);
  const shownShadow = shadow.slice(-SHADOW_CAP);
  const omitted = shadow.length - shownShadow.length;
  const shownDoctrine = doctrine.slice(-DOCTRINE_CAP);
  const omittedDoctrine = doctrine.length - shownDoctrine.length;

  const mechanismOf = (p: PolicyRecord): string =>
    p.mechanism ? `\n    mechanism (revisable, not the rule): ${p.mechanism}` : '';
  const line = (p: PolicyRecord): string => {
    const ev = p.evidence.length
      ? ` evidence=${p.evidence.length} (${p.evidence.filter((e) => e.interventionFree).length} intervention-free)`
      : ' unproven';
    const overlap = doctrine.length ? doctrineOverlapTags(p, doctrine) : [];
    const subordinate = overlap.length ? ` — SUBORDINATE TO DOCTRINE on [${overlap.join(', ')}]` : '';
    return `- ${p.id} [${p.status}/${p.effect.kind}] "${p.statement}" — ${p.effect.description} (learned from ${policyOrigin(p)};${ev})${subordinate}${mechanismOf(p)}`;
  };

  const out: string[] = [];
  if (doctrine.length) {
    out.push(``);
    out.push(
      `Doctrine — the operator's OWN standing rules, in their words (from the rules files they maintain and the directives they gave). These BIND NOW: doctrine needs no evidence, so an unproven one is not a weaker one. Where doctrine and a learned policy below cover the same ground, DOCTRINE WINS — follow it, treat the learned policy as contested, and say so — supersede_policy it with a replacement that agrees with the doctrine, or, if you applied it here and the doctrine corrected you, record_policy_outcome with intervention_free=false naming the doctrine and citing the decision that applied it — rather than picking whichever reads more specific. Cite doctrine in applied_policy_ids exactly like any other policy:`,
    );
    for (const p of shownDoctrine) {
      const flag = p.contested
        ? ` — CONTESTED${p.contested.workstreamSlug ? ` in ${p.contested.workstreamSlug}` : ''}: ${p.contested.note.slice(0, 120)}. It STILL BINDS: a run's negative evidence cannot retire the operator's own rule — only they can, by changing the rules file or superseding it. Follow it and raise the conflict.`
        : '';
      out.push(`- ${p.id} [doctrine/${p.effect.kind}] "${p.statement}" (from ${policyOrigin(p)})${flag}${mechanismOf(p)}`);
    }
    if (omittedDoctrine > 0) {
      out.push(`(+${omittedDoctrine} more doctrine rules not shown — the operator's full rulebook is larger than this projection window; \`weaver policies\` lists it)`);
    }
  }

  out.push(``);
  out.push(
    doctrine.length
      ? `Learned policies matching this workstream's tags — inferred by coordinators from past corrections, and subordinate to the doctrine above wherever their scope tags overlap:`
      : `Learned policies matching this workstream's tags:`,
  );
  for (const p of [...active, ...shownShadow]) out.push(line(p));
  if (omitted > 0) {
    out.push(`(+${omitted} more shadow candidates not shown — the store is larger than this projection window)`);
  }
  if (contested.length) {
    out.push(``);
    out.push(
      `Contested — UNDER REVIEW, do not treat as active guidance. Each has recorded negative evidence (a matching workstream still needed correction on its point), or was contested by a doctrine rule the operator has since rewritten, and needs a human to supersede or clear it before it guides again:`,
    );
    for (const p of contested) {
      const by = p.contested!.workstreamSlug
        ? `CONTESTED in ${p.contested!.workstreamSlug}`
        : `CONTESTED by doctrine ${p.contested!.byPolicyId ?? '(unnamed)'}`;
      out.push(`${line(p)} — ${by}: ${p.contested!.note.slice(0, 160)}`);
    }
  }
  out.push(
    `A policy can only add verification, narrow authority, or advise — never widen what you may do; doctrine included, since the operator writing a rule down is not the same as them granting authority for it. When you apply one, cite its id in applied_policy_ids on the decision that applies it, so its effect stays attributable. If one proves wrong for this workstream, say so in a decision (or supersede_policy) rather than silently ignoring it; if it helped, record_policy_outcome with the applying decision. A policy's mechanism is the current HOW — the exact command, flag, or threshold — and you may correct it (revise_policy_mechanism) the moment it stops working, without ceremony: outcomes are recorded about the statement, never about the mechanism.`,
  );
  return out.join('\n');
}
