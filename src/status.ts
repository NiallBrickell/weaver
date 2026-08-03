/**
 * The five questions, answered from typed state — never from a transcript:
 * Now · Since you left · Needs you · Next · Why.
 */

import type { WorkstreamDoc } from './types.js';
import { virtualNow } from './clock.js';

function section(title: string, lines: string[], empty: string): string {
  const body = lines.length ? lines.map((l) => `  ${l}`).join('\n') : `  (${empty})`;
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

export function renderStatus(doc: WorkstreamDoc): string {
  const ws = doc.workstream;
  const out: string[] = [];
  out.push(`# ${ws.title} (${ws.slug}) — ${ws.status}`);
  out.push(`Objective: ${ws.objective}`);
  out.push(
    `Virtual now: ${virtualNow().toISOString()} · revision ${doc.revision} · ` +
      `${doc.spend.coordinatorPasses}/${ws.budget.maxCoordinatorPasses} passes · $${doc.spend.totalCostUsd.toFixed(2)}/$${ws.budget.maxCostUsd.toFixed(2)}`,
  );
  out.push('');

  // NOW
  const running = doc.assignments.filter((a) => a.state === 'running');
  const queued = doc.assignments.filter((a) => a.state === 'queued');
  const awaiting = doc.assignments.filter((a) => a.state === 'awaiting_review');
  const pendingWakes = doc.wakes.filter((w) => w.status === 'pending');
  const nowLines = [
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
    ...pendingWakes.map((w) =>
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
  const whyLines = [
    ...standing.map(
      (d) => `decision ${d.id}: "${d.title}" — ${d.rationale}${d.supersedes ? ` (supersedes ${d.supersedes})` : ''}`,
    ),
    ...adopted.map((d) => `adopted ${d.id}: "${d.title}" (pinned ${d.adopted!.contentHash.slice(0, 8)})`),
    ...evaluated,
  ];
  out.push(section('## Why (current course, from lineage)', whyLines, 'no commitments yet'));

  return out.join('\n');
}
