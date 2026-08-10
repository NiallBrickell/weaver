/**
 * The five questions, answered from typed state — never from a transcript:
 * Now · Since you left · Needs you · Next · Why.
 */

import type { WorkstreamDoc } from './types.js';
import { virtualNow } from './clock.js';
import { infrastructureWaitSummary } from './capacity.js';

const MANAGES_SHOWN_MAX = 5;

const LINE_MAX = 300;

function clip(s: string): string {
  const oneLine = s.replace(/\s*\n\s*/g, ' ');
  return oneLine.length > LINE_MAX ? `${oneLine.slice(0, LINE_MAX - 1)}…` : oneLine;
}

function section(title: string, lines: string[], empty: string): string {
  const body = lines.length ? lines.map((l) => `  ${clip(l)}`).join('\n') : `  (${empty})`;
  return `${title}\n${body}`;
}

/** Events since the human last plausibly looked = since last resolved attention or last human act; fall back to last 2 passes. */
function sinceCutoff(doc: WorkstreamDoc): string | undefined {
  const humanActs = [
    ...doc.steering.map((s) => s.at),
    ...doc.attention.filter((a) => a.resolvedAt).map((a) => a.resolvedAt!),
    ...doc.interactions.filter((i) => i.approvedAt).map((i) => i.approvedAt!),
  ].sort();
  return humanActs[humanActs.length - 1];
}

/**
 * Operator surfaces render capacity only from the typed, deliberately-safe
 * state; wake prose is never a capacity signal.
 * One outage can produce several retry wakes; collapse identical summaries so
 * the five-question view reports the organizational position once.
 */
function infrastructureWaits(doc: WorkstreamDoc): {
  summaries: string[];
  next: string[];
} {
  const summaries = new Set<string>();
  const nextBySummary = new Map<string, string>();
  for (const entry of Object.values(doc.capacity?.byModel ?? {})) {
    const summary = infrastructureWaitSummary(entry.wait, doc.workstream.slug);
    const due = entry.wait.retryAt <= virtualNow().toISOString();
    // A wait whose retry has come due is no longer a current block, and saying
    // "work is safely parked" once it has is a lie NOW must not tell: a stored
    // wait only clears when that same model runs again (or a credential probe
    // confirms recovery), so a wait for a model the workstream has since
    // stopped using never clears and would claim the workstream is parked
    // forever — while its workers run normally on another model. What remains
    // true is stated where it belongs: NEXT carries the due reconciliation,
    // and anything needing a human is already an open NEEDS YOU item.
    if (!due) summaries.add(summary);
    const candidate = due
      ? 'infrastructure retry is due now'
      : `infrastructure retry scheduled at ${entry.wait.retryAt.slice(0, 16)}`;
    const current = nextBySummary.get(summary);
    if (!current || candidate === 'infrastructure retry is due now' || candidate < current) {
      nextBySummary.set(summary, candidate);
    }
  }
  return { summaries: [...summaries], next: [...nextBySummary.values()] };
}

/**
 * `manages` is computed by the caller (a fleet-wide `listManagedBy` scan;
 * see store.ts) and passed in so this render stays a pure function of one
 * doc, testable without a WEAVER_HOME fleet. Flat one-liners only, never a
 * tree: this workstream's own `managedBy` pointer, and its own single-level
 * `manages` list — never a manager's manager, never a managed stream's own
 * managed streams.
 */
