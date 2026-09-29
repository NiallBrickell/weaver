/**
 * One workstream's history as a readable timeline — the shared model behind
 * the workstream page's default Timeline tab and the overview's worked example.
 *
 * Pure over typed state, like `computeOverview`. It never reads `doc.events`
 * (a bounded tail that silently loses old history) and never reads a
 * transcript: every row is a typed record — an Assignment with its adoption,
 * a Decision with its lineage, a human act with its actor, the conclusion with
 * its disposition. The only derived rows are presentation over those records:
 * a quiet gap between two of them, and a run of retried assignments folded
 * into one row. Neither can change what the records say.
 *
 * Timestamps mix the organizational clock (`*AtVirtual`) with wall time
 * (steering, attention, approvals). Outside a demo that has advanced the
 * virtual clock they are the same clock; the Activity tab already orders
 * them together on the same basis.
 */

import { dispositionLabel, dispositionOf, isSuccessfulConclusion } from './conclusion.js';
import { describeEgressGate } from './egressGate.js';
import type { Assignment, ConclusionDisposition, Decision, Wake, WorkstreamDoc } from './types.js';

/** A quiet stretch at least this long between two rows gets its own row. */
export const GAP_THRESHOLD_MS = 6 * 60 * 60 * 1000;
/** Rows shown by default; `all` lifts it. Routines run to hundreds of rows. */
export const DEFAULT_TIMELINE_LIMIT = 60;
/** How far past a gap's end a covering wake may have been due (pass latency). */
const WAKE_DUE_SLACK_MS = 30 * 60 * 1000;
const SUMMARY_CHARS = 160;

/** The grouping rule, stated once so the page caption and the docs agree. */
export const RETRY_RULE =
  'Consecutive assignments of the same kind, with nothing else recorded between them, fold into one row when every one before the last was rejected or failed.';

export interface TimelineAssignment {
  id: string;
  /** Stored kind as written — legacy docs carry research/work_product/…; only `action` has runtime teeth. */
  kind: string;
  at: string;
  objective: string;
  /** One line, truncated; equal to `objective` when nothing was cut. */
  summary: string;
  truncated: boolean;
  state: Assignment['state'];
  adoption: Assignment['adoption']['state'];
  attempts: number;
  /** The disposable target pinned on the most recent attempt. */
  lastTarget?: { executor?: string; provider?: string; model?: string };
  /** Why the engine's repo-egress gate routed this act to a person — from
   * the typed gate on the action, never from prose. */
  needsPerson?: string;
}

export type TimelineEntry =
  | { type: 'assignment'; key: string; at: string; assignment: TimelineAssignment }
  | {
      type: 'retries';
      key: string;
      at: string;
      endAt: string;
      kind: string;
      steps: TimelineAssignment[];
      rejected: number;
      failed: number;
      /** How the last one in the run ended, as its adoption or state. */
      finalOutcome: string;
    }
  | {
      type: 'decision';
      key: string;
      at: string;
      id: string;
      title: string;
      rationale: string;
      madeBy: Decision['madeBy'];
      status: Decision['status'];
      supersedes?: { id: string; title: string };
      supersededBy?: { id: string; title: string };
      closedReason?: string;
    }
  | { type: 'cycle'; key: string; at: string; decisionId: string; decisionTitle: string; cycle: number; label: string }
  | { type: 'steer'; key: string; at: string; id: string; body: string; summary: string; truncated: boolean; by?: string; read: boolean; withdrawn?: { at: string; by?: string } }
  | {
      type: 'verdict';
      key: string;
      at: string;
      /** What was judged: a gated action, an outbound send, or a worker's result. */
      on: 'action' | 'send' | 'result';
      verdict: 'approved' | 'rejected' | 'accepted';
      by: string;
      subject: string;
      note?: string;
    }
  | { type: 'attention'; key: string; at: string; id: string; phase: 'asked' | 'resolved'; attentionKind: string; summary: string; by?: string }
  | {
      type: 'conclusion';
      key: string;
      at: string;
      summary: string;
      disposition: ConclusionDisposition | 'unclassified';
      dispositionLabel: string;
      successful: boolean;
      evidence: number;
    }
  | {
      type: 'gap';
      key: string;
      at: string;
      endAt: string;
      ms: number;
      label: string;
      /** Reason of the time wake that covered the gap, when typed wake data shows one. */
      reason?: string;
      /** The workstream is still waiting now: the gap runs to the present. */
      ongoing?: boolean;
    };

