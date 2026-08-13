/**
 * weaver inspect — the knowledge/decision inspector.
 *
 * Renders the KNOWLEDGE layer of a workstream (decision lineage, learned
 * policies, human-intervention density, adoption state, action audit) as one
 * self-contained static HTML file: no server, no CDN, all CSS/JS inline, the
 * supersession graph hand-rolled as SVG. `weaver watch` is the ops view; this
 * is "git history for real-world work" — why the current course is the
 * current course, who set it, and what it replaced.
 *
 * Everything here is READ-ONLY over typed state via the store helpers (load /
 * listWorkstreams / loadPolicies). Nothing is parsed out of transcripts and
 * nothing is invented: an empty section renders honestly as empty. The
 * rendered HTML passes through redactSecrets before it touches disk — the
 * inspector is an output surface like any other and gets the same lens.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { compactAge } from './activity.js';
import { virtualNow } from './clock.js';
import type { PolicyRecord } from './policies.js';
import { loadPolicies } from './policies.js';
import { writePrintoutIndex } from './printoutHtml.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import { listManagedBy, listWorkstreams, load, weaverHome, workstreamDir } from './store.js';
import type { Assignment, Decision, Deliverable, EventRecord, WorkstreamDoc } from './types.js';
import { isLegacyDollarBudgetAttention } from './executionSafety.js';
import type { InspectViewed } from './inspectViewed.js';
import { readInspectViewed, writeInspectViewed } from './inspectViewed.js';

// ---------------------------------------------------------------------------
// Helpers

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function shortHash(h: string): string {
  return h.slice(0, 8);
}

function fmtVirtual(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function empty(msg: string): string {
  return `<p class="empty">${esc(msg)}</p>`;
}

/** First line of a stored summary, clipped — a row is a glance, not the record. */
function firstLine(s: string, max: number): string {
  const line = s.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * How long until a scheduled wake fires, in the TUI board's vocabulary. Takes
 * a duration rather than a timestamp because a wake may be dated on either
 * clock, and the remaining time is the only thing the two have in common.
 */
function untilLabel(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (24 * 60))}d`;
}

/** Long lists are windowed, and the remainder is counted rather than dropped. */
function cappedList(cls: string, rows: string[], max = 20): string {
  const shown = rows.slice(0, max);
  const more = rows.length - shown.length;
  return `<ul class="${cls}">${shown.join('')}${more ? `<li class="empty">+${more} more</li>` : ''}</ul>`;
}

// ---------------------------------------------------------------------------
// 1. Decision lineage graph (hand-rolled SVG — the centerpiece)

/**
 * Group decisions into supersession chains: each chain starts at a root (a
 * decision that supersedes nothing we know of) and follows supersededBy links.
 * Chains render as rows, oldest → newest left to right, so a reader scans a
 * row the way they'd scan `git log` for one line of direction.
 */
function buildChains(decisions: Decision[]): Decision[][] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const roots = decisions
    .filter((d) => !d.supersedes || !byId.has(d.supersedes))
    .sort((a, b) => a.decidedAtVirtual.localeCompare(b.decidedAtVirtual));
  const seen = new Set<string>();
  const chains: Decision[][] = [];
  for (const root of roots) {
    const chain: Decision[] = [];
    let cur: Decision | undefined = root;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.supersededBy ? byId.get(cur.supersededBy) : undefined;
    }
    if (chain.length) chains.push(chain);
  }
  // Defensive: anything unreachable (broken lineage) still gets shown.
  for (const d of decisions) {
    if (!seen.has(d.id)) chains.push([d]);
  }
  return chains;
}

function wrapText(s: string, width: number, maxLines: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1]!.slice(0, width - 1) + '…';
  }
  return lines;
}

function decisionGraphSvg(decisions: Decision[]): string {
  if (!decisions.length) return '';
  const chains = buildChains(decisions);
  const W = 250;
  const H = 78;
  const HGAP = 96;
  const VGAP = 34;
  const PAD = 12;
  const maxLen = Math.max(...chains.map((c) => c.length));
  const width = PAD * 2 + maxLen * W + (maxLen - 1) * HGAP;
  const height = PAD * 2 + chains.length * H + (chains.length - 1) * VGAP;

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Decision lineage graph">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)"/></marker></defs>`,
  );
  chains.forEach((chain, row) => {
    const y = PAD + row * (H + VGAP);
    chain.forEach((d, col) => {
      const x = PAD + col * (W + HGAP);
      if (col < chain.length - 1) {
        const midY = y + H / 2;
        parts.push(
          `<line class="edge" x1="${x + W}" y1="${midY}" x2="${x + W + HGAP - 2}" y2="${midY}" marker-end="url(#arrow)"/>`,
          `<text class="edge-label" x="${x + W + HGAP / 2}" y="${midY - 6}" text-anchor="middle">superseded by</text>`,
        );
      }
      const cls = `dnode ${d.madeBy} ${d.status}`;
      const titleLines = wrapText(d.title, 34, 2);
      parts.push(
        `<g class="${cls}" data-id="${esc(d.id)}" tabindex="0">`,
        `<title>${esc(d.title)}\n${esc(d.rationale)}</title>`,
        `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10"/>`,
        `<text class="node-id" x="${x + 12}" y="${y + 18}">${esc(d.id)}</text>`,
        `<text class="node-by ${d.madeBy}" x="${x + W - 12}" y="${y + 18}" text-anchor="end">${d.madeBy === 'human' ? 'HUMAN' : 'COORDINATOR'}</text>`,
        ...titleLines.map(
          (line, i) => `<text class="node-title" x="${x + 12}" y="${y + 37 + i * 15}">${esc(line)}</text>`,
        ),
        `<text class="node-date" x="${x + 12}" y="${y + H - 9}">${esc(fmtVirtual(d.decidedAtVirtual))} · ${d.status}</text>`,
        `</g>`,
      );
    });
  });
  parts.push('</svg>');
  return parts.join('\n');
}

