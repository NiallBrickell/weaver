/**
 * `weaver watch` — an always-on terminal dashboard over ALL workstreams.
 *
 * Everything rendered is a projection of typed state: no transcript parsing,
 * no idle-minute liveness guessing, no LLM narration (the failure modes that
 * sank transcript-scraping fleet monitors). If a doc can't be read, that is
 * rendered as a loud failure line — never as an empty screen.
 *
 * Read-only by design: the dashboard shows the exact command for anything
 * that needs a human, it never runs one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { virtualNow } from './clock.js';
import { listWorkstreams, weaverHome, workstreamDir } from './store.js';
import type { Assignment, WorkstreamDoc } from './types.js';

const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const AMBER = '\x1b[33m';
const BLUE = '\x1b[34m';

const STALE_ATTEMPT_MS = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 10 * 60_000);

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

interface WsView {
  slug: string;
  lines: string[];
  /** Sort/count bucket: 0 needs-you, 1 working, 2 waiting, 3 idle/done, 4 broken. */
  bucket: 0 | 1 | 2 | 3 | 4;
}

/** True while an attempt is open and younger than the crash-recovery horizon. */
function attemptFresh(a: Assignment): boolean {
  const t = a.attempts[a.attempts.length - 1];
  return !!t && !t.endedAt && Date.now() - new Date(t.startedAt).getTime() < STALE_ATTEMPT_MS;
}

function viewOf(slug: string): WsView {
  let doc: WorkstreamDoc;
  try {
    doc = JSON.parse(
      fs.readFileSync(path.join(workstreamDir(slug), 'workstream.json'), 'utf8'),
    ) as WorkstreamDoc;
  } catch (e) {
    return {
      slug,
      bucket: 4,
      lines: [`${RED}${BOLD}✗ ${slug} — CANNOT READ STATE: ${e instanceof Error ? e.message : e}${R}`],
    };
  }
  const ws = doc.workstream;

  const needsYou: string[] = [];
  for (const a of doc.attention.filter((x) => x.status === 'open')) {
    // One glanceable line; the full text lives in `weaver status <slug>`.
    const first = a.summary.split('\n')[0]!;
    const brief = first.length > 160 ? `${first.slice(0, 157)}…` : first;
    needsYou.push(`${RED}● [${a.kind}] ${brief}${R}  ${DIM}→ weaver status ${slug}${R}`);
  }
  for (const a of doc.assignments.filter((x) => x.state === 'gated')) {
    needsYou.push(
      `${RED}● gated action "${a.objective.slice(0, 70)}"${R}  ${DIM}→ weaver approve-action ${slug} ${a.id}${R}`,
    );
  }
  for (const i of doc.interactions.filter((x) => x.status === 'awaiting_approval')) {
    needsYou.push(
      `${RED}● send awaiting approval: ${i.kind} to ${i.to} "${i.subject}"${R}  ${DIM}→ weaver approve ${slug} ${i.id}${R}`,
    );
  }

  const working: string[] = [];
  const suspect: string[] = [];
  for (const a of doc.assignments.filter((x) => x.state === 'running')) {
    const t = a.attempts[a.attempts.length - 1];
    const line = `${a.id} (${a.kind}) "${a.objective.slice(0, 70)}" ${t ? elapsed(t.startedAt) : '?'}`;
    if (attemptFresh(a)) working.push(`${GREEN}▶ ${line}${R}`);
    else suspect.push(`${AMBER}◆ ${line} — stale attempt; next tick will recover by readback${R}`);
  }
  const leaseHeld = doc.lease && new Date(doc.lease.expiresAt).getTime() > Date.now();
  if (leaseHeld) working.push(`${GREEN}▶ coordinator pass ${doc.lease!.passId} in flight${R}`);
  for (const a of doc.assignments.filter((x) => x.state === 'awaiting_review')) {
    working.push(`${DIM}⏳ ${a.id} awaiting coordinator review — next tick${R}`);
  }
  for (const a of doc.assignments.filter((x) => x.state === 'queued')) {
    working.push(`${DIM}⏳ ${a.id} queued — next tick${R}`);
  }

  const waiting: string[] = [];
  const pendingWakes = doc.wakes.filter((w) => w.status === 'pending');
  const nowV = virtualNow().toISOString();
  for (const w of pendingWakes) {
    const due =
      w.condition.type === 'immediate'
        ? 'due NOW — run a tick'
        : w.condition.dueAtVirtual <= nowV
          ? 'due NOW — run a tick'
          : `due ${w.condition.dueAtVirtual.slice(0, 16)}`;
    waiting.push(`${BLUE}○ wake: ${w.reason.slice(0, 80)} (${due})${R}`);
  }

  const bucket: WsView['bucket'] = needsYou.length
    ? 0
    : working.length || suspect.length
      ? 1
      : ws.status === 'active' && waiting.length
        ? 2
        : 3;

  const glyph =
    bucket === 0 ? `${RED}●${R}` : bucket === 1 ? `${GREEN}▶${R}` : bucket === 2 ? `${BLUE}○${R}` : `${DIM}■${R}`;
  const spent = doc.spend.totalCostUsd;
  const header =
    `${glyph} ${BOLD}${slug}${R} — ${ws.title}  ` +
    `${DIM}[${ws.status}] $${spent.toFixed(2)}/$${ws.budget.maxCostUsd} · ` +
    `passes ${doc.spend.coordinatorPasses}/${ws.budget.maxCoordinatorPasses} · ` +
    `interventions ${doc.spend.humanInterventions ?? 0} · rev ${doc.revision}${R}`;

  const lastEvent = doc.events[doc.events.length - 1];
  const lines = [
    header,
    ...needsYou.map((l) => `    ${l}`),
    ...suspect.map((l) => `    ${l}`),
    ...working.map((l) => `    ${l}`),
    ...waiting.slice(0, 3).map((l) => `    ${l}`),
    ...(lastEvent
      ? [`    ${DIM}last: [${lastEvent.at.slice(11, 19)}] ${lastEvent.type}: ${lastEvent.summary.slice(0, 90)}${R}`]
      : []),
  ];
  return { slug, bucket, lines };
}

