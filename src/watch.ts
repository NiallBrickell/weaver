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
import { infrastructureWaitSummary } from './capacity.js';
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
const CYAN = '\x1b[36m';
const WHITE = '\x1b[97m';

const STALE_ATTEMPT_MS = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 45 * 60_000);

type Bucket = 0 | 1 | 2 | 3 | 4; // needs-you, working, waiting, idle, broken

const BUCKET = {
  0: { dot: `${RED}●${R}`, word: `${RED}${BOLD}NEEDS YOU${R}`, plain: 'NEEDS YOU' },
  1: { dot: `${GREEN}●${R}`, word: `${GREEN}WORKING${R}`, plain: 'WORKING' },
  2: { dot: `${BLUE}●${R}`, word: `${BLUE}WAITING${R}`, plain: 'WAITING' },
  3: { dot: `${DIM}●${R}`, word: `${DIM}IDLE${R}`, plain: 'IDLE' },
  4: { dot: `${RED}${BOLD}✗${R}`, word: `${RED}${BOLD}UNREADABLE${R}`, plain: 'UNREADABLE' },
} as const;

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

/** Budget bar: ▰▰▰▱▱▱▱▱, turning amber past 70% and red past 90%. */
function bar(spent: number, max: number, cells = 8): string {
  const frac = max > 0 ? Math.min(1, spent / max) : 0;
  const filled = Math.round(frac * cells);
  const color = frac > 0.9 ? RED : frac > 0.7 ? AMBER : CYAN;
  return `${color}${'▰'.repeat(filled)}${DIM}${'▱'.repeat(cells - filled)}${R}`;
}

function width(): number {
  return Math.max(60, Math.min(process.stdout.columns ?? 120, 160));
}

/** Truncate the PLAIN text of a detail line to fit; colors applied by caller. */
function fit(text: string, reserved: number): string {
  const room = width() - reserved;
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

function wrap(text: string, reserved: number): string[] {
  const room = Math.max(30, width() - reserved);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > room) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface WsView {
  slug: string;
  bucket: Bucket;
  /** The one-line summary row (without the slug column, which is padded globally). */
  row: string;
  details: string[];
}

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
      row: `${RED}CANNOT READ STATE: ${e instanceof Error ? e.message : e}${R}`,
      details: [],
    };
  }
  const ws = doc.workstream;
  const details: string[] = [];

  let needsYou = 0;
  for (const a of doc.attention.filter((x) => x.status === 'open')) {
    needsYou++;
    const first = a.summary.split('\n')[0]!;
    details.push(`${RED}▸ [${a.kind}]${R} ${fit(first, 14 + a.kind.length)}`);
    details.push(`  ${DIM}→ weaver status ${slug}   (resolve: weaver resolve ${slug} ${a.id})${R}`);
  }
  for (const a of doc.assignments.filter((x) => x.state === 'gated')) {
    needsYou++;
    details.push(`${RED}▸ gated action${R} ${fit(`"${a.objective}"`, 20)}`);
    details.push(`  ${DIM}→ weaver approve-action ${slug} ${a.id}${R}`);
  }
  for (const i of doc.interactions.filter((x) => x.status === 'awaiting_approval')) {
    needsYou++;
    details.push(`${RED}▸ send awaiting approval${R} ${fit(`${i.kind} to ${i.to} "${i.subject}"`, 30)}`);
    details.push(`  ${DIM}→ weaver approve ${slug} ${i.id}${R}`);
  }

  let working = 0;
  for (const a of doc.assignments.filter((x) => x.state === 'running')) {
    const t = a.attempts[a.attempts.length - 1];
    if (attemptFresh(a)) {
      working++;
      details.push(`${GREEN}▸ ${a.id}${R} (${a.kind}) ${fit(`"${a.objective}"`, 26)} ${GREEN}${t ? elapsed(t.startedAt) : ''}${R}`);
    } else {
      working++;
      details.push(`${AMBER}▸ ${a.id} stale attempt — next tick recovers by readback${R}`);
    }
  }
  const leaseHeld = doc.lease && new Date(doc.lease.expiresAt).getTime() > Date.now();
  if (leaseHeld) {
    working++;
    details.push(`${GREEN}▸ coordinator pass in flight${R} ${DIM}${doc.lease!.passId}${R}`);
  }
  const queued = doc.assignments.filter((x) => x.state === 'queued' || x.state === 'awaiting_review').length;
  if (queued) details.push(`${DIM}▸ ${queued} assignment(s) queued/awaiting review — next tick${R}`);

  const nowV = virtualNow().toISOString();
  const pendingWakes = doc.wakes.filter((w) => w.status === 'pending');
  const infrastructure = [...new Set(
    Object.values(doc.capacity?.byModel ?? {})
      .map((entry) => infrastructureWaitSummary(entry.wait)),
  )];
  for (const summary of infrastructure) {
    const lines = wrap(summary, 17);
    details.push(`${BLUE}${BOLD}▸ WAITING${R} ${lines[0] ?? ''}`);
    details.push(...lines.slice(1).map((line) => `  ${DIM}${line}${R}`));
  }
  // Typed infrastructure waits have a safe summary above. Never fall back to
  // their raw provider reason; ordinary wakes retain their existing display.
  const normalWakes = pendingWakes.filter((w) => !w.infrastructure);
  const dueNow = normalWakes.filter(
    (w) => w.condition.type === 'immediate' || w.condition.dueAtVirtual <= nowV,
  ).length;
  const nextWake = normalWakes
    .filter((w) => w.condition.type === 'time' && w.condition.dueAtVirtual > nowV)
    .sort((a, b) =>
      (a.condition as { dueAtVirtual: string }).dueAtVirtual.localeCompare(
        (b.condition as { dueAtVirtual: string }).dueAtVirtual,
      ),
    )[0];
  if (dueNow && !working && !queued) details.push(`${BLUE}▸ ${dueNow} wake(s) due — runner will pick up${R}`);
  else if (nextWake && !working)
    details.push(
      `${BLUE}▸ next wake ${(nextWake.condition as { dueAtVirtual: string }).dueAtVirtual.slice(0, 16)}${R} ${DIM}${fit(nextWake.reason, 40)}${R}`,
    );

  const lastEvent = doc.events[doc.events.length - 1];
  if (lastEvent) {
    details.push(`${DIM}  last [${lastEvent.at.slice(11, 19)}] ${lastEvent.type}: ${fit(lastEvent.summary, 28)}${R}`);
  }

  const bucket: Bucket =
    ws.status === 'paused' && !needsYou
      ? 3
      : needsYou
        ? 0
        : working || queued
          ? 1
          : ws.status === 'active' && pendingWakes.length
            ? 2
            : 3;

  const paused = ws.status === 'paused' ? ` ${DIM}[paused]${R}` : '';
  const row =
    `${BUCKET[bucket].word}${' '.repeat(Math.max(1, 11 - BUCKET[bucket].plain.length))}` +
    `${bar(doc.spend.totalCostUsd, ws.budget.maxCostUsd)} ` +
    `${DIM}$${doc.spend.totalCostUsd.toFixed(2)}/$${ws.budget.maxCostUsd}${R} ` +
    `${DIM}· passes ${doc.spend.coordinatorPasses}/${ws.budget.maxCoordinatorPasses}` +
    ` · you ${doc.spend.humanInterventions ?? 0}×${R}${paused}`;

  return { slug, bucket, row, details };
}

