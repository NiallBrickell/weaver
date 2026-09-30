/**
 * `weaver shadow-report`: per-class agreement between the real coordinator
 * and a measurement-only shadow seat, with denominators, the cost of each seat
 * on the same passes, and the passes where they disagreed. Results are grouped
 * by shadow seat AND reasoning effort, so a run at one effort never averages
 * into another. Read-only operator evidence for a promotion decision only the
 * operator makes.
 */

import type { PassUsage, ShadowMove, ShadowPassClass, ShadowPassRecord, WorkstreamDoc } from './types.js';

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
  /** Token totals over the sampled passes whose record carries usage. Effort
   * shows up first in output (thinking counts as output on Anthropic). */
  realOutputTokens: number;
  shadowOutputTokens: number;
  realCacheWriteTokens: number;
  shadowCacheWriteTokens: number;
}

/** One shadow seat at one reasoning effort. */
export interface ShadowSeatGroup {
  seat: string;
  /** Absent for a seat effort does not apply to, or a record made before
   * the effort was kept. */
  effort?: string;
  label: string;
  rows: ShadowClassRow[];
}

export interface ShadowDisagreement {
  slug: string;
  passId: string;
  passClass: ShadowPassClass;
  seat: string;
  /** The seat+effort group this pass counted in. */
  label: string;
  dimensions: string[];
  realMoves: ShadowMove[];
  shadowMoves: ShadowMove[];
}

export interface ShadowReport {
  since?: string;
  groups: ShadowSeatGroup[];
  disagreements: ShadowDisagreement[];
  failures: { slug: string; passId: string; seat: string; label: string; error: string }[];
}

function emptyRow(passClass: ShadowPassClass): ShadowClassRow {
  return {
    passClass, sampled: 0, compared: 0, errors: 0,
    adoptReject: 0, conclude: 0, raiseAttention: 0, headline: 0,
    dispatch: 0, supersede: 0, toolMultiset: 0,
    realCostUsd: 0, shadowCostUsd: 0,
    realOutputTokens: 0, shadowOutputTokens: 0, realCacheWriteTokens: 0, shadowCacheWriteTokens: 0,
  };
}

/** `seat · effort` — the grouping key and the label the report prints. */
export function shadowGroupLabel(shadow: Pick<ShadowPassRecord, 'seat' | 'effort'>): string {
  return shadow.effort ? `${shadow.seat} · effort ${shadow.effort}` : shadow.seat;
}

const money = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const tokens = (usage: PassUsage | undefined, pick: (u: PassUsage) => number) => (usage ? money(pick(usage)) : 0);

export function aggregateShadowReport(docs: readonly WorkstreamDoc[], since?: string): ShadowReport {
  const groups = new Map<string, { seat: string; effort?: string; rows: Map<ShadowPassClass, ShadowClassRow> }>();
  const disagreements: ShadowDisagreement[] = [];
  const failures: ShadowReport['failures'] = [];
  for (const doc of docs) {
    for (const pass of doc.passes) {
      const shadow = pass.shadow;
      if (!shadow) continue;
      if (since && pass.startedAt < since) continue;
      const label = shadowGroupLabel(shadow);
      let group = groups.get(label);
      if (!group) {
        group = {
          seat: shadow.seat,
          ...(shadow.effort ? { effort: shadow.effort } : {}),
          rows: new Map(SHADOW_PASS_CLASSES.map((c) => [c, emptyRow(c)])),
        };
        groups.set(label, group);
      }
      const row = group.rows.get(shadow.passClass) ?? group.rows.get('other')!;
      row.sampled += 1;
      row.realCostUsd += money(pass.costUsd);
      row.shadowCostUsd += money(shadow.costUsd);
      row.realOutputTokens += tokens(pass.usage, (u) => u.outputTokens);
      row.shadowOutputTokens += tokens(shadow.usage, (u) => u.outputTokens);
      row.realCacheWriteTokens += tokens(pass.usage, (u) => u.cacheCreationInputTokens);
      row.shadowCacheWriteTokens += tokens(shadow.usage, (u) => u.cacheCreationInputTokens);
      const slug = doc.workstream.slug;
      if (!shadow.agreement) {
        row.errors += 1;
        failures.push({ slug, passId: pass.id, seat: shadow.seat, label, error: shadow.error ?? 'no agreement recorded' });
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
          slug, passId: pass.id, passClass: shadow.passClass, seat: shadow.seat, label, dimensions,
          realMoves: shadow.realMoves, shadowMoves: shadow.moves,
        });
      }
    }
  }
  return {
    ...(since ? { since } : {}),
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, g]) => ({
        seat: g.seat,
        ...(g.effort ? { effort: g.effort } : {}),
        label,
        rows: SHADOW_PASS_CLASSES.map((c) => g.rows.get(c)!),
      })),
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
    `Seats: ${report.groups.length ? report.groups.map((g) => g.label).join(', ') : 'none recorded'}${report.since ? ` · passes since ${report.since}` : ''}`,
    '',
  ];
  if (!report.groups.length) {
    lines.push('No shadowed passes recorded. Set WEAVER_SHADOW_COORDINATOR and WEAVER_SHADOW_RATE on the runner host to sample passes.');
    return lines.join('\n');
  }
  lines.push('Per seat and effort, per pass class (agreement counts are over compared runs; failed runs have no agreement; a seat with no effort shown is one effort does not apply to, or ran before effort was recorded):');
  for (const group of report.groups) {
    lines.push('', `${group.label}:`);
    for (const r of group.rows) {
      if (!r.sampled) continue;
      lines.push(
        `- ${r.passClass}: ${r.sampled} sampled, ${r.compared} compared, ${r.errors} failed`,
        `    headline (adopt/reject + conclude + raise_attention): ${ratio(r.headline, r.compared)}`,
        `    adopt/reject ${ratio(r.adoptReject, r.compared)} · conclude ${ratio(r.conclude, r.compared)} · raise_attention ${ratio(r.raiseAttention, r.compared)}`,
        `    dispatch count ${ratio(r.dispatch, r.compared)} · supersede ${ratio(r.supersede, r.compared)} · identical tool multiset ${ratio(r.toolMultiset, r.compared)}`,
        `    cost on these passes: real $${r.realCostUsd.toFixed(2)} · shadow $${r.shadowCostUsd.toFixed(2)}`,
      );
      if (r.realOutputTokens || r.shadowOutputTokens || r.realCacheWriteTokens || r.shadowCacheWriteTokens) {
        lines.push(
          `    tokens: output real ${r.realOutputTokens} · shadow ${r.shadowOutputTokens}; cache writes real ${r.realCacheWriteTokens} · shadow ${r.shadowCacheWriteTokens}`,
        );
      }
    }
  }
  if (report.disagreements.length) {
    lines.push('', `Disagreements (${report.disagreements.length}) — read each pass to judge which seat was right:`);
    for (const d of report.disagreements) {
      lines.push(
        `- ${d.slug} ${d.passId} [${d.passClass}] on ${d.dimensions.join(', ')} (${d.label})`,
        `    real:   ${moveList(d.realMoves)}`,
        `    shadow: ${moveList(d.shadowMoves)}`,
      );
    }
  }
  if (report.failures.length) {
    lines.push('', `Failed shadow runs (${report.failures.length}):`);
    for (const f of report.failures) lines.push(`- ${f.slug} ${f.passId} (${f.label}): ${f.error}`);
  }
  lines.push('', 'Promoting a seat for any class of pass is the operator\'s decision; this report is its evidence, not its authority.');
  return lines.join('\n');
}