function frame(): string {
  const slugs = listWorkstreams();
  const views = slugs.map(viewOf).sort((a, b) => a.bucket - b.bucket || a.slug.localeCompare(b.slug));
  const counts = [0, 0, 0, 0, 0];
  for (const v of views) counts[v.bucket]! += 1;

  const now = new Date();
  const vNow = virtualNow();
  const drift = Math.abs(vNow.getTime() - now.getTime()) > 60_000 ? ` · virtual ${vNow.toISOString().slice(0, 16)}` : '';
  const head =
    `${BOLD}WEAVER${R}  ${counts[0] ? `${RED}${counts[0]} NEED YOU${R}` : `${DIM}0 need you${R}`} · ` +
    `${GREEN}${counts[1]} working${R} · ${BLUE}${counts[2]} waiting${R} · ${DIM}${counts[3]} idle${R}` +
    (counts[4] ? ` · ${RED}${BOLD}${counts[4]} UNREADABLE${R}` : '') +
    `   ${DIM}${now.toTimeString().slice(0, 8)}${drift} · ${weaverHome()}${R}`;

  const body = views.length
    ? views.flatMap((v) => ['', ...v.lines]).join('\n')
    : `\n${DIM}(no workstreams under ${weaverHome()} — weaver create ...)${R}`;

  return `${head}\n${body}\n\n${DIM}q quit · refreshes every 2s · dashboard is read-only, commands shown are for your shell${R}\n`;
}

export async function runWatch(): Promise<void> {
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
  const restore = () => {
    out.write('\x1b[?25h\x1b[?1049l');
  };
  let last = '';
  const render = () => {
    let f: string;
    try {
      f = frame();
    } catch (e) {
      f = `${RED}watch render failed: ${e instanceof Error ? e.message : e}${R}\n`;
    }
    if (f === last) return; // content-hash suppression: quiet ≠ redraw
    last = f;
    out.write('\x1b[2J\x1b[H' + f);
  };
  render();
  const timer = setInterval(render, 2000);

  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', (b) => {
      const s = b.toString();
      if (s === 'q' || s === '\x03') resolve();
    });
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });

  clearInterval(timer);
  restore();
  process.exit(0);
}