function decisionSection(doc: WorkstreamDoc): string {
  const decisions = doc.decisions;
  if (!decisions.length) {
    return `<section><h2>Decision lineage</h2>${empty('No decisions recorded yet — direction has not been established.')}</section>`;
  }
  // Details for the click-to-inspect panel, carried as JSON (escaped for the
  // script context) so the page needs no server round-trip.
  const details = Object.fromEntries(
    decisions.map((d) => [
      d.id,
      {
        title: d.title,
        rationale: d.rationale,
        madeBy: d.madeBy,
        status: d.status,
        passId: d.passId ?? null,
        supersedes: d.supersedes ?? null,
        supersededBy: d.supersededBy ?? null,
        reviewWhen: d.reviewWhen ?? null,
        appliedPolicyIds: d.appliedPolicyIds ?? [],
        decidedAtVirtual: d.decidedAtVirtual,
      },
    ]),
  );
  const json = JSON.stringify(details).replaceAll('<', '\\u003c');
  const standing = decisions.filter((d) => d.status === 'standing').length;
  const closed = decisions.filter((d) => d.status === 'closed').length;
  const superseded = decisions.length - standing - closed;
  return `<section>
<h2>Decision lineage <span class="count">${standing} standing · ${superseded} superseded${closed ? ` · ${closed} closed` : ''}</span></h2>
<p class="hint">Each row is one line of direction; arrows are explicit supersessions — a decision is never silently reversed. Click a node for its rationale and applied policies.</p>
<div class="legend">
  <span><i class="swatch human"></i>made by human</span>
  <span><i class="swatch coordinator"></i>made by coordinator</span>
  <span><i class="swatch superseded-swatch"></i>superseded (dashed)</span>
</div>
<div class="scroll-x">${decisionGraphSvg(decisions)}</div>
<div id="decision-detail" class="detail"><p class="empty">Click a decision node to see its rationale and applied policies.</p></div>
<script type="application/json" id="decision-data">${json}</script>
</section>`;
}

// ---------------------------------------------------------------------------
// 2. Policy panel (global store)

function policyCard(p: PolicyRecord): string {
  const evidence = p.evidence.length
    ? `<ul class="evidence">${p.evidence
        .map(
          (e) =>
            `<li><span class="${e.interventionFree ? 'ok' : 'warn'}">${e.interventionFree ? 'intervention-free' : 'intervened'}</span> ${esc(e.workstreamSlug)} / ${esc(e.passId)} — ${esc(e.note)}</li>`,
        )
        .join('')}</ul>`
    : `<p class="empty">No evidence yet — unproven.</p>`;
  const lineage = p.supersededBy ? `<p class="lineage">superseded by <code>${esc(p.supersededBy)}</code></p>` : '';
  const contested = p.contested
    ? `<p class="meta"><span class="pill warn">contested — under review</span> ${esc(p.contested.note)} (in <code>${esc(p.contested.workstreamSlug)}</code>)</p>`
    : '';
  return `<article class="card policy ${p.status}${p.contested ? ' contested' : ''}">
<header><code>${esc(p.id)}</code> <span class="pill status-${p.status}">${p.status}</span> <span class="pill effect">${esc(p.effect.kind)}</span></header>
<p class="statement">${esc(p.statement)}</p>
<p class="meta">effect: ${esc(p.effect.description)}</p>
<p class="meta">scope tags: ${p.scope.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '(none)'}</p>
<p class="meta">${
    'workstreamSlug' in p.provenance
      ? `learned from <code>${esc(p.provenance.workstreamSlug)}</code> pass <code>${esc(p.provenance.passId)}</code>${p.provenance.steeringId ? ` steering <code>${esc(p.provenance.steeringId)}</code>` : ''}`
      : `seeded by <code>${esc(p.provenance.source)}</code> from <code>${esc(p.provenance.ref)}</code>`
  } — ${esc(p.provenance.interventionSummary)}</p>
${contested}${evidence}${lineage}
</article>`;
}

function policySection(
  policies: PolicyRecord[],
  heading: string,
  note: string,
  opts: { emptyMsg?: string; footer?: string } = {},
): string {
  const body = policies.length
    ? policies.map(policyCard).join('\n')
    : empty(opts.emptyMsg ?? 'No learned policies.');
  return `<section><h2>${esc(heading)} <span class="count">${policies.length}</span></h2><p class="hint">${esc(note)}</p>${body}${opts.footer ?? ''}</section>`;
}

/**
 * One line per policy, for the groups a reader scans rather than studies —
 * the 341 shadow policies nothing has yet proven. A full card each buried the
 * handful that ARE load-bearing under a page nobody could read; the statement,
 * its effect, and where it came from are what distinguishes one unproven
 * candidate from another, and the full card is one click away in the store.
 */
function policyOneLiner(p: PolicyRecord): string {
  const source =
    'workstreamSlug' in p.provenance ? p.provenance.workstreamSlug : p.provenance.source;
  const lineage = p.supersededBy ? ` <span class="dim">superseded by <code>${esc(p.supersededBy)}</code></span>` : '';
  return `<li><span class="statement-line">${esc(firstLine(p.statement, 160))}</span> <span class="pill effect">${esc(p.effect.kind)}</span> <span class="dim">${esc(source)}</span>${lineage}</li>`;
}

function policyGroup(title: string, cards: string): string {
  return `<h3>${esc(title)}</h3>${cards}`;
}

/**
 * The fleet page's learning answer: what the fleet has learned, grouped by how
 * much the fleet actually knows about it. Every policy lands in exactly one
 * group — superseded first (resolved lineage), then contested, then by status
 * and evidence — so the totals in the header reconcile with what is on screen.
 */
