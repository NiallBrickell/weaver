/**
 * `weaver shadow-report`: per-class agreement between the real coordinator
 * and a measurement-only shadow seat, with denominators, the cost of each seat
 * on the same passes, and the passes where they disagreed. Read-only operator
 * evidence for a promotion decision only the operator makes.
 */

import type { ShadowMove, ShadowPassClass, WorkstreamDoc } from './types.js';

export const SHADOW_PASS_CLASSES: readonly ShadowPassClass[] = [
  'verify-then-dispatch',
  'dispatch-only',
  'wait-only',
  'conclude',
  'other',
];

export interface ShadowClassRow {
  passClass: ShadowPassClass;
  /** Shadow runs recorded for this class, including failed ones. */
  sampled: number;
  /** Runs that completed and therefore have an agreement. */
  compared: number;
  errors: number;
  adoptReject: number;
  conclude: number;
  raiseAttention: number;
  headline: number;
  dispatch: number;
  supersede: number;
  toolMultiset: number;
  realCostUsd: number;
  shadowCostUsd: number;
}

export interface ShadowDisagreement {
  slug: string;
  passId: string;
  passClass: ShadowPassClass;
  seat: string;
  dimensions: string[];
  realMoves: ShadowMove[];
  shadowMoves: ShadowMove[];
}

export interface ShadowReport {
  since?: string;
  seats: string[];
  rows: ShadowClassRow[];
  disagreements: ShadowDisagreement[];
  failures: { slug: string; passId: string; seat: string; error: string }[];
}

function emptyRow(passClass: ShadowPassClass): ShadowClassRow {
  return {
    passClass, sampled: 0, compared: 0, errors: 0,
    adoptReject: 0, conclude: 0, raiseAttention: 0, headline: 0,
    dispatch: 0, supersede: 0, toolMultiset: 0,
    realCostUsd: 0, shadowCostUsd: 0,
  };
}

const money = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function aggregateShadowReport(docs: readonly WorkstreamDoc[], since?: string): ShadowReport {
  const rows = new Map(SHADOW_PASS_CLASSES.map((c) => [c, emptyRow(c)]));
  const seats = new Set<string>();
  const disagreements: ShadowDisagreement[] = [];
  const failures: ShadowReport['failures'] = [];
  for (const doc of docs) {
    for (const pass of doc.passes) {
      const shadow = pass.shadow;
      if (!shadow) continue;
      if (since && pass.startedAt < since) continue;
      seats.add(shadow.seat);
      const row = rows.get(shadow.passClass) ?? rows.get('other')!;
      row.sampled += 1;
      row.realCostUsd += money(pass.costUsd);
      row.shadowCostUsd += money(shadow.costUsd);
      const slug = doc.workstream.slug;
      if (!shadow.agreement) {
        row.errors += 1;
        failures.push({ slug, passId: pass.id, seat: shadow.seat, error: shadow.error ?? 'no agreement recorded' });
        continue;
      }
      const a = shadow.agreement;
      row.compared += 1;
      if (a.adoptReject.agree) row.adoptReject += 1;
      if (a.conclude.agree) row.conclude += 1;
      if (a.raiseAttention.agree) row.raiseAttention += 1;
      if (a.headline) row.headline += 1;
      if (a.dispatch.agree) row.dispatch += 1;
      if (a.supersede.agree) row.supersede += 1;
      if (a.toolMultiset) row.toolMultiset += 1;
      const dimensions = [
        ...(a.adoptReject.agree ? [] : ['adopt/reject']),
        ...(a.conclude.agree ? [] : ['conclude']),
        ...(a.raiseAttention.agree ? [] : ['raise_attention']),
        ...(a.dispatch.agree ? [] : ['dispatch']),
        ...(a.supersede.agree ? [] : ['supersede']),
      ];
      if (dimensions.length) {
        disagreements.push({
          slug, passId: pass.id, passClass: shadow.passClass, seat: shadow.seat, dimensions,
          realMoves: shadow.realMoves, shadowMoves: shadow.moves,
        });
      }
    }
  }
  return {
    ...(since ? { since } : {}),
    seats: [...seats].sort(),
    rows: SHADOW_PASS_CLASSES.map((c) => rows.get(c)!),
    disagreements,
    failures,
  };
}

function ratio(n: number, d: number): string {
  return d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : '—';
}

function moveList(moves: readonly ShadowMove[]): string {
  if (!moves.length) return '(no moves)';
  return moves.map((m) => (m.targets.length ? `${m.tool}(${m.targets.join(',')})` : m.tool)).join(' ');
}

export function renderShadowReport(report: ShadowReport): string {
  const lines: string[] = [
    'Shadow coordinator report — measurement only; a shadow seat never coordinates.',
    `Seats: ${report.seats.length ? report.seats.join(', ') : 'none recorded'}${report.since ? ` · passes since ${report.since}` : ''}`,
    '',
  ];
  const total = report.rows.reduce((n, r) => n + r.sampled, 0);
  if (!total) {
    lines.push('No shadowed passes recorded. Set WEAVER_SHADOW_COORDINATOR and WEAVER_SHADOW_RATE on the runner host to sample passes.');
    return lines.join('\n');
  }
  lines.push('Per pass class (agreement counts are over compared runs; failed runs have no agreement):');
  for (const r of report.rows) {
    if (!r.sampled) continue;
    lines.push(
      `- ${r.passClass}: ${r.sampled} sampled, ${r.compared} compared, ${r.errors} failed`,
      `    headline (adopt/reject + conclude + raise_attention): ${ratio(r.headline, r.compared)}`,
      `    adopt/reject ${ratio(r.adoptReject, r.compared)} · conclude ${ratio(r.conclude, r.compared)} · raise_attention ${ratio(r.raiseAttention, r.compared)}`,
      `    dispatch count ${ratio(r.dispatch, r.compared)} · supersede ${ratio(r.supersede, r.compared)} · identical tool multiset ${ratio(r.toolMultiset, r.compared)}`,
      `    cost on these passes: real $${r.realCostUsd.toFixed(2)} · shadow $${r.shadowCostUsd.toFixed(2)}`,
    );
  }
  if (report.disagreements.length) {
    lines.push('', `Disagreements (${report.disagreements.length}) — read each pass to judge which seat was right:`);
    for (const d of report.disagreements) {
      lines.push(
        `- ${d.slug} ${d.passId} [${d.passClass}] on ${d.dimensions.join(', ')} (${d.seat})`,
        `    real:   ${moveList(d.realMoves)}`,
        `    shadow: ${moveList(d.shadowMoves)}`,
      );
    }
  }
  if (report.failures.length) {
    lines.push('', `Failed shadow runs (${report.failures.length}):`);
    for (const f of report.failures) lines.push(`- ${f.slug} ${f.passId} (${f.seat}): ${f.error}`);
  }
  lines.push('', 'Promoting a seat for any class of pass is the operator\'s decision; this report is its evidence, not its authority.');
  return lines.join('\n');
}
