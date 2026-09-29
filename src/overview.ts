/**
 * The team overview — a read-only account of what the fleet is, where its work
 * comes from, what it is doing, how outcomes ended, whether the work is useful
 * or churn, and what it costs.
 *
 * Pure over typed state, like `computeStats` (which it reuses for the shared
 * intervention and reliability metrics rather than re-deriving them). Never
 * reads `doc.events` (a bounded tail) or any transcript: a number that could
 * drift as old events fall off would misstate the fleet to people who cannot
 * check it. Every figure carries its denominator so a reader never has to
 * guess what "73%" is a share of.
 *
 * What it deliberately cannot say: whether merged code was good, reverted, or
 * produced follow-up churn. Those facts live in GitHub, and this page does no
 * external reads — the page states that limit instead of approximating it.
 *
 * `overviewInsights` turns the payload into the plain-English takeaway each
 * section leads with. Every sentence is picked by a rule over these numbers,
 * so the prose can never claim more than the typed state supports.
 */

import type { PolicyRecord } from './policies.js';
import { computeStats } from './stats.js';
import { workstreamTimeline, type WorkstreamTimeline } from './timeline.js';
import type { Assignment, Attempt, PassRecord, WorkstreamDoc } from './types.js';
import { fleetBoard, fleetGlance, fleetRunnerLine, type FleetBucket } from './ui/inspect/model.js';

/** How a concluded workstream ended. Added to `conclusion` by a parallel
 * change; read defensively so this page works before and after it lands. */
export const DISPOSITIONS = ['delivered', 'no_change_needed', 'not_worth_doing', 'duplicate', 'directed_closed'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export type OutcomeClass = Disposition | 'unclassified';

function isDisposition(value: unknown): value is Disposition {
  return typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value);
}

/** The disposition of a concluded workstream, `unclassified` when the
 * conclusion predates dispositions (or carries an unknown value), and
 * `undefined` when the workstream has no conclusion at all. */
export function outcomeClassOf(doc: WorkstreamDoc): OutcomeClass | undefined {
  const conclusion = doc.workstream.conclusion as (WorkstreamDoc['workstream']['conclusion'] & { disposition?: unknown }) | undefined;
  if (!conclusion) return undefined;
  return isDisposition(conclusion.disposition) ? conclusion.disposition : 'unclassified';
}

/** Actions whose exact command or objective names `gh pr merge`. A heuristic:
 * the schema has no typed "this is a merge" field, and the page says so. */
const MERGE_PATTERN = /\bgh\s+pr\s+merge\b/i;

export function isMergeAction(a: Assignment): boolean {
  if (a.kind !== 'action') return false;
  return MERGE_PATTERN.test(a.exec?.run ?? '') || MERGE_PATTERN.test(a.objective);
}

// ---------------------------------------------------------------------------
// Cost

export type BillingBasis = 'subscription-notional' | 'cash' | 'unknown';

export interface ProviderCost {
  key: string;
  executor: string;
  provider: string;
  basis: BillingBasis;
  label: string;
  coordinatorUsd: number;
  workerUsd: number;
  totalUsd: number;
}

/**
 * How honestly to read a recorded cost. The Claude Agent SDK reports a
 * list-price figure even when the run is on a subscription, so `local-sdk`
 * costs are notional; OpenRouter bills per token, so its figure is money
 * spent. Everything else is labelled unknown rather than guessed.
 */
export function billingBasis(executor: string | undefined, provider: string | undefined): { basis: BillingBasis; label: string } {
  if (provider === 'openrouter') return { basis: 'cash', label: 'OpenRouter: real money, charged per use' };
  if (executor === 'local-sdk' || (!executor && provider === 'anthropic')) {
    return { basis: 'subscription-notional', label: 'Anthropic through the Claude SDK: a list-price estimate, covered by a subscription' };
  }
  if (!executor && !provider) return { basis: 'unknown', label: 'Not recorded (older records)' };
  return { basis: 'unknown', label: "Weaver doesn't know how this is billed" };
}