export interface WorkstreamTimeline {
  slug: string;
  entries: TimelineEntry[];
  /** Non-gap rows left out by the default limit (0 when showing all). */
  omitted: number;
  /** Non-gap rows in the full timeline. */
  total: number;
}

export interface TimelineOptions {
  /** Organizational now: closes an ongoing wait on a workstream that is not done. */
  now: Date;
  /** Most recent N non-gap rows; `'all'` for every row. Default 60. */
  limit?: number | 'all';
}

function oneLine(text: string, max = SUMMARY_CHARS): { summary: string; truncated: boolean } {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return { summary: line, truncated: line !== text.trim() };
  return { summary: `${line.slice(0, max - 1).trimEnd()}…`, truncated: true };
}

function ms(at: string | undefined): number {
  return at ? Date.parse(at) : Number.NaN;
}

/** "2d 4h", "7h 30m", "6h". Whole minutes; days drop minutes. */
export function formatWait(duration: number): string {
  const minutes = Math.floor(duration / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function timelineAssignment(a: Assignment): TimelineAssignment {
  const { summary, truncated } = oneLine(a.objective);
  const last = a.attempts.at(-1);
  const lastTarget = last && (last.executor || last.provider || last.model)
    ? { ...(last.executor ? { executor: last.executor } : {}), ...(last.provider ? { provider: last.provider } : {}), ...(last.model ? { model: last.model } : {}) }
    : undefined;
  return {
    id: a.id,
    kind: a.kind,
    at: a.createdAtVirtual,
    objective: a.objective,
    summary,
    truncated,
    state: a.state,
    adoption: a.adoption.state,
    attempts: a.attempts.length,
    ...(lastTarget ? { lastTarget } : {}),
    ...(a.exec?.egressGate?.reasons.length ? { needsPerson: describeEgressGate(a.exec.egressGate.reasons) } : {}),
  };
}

/** Rejected by adoption, or failed as work: the only typed signals that the
 * next same-kind assignment is a retry. The schema has no explicit
 * retry/supersedes link between assignments, so nothing stronger exists. */
function isRetried(a: TimelineAssignment): boolean {
  return a.adoption === 'rejected' || a.state === 'failed';
}

function finalOutcome(a: TimelineAssignment): string {
  if (a.adoption !== 'none') return a.adoption;
  return a.state.replaceAll('_', ' ');
}

/** Order within one instant: what was decided before what was dispatched on
 * it, and the conclusion last. */
const TYPE_ORDER: Record<TimelineEntry['type'], number> = {
  steer: 0, attention: 1, verdict: 2, decision: 3, cycle: 4, assignment: 5, retries: 5, conclusion: 9, gap: 10,
};

function rawEntries(doc: WorkstreamDoc): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const decisionsById = new Map(doc.decisions.map((d) => [d.id, d]));
  const ref = (id: string | undefined) => {
    if (!id) return undefined;
    return { id, title: decisionsById.get(id)?.title ?? id };
  };

  for (const a of doc.assignments) {
    out.push({ type: 'assignment', key: `a:${a.id}`, at: a.createdAtVirtual, assignment: timelineAssignment(a) });
    const subject = oneLine(a.objective).summary;
    const approval = a.exec?.approval;
    // Pilot approvals are the operator's standing policy, not an act at the
    // keyboard; they show on the action row's state rather than as a human act.
    if (approval && approval.by === 'human') {
      out.push({
        type: 'verdict', key: `v:${a.id}:approved`, at: approval.at, on: 'action', verdict: 'approved',
        by: approval.actor ?? 'human', subject, ...(approval.note ? { note: approval.note } : {}),
      });
    }
    const rejection = a.exec?.rejection;
    if (rejection) {
      out.push({ type: 'verdict', key: `v:${a.id}:rejected`, at: rejection.at, on: 'action', verdict: 'rejected', by: rejection.actor, subject, note: rejection.reason });
    }
    // A human adoption override carries its own actor and time; a coordinator
    // adoption is part of the assignment row, not a separate act.
    if (a.adoption.actor && a.adoption.at && (a.adoption.state === 'accepted' || a.adoption.state === 'rejected')) {
      out.push({
        type: 'verdict', key: `v:${a.id}:adoption`, at: a.adoption.at, on: 'result',
        verdict: a.adoption.state === 'accepted' ? 'accepted' : 'rejected',
        by: a.adoption.actor, subject, ...(a.adoption.reason ? { note: a.adoption.reason } : {}),
      });
    }
  }

  for (const d of doc.decisions) {
    const supersedes = ref(d.supersedes);
    const supersededBy = ref(d.supersededBy);
    out.push({
      type: 'decision', key: `d:${d.id}`, at: d.decidedAtVirtual, id: d.id, title: d.title, rationale: d.rationale,
      madeBy: d.madeBy, status: d.status,
      ...(supersedes ? { supersedes } : {}),
      ...(supersededBy ? { supersededBy } : {}),
      ...(d.closedReason ? { closedReason: d.closedReason } : {}),
    });
    // Progress is overwritten in place, so only the latest cycle's start is
    // typed; earlier boundaries live in printouts, which this never reads.
    if (d.progress && d.progress.cycle > 1) {
      out.push({
        type: 'cycle', key: `c:${d.id}:${d.progress.cycle}`, at: d.progress.cycleStartedAtVirtual,
        decisionId: d.id, decisionTitle: d.title, cycle: d.progress.cycle, label: d.progress.label,
      });
    }
  }

  for (const s of doc.steering) {
    const { summary, truncated } = oneLine(s.body);
    out.push({
      type: 'steer', key: `s:${s.id}`, at: s.at, id: s.id, body: s.body, summary, truncated,
      ...(s.by ? { by: s.by } : {}),
      read: !!s.consumedByPass,
      ...(s.revokedAt ? { withdrawn: { at: s.revokedAt, ...(s.revokedBy ? { by: s.revokedBy } : {}) } } : {}),
    });
  }

  for (const i of doc.interactions) {
    const subject = `${i.subject} → ${i.to}`;
    if (i.approvedAt) {
      out.push({ type: 'verdict', key: `v:${i.id}:approved`, at: i.approvedAt, on: 'send', verdict: 'approved', by: i.approvedByActor ?? i.approvedBy ?? 'human', subject });
    }
    if (i.rejectedAt) {
      out.push({ type: 'verdict', key: `v:${i.id}:rejected`, at: i.rejectedAt, on: 'send', verdict: 'rejected', by: i.rejectedBy ?? 'human', subject });
    }
  }

  for (const item of doc.attention) {
    const summary = oneLine(item.summary).summary;
    out.push({ type: 'attention', key: `n:${item.id}:asked`, at: item.createdAt, id: item.id, phase: 'asked', attentionKind: item.kind, summary });
    if (item.status === 'resolved' && item.resolvedAt) {
      out.push({
        type: 'attention', key: `n:${item.id}:resolved`, at: item.resolvedAt, id: item.id, phase: 'resolved', attentionKind: item.kind, summary,
        ...(item.resolvedBy ? { by: item.resolvedBy } : item.resolution ? { by: item.resolution.by } : {}),
      });
    }
  }

  const conclusion = doc.workstream.conclusion;
  if (conclusion) {
    out.push({
      type: 'conclusion', key: `z:${conclusion.passId}`, at: conclusion.atVirtual, summary: conclusion.summary,
      disposition: dispositionOf(conclusion), dispositionLabel: dispositionLabel(conclusion),
      successful: isSuccessfulConclusion(conclusion), evidence: conclusion.evidenceIds.length,
    });
  }

  return out
    .filter((e) => Number.isFinite(ms(e.at)))
    .sort((a, b) => ms(a.at) - ms(b.at) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.key.localeCompare(b.key));
}

/** Fold runs of retried assignments. A run is broken by any other row, by a
 * different kind, or by a member before the last that was not rejected/failed. */
function collapseRetries(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let run: TimelineAssignment[] = [];
  const flush = () => {
    if (run.length === 1) {
      out.push({ type: 'assignment', key: `a:${run[0]!.id}`, at: run[0]!.at, assignment: run[0]! });
    } else if (run.length > 1) {
      const last = run.at(-1)!;
      out.push({
        type: 'retries',
        key: `r:${run[0]!.id}`,
        at: run[0]!.at,
        endAt: last.at,
        kind: last.kind,
        steps: run,
        rejected: run.filter((a) => a.adoption === 'rejected').length,
        failed: run.filter((a) => a.state === 'failed' && a.adoption !== 'rejected').length,
        finalOutcome: finalOutcome(last),
      });
    }
    run = [];
  };
  for (const entry of entries) {
    if (entry.type !== 'assignment') {
      flush();
      out.push(entry);
      continue;
    }
    const a = entry.assignment;
    const prev = run.at(-1);
    if (prev && prev.kind === a.kind && isRetried(prev)) {
      run.push(a);
    } else {
      flush();
      run = [a];
    }
  }
  flush();
  return out;
}

function endOf(entry: TimelineEntry): number {
  return entry.type === 'retries' || entry.type === 'gap' ? ms(entry.endAt) : ms(entry.at);
}

function wakeDue(wake: Wake): number {
  if (wake.condition.type === 'time') return ms(wake.condition.dueAtVirtual);
  if (wake.condition.type === 'wall_time') return ms(wake.condition.dueAt);
  return Number.NaN;
}

/** The time wake that covered a quiet stretch: created before it ended and
 * due inside it (allowing for the pass that answered it to start a little
 * late). The latest-due one is the wait that actually ended the quiet. */
function coveringWake(doc: WorkstreamDoc, start: number, end: number, ongoing: boolean): Wake | undefined {
  let best: { wake: Wake; due: number } | undefined;
  for (const wake of doc.wakes) {
    if (wake.status === 'cancelled') continue;
    const due = wakeDue(wake);
    if (!Number.isFinite(due) || !(ms(wake.createdAt) <= end)) continue;
    if (ongoing) {
      // Still waiting: the pending wake that will end it, soonest first.
      if (wake.status !== 'pending') continue;
      if (!best || due < best.due) best = { wake, due };
      continue;
    }
    if (due <= start || due > end + WAKE_DUE_SLACK_MS) continue;
    if (!best || due > best.due) best = { wake, due };
  }
  return best?.wake;
}

function gapEntry(doc: WorkstreamDoc, start: number, end: number, ongoing: boolean): TimelineEntry {
  const wake = coveringWake(doc, start, end, ongoing);
  const at = new Date(start).toISOString();
  return {
    type: 'gap',
    key: `g:${at}`,
    at,
    endAt: new Date(end).toISOString(),
    ms: end - start,
    label: formatWait(end - start),
    ...(wake ? { reason: wake.reason } : {}),
    ...(ongoing ? { ongoing: true } : {}),
  };
}

function withGaps(doc: WorkstreamDoc, entries: TimelineEntry[], now: Date): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let lastEnd = Number.NaN;
  for (const entry of entries) {
    const start = ms(entry.at);
    if (Number.isFinite(lastEnd) && start - lastEnd >= GAP_THRESHOLD_MS) out.push(gapEntry(doc, lastEnd, start, false));
    out.push(entry);
    lastEnd = Number.isFinite(lastEnd) ? Math.max(lastEnd, endOf(entry)) : endOf(entry);
  }
  if (doc.workstream.status !== 'done' && Number.isFinite(lastEnd) && now.getTime() - lastEnd >= GAP_THRESHOLD_MS) {
    out.push(gapEntry(doc, lastEnd, now.getTime(), true));
  }
  return out;
}

export function workstreamTimeline(doc: WorkstreamDoc, opts: TimelineOptions): WorkstreamTimeline {
  const entries = withGaps(doc, collapseRetries(rawEntries(doc)), opts.now);
  const total = entries.filter((e) => e.type !== 'gap').length;
  const limit = opts.limit ?? DEFAULT_TIMELINE_LIMIT;
  if (limit === 'all' || total <= limit) return { slug: doc.workstream.slug, entries, omitted: 0, total };
  // Keep the most recent `limit` real rows; a gap only survives between two kept rows.
  let kept = 0;
  let cut = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.type === 'gap') continue;
    if (kept === limit) break;
    kept += 1;
    cut = i;
  }
  return { slug: doc.workstream.slug, entries: entries.slice(cut), omitted: total - limit, total };
}