export function renderStatus(doc: WorkstreamDoc, manages: { slug: string; status: string }[] = []): string {
  const ws = doc.workstream;
  const out: string[] = [];
  out.push(`# ${ws.title} (${ws.slug}) — ${ws.status}`);
  out.push(`Objective: ${ws.objective}`);
  out.push(
    `Virtual now: ${virtualNow().toISOString()} · revision ${doc.revision} · ` +
      `${doc.spend.coordinatorPasses}/${ws.budget.maxCoordinatorPasses} passes · $${doc.spend.totalCostUsd.toFixed(2)}/$${ws.budget.maxCostUsd.toFixed(2)} · ${doc.spend.humanInterventions ?? 0} human interventions`,
  );
  if (ws.managedBy) {
    out.push(`Managed by: ${ws.managedBy.slug} (since ${ws.managedBy.sinceVirtual.slice(0, 16)})`);
  }
  if (manages.length) {
    const shown = manages.slice(0, MANAGES_SHOWN_MAX).map((m) => `${m.slug} (${m.status})`).join(', ');
    const more = manages.length > MANAGES_SHOWN_MAX ? ` +${manages.length - MANAGES_SHOWN_MAX} more` : '';
    out.push(`Manages: ${manages.length} workstream(s): ${shown}${more}`);
  }
  out.push('');

  // NOW
  const running = doc.assignments.filter((a) => a.state === 'running');
  const queued = doc.assignments.filter((a) => a.state === 'queued');
  const awaiting = doc.assignments.filter((a) => a.state === 'awaiting_review');
  const pendingWakes = doc.wakes.filter((w) => w.status === 'pending');
  const normalWakes = pendingWakes.filter((w) => !w.infrastructure);
  const recoveredCapacityWakes = pendingWakes.filter(
    (wake) => wake.infrastructure && !doc.capacity?.byModel[wake.infrastructure.model],
  );
  const infrastructure = infrastructureWaits(doc);
  const nowVirtual = virtualNow().toISOString();
  const nowLines = [
    ...infrastructure.summaries.map((summary) => `WAITING — ${summary}`),
    ...recoveredCapacityWakes
      .filter((wake) => wake.condition.type === 'immediate' || wake.condition.dueAtVirtual <= nowVirtual)
      .map(() => 'READY — Claude capacity recovered; reconciliation is due now'),
    ...running.map((a) => `working: ${a.id} "${a.objective}"`),
    ...queued.map((a) => `queued: ${a.id} "${a.objective}"`),
    ...awaiting.map((a) => `awaiting review: ${a.id} "${a.objective}"`),
    ...doc.interactions
      .filter((i) => ['approved', 'sent', 'unknown'].includes(i.status))
      .map((i) => `interaction ${i.id} [${i.status}] "${i.subject}" → ${i.to}`),
  ];
  out.push(section('## Now', nowLines, 'idle — waiting on wakes'));
  out.push('');

  // SINCE YOU LEFT
  const cutoff = sinceCutoff(doc);
  const since = (cutoff ? doc.events.filter((e) => e.at > cutoff) : doc.events).slice(-15);
  out.push(
    section(
      '## Since you left',
      since.map((e) => `[${e.atVirtual.slice(0, 16)}] ${e.summary}`),
      'nothing new',
    ),
  );
  out.push('');

  // NEEDS YOU
  const needs = doc.attention.filter((a) => a.status === 'open');
  out.push(
    section(
      '## Needs you',
      needs.map((a) => `${a.id} [${a.kind}] ${a.summary}`),
      'nothing — the workstream can proceed without you',
    ),
  );
  out.push('');

  // NEXT
  const nextLines = [
    ...infrastructure.next,
    ...recoveredCapacityWakes.map((wake) =>
      wake.condition.type === 'time' && wake.condition.dueAtVirtual > nowVirtual
        ? `capacity recovery wake at ${wake.condition.dueAtVirtual.slice(0, 16)}`
        : 'capacity recovery reconciliation is due now',
    ),
    ...normalWakes.map((w) =>
      w.condition.type === 'time'
        ? `wake at ${w.condition.dueAtVirtual.slice(0, 16)}: ${w.reason}`
        : `wake (immediate): ${w.reason}`,
    ),
    ...queued.map((a) => `worker will run: ${a.id}`),
    ...doc.interactions
      .filter((i) => i.status === 'awaiting_approval')
      .map((i) => `blocked on your approval: send ${i.id} "${i.subject}"`),
  ];
  out.push(section('## Next', nextLines, 'nothing scheduled — the workstream is dormant'));
  out.push('');

  // WHY
  const standing = doc.decisions.filter((d) => d.status === 'standing');
  const adopted = doc.deliverables.filter((d) => d.adopted);
  const evaluated = [
    ...doc.interactions.flatMap((i) =>
      i.replies
        .filter((r) => r.evaluation)
        .map(
          (r) =>
            `reply on ${i.id}: ${r.evaluation!.countsTowardObjective ? 'counts' : "doesn't count"} — ${r.evaluation!.note}`,
        ),
    ),
    ...doc.observations
      .filter((o) => o.evaluation)
      .map((o) => `observation ${o.id}: ${o.evaluation!.note}`),
  ];
  // Bounded like the projection: the five-questions view answers "why this
  // course" from the current commitments, not the whole history. Full lineage
  // lives in [i]/printout. Rationale is excerpted; only recent adopted products
  // are listed (older ones stay pinned and inspectable).
  const whyExcerpt = (s: string): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? `${flat.slice(0, 200).trimEnd()}…` : flat;
  };
  const recentAdopted = adopted.slice(-8);
  const whyLines = [
    ...standing.map(
      (d) => `decision ${d.id}: "${d.title}" — ${whyExcerpt(d.rationale)}${d.supersedes ? ` (supersedes ${d.supersedes})` : ''}`,
    ),
    ...(adopted.length > recentAdopted.length
      ? [`(+${adopted.length - recentAdopted.length} earlier adopted products — see [i])`]
      : []),
    ...recentAdopted.map((d) => `adopted ${d.id}: "${d.title}" (pinned ${d.adopted!.contentHash.slice(0, 8)})`),
    ...evaluated,
  ];
  out.push(section('## Why (current course, from lineage)', whyLines, 'no commitments yet'));

  return out.join('\n');
}