function usd(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function passCost(passes: PassRecord[]): number {
  return passes.reduce((sum, p) => sum + usd(p.costUsd), 0);
}

function attemptsOf(doc: WorkstreamDoc): Attempt[] {
  return doc.assignments.flatMap((a) => a.attempts);
}

export function docCost(doc: WorkstreamDoc): { coordinatorUsd: number; workerUsd: number; totalUsd: number } {
  const coordinatorUsd = passCost(doc.passes);
  const workerUsd = attemptsOf(doc).reduce((sum, a) => sum + usd(a.costUsd), 0);
  return { coordinatorUsd, workerUsd, totalUsd: coordinatorUsd + workerUsd };
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Payload

/** `null` parent = top level: opened by a person or by intake, not by another
 * workstream. */
export interface OriginRow {
  parent: string | null;
  label: string;
  count: number;
  active: number;
  paused: number;
  done: number;
}

export interface NowItem {
  slug: string;
  title: string;
  objective: string;
  decision?: string;
}

/** The board's own status bucket for open jobs (everything but done), with
 * the board's label, so the overview, the board tiles and the sidebar can
 * never show different numbers for the same fleet. */
export type OpenBucket = Exclude<FleetBucket, 'done'>;

export interface OpenBucketCount {
  key: OpenBucket;
  label: string;
  count: number;
}

/** The slice of `fleetGlance` the overview reads. */
export interface GlanceBuckets {
  buckets: ReadonlyArray<{ key: FleetBucket; label: string; count: number }>;
}

export interface NowGroup {
  parent: string | null;
  label: string;
  items: NowItem[];
}

export interface OutcomeRow {
  outcome: OutcomeClass;
  label: string;
  count: number;
  totalUsd: number;
  medianUsd: number | null;
}

/** Accepted versus rejected results for one family (a routine and the jobs
 * it opened, or top-level work), so an unusually high rejection rate can be
 * named rather than hidden in the fleet average. */
export interface FamilyAdoption {
  family: string | null;
  label: string;
  accepted: number;
  rejected: number;
  judged: number;
}

/** One job's lifetime cost, and its cost per day alive. */
export interface JobCost {
  slug: string;
  title: string;
  totalUsd: number;
  days: number;
  perDayUsd: number;
}

export interface FamilyCost {
  family: string | null;
  label: string;
  workstreams: number;
  ownUsd: number;
  childrenUsd: number;
  totalUsd: number;
}

/** Why an example was picked: each tab shows a different way work ends. */
export type ExampleKind = 'delivered' | 'investigated' | 'corrected' | 'stopped';

export const EXAMPLE_KIND_LABELS: Record<ExampleKind, string> = {
  delivered: 'Delivered',
  investigated: 'Looked into it, no code needed',
  corrected: 'A person corrected it',
  stopped: 'Stopped without delivering',
};

export interface WorkedExample {
  kind: ExampleKind;
  slug: string;
  title: string;
  parent: string | null;
  objective: string;
  outcome: OutcomeClass;
  concludedAt: string;
  summary: string;
  assignments: number;
  actions: number;
  passes: number;
  steers: number;
  costUsd: number;
  /** The same timeline model and component the workstream page uses. */
  timeline: WorkstreamTimeline;
}

export interface OverviewPayload {
  generatedAt: string;
  totals: {
    workstreams: number;
    active: number;
    paused: number;
    done: number;
    assignments: number;
    workAssignments: number;
    actionAssignments: number;
    passes: number;
    decisions: number;
    steers: number;
  };
  origins: {
    total: number;
    topLevel: number;
    managed: number;
    rows: OriginRow[];
  };
  now: {
    active: number;
    /** Open jobs on the board: the sum of `buckets`. */
    open: number;
    /** The board's buckets, in its order, done excluded. */
    buckets: OpenBucketCount[];
    groups: NowGroup[];
  };
  outcomes: {
    concluded: number;
    rows: OutcomeRow[];
    /** Status `done` with no typed conclusion — closed without a success claim. */
    doneWithoutConclusion: number;
    paused: Array<{ slug: string; title: string; parent: string | null }>;
  };
  signals: {
    adoption: { accepted: number; rejected: number; judged: number; pending: number; superseded: number };
    adoptionByFamily: FamilyAdoption[];
    firstAttempt: { firstAttempt: number; completed: number; rate: number | null; failed: number };
    merges: { total: number; confirmed: number; failedReadback: number; notRun: number };
    repairsOfRepairs: { count: number; managed: number; slugs: string[] };
    interventions: {
      count: number;
      successfulOutcomes: number;
      perOutcome: number | null;
      undated: number;
      /** Jobs with at least one recorded human intervention, of all jobs. */
      jobsWithIntervention: number;
    };
    passes: { total: number; completed: number; providerBackoff: number; logicalFailure: number };
  };
  cost: {
    totalUsd: number;
    coordinatorUsd: number;
    workerUsd: number;
    coordinatorShare: number | null;
    byFamily: FamilyCost[];
    perOutcome: { count: number; totalUsd: number; medianUsd: number | null };
    byProvider: ProviderCost[];
    byBasis: Record<BillingBasis, number>;
    /** Whole days from the first job's creation to now (at least 1). */
    days: number;
    firstJobAt: string | null;
    /** The most expensive jobs, most expensive first (at most five). */
    topJobs: JobCost[];
  };
  /** Up to one example per kind, in EXAMPLE_KIND order; empty when none qualify. */
  examples: WorkedExample[];
}

export const TOP_LEVEL_LABEL = 'Started directly by people';

export const OUTCOME_LABELS: Record<OutcomeClass, string> = {
  delivered: 'Delivered something',
  no_change_needed: 'Nothing needed changing',
  not_worth_doing: 'Not worth doing',
  duplicate: 'Duplicate of another job',
  directed_closed: 'Closed by a person',
  unclassified: 'Finished before endings were recorded',
};

const EXAMPLE_MIN_ASSIGNMENTS = 5;
const EXAMPLE_MAX_ROWS = 40;
const OBJECTIVE_CHARS = 160;

function oneLine(text: string, max = OBJECTIVE_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function parentOf(doc: WorkstreamDoc): string | null {
  return doc.workstream.managedBy?.slug ?? null;
}

function latestStandingDecision(doc: WorkstreamDoc): string | undefined {
  let best: WorkstreamDoc['decisions'][number] | undefined;
  for (const d of doc.decisions) {
    if (d.status !== 'standing') continue;
    if (!best || d.decidedAtVirtual > best.decidedAtVirtual) best = d;
  }
  return best?.title;
}

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`, never less than one. */
function daysBetween(from: string, to: Date): number {
  const ms = to.getTime() - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / DAY_MS)) : 1;
}

/**
 * The board's classification of this fleet when the caller has none to hand
 * (the route passes the glance it already built, with runner presence).
 * Never a second classifier: it runs the board's own `fleetBoard` and
 * `fleetGlance` over the same documents.
 */
function glanceFor(docs: WorkstreamDoc[], policies: PolicyRecord[], now: Date): GlanceBuckets {
  return fleetGlance(fleetBoard(docs, policies, new Map(), [], now, now), fleetRunnerLine([], undefined, now), now);
}

function byCountThenName<T extends { parent: string | null; label: string }>(count: (row: T) => number) {
  return (a: T, b: T) => count(b) - count(a) || a.label.localeCompare(b.label);
}

export function computeOverview(docs: WorkstreamDoc[], policies: PolicyRecord[], now: Date, glance?: GlanceBuckets): OverviewPayload {
  const bySlug = new Map(docs.map((d) => [d.workstream.slug, d]));
  const stats = computeStats(docs, policies, now);
  const managesSomething = new Set(docs.map(parentOf).filter((p): p is string => p !== null));
  // A family is the routine a doc belongs to: a managed doc belongs to its
  // parent; a top-level doc that manages others is its own family; any other
  // top-level doc is "top level".
  const familyOf = (doc: WorkstreamDoc): string | null => parentOf(doc) ?? (managesSomething.has(doc.workstream.slug) ? doc.workstream.slug : null);

  // Origins: strictly by the single managedBy pointer (flat, kernel rule 1).
  const origins = new Map<string | null, OriginRow>();
  for (const doc of docs) {
    const parent = parentOf(doc);
    const row = origins.get(parent) ?? {
      parent,
      label: parent ?? TOP_LEVEL_LABEL,
      count: 0,
      active: 0,
      paused: 0,
      done: 0,
    };
    row.count += 1;
    row[doc.workstream.status] += 1;
    origins.set(parent, row);
  }
  const topLevel = origins.get(null)?.count ?? 0;

  // Now: active work grouped by parent; open jobs by the board's buckets.
  const openBuckets: OpenBucketCount[] = (glance ?? glanceFor(docs, policies, now)).buckets
    .filter((bucket): bucket is OpenBucketCount => bucket.key !== 'done')
    .map(({ key, label, count }) => ({ key, label, count }));
  const nowGroups = new Map<string | null, NowGroup>();
  for (const doc of docs) {
    if (doc.workstream.status !== 'active') continue;
    const parent = parentOf(doc);
    const group = nowGroups.get(parent) ?? { parent, label: parent ?? TOP_LEVEL_LABEL, items: [] };
    const decision = latestStandingDecision(doc);
    group.items.push({
      slug: doc.workstream.slug,
      title: doc.workstream.title,
      objective: oneLine(doc.workstream.objective),
      ...(decision ? { decision: oneLine(decision) } : {}),
    });
    nowGroups.set(parent, group);
  }
  for (const group of nowGroups.values()) group.items.sort((a, b) => a.title.localeCompare(b.title));

  // Outcomes and per-outcome cost.
  const outcomeCosts = new Map<OutcomeClass, number[]>();
  const concludedCosts: number[] = [];
  let doneWithoutConclusion = 0;
  for (const doc of docs) {
    const outcome = outcomeClassOf(doc);
    if (!outcome) {
      if (doc.workstream.status === 'done') doneWithoutConclusion += 1;
      continue;
    }
    const cost = docCost(doc).totalUsd;
    concludedCosts.push(cost);
    outcomeCosts.set(outcome, [...(outcomeCosts.get(outcome) ?? []), cost]);
  }
  const outcomeRows: OutcomeRow[] = ([...DISPOSITIONS, 'unclassified'] as OutcomeClass[])
    .filter((outcome) => outcomeCosts.has(outcome))
    .map((outcome) => {
      const costs = outcomeCosts.get(outcome)!;
      return {
        outcome,
        label: OUTCOME_LABELS[outcome],
        count: costs.length,
        totalUsd: costs.reduce((a, b) => a + b, 0),
        medianUsd: median(costs),
      };
    });

  // Signals.
  const adoption = { accepted: 0, rejected: 0, judged: 0, pending: 0, superseded: 0 };
  const merges = { total: 0, confirmed: 0, failedReadback: 0, notRun: 0 };
  const familyAdoption = new Map<string | null, FamilyAdoption>();
  let assignments = 0;
  let actionAssignments = 0;
  for (const doc of docs) {
    const family = familyOf(doc);
    const fa = familyAdoption.get(family) ?? { family, label: family ?? TOP_LEVEL_LABEL, accepted: 0, rejected: 0, judged: 0 };
    familyAdoption.set(family, fa);
    for (const a of doc.assignments) {
      assignments += 1;
      if (a.kind === 'action') actionAssignments += 1;
      if (a.adoption.state === 'accepted') {
        adoption.accepted += 1;
        fa.accepted += 1;
        fa.judged += 1;
      } else if (a.adoption.state === 'rejected') {
        adoption.rejected += 1;
        fa.rejected += 1;
        fa.judged += 1;
      }
      if (a.adoption.state === 'proposed') adoption.pending += 1;
      else if (a.adoption.state === 'superseded') adoption.superseded += 1;
      if (isMergeAction(a)) {
        merges.total += 1;
        const verified = a.exec?.verified;
        if (verified?.ok) merges.confirmed += 1;
        else if (verified) merges.failedReadback += 1;
        else merges.notRun += 1;
      }
    }
  }
  adoption.judged = adoption.accepted + adoption.rejected;

  const managedDocs = docs.filter((d) => parentOf(d) !== null);
  const repairsOfRepairs = managedDocs
    .filter((d) => {
      const parent = bySlug.get(parentOf(d)!);
      return !!parent && parentOf(parent) !== null;
    })
    .map((d) => d.workstream.slug)
    .sort();

  const reliability = stats.totals.reliability;
  const passHealth = stats.totals.passHealth;

  // Cost by family (a routine's own passes are part of what it costs).
  const families = new Map<string | null, FamilyCost>();
  const providers = new Map<string, ProviderCost>();
  let coordinatorUsd = 0;
  let workerUsd = 0;
  const addProvider = (executor: string | undefined, provider: string | undefined, role: 'coordinatorUsd' | 'workerUsd', cost: number) => {
    if (cost <= 0) return;
    const key = `${executor ?? '—'} / ${provider ?? '—'}`;
    const existing = providers.get(key);
    if (existing) {
      existing[role] += cost;
      existing.totalUsd += cost;
      return;
    }
    const { basis, label } = billingBasis(executor, provider);
    const row: ProviderCost = { key, executor: executor ?? '—', provider: provider ?? '—', basis, label, coordinatorUsd: 0, workerUsd: 0, totalUsd: 0 };
    row[role] += cost;
    row.totalUsd += cost;
    providers.set(key, row);
  };
  for (const doc of docs) {
    const cost = docCost(doc);
    coordinatorUsd += cost.coordinatorUsd;
    workerUsd += cost.workerUsd;
    for (const p of doc.passes) addProvider(p.executor, p.provider, 'coordinatorUsd', usd(p.costUsd));
    for (const a of attemptsOf(doc)) addProvider(a.executor, a.provider, 'workerUsd', usd(a.costUsd));

    const slug = doc.workstream.slug;
    const family = familyOf(doc);
    const row = families.get(family) ?? {
      family,
      label: family ?? TOP_LEVEL_LABEL,
      workstreams: 0,
      ownUsd: 0,
      childrenUsd: 0,
      totalUsd: 0,
    };
    row.workstreams += 1;
    if (family === null || family === slug) row.ownUsd += cost.totalUsd;
    else row.childrenUsd += cost.totalUsd;
    row.totalUsd += cost.totalUsd;
    families.set(family, row);
  }
  const totalUsd = coordinatorUsd + workerUsd;
  const topJobs: JobCost[] = docs
    .map((doc) => {
      const total = docCost(doc).totalUsd;
      const end = doc.workstream.conclusion?.atVirtual;
      const days = daysBetween(doc.workstream.createdAt, end ? new Date(end) : now);
      return { slug: doc.workstream.slug, title: doc.workstream.title, totalUsd: total, days, perDayUsd: total / days };
    })
    .filter((job) => job.totalUsd > 0)
    .sort((a, b) => b.totalUsd - a.totalUsd || a.slug.localeCompare(b.slug))
    .slice(0, 5);
  const firstJobAt = docs.map((d) => d.workstream.createdAt).filter((at) => Number.isFinite(Date.parse(at))).sort()[0] ?? null;
  const examples = workedExamples(docs, now);
  const byProvider = [...providers.values()].sort((a, b) => b.totalUsd - a.totalUsd || a.key.localeCompare(b.key));
  const byBasis: Record<BillingBasis, number> = { 'subscription-notional': 0, cash: 0, unknown: 0 };
  for (const row of byProvider) byBasis[row.basis] += row.totalUsd;

  return {
    generatedAt: now.toISOString(),
    totals: {
      workstreams: docs.length,
      active: docs.filter((d) => d.workstream.status === 'active').length,
      paused: docs.filter((d) => d.workstream.status === 'paused').length,
      done: docs.filter((d) => d.workstream.status === 'done').length,
      assignments,
      workAssignments: assignments - actionAssignments,
      actionAssignments,
      passes: docs.reduce((n, d) => n + d.passes.length, 0),
      decisions: docs.reduce((n, d) => n + d.decisions.length, 0),
      steers: docs.reduce((n, d) => n + d.steering.length, 0),
    },
    origins: {
      total: docs.length,
      topLevel,
      managed: docs.length - topLevel,
      rows: [...origins.values()].sort(byCountThenName((r) => r.count)),
    },
    now: {
      active: docs.filter((d) => d.workstream.status === 'active').length,
      open: openBuckets.reduce((n, bucket) => n + bucket.count, 0),
      buckets: openBuckets,
      groups: [...nowGroups.values()].sort(byCountThenName((g) => g.items.length)),
    },
    outcomes: {
      concluded: concludedCosts.length,
      rows: outcomeRows,
      doneWithoutConclusion,
      paused: docs
        .filter((d) => d.workstream.status === 'paused')
        .map((d) => ({ slug: d.workstream.slug, title: d.workstream.title, parent: parentOf(d) }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    },
    signals: {
      adoption,
      adoptionByFamily: [...familyAdoption.values()]
        .filter((row) => row.judged > 0)
        .sort((a, b) => b.judged - a.judged || a.label.localeCompare(b.label)),
      firstAttempt: {
        firstAttempt: reliability.firstAttempt,
        completed: reliability.completed,
        rate: reliability.firstAttemptRate,
        failed: reliability.failed,
      },
      merges,
      repairsOfRepairs: { count: repairsOfRepairs.length, managed: managedDocs.length, slugs: repairsOfRepairs },
      interventions: {
        count: stats.totals.interventions,
        successfulOutcomes: stats.totals.successfulOutcomes,
        perOutcome: stats.totals.interventionsPerOutcome,
        undated: stats.totals.undated,
        jobsWithIntervention: docs.filter((d) => (d.spend.humanInterventions ?? 0) > 0).length,
      },
      passes: {
        total: passHealth.completed + passHealth.providerBackoff + passHealth.logicalFailure + passHealth.conflicted + passHealth.running,
        completed: passHealth.completed,
        providerBackoff: passHealth.providerBackoff,
        logicalFailure: passHealth.logicalFailure,
      },
    },
    cost: {
      totalUsd,
      coordinatorUsd,
      workerUsd,
      coordinatorShare: totalUsd > 0 ? coordinatorUsd / totalUsd : null,
      byFamily: [...families.values()].sort((a, b) => b.totalUsd - a.totalUsd || a.label.localeCompare(b.label)),
      perOutcome: {
        count: concludedCosts.length,
        totalUsd: concludedCosts.reduce((a, b) => a + b, 0),
        medianUsd: median(concludedCosts),
      },
      byProvider,
      byBasis,
      days: firstJobAt ? daysBetween(firstJobAt, now) : 1,
      firstJobAt,
      topJobs,
    },
    examples,
  };
}

// ---------------------------------------------------------------------------
// Insights: the takeaway each section leads with

/** One takeaway sentence. `flag` marks something that looks off and deserves
 * a second look; the page renders it apart from the plain takeaways. */
export interface Insight {
  text: string;
  flag?: boolean;
}

export interface OverviewInsights {
  intro: Insight[];
  origins: Insight[];
  now: Insight[];
  outcomes: Insight[];
  signals: Insight[];
  cost: Insight[];
}

function count(value: number): string {
  return value.toLocaleString('en-GB');
}

function jobs(value: number): string {
  return `${count(value)} ${value === 1 ? 'job' : 'jobs'}`;
}

export function dollars(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString('en-GB')}`;
  return `$${value.toFixed(2)}`;
}

function percent(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a", "a and b", "a, b and c". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const FRIENDLY_DENOMINATORS = [2, 3, 4, 5, 6, 10];
const FRIENDLY_TOLERANCE = 0.02;

/**
 * A share said the way a person would say it: "all results", "about 5 in 6
 * results", "half the results", or "94% of results" when no small fraction is
 * within two percentage points. Callers put the exact numerator and
 * denominator in the same sentence, so the rounding never hides the figure.
 */
export function quantify(part: number, whole: number, noun: string): string {
  if (whole <= 0 || part <= 0) return `no ${noun}`;
  if (part >= whole) return `all ${noun}`;
  const ratio = part / whole;
  let best: { p: number; q: number; err: number } | undefined;
  for (const q of FRIENDLY_DENOMINATORS) {
    const p = Math.round(ratio * q);
    if (p <= 0 || p >= q) continue;
    const err = Math.abs(p / q - ratio);
    if (!best || err < best.err - 1e-9) best = { p, q, err };
  }
  if (best && best.err <= FRIENDLY_TOLERANCE) {
    const about = best.err < 1e-9 ? '' : 'about ';
    return best.p * 2 === best.q ? `${about}half the ${noun}` : `${about}${best.p} in ${best.q} ${noun}`;
  }
  return `${Math.round(ratio * 100)}% of ${noun}`;
}

/** One count with the right verb: "1 is waiting", "3 are waiting". */
function counted(value: number, singular: string, plural: string): string {
  return `${count(value)} ${value === 1 ? singular : plural}`;
}

function familyName(family: string | null, label: string): string {
  return family === null ? 'jobs started directly by people' : `the work under ${label}`;
}

const DISPOSITION_PHRASES: Record<Disposition, [string, string]> = {
  delivered: ['delivered something', 'delivered something'],
  no_change_needed: ['found nothing needed changing', 'found nothing needed changing'],
  not_worth_doing: ["wasn't worth doing", "weren't worth doing"],
  duplicate: ['duplicated another job', 'duplicated other jobs'],
  directed_closed: ['was closed by a person', 'were closed by a person'],
};

/** A family's rejection rate this far above the fleet's, on enough judged
 * results, is called out by name. */
const REJECTION_FLAG_MIN_JUDGED = 20;
const REJECTION_FLAG_MIN_GAP = 0.1;
const REJECTION_FLAG_MIN_RATIO = 1.5;
/** Shares of planning runs, open jobs or managed jobs worth flagging. */
const CAPACITY_FLAG_SHARE = 0.2;
const BLOCKED_FLAG_SHARE = 0.25;
const FAILURE_FLAG_SHARE = 0.1;
const REPAIR_FLAG_SHARE = 0.1;
/** A top job below this share of all spend is not called out. */
const TOP_JOB_SHARE_SHOWN = 0.05;

function introInsights(o: OverviewPayload): Insight[] {
  const { totals } = o;
  if (!totals.workstreams) return [{ text: "Weaver hasn't taken on any jobs yet." }];
  const states = [
    totals.done ? `${count(totals.done)} ${totals.done === 1 ? 'is' : 'are'} finished` : '',
    totals.active ? `${count(totals.active)} ${totals.active === 1 ? 'is' : 'are'} active` : '',
    totals.paused ? `${count(totals.paused)} ${totals.paused === 1 ? 'is' : 'are'} paused` : '',
  ].filter(Boolean);
  return [
    { text: `Weaver has taken on ${jobs(totals.workstreams)} so far and split ${totals.workstreams === 1 ? 'it' : 'them'} into ${counted(totals.assignments, 'smaller piece of work', 'smaller pieces of work')}.` },
    { text: `${capitalise(listOf(states))}.` },
  ];
}

function originInsights(o: OverviewPayload): Insight[] {
  const { total, topLevel, managed, rows } = o.origins;
  if (!total) return [{ text: 'There are no jobs yet, so nothing has started any work.' }];
  const out: Insight[] = [];
  if (!managed) {
    out.push({ text: `Every job so far was started directly by a person: ${count(topLevel)} of ${count(total)}.` });
    return out;
  }
  if (managed * 2 > total) out.push({ text: `Most jobs are started by other jobs, not by people: ${count(managed)} of ${count(total)}.` });
  else if (managed * 2 === total) out.push({ text: `Half the jobs were started by other jobs and half directly by people: ${count(managed)} each.` });
  else out.push({ text: `Most jobs were started directly by people: ${count(topLevel)} of ${count(total)}. Other jobs started the remaining ${count(managed)}.` });
  const parents = rows.filter((row) => row.parent !== null);
  if (parents.length === 1) out.push({ text: `All ${count(managed)} of those came from ${parents[0]!.label}.` });
  else if (parents.length >= 2) {
    const [a, b] = parents as [OriginRow, OriginRow];
    out.push({ text: `The jobs that started the most others are ${a.label} (${count(a.count)}) and ${b.label} (${count(b.count)}).` });
  }
  return out;
}

/** How each board bucket reads in a sentence; the tiles use the board's own
 * labels (Needs you, Blocked, Degraded, Working, Waiting, Paused). */
const BUCKET_PHRASES: Record<OpenBucket, [string, string]> = {
  'needs-you': ['needs you', 'need you'],
  blocked: ['is blocked', 'are blocked'],
  degraded: ['is running on a backup model', 'are running on a backup model'],
  working: ['is being worked on right now', 'are being worked on right now'],
  waiting: ['is waiting for its next scheduled step', 'are waiting for their next scheduled step'],
  paused: ['is paused', 'are paused'],
};

function nowInsights(o: OverviewPayload): Insight[] {
  const { open, buckets, active, groups } = o.now;
  if (!open) return [{ text: 'Nothing is open on the board right now.' }];
  const out: Insight[] = [];
  const parts = buckets.filter((bucket) => bucket.count > 0);
  const opening = `The board has ${counted(open, 'open job', 'open jobs')}.`;
  if (parts.length === 1) {
    const [singular, plural] = BUCKET_PHRASES[parts[0]!.key];
    out.push({ text: `${opening} ${open === 1 ? `It ${singular}` : `All of them ${plural}`}.` });
  } else {
    out.push({ text: `${opening} ${capitalise(listOf(parts.map((bucket) => {
      const [singular, plural] = BUCKET_PHRASES[bucket.key];
      return counted(bucket.count, singular, plural);
    })))}.` });
  }
  const needsYou = buckets.find((bucket) => bucket.key === 'needs-you')?.count ?? 0;
  const blocked = buckets.find((bucket) => bucket.key === 'blocked')?.count ?? 0;
  if (!needsYou) out.push({ text: 'Nothing needs you right now.' });
  if (blocked && blocked / open >= BLOCKED_FLAG_SHARE) {
    out.push({ text: `A lot of work is stuck: ${count(blocked)} of ${count(open)} open jobs are blocked because no model or runner can take them right now.`, flag: true });
  }
  const sorted = [...groups].sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  const [top, next] = sorted;
  if (top && next) {
    out.push({
      text: top.parent === null
        ? `Of the ${counted(active, 'active job', 'active jobs')}, the largest group, ${count(top.items.length)}, was started directly by people; ${next.label} has the next most with ${count(next.items.length)}.`
        : `The most active jobs sit under ${top.label}: ${count(top.items.length)} of ${count(active)}.`,
    });
  }
  return out;
}

function outcomeInsights(o: OverviewPayload): Insight[] {
  const { concluded, rows, doneWithoutConclusion, paused } = o.outcomes;
  const out: Insight[] = [];
  if (!concluded) out.push({ text: 'No job has finished yet.' });
  else {
    const unclassified = rows.find((row) => row.outcome === 'unclassified')?.count ?? 0;
    const classified = rows.filter((row): row is OutcomeRow & { outcome: Disposition } => row.outcome !== 'unclassified');
    const list = listOf(classified.map((row) => {
      const [singular, plural] = DISPOSITION_PHRASES[row.outcome];
      return counted(row.count, singular, plural);
    }));
    const opening = `${jobs(concluded)} ${concluded === 1 ? 'has' : 'have'} finished.`;
    if (!classified.length) {
      out.push({ text: `${opening} ${concluded === 1 ? 'It' : 'All of them'} finished before Weaver started recording how a job ended, so there is no breakdown yet.` });
    } else if (classified.length === 1 && !unclassified) {
      const [singular, plural] = DISPOSITION_PHRASES[classified[0]!.outcome];
      out.push({ text: `${opening} ${concluded === 1 ? `It ${singular}` : `All of them ${plural}`}.` });
    } else if (unclassified) {
      const lead = unclassified * 2 > concluded ? `Most of them (${count(unclassified)})` : count(unclassified);
      out.push({ text: `${opening} ${lead} finished before Weaver started recording how a job ended. Since then, ${list}.` });
    } else {
      out.push({ text: `${opening} ${capitalise(list)}.` });
    }
    const median = o.cost.perOutcome.medianUsd;
    if (median !== null && median > 0) out.push({ text: `A typical finished job cost ${dollars(median)}.` });
  }
  if (doneWithoutConclusion) {
    const one = doneWithoutConclusion === 1;
    out.push({ text: `${count(doneWithoutConclusion)} more ${one ? 'was' : 'were'} closed without saying how ${one ? 'it' : 'they'} ended.` });
  }
  if (paused.length) {
    const one = paused.length === 1;
    out.push({ text: `${jobs(paused.length)} ${one ? 'is' : 'are'} paused: a person stopped ${one ? 'it' : 'them'}, and ${one ? 'it' : 'they'} can be picked back up.` });
  }
  return out;
}

function signalInsights(o: OverviewPayload): Insight[] {
  const { adoption, adoptionByFamily, firstAttempt, interventions, passes, repairsOfRepairs, merges } = o.signals;
  const out: Insight[] = [];
  if (!adoption.judged) out.push({ text: 'Weaver has not checked any results yet.' });
  else {
    out.push({ text: `${capitalise(quantify(adoption.accepted, adoption.judged, 'results'))} were accepted when Weaver checked them: ${count(adoption.accepted)} of ${count(adoption.judged)}.` });
  }
  if (firstAttempt.completed) {
    out.push({ text: `${capitalise(quantify(firstAttempt.firstAttempt, firstAttempt.completed, 'finished pieces of work'))} succeeded on the first try: ${count(firstAttempt.firstAttempt)} of ${count(firstAttempt.completed)}.` });
  }
  const total = o.totals.workstreams;
  if (total) {
    const needed = interventions.jobsWithIntervention;
    const perJob = interventions.perOutcome === null
      ? ''
      : ` Across the fleet, a person stepped in (answering, approving, rejecting, steering or correcting) ${interventions.perOutcome.toFixed(1)} times per successfully finished job, the number Weaver is trying to push down.`;
    out.push({ text: `${capitalise(quantify(needed, total, 'jobs'))} needed a person to step in: ${count(needed)} of ${count(total)}.${perJob}` });
  }
  if (adoption.judged && adoptionByFamily.length >= 2) {
    const fleetRate = adoption.rejected / adoption.judged;
    const worst = adoptionByFamily
      .filter((row) => row.judged >= REJECTION_FLAG_MIN_JUDGED)
      .map((row) => ({ row, rate: row.rejected / row.judged }))
      .filter(({ rate }) => rate >= fleetRate + REJECTION_FLAG_MIN_GAP && rate >= fleetRate * REJECTION_FLAG_MIN_RATIO)
      .sort((a, b) => b.rate - a.rate || a.row.label.localeCompare(b.row.label))[0];
    if (worst) {
      out.push({
        text: `Rejections are higher than usual for ${familyName(worst.row.family, worst.row.label)}: ${percent(worst.row.rejected, worst.row.judged)} of their results were rejected, against ${percent(adoption.rejected, adoption.judged)} across all jobs.`,
        flag: true,
      });
    }
  }
  if (passes.total && passes.providerBackoff / passes.total >= CAPACITY_FLAG_SHARE) {
    out.push({
      text: `${capitalise(quantify(passes.providerBackoff, passes.total, 'planning runs'))} had to wait because the model provider was out of capacity: ${count(passes.providerBackoff)} of ${count(passes.total)}. That slows work down, but nothing is lost.`,
      flag: true,
    });
  }
  if (passes.total && passes.logicalFailure / passes.total >= FAILURE_FLAG_SHARE) {
    out.push({ text: `${count(passes.logicalFailure)} planning runs (${percent(passes.logicalFailure, passes.total)}) failed for reasons other than capacity.`, flag: true });
  }
  if (repairsOfRepairs.count && repairsOfRepairs.managed) {
    const share = repairsOfRepairs.count / repairsOfRepairs.managed;
    out.push({
      text: `${counted(repairsOfRepairs.count, 'job was', 'jobs were')} opened by a job that another job had opened: ${percent(repairsOfRepairs.count, repairsOfRepairs.managed)} of the jobs started by other jobs. A rising share would mean fixes are causing more fixes.`,
      ...(share >= REPAIR_FLAG_SHARE ? { flag: true } : {}),
    });
  }
  if (merges.total) {
    const rest = [
      merges.failedReadback ? `${count(merges.failedReadback)} didn't go through` : '',
      merges.notRun ? `${count(merges.notRun)} haven't run` : '',
    ].filter(Boolean);
    out.push({
      text: `Weaver tried to merge ${counted(merges.total, 'pull request', 'pull requests')}. ${count(merges.confirmed)} ${merges.confirmed === 1 ? 'was' : 'were'} confirmed merged when checked on GitHub afterwards${rest.length ? `, ${listOf(rest)}` : ''}.`,
      ...(merges.failedReadback > merges.confirmed ? { flag: true } : {}),
    });
  }
  return out;
}

function costInsights(o: OverviewPayload): Insight[] {
  const { cost } = o;
  if (cost.totalUsd <= 0) return [{ text: 'No cost has been recorded yet.' }];
  const out: Insight[] = [];
  out.push({
    text: cost.days > 1
      ? `Weaver has recorded ${dollars(cost.totalUsd)} of model cost over ${count(cost.days)} days, about ${dollars(cost.totalUsd / cost.days)} a day.`
      : `Weaver has recorded ${dollars(cost.totalUsd)} of model cost in its first day.`,
  });
  const share = cost.coordinatorShare ?? 0;
  if (share >= 0.55) out.push({ text: `Most of the spend is Weaver deciding what to do next, not the work itself: ${percent(cost.coordinatorUsd, cost.totalUsd)}.` });
  else if (share <= 0.45) out.push({ text: `Most of the spend is the work itself: ${percent(cost.workerUsd, cost.totalUsd)} went to the agents doing the jobs.` });
  else out.push({ text: 'The spend is split roughly evenly between Weaver deciding what to do next and the work itself.' });
  const [top, second] = cost.topJobs;
  if (top && second && top.totalUsd / cost.totalUsd >= TOP_JOB_SHARE_SHOWN) {
    const perDay = top.days >= 2 ? `, about ${dollars(top.perDayUsd)} a day over ${count(top.days)} days` : '';
    out.push({ text: `The single most expensive job is “${top.title}” at ${dollars(top.totalUsd)}${perDay} (${percent(top.totalUsd, cost.totalUsd)} of all spend).` });
  }
  const family = cost.byFamily.find((row) => row.family !== null && row.totalUsd > 0);
  if (family && cost.byFamily.length >= 2) {
    out.push({ text: `Of the groups of work that one job started, the group under ${family.label} costs the most: ${dollars(family.totalUsd)} (${percent(family.totalUsd, cost.totalUsd)} of the total).` });
  }
  const { cash, unknown } = cost.byBasis;
  const notional = cost.byBasis['subscription-notional'];
  if (notional > 0 && !cash && !unknown) {
    out.push({ text: 'All of it is a list-price estimate for runs covered by a subscription, not money actually spent.' });
  } else {
    const parts = [
      cash > 0 ? `${dollars(cash)} was real money, paid per use through OpenRouter.` : '',
      notional > 0 ? `${dollars(notional)} is a list-price estimate for runs covered by a subscription, not money actually spent.` : '',
      unknown > 0 ? `For ${dollars(unknown)}, Weaver doesn't know how it was billed.` : '',
    ].filter(Boolean);
    if (parts.length) out.push({ text: parts.join(' ') });
  }
  return out;
}

/**
 * The takeaway sentences each section of the overview leads with. Pure over
 * the computed payload: each sentence is chosen by a rule over the numbers
 * (a majority, a threshold, the largest row), carries the figures it rests
 * on, and is left out when the data cannot support it.
 */
export function overviewInsights(o: OverviewPayload): OverviewInsights {
  return {
    intro: introInsights(o),
    origins: originInsights(o),
    now: nowInsights(o),
    outcomes: outcomeInsights(o),
    signals: signalInsights(o),
    cost: costInsights(o),
  };
}

const EXAMPLE_ORDER: ExampleKind[] = ['delivered', 'investigated', 'corrected', 'stopped'];
/** A readable example: enough steps to show the loop, few enough to follow. */
const EXAMPLE_CLEAN_MAX_ASSIGNMENTS = 30;
const EXAMPLE_CLEAN_MAX_REJECTED_SHARE = 0.25;
const EXAMPLE_CLEAN_MAX_PASSES = 60;

function exampleKinds(doc: WorkstreamDoc): Set<ExampleKind> {
  const kinds = new Set<ExampleKind>();
  const outcome = outcomeClassOf(doc);
  if (!outcome) return kinds;
  const success = outcome === 'delivered' || outcome === 'no_change_needed' || outcome === 'unclassified';
  if (outcome === 'delivered' || (outcome === 'unclassified' && hasConfirmedMerge(doc))) kinds.add('delivered');
  if (outcome === 'no_change_needed' || (outcome === 'unclassified' && !doc.assignments.some(isMergeAction))) kinds.add('investigated');
  if (success && doc.steering.some((st) => !st.revokedAt)) kinds.add('corrected');
  if (outcome === 'not_worth_doing' || outcome === 'duplicate' || outcome === 'directed_closed') kinds.add('stopped');
  return kinds;
}

function hasConfirmedMerge(doc: WorkstreamDoc): boolean {
  return doc.assignments.some((a) => isMergeAction(a) && a.exec?.verified?.ok === true);
}

/** Few enough steps and few enough rejected results that a newcomer can
 * follow the story; a long retry-heavy run is a poor first example. */
function isCleanExample(doc: WorkstreamDoc): boolean {
  const judged = doc.assignments.filter((a) => a.adoption.state === 'accepted' || a.adoption.state === 'rejected');
  const rejected = judged.filter((a) => a.adoption.state === 'rejected').length;
  return doc.assignments.length <= EXAMPLE_CLEAN_MAX_ASSIGNMENTS
    && doc.passes.length <= EXAMPLE_CLEAN_MAX_PASSES
    && (judged.length === 0 || rejected / judged.length <= EXAMPLE_CLEAN_MAX_REJECTED_SHARE);
}

function toExample(kind: ExampleKind, chosen: WorkstreamDoc, now: Date): WorkedExample {
  const conclusion = chosen.workstream.conclusion!;
  return {
    kind,
    slug: chosen.workstream.slug,
    title: chosen.workstream.title,
    parent: parentOf(chosen),
    objective: oneLine(chosen.workstream.objective, 320),
    outcome: outcomeClassOf(chosen)!,
    concludedAt: conclusion.atVirtual,
    summary: oneLine(conclusion.summary, 600),
    assignments: chosen.assignments.length,
    actions: chosen.assignments.filter((a) => a.kind === 'action').length,
    passes: chosen.passes.length,
    steers: chosen.steering.length,
    costUsd: docCost(chosen).totalUsd,
    timeline: workstreamTimeline(chosen, { now, limit: EXAMPLE_MAX_ROWS }),
  };
}

/**
 * One worked example per way work ends — delivered (preferring a merged fix), investigated with no
 * code needed, corrected by a person, stopped without delivery — each the most
 * recent concluded workstream of that kind with at least five assignments,
 * preferring a clean one (at most 30 assignments and 60 coordinator passes, at most a
 * quarter of judged results rejected) over a merely recent one. Chosen from typed state only,
 * never by hand; a workstream appears under at most one tab.
 */
export function workedExamples(docs: WorkstreamDoc[], now: Date): WorkedExample[] {
  const recentFirst = docs
    .filter((doc) => doc.workstream.conclusion && doc.assignments.length >= EXAMPLE_MIN_ASSIGNMENTS)
    .sort((a, b) => b.workstream.conclusion!.atVirtual.localeCompare(a.workstream.conclusion!.atVirtual));
  const used = new Set<string>();
  const examples: WorkedExample[] = [];
  for (const kind of EXAMPLE_ORDER) {
    const eligible = recentFirst.filter((doc) => !used.has(doc.workstream.slug) && exampleKinds(doc).has(kind));
    // A delivered example that merged code shows the whole loop, so it is
    // preferred over one that delivered only a report.
    const chosen = (kind === 'delivered' ? eligible.find((doc) => isCleanExample(doc) && hasConfirmedMerge(doc)) : undefined)
      ?? eligible.find(isCleanExample)
      ?? eligible[0];
    if (!chosen) continue;
    used.add(chosen.workstream.slug);
    examples.push(toExample(kind, chosen, now));
  }
  return examples;
}

/**
 * One computed value per fleet revision. Callers pass the cheap revision probe
 * (heads + presence, no document bodies) and the expensive compute; while the
 * revision is unchanged every caller shares the cached value, and concurrent
 * misses share one in-flight compute, so N viewers cost one fleet load per
 * revision rather than one per request. The value is keyed by the revision the
 * compute itself observed, so a write landing mid-load is a miss next time,
 * never a stale hit.
 */
export function revisionMemo<T>(
  currentRevision: () => Promise<string>,
  compute: () => Promise<{ revision: string; value: T }>,
): () => Promise<T> {
  let cached: { revision: string; value: T } | undefined;
  let inflight: Promise<{ revision: string; value: T }> | undefined;
  return async () => {
    const revision = await currentRevision();
    if (cached && cached.revision === revision) return cached.value;
    if (!inflight) {
      inflight = compute().finally(() => {
        inflight = undefined;
      });
    }
    const next = await inflight;
    cached = next;
    return next.value;
  };
}