function frame(): string {
  const slugs = listWorkstreams();
  const views = slugs
    .map(viewOf)
    .sort((a, b) => a.bucket - b.bucket || a.slug.localeCompare(b.slug));
  const counts = [0, 0, 0, 0, 0];
  for (const v of views) counts[v.bucket]! += 1;
  const w = width();

  const now = new Date();
  const vNow = virtualNow();
  const drift =
    Math.abs(vNow.getTime() - now.getTime()) > 60_000
      ? `${AMBER}virtual ${vNow.toISOString().slice(0, 16)}${R}  `
      : '';

  const countsStr =
    (counts[0] ? `${RED}${BOLD}${counts[0]} need you${R}` : `${DIM}0 need you${R}`) +
    ` ${DIM}·${R} ${GREEN}${counts[1]} working${R}` +
    ` ${DIM}·${R} ${BLUE}${counts[2]} waiting${R}` +
    ` ${DIM}·${R} ${DIM}${counts[3]} idle${R}` +
    (counts[4] ? ` ${DIM}·${R} ${RED}${BOLD}${counts[4]} UNREADABLE${R}` : '');

  const top = `${DIM}╭${'─'.repeat(w - 2)}╮${R}`;
  const title = `${DIM}│${R} ${BOLD}${WHITE}W E A V E R${R}   ${countsStr}`;
  const clock = `${drift}${DIM}${now.toTimeString().slice(0, 8)}${R}`;
  // Right-align the clock inside the box using plain lengths.
  const plainTitleLen =
    2 + 11 + 3 +
    `${counts[0]} need you · ${counts[1]} working · ${counts[2]} waiting · ${counts[3]} idle${counts[4] ? ` · ${counts[4]} UNREADABLE` : ''}`.length;
  const plainClockLen = (drift ? `virtual ${vNow.toISOString().slice(0, 16)}  ` : '').length + 8;
  const gap = Math.max(1, w - plainTitleLen - plainClockLen - 2);
  const header = [top, `${title}${' '.repeat(gap)}${clock} ${DIM}│${R}`, `${DIM}╰${'─'.repeat(w - 2)}╯${R}`].join('\n');

  const slugPad = Math.max(12, ...views.map((v) => v.slug.length)) + 2;
  const body = views.length
    ? views
        .map((v) => {
          const name = `${BOLD}${v.slug}${R}${' '.repeat(Math.max(1, slugPad - v.slug.length))}`;
          const lines = [` ${BUCKET[v.bucket].dot} ${name}${v.row}`];
          for (const d of v.details) lines.push(`     ${d}`);
          return lines.join('\n');
        })
        .join('\n\n')
    : `${DIM} (no workstreams under ${weaverHome()} — weaver create ...)${R}`;

  const foot = `${DIM} q quit · read-only · run shown commands in your own shell · state: ${weaverHome()}${R}`;
  return `${header}\n\n${body}\n\n${foot}\n`;
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
  process.stdout.on('resize', render);

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
