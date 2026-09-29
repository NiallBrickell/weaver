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
 */

import type { PolicyRecord } from './policies.js';
import { computeStats } from './stats.js';
import { workstreamTimeline, type WorkstreamTimeline } from './timeline.js';
import type { Assignment, Attempt, PassRecord, WorkstreamDoc } from './types.js';

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
  if (provider === 'openrouter') return { basis: 'cash', label: 'OpenRouter — real spend, billed per token' };
  if (executor === 'local-sdk' || (!executor && provider === 'anthropic')) {
    return { basis: 'subscription-notional', label: 'Anthropic via the Claude SDK — notional list-price cost on a subscription' };
  }
  if (!executor && !provider) return { basis: 'unknown', label: 'Target not recorded (older records)' };
  return { basis: 'unknown', label: 'Billing basis not known to Weaver' };
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

export interface FamilyCost {
  family: string | null;
  label: string;
  workstreams: number;
  ownUsd: number;
  childrenUsd: number;
  totalUsd: number;
}

export interface WorkedExample {
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
    firstAttempt: { firstAttempt: number; completed: number; rate: number | null; failed: number };
    merges: { total: number; confirmed: number; failedReadback: number; notRun: number };
    repairsOfRepairs: { count: number; managed: number; slugs: string[] };
    interventions: { count: number; successfulOutcomes: number; perOutcome: number | null; undated: number };
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
  };
  example?: WorkedExample;
}

export const TOP_LEVEL_LABEL = 'Top level (a person or intake)';

export const OUTCOME_LABELS: Record<OutcomeClass, string> = {
  delivered: 'Delivered',
  no_change_needed: 'No change needed',
  not_worth_doing: 'Not worth doing',
  duplicate: 'Duplicate',
  directed_closed: 'Closed at a person\'s direction',
  unclassified: 'Unclassified (concluded before dispositions existed)',
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

function byCountThenName<T extends { parent: string | null; label: string }>(count: (row: T) => number) {
  return (a: T, b: T) => count(b) - count(a) || a.label.localeCompare(b.label);
}

export function computeOverview(docs: WorkstreamDoc[], policies: PolicyRecord[], now: Date): OverviewPayload {
  const bySlug = new Map(docs.map((d) => [d.workstream.slug, d]));
  const stats = computeStats(docs, policies, now);
  const managesSomething = new Set(docs.map(parentOf).filter((p): p is string => p !== null));

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

  // Now: active work grouped by parent.
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
  let assignments = 0;
  let actionAssignments = 0;
  for (const doc of docs) {
    for (const a of doc.assignments) {
      assignments += 1;
      if (a.kind === 'action') actionAssignments += 1;
      if (a.adoption.state === 'accepted') adoption.accepted += 1;
      else if (a.adoption.state === 'rejected') adoption.rejected += 1;
      else if (a.adoption.state === 'proposed') adoption.pending += 1;
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

  // Cost: family = the routine a doc belongs to. A managed doc belongs to its
  // parent; a top-level doc that manages others is its own family (a routine's
  // own passes are part of what it costs); any other top-level doc is "top level".
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

    const parent = parentOf(doc);
    const slug = doc.workstream.slug;
    const family = parent ?? (managesSomething.has(slug) ? slug : null);
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
  const example = workedExample(docs, now);
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
    },
    ...(example ? { example } : {}),
  };
}

/** The most recently concluded workstream with enough assignments to show the
 * loop at work. Chosen by typed conclusion time, never by hand. */
export function workedExample(docs: WorkstreamDoc[], now: Date): WorkedExample | undefined {
  let chosen: WorkstreamDoc | undefined;
  for (const doc of docs) {
    const conclusion = doc.workstream.conclusion;
    if (!conclusion || doc.assignments.length < EXAMPLE_MIN_ASSIGNMENTS) continue;
    if (!chosen || conclusion.atVirtual > chosen.workstream.conclusion!.atVirtual) chosen = doc;
  }
  if (!chosen) return undefined;
  const conclusion = chosen.workstream.conclusion!;
  return {
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
