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
import type { PolicyRecord } from './policies.js';
import { loadPolicies } from './policies.js';
import { writePrintoutIndex } from './printoutHtml.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import { listWorkstreams, load, weaverHome, workstreamDir } from './store.js';
import type { Assignment, Decision, Deliverable, EventRecord, WorkstreamDoc } from './types.js';

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
        `<text class="node-date" x="${x + 12}" y="${y + H - 9}">${esc(fmtVirtual(d.decidedAtVirtual))}${d.status === 'superseded' ? ' · superseded' : ' · standing'}</text>`,
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
  return `<section>
<h2>Decision lineage <span class="count">${standing} standing · ${decisions.length - standing} superseded</span></h2>
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
  return `<article class="card policy ${p.status}">
<header><code>${esc(p.id)}</code> <span class="pill status-${p.status}">${p.status}</span> <span class="pill effect">${esc(p.effect.kind)}</span></header>
<p class="statement">${esc(p.statement)}</p>
<p class="meta">effect: ${esc(p.effect.description)}</p>
<p class="meta">scope tags: ${p.scope.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '(none)'}</p>
<p class="meta">${
    'workstreamSlug' in p.provenance
      ? `learned from <code>${esc(p.provenance.workstreamSlug)}</code> pass <code>${esc(p.provenance.passId)}</code>${p.provenance.steeringId ? ` steering <code>${esc(p.provenance.steeringId)}</code>` : ''}`
      : `seeded by <code>${esc(p.provenance.source)}</code> from <code>${esc(p.provenance.ref)}</code>`
  } — ${esc(p.provenance.interventionSummary)}</p>
${evidence}${lineage}
</article>`;
}

function policySection(policies: PolicyRecord[], heading: string, note: string): string {
  const body = policies.length ? policies.map(policyCard).join('\n') : empty('No learned policies.');
  return `<section><h2>${esc(heading)} <span class="count">${policies.length}</span></h2><p class="hint">${esc(note)}</p>${body}</section>`;
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
.ws-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.page-nav { display:flex; gap:16px; margin:0 0 14px; font-size:13px; }
.page-nav a { text-decoration:none; }
a { color: var(--coord); }
footer { color: var(--dim); font-size: 12px; margin-top: 24px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 600; }
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

/** Policies relevant to one workstream: tag-matched or learned from it. */
export function policiesForWorkstream(policies: PolicyRecord[], doc: WorkstreamDoc): PolicyRecord[] {
  return policies.filter(
    (p) =>
      ('workstreamSlug' in p.provenance && p.provenance.workstreamSlug === doc.workstream.slug) ||
      p.scope.tags.some((t) => doc.workstream.tags.includes(t)),
  );
}

/** The task card: what this stream IS, before any knowledge detail — the
 * first question a returning human asks ("what is approvals-cleanup?") must
 * be the first thing the page answers. */
function taskSection(doc: WorkstreamDoc): string {
  const ws = doc.workstream;
  const latest = [...doc.decisions].reverse().find((d) => d.status === 'standing');
  const open = doc.attention.filter((a) => a.status === 'open');
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

export function renderWorkstreamHtml(doc: WorkstreamDoc, policies: PolicyRecord[]): string {
  const ws = doc.workstream;
  const body = [
    taskSection(doc),
    printoutSection(`../printouts/index.html#${encodeURIComponent(ws.slug)}`, 'this workstream’s'),
    decisionSection(doc),
    policySection(
      policiesForWorkstream(policies, doc),
      'Learned policies',
      'From the global store (state/policies.json): tag-matched or learned here. A policy can only add verification, narrow authority, or advise — authority is never learned.',
    ),
    interventionSection(doc),
    deliverableSection(doc),
    actionSection(doc),
  ].join('\n');
  return page(
    `${ws.title} — knowledge inspector`,
    `${ws.slug} · ${ws.status} · revision ${doc.revision} · ${doc.spend.coordinatorPasses} passes · $${doc.spend.totalCostUsd.toFixed(2)}`,
    body,
    // A workstream page is reachable directly (dashboard [i] on a selected
    // stream), so it always carries its own way back up to the fleet page.
    { href: '../inspect.html', label: '← all workstreams' },
    `../printouts/index.html#${encodeURIComponent(ws.slug)}`,
  );
}