function learnedSection(policies: PolicyRecord[]): string {
  if (!policies.length) {
    return `<section id="policies"><h2>Learned <span class="count">0</span></h2>${empty('No learned policies.')}</section>`;
  }
  const superseded = policies.filter((p) => p.status === 'superseded');
  const live = policies.filter((p) => p.status !== 'superseded');
  const contested = live.filter((p) => p.contested);
  const rest = live.filter((p) => !p.contested);
  const active = rest.filter((p) => p.status === 'active');
  const shadowProven = rest.filter((p) => p.status === 'shadow' && p.evidence.length > 0);
  const shadowUnproven = rest.filter((p) => p.status === 'shadow' && p.evidence.length === 0);

  const byEvidence = (a: PolicyRecord, b: PolicyRecord) =>
    b.evidence.length - a.evidence.length || b.createdAt.localeCompare(a.createdAt);

  const unproven = policies.filter((p) => p.evidence.length === 0).length;
  const effectCounts = new Map<string, number>();
  for (const p of policies) effectCounts.set(p.effect.kind, (effectCounts.get(p.effect.kind) ?? 0) + 1);
  const effects = [...effectCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(' / ');
  const statuses = [
    `${policies.filter((p) => p.status === 'active').length} active`,
    `${policies.filter((p) => p.status === 'shadow').length} shadow (${unproven} unproven)`,
    `${superseded.length} superseded`,
  ].join(' · ');

  const groups = [
    active.length
      ? policyGroup(`Active (${active.length})`, [...active].sort(byEvidence).map(policyCard).join('\n'))
      : '',
    contested.length
      ? policyGroup(
          `Contested (${contested.length})`,
          [...contested].sort(byEvidence).map(policyCard).join('\n'),
        )
      : '',
    shadowProven.length
      ? policyGroup(
          `Shadow, with evidence (${shadowProven.length})`,
          [...shadowProven].sort(byEvidence).map(policyCard).join('\n'),
        )
      : '',
    shadowUnproven.length
      ? `<details><summary>Shadow, unproven (${shadowUnproven.length})</summary><ul class="policy-lines">${shadowUnproven
          .map(policyOneLiner)
          .join('')}</ul></details>`
      : '',
    superseded.length
      ? `<details><summary>Superseded (${superseded.length})</summary><ul class="policy-lines">${superseded
          .map(policyOneLiner)
          .join('')}</ul></details>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `<section id="policies">
<h2>Learned <span class="count">${policies.length}</span></h2>
<p class="hint">${esc(statuses)} — ${esc(effects)}</p>
<p class="hint">Shadow policies shape plans but are cited on every application; promotion to active is earned by an intervention-free matching workstream. A policy can only add verification, narrow authority, or advise — authority is never learned.</p>
${groups}
</section>`;
}

// ---------------------------------------------------------------------------
// 3. Interventions timeline

/** Event types that are unambiguously a human act (see humanActs.ts / cli.ts). */
const HUMAN_EVENT_KINDS: Record<string, string> = {
  'steering.arrived': 'steering',
  'send.approved': 'approval',
  'send.rejected': 'rejection',
  'action.approved': 'approval',
  'action.rejected': 'rejection',
  'action.human_authored': 'authored',
  'attention.resolved': 'resolution',
  'constraint.added': 'correction',
  'constraint.removed': 'correction',
  'budget.updated': 'config',
  'tags.changed': 'config',
};

function humanEvents(events: EventRecord[]): { kind: string; e: EventRecord }[] {
  const out: { kind: string; e: EventRecord }[] = [];
  for (const e of events) {
    const kind = HUMAN_EVENT_KINDS[e.type];
    if (kind) out.push({ kind, e });
    // Adoption is usually a coordinator act; only the human override counts.
    else if (e.type === 'submission.adopted' && e.summary.includes('by HUMAN')) {
      out.push({ kind: 'adoption', e });
    }
  }
  return out;
}

function interventionSection(doc: WorkstreamDoc): string {
  const entries = humanEvents(doc.events);
  const total = doc.spend.humanInterventions;
  const body = entries.length
    ? `<ol class="timeline">${entries
        .map(
          ({ kind, e }) =>
            `<li class="tl-${kind}"><span class="tl-when">${esc(fmtVirtual(e.atVirtual))}</span><span class="pill tl-kind">${kind}</span> <span class="tl-what">${esc(e.summary)}</span></li>`,
        )
        .join('')}</ol>`
    : empty('No human interventions in the event tail.');
  return `<section>
<h2>Interventions <span class="count">${total} total</span></h2>
<p class="hint">Interventions per successful outcome is the number the learning loop drives down. The timeline below is drawn from the bounded event tail (last ${doc.events.length} events), so the lifetime count above may exceed what is listed.</p>
${body}
</section>`;
}

// ---------------------------------------------------------------------------
// 4. Deliverables — adoption ≠ completion made visible

function producingAssignment(doc: WorkstreamDoc, d: Deliverable): Assignment | undefined {
  return (
    doc.assignments.find((a) => a.submission?.deliverableId === d.id) ??
    doc.assignments.find((a) => a.id === d.producedByAssignment)
  );
}

function deliverableRow(doc: WorkstreamDoc, d: Deliverable): string {
  const asg = producingAssignment(doc, d);
  if (d.adopted) {
    return `<li class="del adopted"><code>${esc(d.id)}</code> <strong>${esc(d.title)}</strong> (${esc(d.kind)}) — <span class="ok">ADOPTED</span> pinned <code>${esc(shortHash(d.adopted.contentHash))}</code> in pass <code>${esc(d.adopted.passId)}</code> at ${esc(fmtVirtual(d.adopted.atVirtual))}</li>`;
  }
  const state = asg?.adoption.state ?? 'none';
  const reason = asg?.adoption.reason ? ` — ${esc(asg.adoption.reason)}` : '';
  return `<li class="del ${state === 'rejected' ? 'rejected' : 'candidate'}"><code>${esc(d.id)}</code> <strong>${esc(d.title)}</strong> (${esc(d.kind)}) — ${state === 'rejected' ? `<span class="bad">REJECTED</span>${reason}` : `candidate, adoption=${esc(state)}`}, hash <code>${esc(shortHash(d.contentHash))}</code>, from <code>${esc(d.producedByAssignment ?? asg?.id ?? '?')}</code></li>`;
}

function deliverableSection(doc: WorkstreamDoc): string {
  const adopted = doc.deliverables.filter((d) => d.adopted);
  const rest = doc.deliverables.filter((d) => !d.adopted);
  const rejected = rest.filter((d) => producingAssignment(doc, d)?.adoption.state === 'rejected');
  const candidates = rest.filter((d) => !rejected.includes(d));
  const group = (title: string, items: Deliverable[]) =>
    `<h3>${esc(title)} <span class="count">${items.length}</span></h3>` +
    (items.length ? `<ul class="dels">${items.map((d) => deliverableRow(doc, d)).join('')}</ul>` : empty('None.'));
  if (!doc.deliverables.length) {
    return `<section><h2>Deliverables</h2>${empty('No deliverables produced yet.')}</section>`;
  }
  return `<section>
<h2>Deliverables</h2>
<p class="hint">A worker finishing is a submission; only adoption pins a hash and makes it authoritative. Rejected candidates stay inspectable.</p>
${group('Adopted', adopted)}
${group('Candidates', candidates)}
${group('Rejected', rejected)}
</section>`;
}

// ---------------------------------------------------------------------------
// 5. Actions audit

function actionCard(a: Assignment): string {
  const ex = a.exec;
  const approval = ex?.approval
    ? `<span class="ok">approved by ${esc(ex.approval.by)}</span> at ${esc(fmtVirtual(ex.approval.at))}`
    : a.state === 'gated'
      ? '<span class="warn">gated — awaiting human approval</span>'
      : a.state === 'cancelled'
        ? '<span class="bad">rejected / cancelled</span>'
        : '<span class="warn">no approval recorded</span>';
  const executed = ex?.run
    ? `<p class="meta">engine-executed command:</p><pre>${esc(ex.run)}</pre>`
    : `<p class="meta">worker briefing:</p><pre>${esc(a.briefing)}</pre>`;
  const readback = ex?.verified
    ? `<p class="meta">readback <span class="${ex.verified.ok ? 'ok' : 'bad'}">${ex.verified.ok ? 'CONFIRMED' : 'FAILED'}</span> at ${esc(fmtVirtual(ex.verified.at))} via <code>${esc(ex.verify)}</code></p><pre>${esc(ex.verified.output.trim().slice(0, 400))}</pre>`
    : `<p class="meta">readback not yet run (verify: <code>${esc(ex?.verify ?? '?')}</code>)</p>`;
  return `<article class="card action">
<header><code>${esc(a.id)}</code> <span class="pill">${esc(a.state)}</span> <span class="pill">adoption: ${esc(a.adoption.state)}</span></header>
<p class="statement">${esc(a.objective)}</p>
${ex?.ask ? `<p class="meta">ask: ${esc(ex.ask)}</p>` : ''}
<p class="meta">${approval}</p>
${executed}
${readback}
</article>`;
}

function actionSection(doc: WorkstreamDoc): string {
  const actions = doc.assignments.filter((a) => a.kind === 'action');
  const body = actions.length ? actions.map(actionCard).join('\n') : empty('No real-world actions in this workstream.');
  return `<section><h2>Actions audit <span class="count">${actions.length}</span></h2>
<p class="hint">Every real-world act: who approved it, what actually ran, and the deterministic readback that confirmed (or refuted) the effect — the worker's prose never counts.</p>
${body}</section>`;
}

// ---------------------------------------------------------------------------
// Page chrome

const STYLE = `
:root { color-scheme: dark; --bg:#0f1117; --panel:#161a22; --panel2:#1d222d; --fg:#d6dbe4; --dim:#8891a0;
  --line:#2a3040; --edge:#5a6478; --human:#e0a458; --coord:#6d9ee8; --ok:#63c78a; --warn:#e0c358; --bad:#e07070; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 28px 24px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 0 0 8px; } h3 { font-size: 14px; margin: 16px 0 6px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; }
.subtitle { color: var(--dim); margin: 0 0 24px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin: 18px 0; }
.count { color: var(--dim); font-weight: normal; font-size: 13px; margin-left: 8px; }
.hint { color: var(--dim); font-size: 13px; margin: 2px 0 12px; }
.empty { color: var(--dim); font-style: italic; }
code { background: var(--panel2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
pre { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
.scroll-x { overflow-x: auto; padding: 6px 0; }
.pill { display:inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--panel2); border: 1px solid var(--line); color: var(--dim); }
.pill.status-active { color: var(--ok); border-color: var(--ok); }
.pill.status-shadow { color: var(--warn); border-color: var(--warn); }
.pill.status-superseded { color: var(--dim); text-decoration: line-through; }
.tag { display:inline-block; font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--panel2); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
.card { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
.card header { margin-bottom: 6px; }
.card .statement { margin: 4px 0; font-weight: 600; }
.card .meta { margin: 3px 0; color: var(--dim); font-size: 13px; }
.card.policy.superseded { opacity: .6; }
.evidence { margin: 6px 0 0; padding-left: 18px; font-size: 13px; }
.lineage { color: var(--dim); font-size: 13px; }
.legend { display:flex; gap: 18px; color: var(--dim); font-size: 12px; margin-bottom: 8px; }
.legend .swatch { display:inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 5px; vertical-align: -2px; border: 2px solid var(--edge); }
.legend .swatch.human { border-color: var(--human); } .legend .swatch.coordinator { border-color: var(--coord); }
.legend .swatch.superseded-swatch { border-style: dashed; }
svg .dnode rect { fill: var(--panel2); stroke-width: 2; cursor: pointer; }
svg .dnode.human rect { stroke: var(--human); } svg .dnode.coordinator rect { stroke: var(--coord); }
svg .dnode.superseded rect { stroke-dasharray: 5 4; } svg .dnode.superseded { opacity: .6; }
svg .dnode.selected rect { fill: #253048; }
svg .node-id { fill: var(--dim); font-size: 11px; font-family: ui-monospace, monospace; }
svg .node-by { font-size: 10px; letter-spacing: .05em; } svg .node-by.human { fill: var(--human); } svg .node-by.coordinator { fill: var(--coord); }
svg .node-title { fill: var(--fg); font-size: 12px; font-weight: 600; }
svg .node-date { fill: var(--dim); font-size: 10px; }
svg .edge { stroke: var(--edge); stroke-width: 1.5; }
svg .edge-label { fill: var(--dim); font-size: 9px; }
svg text { pointer-events: none; }
.detail { border: 1px dashed var(--line); border-radius: 10px; padding: 12px 14px; margin-top: 10px; min-height: 46px; }
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { padding: 5px 0 5px 14px; border-left: 2px solid var(--line); margin-left: 6px; }
.timeline li.tl-steering { border-left-color: var(--human); }
.timeline li.tl-approval, .timeline li.tl-adoption { border-left-color: var(--ok); }
.timeline li.tl-rejection { border-left-color: var(--bad); }
.timeline li.tl-correction, .timeline li.tl-authored, .timeline li.tl-resolution { border-left-color: var(--warn); }
.timeline li.tl-config { border-left-color: var(--muted, #666); opacity: .75; }
.tl-when { color: var(--dim); font-size: 12px; font-family: ui-monospace, monospace; margin-right: 8px; }
.dels { list-style: none; padding: 0; margin: 6px 0; } .dels li { padding: 4px 0; }
.page-nav { display:flex; gap:16px; margin:0 0 14px; font-size:13px; }
.page-nav a { text-decoration:none; }
a { color: var(--coord); }
footer { color: var(--dim); font-size: 12px; margin-top: 24px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 600; }
td.age { color: var(--dim); font-family: ui-monospace, monospace; white-space: nowrap; }
td.state { white-space: nowrap; }
.dim { color: var(--dim); }
.pill.need-blocker { color: var(--bad); border-color: var(--bad); }
.pill.need-action, .pill.need-approval, .pill.need-send { color: var(--warn); border-color: var(--warn); }
.pill.routine { color: var(--coord); border-color: var(--coord); }
.pill.bad { color: var(--bad); border-color: var(--bad); }
tr.state-needs-you td.state { color: var(--bad); }
tr.state-working td.state { color: var(--coord); }
tr.state-waiting td.state { color: var(--dim); }
tr.state-idle td.state, tr.state-paused td.state { color: var(--dim); font-style: italic; }
details { margin: 10px 0; }
details > summary { cursor: pointer; color: var(--dim); font-size: 13px; padding: 4px 0; }
.since, .policy-lines { list-style: none; margin: 4px 0 12px; padding: 0; }
.since li, .policy-lines li { padding: 4px 0; border-bottom: 1px solid var(--line); }
.statement-line { font-weight: 600; }
`;

/** Click-to-inspect for decision nodes; data comes from the embedded JSON. */
const SCRIPT = `
(function () {
  var dataEl = document.getElementById('decision-data');
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var panel = document.getElementById('decision-detail');
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function show(id) {
    var d = data[id];
    if (!d) return;
    document.querySelectorAll('.dnode.selected').forEach(function (n) { n.classList.remove('selected'); });
    var node = document.querySelector('.dnode[data-id="' + id + '"]');
    if (node) node.classList.add('selected');
    var rows = [
      '<p><code>' + esc(id) + '</code> <strong>' + esc(d.title) + '</strong> <span class="pill">' + esc(d.status) + '</span> <span class="pill">' + esc(d.madeBy) + '</span></p>',
      '<p>' + esc(d.rationale) + '</p>',
      '<p class="meta">decided ' + esc(d.decidedAtVirtual) + (d.passId ? ' in pass <code>' + esc(d.passId) + '</code>' : ' (no pass — human)') + '</p>'
    ];
    if (d.supersedes) rows.push('<p class="meta">supersedes <code>' + esc(d.supersedes) + '</code></p>');
    if (d.supersededBy) rows.push('<p class="meta">superseded by <code>' + esc(d.supersededBy) + '</code></p>');
    if (d.reviewWhen) rows.push('<p class="meta">review when: ' + esc(d.reviewWhen) + '</p>');
    rows.push(d.appliedPolicyIds.length
      ? '<p class="meta">applied policies: ' + d.appliedPolicyIds.map(function (p) { return '<code>' + esc(p) + '</code>'; }).join(' ') + '</p>'
      : '<p class="meta">no learned policies applied</p>');
    panel.innerHTML = rows.join('');
  }
  document.querySelectorAll('.dnode').forEach(function (n) {
    n.addEventListener('click', function () { show(n.getAttribute('data-id')); });
    n.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(n.getAttribute('data-id')); } });
  });
})();
`;

function page(
  title: string,
  subtitle: string,
  body: string,
  back?: { href: string; label: string },
  printoutsHref = 'printouts/index.html',
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<nav class="page-nav">${back ? `<a href="${esc(back.href)}">${esc(back.label)}</a>` : ''}<a href="${esc(printoutsHref)}">Printouts</a></nav>
<h1>${esc(title)}</h1>
<p class="subtitle">${esc(subtitle)}</p>
${body}
<footer>Generated by <code>weaver inspect</code> from typed state — decisions, policies, and adoptions are read from the store, never from transcripts.</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Renderers (pure over typed state — this is what the tests exercise)

/**
 * The policies that have actually SHAPED this workstream: learned here, cited
 * by a decision here, or evidenced by an outcome here.
 *
 * Deliberately not the tag-scoped set. Tag scope answers a coordinator's
 * question — which policies MAY apply to a stream it is about to plan — and
 * one shared tag is enough to match, so `erdo` alone put 351 of 371 policies on
 * every page. This page answers the human's question instead: which learning
 * is on the record here. The full store, tag scope and all, is one link away.
 */
export function policiesForWorkstream(policies: PolicyRecord[], doc: WorkstreamDoc): PolicyRecord[] {
  const slug = doc.workstream.slug;
  const applied = new Set(doc.decisions.flatMap((d) => d.appliedPolicyIds ?? []));
  return policies.filter(
    (p) =>
      ('workstreamSlug' in p.provenance && p.provenance.workstreamSlug === slug) ||
      p.evidence.some((e) => e.workstreamSlug === slug) ||
      applied.has(p.id),
  );
}

/** The task card: what this stream IS, before any knowledge detail — the
 * first question a returning human asks ("what is approvals-cleanup?") must
 * be the first thing the page answers. */
function taskSection(doc: WorkstreamDoc): string {
  const ws = doc.workstream;
  const latest = [...doc.decisions].reverse().find((d) => d.status === 'standing');
  const open = doc.attention.filter((a) => a.status === 'open' && !isLegacyDollarBudgetAttention(a));
  const legacyConclusion =
    ws.status === 'done' ? [...doc.events].reverse().find((e) => e.type === 'workstream.concluded') : undefined;
  const conclusion = ws.status === 'done' && ws.conclusion
    ? `Typed completion evidence (validated at conclusion): ${ws.conclusion.evidenceIds.join(', ')}. Coordinator account (informational): ${ws.conclusion.summary}`
    : undefined;
  const legacyClaim = ws.status === 'done' && !ws.conclusion
    ? legacyConclusion?.summary.replace(/^coordinator concluded the workstream:\s*/, '')
    : undefined;
  return `<section>
<h2>The task</h2>
<p class="statement">${esc(ws.objective)}</p>
${ws.successCriteria.length ? `<h3>Done when</h3><ul>${ws.successCriteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
${
  conclusion
    ? `<h3>Outcome</h3><p>${esc(conclusion)}</p>`
    : legacyClaim
      ? `<h3>Legacy conclusion claim (evidence unvalidated)</h3><p>${esc(legacyClaim)}</p>`
    : latest
      ? `<h3>Current course</h3><p><strong>${esc(latest.title)}</strong> — ${esc(latest.rationale)}</p>`
      : ''
}
${open.length ? `<h3>Waiting on the human</h3><ul>${open.map((a) => `<li>${esc(a.summary.slice(0, 400))}</li>`).join('')}</ul>` : ''}
</section>`;
}

function printoutSection(href: string, scope: string): string {
  return `<section>
<h2>Printouts</h2>
<p class="hint">Readable, archived catch-up windows showing what changed, what was adopted, and which external effects were actually verified.</p>
<p><a href="${esc(href)}">Browse ${esc(scope)} printouts →</a></p>
</section>`;
}

/**
 * `managed` is a fleet-wide `listManagedBy` scan the caller (runInspect)
 * performs and passes in, so this stays a pure function of one doc for
 * tests. Flat one-liner only, appended to the subtitle: this doc's own
 * `managedBy` pointer and its own single-level `manages` count — never a
 * resolved chain.
 */
export function renderWorkstreamHtml(
  doc: WorkstreamDoc,
  policies: PolicyRecord[],
  managed: { slug: string; status: string }[] = [],
): string {
  const ws = doc.workstream;
  const managedBadge = [
    ws.managedBy ? `managed by ${ws.managedBy.slug}` : '',
    managed.length ? `manages ${managed.length} workstream${managed.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
  const body = [
    taskSection(doc),
    printoutSection(`../printouts/index.html#${encodeURIComponent(ws.slug)}`, 'this workstream’s'),
    decisionSection(doc),
    policySection(
      policiesForWorkstream(policies, doc),
      'Policies in play here',
      'Learned here, cited by a decision here, or evidenced by an outcome here — what has actually shaped this workstream. Tag scope is wider: it selects what a coordinator MAY apply when planning, and lives in the full store. A policy can only add verification, narrow authority, or advise — authority is never learned.',
      {
        emptyMsg: 'No policy has been learned here, applied here, or evidenced here yet.',
        footer: `<p class="hint"><a href="../inspect.html#policies">Full policy store (${policies.length}) →</a></p>`,
      },
    ),
    interventionSection(doc),
    deliverableSection(doc),
    actionSection(doc),
  ].join('\n');
  return page(
    `${ws.title} — knowledge inspector`,
    `${ws.slug} · ${ws.status} · revision ${doc.revision} · ${doc.spend.coordinatorPasses} coordinator passes · ~$${doc.spend.totalCostUsd.toFixed(2)} SDK estimate${managedBadge ? ` · ${managedBadge}` : ''}`,
    body,
    // A workstream page is reachable directly (dashboard [i] on a selected
    // stream), so it always carries its own way back up to the fleet page.
    { href: '../inspect.html', label: '← all workstreams' },
    `../printouts/index.html#${encodeURIComponent(ws.slug)}`,
  );
}

/**
 * Structurally impossible pass combinations — the audit signal for provenance
 * that should never occur. A clean finish always records a summary, so a
 * 'completed' pass without one is a tell of the old conflicted-finish bug (a
 * finish that lost its write yet was recorded completed). Surfaced, never
 * rewritten: history stays as it was, but the anomaly is visible.
 */
export function passIntegrityWarnings(doc: WorkstreamDoc): string[] {
  const out: string[] = [];
  for (const p of doc.passes) {
    if (p.outcome === 'completed' && !p.summary) {
      out.push(`${p.id}: completed without a summary — a clean finish always records one`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The fleet page — the five questions (kernel rule 10), in order:
// needs-me · since-I-left · now (the fleet table) · why (what it learned).

/** One thing on the fleet that is waiting for a person, whichever surface it
 * arrived on: an attention item, a gated action, or a send awaiting approval. */
export interface FleetNeed {
  slug: string;
  kind: 'blocker' | 'approval' | 'review' | 'budget' | 'capacity' | 'action' | 'send';
  /** When it started waiting. A send records no creation time, so it has none. */
  at?: string;
  /** Which clock `at` is on: attention is wall-stamped, an assignment virtual. */
  clock?: 'wall' | 'virtual';
  summary: string;
}

/**
 * Urgency, not alphabet. A blocker is the fleet stopped; an approval, a gated
 * action and a pending send are one keypress each; a review can wait a beat;
 * budget and capacity clear themselves or need a console, never a decision.
 */
const NEED_RANK: Record<FleetNeed['kind'], number> = {
  blocker: 0,
  action: 1,
  approval: 1,
  send: 1,
  review: 2,
  budget: 3,
  capacity: 3,
};

/** Everything on the fleet waiting for a person, most urgent then oldest. */
export function fleetNeeds(docs: WorkstreamDoc[]): FleetNeed[] {
  const needs: FleetNeed[] = [];
  for (const doc of docs) {
    const slug = doc.workstream.slug;
    for (const a of doc.attention) {
      if (a.status !== 'open' || isLegacyDollarBudgetAttention(a)) continue;
      needs.push({ slug, kind: a.kind, at: a.createdAt, clock: 'wall', summary: a.summary });
    }
    for (const a of doc.assignments) {
      // A gated action pilot has already approved is the runner's to execute,
      // not the human's to decide — it is on its way out of the gate.
      if (a.state !== 'gated' || a.exec?.pilotVerdict?.decision === 'approve') continue;
      needs.push({
        slug,
        kind: 'action',
        at: a.createdAtVirtual,
        clock: 'virtual',
        summary: a.exec?.ask ?? a.objective,
      });
    }
    for (const i of doc.interactions) {
      if (i.status !== 'awaiting_approval') continue;
      needs.push({ slug, kind: 'send', summary: `send ${i.kind} to ${i.to} — “${i.subject}”` });
    }
  }
  return needs.sort(
    (a, b) =>
      NEED_RANK[a.kind] - NEED_RANK[b.kind] ||
      // Undated items (sends) sort last within their rank rather than first:
      // an empty age must never outrank something that has waited a week.
      (a.at ? (b.at ? a.at.localeCompare(b.at) : -1) : b.at ? 1 : 0) ||
      a.slug.localeCompare(b.slug),
  );
}

function needsYouSection(needs: FleetNeed[]): string {
  if (!needs.length) {
    return `<section><h2>Needs you</h2>${empty('Nothing needs you.')}</section>`;
  }
  const wall = new Date();
  const virtual = virtualNow();
  const rows = needs.map((n) => {
    const age = n.at ? compactAge(n.at, n.clock === 'virtual' ? virtual : wall) : '';
    return `<tr>
<td><span class="pill need-${esc(n.kind)}">${esc(n.kind)}</span></td>
<td class="age">${esc(age)}</td>
<td><a href="${esc(n.slug)}/inspect.html">${esc(n.slug)}</a></td>
<td>${esc(firstLine(n.summary, 160))}</td>
</tr>`;
  });
  return `<section>
<h2>Needs you <span class="count">${needs.length}</span></h2>
<p class="hint">Most urgent first, then longest waiting. Answer them in the dashboard (<code>weaver watch</code>) — approving there IS the approval.</p>
<table><tbody>${rows.join('\n')}</tbody></table>
</section>`;
}

/**
 * What moved while the human was away. The window opens at the previous
 * generation of these pages, which is a human act by construction (`weaver
 * inspect`, or [i] on the dashboard) — so "since the last generation" and
 * "since you last looked" are the same moment.
 *
 * Organizational facts are compared against the virtual stamp and physical
 * ones against the wall stamp; mixing them would mis-window the whole section
 * the first time the demo clock is advanced.
 */
function sinceYouLeftSection(
  docs: WorkstreamDoc[],
  policies: PolicyRecord[],
  viewed: InspectViewed | null,
): string {
  if (!viewed) {
    return `<section>
<h2>Since you left</h2>
${empty('First visit — the next generation will know what changed.')}
</section>`;
  }
  const li = (s: string) => `<li>${s}</li>`;
  const wsLink = (slug: string) => `<a href="${esc(slug)}/inspect.html">${esc(slug)}</a>`;

  const decisions = docs.flatMap((doc) =>
    doc.decisions
      .filter((d) => d.decidedAtVirtual > viewed.virtualAt)
      .map((d) =>
        li(
          `${wsLink(doc.workstream.slug)} <strong>${esc(firstLine(d.title, 160))}</strong> <span class="dim">${esc(d.madeBy)} · ${esc(d.status)} · ${esc(fmtVirtual(d.decidedAtVirtual))}</span>`,
        ),
      ),
  );
  const adopted = docs.flatMap((doc) =>
    doc.deliverables
      .filter((d) => d.adopted && d.adopted.atVirtual > viewed.virtualAt)
      .map((d) =>
        li(
          `${wsLink(doc.workstream.slug)} <strong>${esc(firstLine(d.title, 160))}</strong> <span class="dim">pinned <code>${esc(shortHash(d.adopted!.contentHash))}</code> · ${esc(fmtVirtual(d.adopted!.atVirtual))}</span>`,
        ),
      ),
  );
  const concluded = docs
    .filter((doc) => doc.workstream.conclusion && doc.workstream.conclusion.atVirtual > viewed.virtualAt)
    .map((doc) =>
      li(
        `${wsLink(doc.workstream.slug)} <span class="dim">${esc(fmtVirtual(doc.workstream.conclusion!.atVirtual))} · evidence ${esc(doc.workstream.conclusion!.evidenceIds.join(', ') || '(none cited)')}</span>`,
      ),
    );
  // Status rides along per row: a send with an unknown provider result is a
  // send that happened, and must not be listed as if it were confirmed.
  const sends = docs.flatMap((doc) =>
    doc.interactions
      .filter((i) => i.sentAtVirtual && i.sentAtVirtual > viewed.virtualAt)
      .map((i) =>
        li(
          `${wsLink(doc.workstream.slug)} <strong>${esc(firstLine(i.subject, 160))}</strong> → ${esc(i.to)} <span class="dim">${esc(i.status)} · ${esc(fmtVirtual(i.sentAtVirtual!))}</span>`,
        ),
      ),
  );
  const newPolicies = policies.filter((p) => p.createdAt > viewed.wallAt);
  const newEvidence = policies.flatMap((p) => p.evidence.filter((e) => e.at > viewed.wallAt));

  const groups: [string, string[]][] = [
    [`Decisions made (${decisions.length})`, decisions],
    [`Deliverables adopted (${adopted.length})`, adopted],
    [`Workstreams concluded (${concluded.length})`, concluded],
    [`Sends (${sends.length})`, sends],
    [
      `New policies (${newPolicies.length})`,
      newPolicies.map((p) =>
        li(
          `<span class="statement-line">${esc(firstLine(p.statement, 160))}</span> <span class="pill effect">${esc(p.effect.kind)}</span> <span class="dim">${esc(p.status)}</span>`,
        ),
      ),
    ],
  ];
  const body = groups
    .filter(([, rows]) => rows.length)
    .map(([title, rows]) => `<h3>${esc(title)}</h3>${cappedList('since', rows)}`)
    .join('\n');
  const evidenceLine = newEvidence.length
    ? `<p class="meta">${newEvidence.length} new piece(s) of policy evidence — ${newEvidence.filter((e) => e.interventionFree).length} intervention-free.</p>`
    : '';
  return `<section>
<h2>Since you left</h2>
<p class="hint">Everything below happened after the last time these pages were generated (${esc(fmtVirtual(viewed.wallAt))} wall · ${esc(fmtVirtual(viewed.virtualAt))} virtual).</p>
${body || evidenceLine ? `${body}\n${evidenceLine}` : empty('Nothing has changed since you last looked.')}
</section>`;
}

/** The five state words a fleet row can wear, in the order they matter. */
type FleetState = 'needs you' | 'working' | 'waiting' | 'idle' | 'paused';

const STATE_RANK: Record<FleetState, number> = {
  'needs you': 0,
  working: 1,
  waiting: 2,
  idle: 3,
  paused: 4,
};

/** The soonest pending wake still in the future, on whichever clock dates it. */
function nextWake(
  doc: WorkstreamDoc,
  wallNow: Date,
  virtual: Date,
): { inMs: number; reason: string } | undefined {
  let best: { inMs: number; reason: string } | undefined;
  for (const w of doc.wakes) {
    if (w.status !== 'pending') continue;
    const inMs =
      w.condition.type === 'time'
        ? Date.parse(w.condition.dueAtVirtual) - virtual.getTime()
        : w.condition.type === 'wall_time'
          ? Date.parse(w.condition.dueAt) - wallNow.getTime()
          : 0;
    if (!Number.isFinite(inMs) || inMs <= 0) continue;
    if (!best || inMs < best.inMs) best = { inMs, reason: w.reason };
  }
  return best;
}

/**
 * The state word for one live stream. Deliberately simpler than the
 * dashboard's: a static page cannot poll pilot or watch a lease tick over, so
 * it says only what the stored document supports — needing a person outranks
 * everything, then work in flight, then a scheduled wait, then nothing at all.
 */
function fleetState(
  doc: WorkstreamDoc,
  needsCount: number,
  wallNow: Date,
  virtual: Date,
): { state: FleetState; note: string } {
  if (needsCount) return { state: 'needs you', note: '' };
  if (doc.workstream.status === 'paused') return { state: 'paused', note: '' };
  const working =
    doc.assignments.some((a) => a.state === 'running') ||
    (!!doc.lease && Date.parse(doc.lease.expiresAt) > wallNow.getTime());
  if (working) return { state: 'working', note: '' };
  if (doc.wakes.some((w) => w.status === 'pending')) {
    const next = nextWake(doc, wallNow, virtual);
    return {
      state: 'waiting',
      note: next ? ` · in ${untilLabel(next.inMs)} — ${firstLine(next.reason, 60)}` : '',
    };
  }
  return { state: 'idle', note: '' };
}

function fleetSection(docs: WorkstreamDoc[], needs: FleetNeed[], unreadable: string[]): string {
  const wallNow = new Date();
  const virtual = virtualNow();
  const needCount = new Map<string, number>();
  for (const n of needs) needCount.set(n.slug, (needCount.get(n.slug) ?? 0) + 1);

  const cell = (doc: WorkstreamDoc): { link: string; tail: string } => {
    const ws = doc.workstream;
    const warnings = passIntegrityWarnings(doc);
    const pills = [
      ws.tags.includes('routine') ? `<span class="pill routine" title="a standing recurring loop">↻</span>` : '',
      warnings.length
        ? `<span class="pill bad" title="${esc(warnings.join(' · '))}">⚠ ${warnings.length}</span>`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      link: `<a href="${esc(ws.slug)}/inspect.html" title="${esc(ws.title)}">${esc(ws.slug)}</a>${pills ? ` ${pills}` : ''}`,
      tail: `<td>${doc.decisions.filter((d) => d.status === 'standing').length}</td>
<td>${doc.deliverables.filter((d) => d.adopted).length}</td>
<td>${doc.spend.coordinatorPasses} · ~$${doc.spend.totalCostUsd.toFixed(2)}</td>
<td>${doc.spend.humanInterventions ?? 0}</td>`,
    };
  };

  const live = docs.filter((doc) => doc.workstream.status !== 'done');
  const rows = live
    .map((doc) => {
      const n = needCount.get(doc.workstream.slug) ?? 0;
      const { state, note } = fleetState(doc, n, wallNow, virtual);
      const { link, tail } = cell(doc);
      return {
        state,
        slug: doc.workstream.slug,
        html: `<tr class="state-${state.replace(' ', '-')}">
<td>${link}</td>
<td class="state">${esc(state)}${esc(note)}</td>
<td>${n || ''}</td>
${tail}
</tr>`,
      };
    })
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.slug.localeCompare(b.slug))
    .map((r) => r.html);

  const concludedAt = (doc: WorkstreamDoc): string =>
    doc.workstream.conclusion?.atVirtual ??
    [...doc.events].reverse().find((e) => e.type === 'workstream.concluded')?.atVirtual ??
    doc.workstream.createdAt;
  const doneRows = docs
    .filter((doc) => doc.workstream.status === 'done')
    .sort((a, b) => concludedAt(b).localeCompare(concludedAt(a)))
    .map((doc) => {
      const { link } = cell(doc);
      return `<tr>
<td>${link}</td>
<td>${esc(fmtVirtual(concludedAt(doc)))}</td>
<td>${doc.deliverables.filter((d) => d.adopted).length} adopted</td>
<td>${doc.spend.coordinatorPasses} passes</td>
</tr>`;
    });

  // Skipped workstreams are named, never silently absent: a missing row must
  // not read as "no such workstream".
  const skipped = unreadable.length
    ? `<p class="hint bad">Unreadable, no page generated: ${unreadable.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>`
    : '';
  const liveTable = rows.length
    ? `<table>
<thead><tr><th>Workstream</th><th>State</th><th>Needs you</th><th>Direction</th><th>Adopted</th><th>Passes · ~$</th><th>Interventions</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>`
    : empty(docs.length ? 'Every workstream is done.' : 'No workstreams under this WEAVER_HOME.');
  const done = doneRows.length
    ? `<details><summary>Done (${doneRows.length})</summary><table>
<thead><tr><th>Workstream</th><th>Concluded</th><th>Adopted</th><th>Passes</th></tr></thead>
<tbody>${doneRows.join('\n')}</tbody>
</table></details>`
    : '';
  return `<section>
<h2>Fleet <span class="count">${live.length} live · ${doneRows.length} done</span></h2>
<p class="hint">One row per workstream: what it is doing now, and what it has committed to, adopted, and cost. Direction is standing decisions — the commitments a fresh coordinator continues.</p>
${skipped}${liveTable}
${done}
</section>`;
}

export function renderOverviewHtml(
  docs: WorkstreamDoc[],
  policies: PolicyRecord[],
  unreadable: string[] = [],
  viewed: InspectViewed | null = null,
): string {
  const needs = fleetNeeds(docs);
  const body = [
    needsYouSection(needs),
    sinceYouLeftSection(docs, policies, viewed),
    fleetSection(docs, needs, unreadable),
    learnedSection(policies),
    printoutSection('printouts/index.html', 'fleet'),
  ].join('\n');
  return page(
    'Weaver — knowledge inspector',
    `Overview of ${docs.length} workstream(s) and ${policies.length} learned polic${policies.length === 1 ? 'y' : 'ies'} under ${weaverHome()}`,
    body,
  );
}

// ---------------------------------------------------------------------------
// Entry point: render → redact → write. Returns the path of the primary file.

function writeRedacted(filePath: string, html: string, secrets: Record<string, string>): void {
  fs.writeFileSync(filePath, redactSecrets(html, secrets));
}

/**
 * Regenerates the whole site — the fleet overview plus every per-workstream
 * page — and returns the entry point the caller asked for: a workstream's own
 * page when `slug` is given, the fleet page otherwise. One generation path,
 * because pages link both ways: entering at a workstream must not leave the
 * "← all workstreams" link pointing at a stale or missing fleet page.
 *
 * Generating is itself the human act that "since you left" measures from, so
 * the PREVIOUS stamp is read before rendering and the new one written after
 * the pages land — a generation that fails renders no page and must not move
 * the window past changes nobody has seen.
 */
export async function runInspect(slug?: string): Promise<string> {
  // The requested workstream is the one failure that must be loud: asking for
  // a page we cannot render is an error, not an empty site.
  if (slug) await load(slug);
  const viewed = readInspectViewed();
  const policies = (await loadPolicies()).policies;
  const docs: WorkstreamDoc[] = [];
  const allSecrets = loadAllSecrets();
  const unreadable: string[] = [];
  for (const s of await listWorkstreams()) {
    let doc: WorkstreamDoc;
    try {
      doc = await load(s);
    } catch {
      // An unreadable doc is a state the dashboard already renders (UNREADABLE);
      // it must not blank out the knowledge pages of every healthy workstream.
      unreadable.push(s);
      continue;
    }
    docs.push(doc);
    writeRedacted(path.join(workstreamDir(s), 'inspect.html'), renderWorkstreamHtml(doc, policies, await listManagedBy(s)), allSecrets);
  }
  const overview = path.join(weaverHome(), 'inspect.html');
  writeRedacted(overview, renderOverviewHtml(docs, policies, unreadable, viewed), allSecrets);
  await writePrintoutIndex();
  writeInspectViewed();
  return slug ? path.join(workstreamDir(slug), 'inspect.html') : overview;
}