export function renderOverviewHtml(
  docs: WorkstreamDoc[],
  policies: PolicyRecord[],
  unreadable: string[] = [],
): string {
  const cards = docs.map((doc) => {
    const ws = doc.workstream;
    const standing = doc.decisions.filter((d) => d.status === 'standing').length;
    const superseded = doc.decisions.length - standing;
    const adopted = doc.deliverables.filter((d) => d.adopted).length;
    const candidates = doc.deliverables.length - adopted;
    return `<article class="card">
<header><a href="${esc(ws.slug)}/inspect.html"><strong>${esc(ws.title)}</strong></a> <span class="pill status-${ws.status === 'active' ? 'active' : 'shadow'}">${esc(ws.status)}</span></header>
<p class="meta">${esc(ws.objective)}</p>
<table><tbody>
<tr><th>Decisions</th><td>${standing} standing · ${superseded} superseded</td></tr>
<tr><th>Deliverables</th><td>${adopted} adopted · ${candidates} candidate/rejected</td></tr>
<tr><th>Actions</th><td>${doc.assignments.filter((a) => a.kind === 'action').length}</td></tr>
<tr><th>Interventions</th><td>${doc.spend.humanInterventions}</td></tr>
<tr><th>Spend</th><td>${doc.spend.coordinatorPasses} passes · $${doc.spend.totalCostUsd.toFixed(2)}</td></tr>
<tr><th>Tags</th><td>${ws.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') || '(none)'}</td></tr>
</tbody></table>
</article>`;
  });
  // Skipped workstreams are named, never silently absent: a missing card must
  // not read as "no such workstream".
  const skipped = unreadable.length
    ? `<p class="hint bad">Unreadable, no page generated: ${unreadable.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p>`
    : '';
  const wsSection = `<section><h2>Workstreams <span class="count">${docs.length}</span></h2>${skipped}${
    docs.length ? `<div class="ws-grid">${cards.join('\n')}</div>` : empty('No workstreams under this WEAVER_HOME.')
  }</section>`;
  const body = [
    printoutSection('printouts/index.html', 'fleet'),
    wsSection,
    policySection(
      policies,
      'Global policy store',
      'Every learned policy across all workstreams, with provenance, evidence, and supersession lineage. Shadow policies shape plans but are cited on every application; promotion to active is earned by an intervention-free matching workstream.',
    ),
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
 */
export function runInspect(slug?: string): string {
  // The requested workstream is the one failure that must be loud: asking for
  // a page we cannot render is an error, not an empty site.
  if (slug) load(slug);
  const policies = loadPolicies().policies;
  const docs: WorkstreamDoc[] = [];
  const allSecrets = loadAllSecrets();
  const unreadable: string[] = [];
  for (const s of listWorkstreams()) {
    let doc: WorkstreamDoc;
    try {
      doc = load(s);
    } catch {
      // An unreadable doc is a state the dashboard already renders (UNREADABLE);
      // it must not blank out the knowledge pages of every healthy workstream.
      unreadable.push(s);
      continue;
    }
    docs.push(doc);
    writeRedacted(path.join(workstreamDir(s), 'inspect.html'), renderWorkstreamHtml(doc, policies), allSecrets);
  }
  const overview = path.join(weaverHome(), 'inspect.html');
  writeRedacted(overview, renderOverviewHtml(docs, policies, unreadable), allSecrets);
  writePrintoutIndex();
  return slug ? path.join(workstreamDir(slug), 'inspect.html') : overview;
}
