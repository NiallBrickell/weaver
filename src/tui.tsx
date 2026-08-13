/**
 * `weaver watch` — the interactive dashboard (Ink).
 *
 * The design center is the NEEDS-YOU queue: the only turns a human should
 * spend on a workstream are judgment calls, so those are the first thing on
 * screen and every one is answerable with a single keypress. Everything else
 * (running workers, wakes, activity age) is glanceable context below.
 *
 * All state shown is a projection of typed workstream state — no transcript
 * parsing, no liveness guessing. Human keypresses call the same first-class
 * mutations as the CLI (src/humanActs.ts): approving here IS the approval.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import {
  capacityPresentation,
  hasCapacityBackoffForWait,
  providerCapacityHeadline,
} from './capacity.js';
import { activitySummary } from './activity.js';
import { isLegacyDollarBudgetAttention, isWakeDue } from './executionSafety.js';
import { virtualNow } from './clock.js';
import {
  approveAction,
  approveSend,
  rejectAction,
  rejectSend,
  resolveAttention,
  addSteering,
  setPaused,
} from './humanActs.js';
import { execFile } from 'node:child_process';
import { runInspect } from './inspect.js';
import { requestedPrintoutScope } from './printoutControls.js';
import { publishPrintoutHtml } from './printoutHtml.js';
import { acquireRunnerLock, liveRunnerPid, promoteOnRunnerVacancy, runLoop, runnerLoopHealthy } from './runner.js';
import { listWorkstreams, load, weaverHome } from './store.js';
import type { ProviderCapacityObservation, WorkstreamDoc } from './types.js';

const STALE_ATTEMPT_MS = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 45 * 60_000);

// ---------------------------------------------------------------------------
// Data

interface NeedsYouItem {
  key: string;
  slug: string;
  kind: 'action' | 'send' | 'attention';
  refId: string;
  title: string;
  body: string;
}

interface StreamRow {
  slug: string;
  bucket: 0 | 1 | 2 | 3 | 4 | 5;
  /** Bucket 2 split: due right now (in line for the runner) vs scheduled later. */
  queuedNow: boolean;
  /** Tagged 'routine': a standing recurring loop, demarcated in its own section. */
  routine: boolean;
  /** Earliest future scheduled wake — a routine's "next run". */
  nextRun?: string;
  /** That wake's reason — WHAT the stream is waiting for, shown inline. */
  nextReason?: string;
  /** Safe typed infrastructure position; raw provider errors never render. */
  infrastructureWait?: string;
  /** Set when capacity — not a schedule — is what holds this stream. The row
   * renders its own state word off this, because "waiting for its next wake"
   * and "parked behind a provider limit" are different situations an operator
   * has to tell apart at a glance, and the board used to spell both WAITING. */
  capacityBlock?: { summary: string; needsHuman: boolean };
  /** Honest elapsed execution / decision age from durable timestamps. */
  activity?: string;
  paused: boolean;
  details: string[];
  /** The task card ([enter] on the row): what this stream IS — its objective
   * plus latest standing decision — so "what is this and what's it doing?"
   * never requires the CLI or an external page. */
  objective: string;
  latestDecision?: string;
  /** When the stream concluded (virtual clock) — drives leaving the board. */
  concludedAtVirtual?: string;
  /** Manager stream slug (create_workstream lineage), when managed. */
  managedBy?: string;
  /** Nesting depth under its manager in the rendered board (0 = root). */
  depth: number;
  error?: string;
}

/**
 * Children render directly under their manager, indented — the managedBy
 * lineage a flat board hid. A child inherits its manager's SECTION (routine
 * or not): a one-shot fix stream spawned by a routine belongs visually with
 * the routine that owns it. Cycle or dangling-manager rows fall back to root.
 */
export function nestUnderManagers(streams: StreamRow[]): StreamRow[] {
  const bySlug = new Map(streams.map((s) => [s.slug, s]));
  const kids = new Map<string, StreamRow[]>();
  const roots: StreamRow[] = [];
  for (const s of streams) {
    const mgr = s.managedBy ? bySlug.get(s.managedBy) : undefined;
    if (mgr && mgr !== s) {
      const list = kids.get(mgr.slug) ?? [];
      list.push(s);
      kids.set(mgr.slug, list);
    } else roots.push(s);
  }
  const nested: StreamRow[] = [];
  const place = (s: StreamRow, depth: number, routine: boolean): void => {
    if (nested.includes(s)) return;
    s.depth = depth;
    s.routine = routine;
    nested.push(s);
    if (depth < 3) for (const k of kids.get(s.slug) ?? []) place(k, depth + 1, routine);
  };
  for (const r of roots) place(r, 0, r.routine);
  for (const s of streams) if (!nested.includes(s)) { s.depth = 0; nested.push(s); }
  return nested;
}

interface Snapshot {
  items: NeedsYouItem[];
  streams: StreamRow[];
  capacityHeadline?: string;
  /** DONE streams past their linger window — off the board, still on record. */
  archivedDone: number;
}

/** How long a finished workstream stays on the board before leaving it.
 * Half a day: long enough to see an outcome land the same working day,
 * short enough that a busy fleet's board stays about live work. */
const DONE_LINGER_MS = Number(process.env.WEAVER_DONE_LINGER_HOURS ?? 12) * 3_600_000;

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function until(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const m = Math.ceil(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / (24 * 60))}d`;
}

/**
 * A wake reason is coordinator prose; the row gets its first SUBSTANTIVE
 * clause. Scheduling jargon ("Backstop:", "Safety net for…") is how the
 * coordinator talks to itself — stripped, so the row says what is being
 * waited FOR, not what kind of wait it is.
 */
function waitLabel(reason: string): string {
  const flat = reason
    .replace(/\s+/g, ' ')
    .replace(/^(backstop|safety net|fallback|retry|reconcile)\b[^:—-]*[:—-]\s*/i, '')
    .trim();
  const clause = flat.split(/[.;(]/)[0]!.trim();
  return (clause.length > 12 ? clause : flat).slice(0, 64);
}

function wrapDetail(text: string, columns: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > columns) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Cached pilot liveness, probed off the render path. The pilot-pending grace
 * window is 120s when pilot may be down (fail closed, visibly) — but while
 * pilot is demonstrably alive, a gated action is pilot's to rule on, not the
 * human's, however long the runner's tick takes to get there: cards leaking
 * into NEEDS YOU during busy-fleet tick latency spooked the human into
 * approving what pilot was seconds from handling.
 */
let pilotOkAt = 0;
function probePilot(): void {
  const base = process.env.WEAVER_PILOT_URL ?? 'http://127.0.0.1:9721';
  fetch(`${base}/status`, { signal: AbortSignal.timeout(3_000) })
    .then((r) => { if (r.ok) pilotOkAt = Date.now(); })
    .catch(() => {});
}

/**
 * Word-wrap into EXACT single rows for the height-budgeted panes. Ink's own
 * wrapping desyncs the frame (one wrapped line = ghost frames), and
 * truncate-end silently amputates a long paragraph — "expanded" once showed
 * only the first terminal-width of each line. Pre-wrapping keeps line math
 * exact AND makes every character reachable via [ ] scrolling.
 */
function wrapRows(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      rows.push(' ');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && line.length + 1 + word.length > width) {
        rows.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
      while (line.length > width) {
        rows.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    if (line) rows.push(line);
  }
  return rows;
}

async function snapshot(): Promise<Snapshot> {
  const items: NeedsYouItem[] = [];
  const streams: StreamRow[] = [];
  const providerCapacity: ProviderCapacityObservation[] = [];
  for (const slug of await listWorkstreams()) {
    let doc: WorkstreamDoc;
    try {
      // Through the store so the dashboard reflects whichever backend
      // WEAVER_STORE selected; snapshot() is an effect, not a render path.
      doc = await load(slug);
    } catch (e) {
      streams.push({
        slug, bucket: 4, queuedNow: false, routine: false, paused: false, depth: 0,
        details: [], objective: '', error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const ws = doc.workstream;
    providerCapacity.push(...(doc.providerCapacity ?? []));

    // ONE decision = ONE row. Approvable things (gated actions, pending
    // sends) render as themselves; attention items that merely point AT one
    // of them are commentary and fold into it, and multiple attention items
    // about the same ref collapse to the first.
    let needsYou = 0;
    const gated = doc.assignments.filter((x) => x.state === 'gated');
    const pendingSends = doc.interactions.filter((x) => x.status === 'awaiting_approval');
    const approvableIds = new Set<string>([...gated.map((a) => a.id), ...pendingSends.map((i) => i.id)]);
    const commentary = new Map<string, string[]>();
    const seenRefs = new Set<string>();
    const seenSummaries = new Set<string>();
    for (const a of doc.attention.filter((x) => x.status === 'open' && !isLegacyDollarBudgetAttention(x))) {
      if (a.refId && approvableIds.has(a.refId)) {
        commentary.set(a.refId, [...(commentary.get(a.refId) ?? []), a.summary]);
        continue;
      }
      if (a.refId && seenRefs.has(a.refId)) continue;
      if (a.refId) seenRefs.add(a.refId);
      // Identical word-for-word cards (e.g. repeated strike triples during
      // one outage) are one decision, not N — show the first only. Resolving
      // it clears the twins too (the resolve path matches by summary).
      if (seenSummaries.has(a.summary)) continue;
      seenSummaries.add(a.summary);
      needsYou++;
      items.push({
        key: `${slug}:${a.id}`, slug, kind: 'attention', refId: a.id,
        title: a.summary.split('\n')[0]!.slice(0, 120),
        body: a.summary,
      });
    }
    const pendingPilot: string[] = [];
    for (const a of gated) {
      // Intermediate state: a fresh gated action the pilot hasn't ruled on
      // yet is NOT the human's decision — surfacing it early makes cards
      // flash into the queue and vanish when pilot approves a tick later
      // (spooking the human into approving what pilot was about to handle).
      // It reaches NEEDS YOU only when pilot escalated it, or when no verdict
      // arrived within the grace window (pilot down ⇒ fail closed, visibly).
      const ageMs = Date.now() - new Date(a.createdAtVirtual).getTime();
      const noVerdict = !a.exec?.pilotVerdict;
      // Healthy pilot ⇒ long grace (it WILL rule; only a stuck runner should
      // surface this). Pilot silent >90s ⇒ short grace, fail closed visibly.
      const grace = Date.now() - pilotOkAt < 90_000 ? 600_000 : 120_000;
      if (noVerdict && ageMs < grace) {
        pendingPilot.push(`⧗ awaiting pilot: "${a.objective.slice(0, 70)}"`);
        continue;
      }
      needsYou++;
      const notes = commentary.get(a.id);
      // The card is the plain-language ask, then THE ACTUAL COMMANDS (pulled
      // from the briefing's fenced code blocks) — what gets executed is the
      // thing being approved, so it is never buried. Full briefing last.
      const escalated = a.exec?.pilotVerdict && a.exec.pilotVerdict.decision !== 'approve';
      const ask = (escalated ? `pilot escalated (${a.exec!.pilotVerdict!.reason.slice(0, 60)}): ` : '') + (a.exec?.ask ?? a.objective);
      const commands = a.exec?.run
        ? [a.exec.run]
        : [...a.briefing.matchAll(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g)].map((m) => m[1]!.trimEnd());
      items.push({
        key: `${slug}:${a.id}`, slug, kind: 'action', refId: a.id,
        title: `approve? ${ask.slice(0, 115)}`,
        body: [
          ask,
          ``,
          `runs in: ${a.exec?.cwd ?? '?'}`,
          ...(commands.length
            ? [``, `commands it will run:`, ...commands.join('\n').split('\n').map((l) => `  $ ${l}`)]
            : [``, `(no explicit commands in the briefing — the worker chooses its own; enter for the full brief)`]),
          ``,
          `— audit trail —`,
          `verification (harness-run, confirms the outcome): ${a.exec?.verify ?? '?'}`,
          ...(notes ? [``, `coordinator notes:`, ...notes] : []),
          ``,
          `full worker briefing:`,
          a.briefing,
        ].join('\n'),
      });
    }
    for (const i of pendingSends) {
      needsYou++;
      const notes = commentary.get(i.id);
      items.push({
        key: `${slug}:${i.id}`, slug, kind: 'send', refId: i.id,
        title: `approve send? ${i.kind} to ${i.to} — "${i.subject}"`,
        body: `draft deliverable ${i.deliverableId} (weaver show ${slug} ${i.deliverableId})${notes ? `\n\ncoordinator says:\n${notes.join('\n---\n')}` : ''}`,
      });
    }

    const details: string[] = [];
    let working = 0;
    for (const a of doc.assignments.filter((x) => x.state === 'running')) {
      const t = a.attempts[a.attempts.length - 1];
      const fresh = !!t && !t.endedAt && Date.now() - new Date(t.startedAt).getTime() < STALE_ATTEMPT_MS;
      working++;
      details.push(
        fresh
          ? `▶ ${a.id} (${a.kind}) "${a.objective.slice(0, 80)}" ${t ? elapsed(t.startedAt) : ''}`
          : `◆ ${a.id} stale attempt — next tick recovers by readback`,
      );
    }
    const leaseHeld = doc.lease && new Date(doc.lease.expiresAt).getTime() > Date.now();
    if (leaseHeld) { working++; details.push(`▶ coordinator pass in flight`); }
    const queued = doc.assignments.filter((x) => x.state === 'queued' || x.state === 'awaiting_review').length;
    if (queued) details.push(`… ${queued} assignment(s) queued/awaiting review`);
    const wallNow = new Date();
    const virtual = virtualNow();
    const nowV = virtual.toISOString();
    const pending = doc.wakes.filter((w) => w.status === 'pending');
    const capacity = capacityPresentation(doc, nowV);
    const operationalPending = pending.filter((wake) =>
      !wake.infrastructure ||
      capacity.relevantSourceIds.includes(wake.infrastructure.sourceId) ||
      !hasCapacityBackoffForWait(doc, wake.infrastructure),
    );
    const dueNow = operationalPending.filter((w) => isWakeDue(w.condition, wallNow, virtual)).length;
    if (dueNow && !working) details.push(`○ ${dueNow} wake(s) due — in line for the runner`);
    const last = doc.events[doc.events.length - 1];
    if (last) details.push(`  last [${last.at.slice(11, 19)}] ${last.type}: ${last.summary.slice(0, 90)}`);

    const bucket: StreamRow['bucket'] =
      ws.status === 'paused' && !needsYou ? 3
      : needsYou ? 0
      : capacity.blocking && !working ? 2
      : working || queued ? 1
      : ws.status === 'active' && operationalPending.length ? 2
      : 3;

    // Steering must be VISIBLY acknowledged the moment it lands: an
    // unconsumed steer means "heard — the next coordinator pass acts on it".
    const pendingSteers = doc.steering.filter((s) => !s.consumedByPass).length;
    if (pendingSteers) {
      details.unshift(`✉ steering received — coordinator acts on it next pass (${pendingSteers} pending)`);
    }
    // Pilot-pending actions live in the stream details (visible, not yours).
    details.unshift(...pendingPilot);
    // Capacity is rendered from the shared role-aware projection. Historical,
    // overdue, or fallback-covered records are never labelled WAITING.
    const detailWidth = Math.max(40, (process.stdout.columns ?? 120) - 20);
    const infrastructureDetails = capacity.details.flatMap((summary) =>
      wrapDetail(summary, detailWidth).map((line, index) =>
        index === 0 ? `○ ${line}` : `  ${line}`,
      ),
    );
    details.unshift(...infrastructureDetails);

    // A DONE stream's details ARE its outcome — the dashboard is the only
    // surface the operator uses, so "what did it actually do" must live here,
    // not in a CLI they won't open: the conclusion (with its evidence), then
    // the hard tallies (readback-confirmed acts, adopted artifacts).
    if (ws.status === 'done') {
      details.length = 0;
      const legacy = [...doc.events].reverse().find((e) => e.type === 'workstream.concluded');
      const conclusion = ws.conclusion;
      const text = conclusion?.summary ?? legacy?.summary.replace(/^coordinator concluded the workstream:\s*/, '');
      if (conclusion) {
        details.push(`✓ typed completion evidence: ${conclusion.evidenceIds.join(', ')}`);
        details.push(`  coordinator account (informational): ${text!.slice(0, 105)}`);
      } else if (text) {
        details.push(`⚠ legacy conclusion, evidence unvalidated: ${text.slice(0, 105)}`);
      }
      if (text) {
        for (let off = 105; off < Math.min(text.length, 315); off += 105) {
          details.push(`  ${text.slice(off, off + 105)}`);
        }
      }
      const verifiedActs = doc.assignments.filter((x) => x.kind === 'action' && x.exec?.verified?.ok).length;
      const adopted = doc.deliverables.filter((x) => x.adopted).length;
      details.push(`  ${verifiedActs} verified action(s) · ${adopted} adopted deliverable(s) · ${doc.spend.coordinatorPasses} passes · ${doc.spend.humanInterventions ?? 0} human interventions — [i] full record`);
    }

    const nextInfrastructureWake = operationalPending
      .filter((w) => capacity.blocking && w.infrastructure && w.condition.type === 'time' && w.condition.dueAtVirtual > nowV)
      .sort((a, b) =>
        (a.condition as { dueAtVirtual: string }).dueAtVirtual.localeCompare(
          (b.condition as { dueAtVirtual: string }).dueAtVirtual,
        ),
      )[0];
    const nextExecutionWake = operationalPending
      .filter((w) => w.executionSafety && w.condition.type === 'wall_time' && w.condition.dueAt > wallNow.toISOString())
      .sort((a, b) =>
        (a.condition as { dueAt: string }).dueAt.localeCompare((b.condition as { dueAt: string }).dueAt),
      )[0];
    const nextWake = operationalPending
      .filter((w) => !w.infrastructure && !w.executionSafety && w.condition.type === 'time' && w.condition.dueAtVirtual > nowV)
      .sort((a, b) =>
        (a.condition as { dueAtVirtual: string }).dueAtVirtual.localeCompare(
          (b.condition as { dueAtVirtual: string }).dueAtVirtual,
        ),
      )[0];
    const displayedWake = nextInfrastructureWake ?? nextExecutionWake ?? nextWake;
    const nextRun = displayedWake
      ? displayedWake.condition.type === 'wall_time'
        ? displayedWake.condition.dueAt
        : (displayedWake.condition as { dueAtVirtual: string }).dueAtVirtual
      : undefined;
    const concludedAtVirtual = ws.status === 'done'
      ? ws.conclusion?.atVirtual
        ?? [...doc.events].reverse().find((e) => e.type === 'workstream.concluded')?.at
        ?? last?.at
        ?? ws.createdAt
      : undefined;
    streams.push({
      slug,
      bucket: ws.status === 'done' ? 5 : bucket,
      concludedAtVirtual,
      queuedNow: dueNow > 0 || pendingSteers > 0,
      routine: ws.tags.includes('routine'),
      managedBy: ws.managedBy?.slug,
      depth: 0,
      nextRun,
      nextReason: displayedWake?.reason,
      infrastructureWait: capacity.blocking?.summary,
      // Only when capacity is what actually holds the stream — a stream with
      // work in flight has already routed around the limit and must not wear
      // the badge, however many stale per-model records it still carries.
      capacityBlock: capacity.blocking && !working
        ? { summary: capacity.blocking.summary, needsHuman: capacity.blocking.needsHuman }
        : undefined,
      activity: activitySummary(doc, wallNow, virtual),
      paused: ws.status === 'paused',
      details,
      objective: ws.objective,
      latestDecision: [...doc.decisions].reverse().find((x) => x.status === 'standing')?.title,
    });
  }
  streams.sort((a, b) => a.bucket - b.bucket || a.slug.localeCompare(b.slug));
  items.sort((a, b) => a.slug.localeCompare(b.slug));
  const nested = nestUnderManagers(streams);
  // Finished work earns a few days on the board, then leaves it: the dashboard
  // is for what's moving or needs someone, and a wall of green rows buries
  // that. The record never leaves — [i], printouts, and the CLI read the same
  // typed state; nothing here mutates or deletes a workstream.
  const cutoff = virtualNow().getTime() - DONE_LINGER_MS;
  const visible = nested.filter(
    (s) => !s.concludedAtVirtual || new Date(s.concludedAtVirtual).getTime() > cutoff,
  );
  return {
    items,
    streams: visible,
    archivedDone: nested.length - visible.length,
    capacityHeadline: providerCapacityHeadline(providerCapacity),
  };
}

// ---------------------------------------------------------------------------
// UI

// Color semantics: red = needs a human, cyan = in motion, blue = in line or
// scheduled, green = DONE only (never suggests completion where there is
// none), yellow = reserved for warnings (stale/suspect), dim = at rest.
const DOT: Record<number, { color: string; word: string; glyph: string }> = {
  0: { color: 'red', word: 'NEEDS YOU', glyph: '●' },
  1: { color: 'cyan', word: 'WORKING', glyph: '▶' },
  2: { color: 'blue', word: 'WAITING', glyph: '○' },
  3: { color: 'gray', word: 'IDLE', glyph: '■' },
  4: { color: 'red', word: 'UNREADABLE', glyph: '✗' },
  5: { color: 'green', word: 'DONE', glyph: '✓' },
};

/** The state word, colour and glyph one fleet row wears.
 *
 * A capacity park outranks the bucket, because "parked behind a provider
 * limit" and "waiting for its next scheduled wake" are the same blue WAITING
 * on the board and mean opposite things — the first is the fleet stopped, the
 * second is the fleet working as designed. Within a park, red says a person
 * has to act (enable usage credits, log in again) and yellow says it clears
 * itself on a reset, so an operator can tell "mine to fix" from "wait it out"
 * without opening a single stream. An ACTIVE stream in the idle bucket has
 * nothing scheduled at all — a stranded stream the quiescence backstop should
 * be reviving, never a restful gray: paused is the only honest IDLE. */
export function streamDecoration(
  st: Pick<StreamRow, 'bucket' | 'queuedNow' | 'paused' | 'capacityBlock'>,
): { color: string; word: string; glyph: string } {
  if (st.capacityBlock) {
    return st.capacityBlock.needsHuman
      ? { color: 'red', word: 'LIMITED', glyph: '▲' }
      : { color: 'yellow', word: 'LIMITED', glyph: '◔' };
  }
  if (st.bucket === 2 && st.queuedNow) return { color: 'blueBright', word: 'QUEUED', glyph: '●' };
  if (st.bucket === 3 && !st.paused) return { color: 'yellow', word: 'DORMANT', glyph: '■' };
  return DOT[st.bucket]!;
}

/** Hard-clear (incl. scrollback) — Ink's incremental repaint desyncs whenever
 * a frame ever wrapped or overflowed, so any layout change gets a clean slate. */
function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

/** Cursor position above the first row: the fleet header, nothing selected.
 * Keys that address "the current thing" then address the whole fleet — [i]
 * opens the fleet knowledge page instead of one workstream's. */
const NO_SELECTION = -1;

function App({ embeddedRunner }: { embeddedRunner: boolean }): React.JSX.Element {
  const { exit } = useApp();
  // The store is async, so the first snapshot arrives via the mount effect —
  // render paths never await; state loads in effects/callbacks only.
  const [snap, setSnap] = useState<Snapshot>({ items: [], streams: [], archivedDone: 0 });
  const lastSnapJson = React.useRef('');
  const [runnerState, setRunnerState] = useState<'embedded' | 'external' | 'stalled' | 'none'>(
    embeddedRunner ? 'embedded' : liveRunnerPid() !== null ? 'external' : 'none',
  );
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scroll, setScroll] = useState(0);
  const [steering, setSteering] = useState<{ slug: string; text: string; answersAttentionId?: string } | null>(null);
  const [resolving, setResolving] = useState<{ slug: string; attId: string; note: string } | null>(null);
  const [toast, setToast] = useState('');
  const printoutAbort = React.useRef<AbortController | null>(null);
  const printoutOpening = React.useRef(false);

  useEffect(() => {
    probePilot();
    const p = setInterval(probePilot, 30_000);
    let polling = false;
    const poll = async () => {
      if (polling) return; // never let a slow poll stack a second one
      polling = true;
      try {
        const s = await snapshot();
        const j = JSON.stringify(s);
        if (j !== lastSnapJson.current) {
          lastSnapJson.current = j;
          setSnap(s); // Ink diffs in place — no clear, no flicker
        }
      } finally {
        polling = false;
      }
      // Heartbeat truth, embedded or not: a live pid with a dead loop must
      // render STALLED, never ✓ — pid-aliveness lied to us once already.
      setRunnerState(runnerLoopHealthy() ? (embeddedRunner ? 'embedded' : 'external') : liveRunnerPid() !== null ? 'stalled' : 'none');
    };
    void poll(); // first frame: same data path as every later one
    const t = setInterval(() => void poll(), 2000);
    return () => { clearInterval(t); clearInterval(p); };
  }, [embeddedRunner]);

  useEffect(() => () => {
    printoutAbort.current?.abort();
  }, []);

  const refresh = (msg: string) => {
    clearScreen();
    void snapshot().then((s) => {
      lastSnapJson.current = JSON.stringify(s);
      setSnap(s);
      setToast(msg);
    }).catch((e) => setToast(`✗ ${e instanceof Error ? e.message : e}`));
  };

  /** Run an async human act; toast success (via refresh) or failure. The
   * useInput handler itself must stay synchronous. */
  const act = (fn: () => Promise<unknown>, done: string) => {
    void fn().then(() => refresh(done)).catch((e) => setToast(`✗ ${e instanceof Error ? e.message : e}`));
  };

  // The selectable list: needs-you items first, then streams.
  const rows = useMemo(
    () => [
      ...snap.items.map((i) => ({ type: 'item' as const, item: i })),
      // Cursor order mirrors visual order: workstreams section, then routines.
      ...snap.streams.filter((s) => !s.routine).map((s) => ({ type: 'stream' as const, stream: s })),
      ...snap.streams.filter((s) => s.routine).map((s) => ({ type: 'stream' as const, stream: s })),
    ],
    [snap],
  );
  const sel = cursor === NO_SELECTION ? undefined : rows[Math.min(cursor, Math.max(0, rows.length - 1))];
  // What [i] addresses: the selected row's workstream, or the whole fleet.
  const selSlug = sel ? (sel.type === 'item' ? sel.item.slug : sel.stream.slug) : undefined;

  useInput((input, key) => {
    if (steering || resolving) {
      // TextInput owns the keyboard; esc backs out without acting.
      if (key.escape) { setSteering(null); setResolving(null); }
      return;
    }
    if (input === 'q') {
      printoutAbort.current?.abort();
      exit();
      return;
    }
    const printoutRequest = requestedPrintoutScope(input, selSlug);
    if (printoutRequest.requested) {
      if (printoutOpening.current) { setToast('printout is already opening…'); return; }
      const controller = new AbortController();
      printoutAbort.current = controller;
      printoutOpening.current = true;
      setToast(`opening ${printoutRequest.slug ?? 'fleet'} printout…`);
      void publishPrintoutHtml(printoutRequest.slug, { signal: controller.signal })
        .then((published) => {
          if (!controller.signal.aborted) setToast(`printout → ${published.path}`);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setToast(`✗ printout not delivered; next P repeats: ${error instanceof Error ? error.message : error}`);
        })
        .finally(() => {
          if (printoutAbort.current === controller) printoutAbort.current = null;
          printoutOpening.current = false;
        });
      return;
    }
    if (input === 'i') {
      // i opens knowledge for whatever is selected: one workstream's own page,
      // or — with nothing selected, at the top — the fleet homepage with the
      // global policy store. Either way the whole site is regenerated, so the
      // links between the two directions resolve.
      void runInspect(selSlug)
        .then((out) => {
          if (process.platform === 'darwin') execFile('open', [out]);
          // Where it went is only worth a toast when we couldn't open it for you.
          setToast(process.platform === 'darwin' ? `knowledge → ${selSlug ?? 'fleet'}` : `knowledge → ${out}`);
        })
        .catch((e) => setToast(`✗ ${e instanceof Error ? e.message : e}`));
      return;
    }
    if (key.upArrow || input === 'k') { setCursor((c) => Math.max(NO_SELECTION, c - 1)); setScroll(0); }
    if (key.downArrow || input === 'j') { setCursor((c) => Math.min(rows.length - 1, c + 1)); setScroll(0); }
    if (key.pageDown || input === ']') setScroll((s) => s + 12);
    if (key.pageUp || input === '[') setScroll((s) => Math.max(0, s - 12));
    if (!sel) return;
    if (sel.type === 'item') {
      const it = sel.item;
      if (input === 'a') {
        if (it.kind === 'action') act(() => approveAction(it.slug, it.refId), `approved ${it.refId} — runner will execute + verify`);
        else if (it.kind === 'send') act(() => approveSend(it.slug, it.refId), `approved ${it.refId} — runner will send`);
      } else if (input === 'x') {
        if (it.kind === 'action') act(() => rejectAction(it.slug, it.refId), `rejected ${it.refId}`);
        else if (it.kind === 'send') act(() => rejectSend(it.slug, it.refId), `rejected ${it.refId}`);
      } else if (input === 'd' && it.kind === 'attention') {
        // A bare dismiss is ambiguous to the next coordinator pass ("seen" vs
        // "declined"), so d asks for an optional one-line answer first.
        setResolving({ slug: it.slug, attId: it.refId, note: '' });
      } else if (input === 's') {
        setSteering({ slug: it.slug, text: '', ...(it.kind === 'attention' ? { answersAttentionId: it.refId } : {}) });
      } else if (key.return) {
        setExpanded((e) => {
          const n = new Set(e);
          n.has(it.key) ? n.delete(it.key) : n.add(it.key);
          return n;
        });
      }
    } else {
      const st = sel.stream;
      if (input === 's') setSteering({ slug: st.slug, text: '' });
      else if (input === 'p') {
        if (st.bucket === 5) setToast(`${st.slug} is done; status unchanged`);
        else act(() => setPaused(st.slug, !st.paused), `${st.slug} ${st.paused ? 'resumed' : 'paused'}`);
      }
      else if (key.return) {
        setExpanded((e) => {
          const n = new Set(e);
          n.has(st.slug) ? n.delete(st.slug) : n.add(st.slug);
          return n;
        });
      }
    }
  });

  const counts = [0, 0, 0, 0, 0, 0];
  for (const s of snap.streams) counts[s.bucket]! += 1;
  // Capacity parks are counted apart from ordinary waiting: a fleet that has
  // stopped because of a provider limit should say so in the header, not hide
  // inside a waiting tally that looks the same on a busy afternoon.
  const limited = snap.streams.filter((s) => s.capacityBlock).length;
  const limitedNeedsYou = snap.streams.some((s) => s.capacityBlock?.needsHuman);
  counts[5]! += snap.archivedDone; // the header's done tally never shrinks as rows age off the board
  const now = new Date();
  const vNow = virtualNow();
  const drift = Math.abs(vNow.getTime() - now.getTime()) > 60_000;

  // HEIGHT BUDGET: the frame must NEVER exceed the terminal, or Ink loses
  // control of the scrollback and ghost frames stack up. Every body line
  // below is single-row (truncate-end), so line math is exact.
  const termRows = process.stdout.rows ?? 40;
  const chrome = 7; // header (1) + section titles/margins (~5) + footer (1)
  const selDetailLines = 5; // selected stream: details (4) + key hint
  const streamCount = snap.streams.length + (snap.archivedDone ? 1 : 0); // +1: the archived-summary line
  const selPane = (() => {
    const isExpandedSel = sel?.type === 'item' && expanded.has(sel.item.key);
    // Expanded reading OUTRANKS fleet rows: reserve a 3-stream floor and give
    // the pane the rest. Clamping the pane to leftover space instead once made
    // [enter] compute the same 4 lines as collapsed on a busy fleet — a
    // keypress that visibly did nothing.
    const roomExpanded = Math.max(6, termRows - chrome - snap.items.length - selDetailLines - 3 - 2);
    const fixed = chrome + snap.items.length + streamCount + selDetailLines;
    const roomCollapsed = Math.max(4, termRows - fixed - 2);
    return isExpandedSel ? Math.min(18, roomExpanded) : Math.min(4, roomCollapsed);
  })();
  // The stream task card ([enter] on a workstream row) also claims lines.
  const streamCardOpen = sel?.type === 'stream' && expanded.has(sel.stream.slug);
  const streamCardLines = streamCardOpen ? 7 : 0;
  // If content overflows, trim the visible stream lists (3-row floor).
  const overflow = Math.max(0, chrome + snap.items.length + selPane + 2 + selDetailLines + streamCardLines + streamCount - termRows);
  const streamsVisible = Math.max(3, streamCount - overflow);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Borderless single-line header: border boxes + space-between wrap on
          narrow windows, and one wrapped line permanently desyncs Ink. */}
      <Box>
        <Text wrap="truncate-end">
          {/* The brand is the fleet row: inverse when the cursor sits above
              every workstream, so "nothing selected" is a visible position
              in the same visual language as a selected row. */}
          <Text bold color="white" inverse={cursor === NO_SELECTION}> W E A V E R </Text>
          <Text dimColor>· </Text>
          {snap.items.length ? <Text bold color="red">{snap.items.length} need you</Text> : <Text dimColor>0 need you</Text>}
          <Text dimColor> · </Text><Text color="cyan">{counts[1]} working</Text>
          <Text dimColor> · </Text><Text color="blue">{counts[2]} waiting</Text>
          {limited ? <><Text dimColor> · </Text><Text bold color={limitedNeedsYou ? 'red' : 'yellow'}>{limited} limited</Text></> : null}
          <Text dimColor> · </Text><Text dimColor>{counts[3]} idle</Text>
          {counts[5] ? <><Text dimColor> · </Text><Text color="green">{counts[5]} done</Text></> : null}
          {counts[4] ? <Text bold color="red"> · {counts[4]} UNREADABLE</Text> : null}
          <Text dimColor> · </Text>
          {runnerState === 'embedded' ? <Text color="green">runner ✓</Text>
            : runnerState === 'external' ? <Text color="green">runner ✓ ext</Text>
            : runnerState === 'stalled' ? <Text bold color="red">RUNNER STALLED — q and relaunch!</Text>
            : <Text bold color="red">NO RUNNER — nothing will advance!</Text>}
          {snap.capacityHeadline ? <><Text dimColor> · </Text><Text color={snap.capacityHeadline.startsWith('⚠') ? 'yellow' : undefined} dimColor={!snap.capacityHeadline.startsWith('⚠')}>{snap.capacityHeadline}</Text></> : null}
          <Text dimColor> · {drift ? `virtual ${vNow.toISOString().slice(0, 16)} ` : ''}{now.toTimeString().slice(0, 8)}</Text>
        </Text>
      </Box>

      {/* The fleet row's own hint, mirroring a selected stream's. Costs a line
          only in the state that has one spare: nothing selected means no
          selection-detail pane below. */}
      {cursor === NO_SELECTION && (
        <Text color="cyan" wrap="truncate-end"> [i] fleet knowledge · [P] open fleet printout — workstreams + global policies</Text>
      )}

      {snap.items.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">⚡ NEEDS YOU</Text>
          {snap.items.map((it) => {
            const isSel = sel?.type === 'item' && sel.item.key === it.key;
            return (
              <Box key={it.key} flexDirection="column">
                <Text inverse={isSel} wrap="truncate-end">
                  <Text color="red"> ● </Text>
                  <Text bold>{it.slug}</Text>
                  <Text>  {it.title}</Text>
                </Text>
                {isSel && (() => {
                  // Single-row lines only (truncate-end): the height budget
                  // depends on exact line math, and long lines get the full
                  // text via [ / ] scrolling rather than wrapping.
                  const all = wrapRows(it.body, Math.max(40, (process.stdout.columns ?? 120) - 8));
                  const isExpanded = expanded.has(it.key);
                  const pane = selPane;
                  const from = Math.min(scroll, Math.max(0, all.length - pane));
                  const shown = all.slice(from, from + pane);
                  return (
                    <Box flexDirection="column" marginLeft={4} marginBottom={0}>
                      {shown.map((l, j) => (
                        <Text key={j} dimColor wrap="truncate-end">{l || ' '}</Text>
                      ))}
                      <Text color="cyan" wrap="truncate-end">
                        {all.length > pane ? `— ${from + 1}–${Math.min(from + pane, all.length)}/${all.length} · [ ] scroll — ` : ''}
                        {it.kind === 'attention' ? '[d] done/resolve  [s] steer' : '[a] approve  [x] reject  [s] steer'}
                        {isExpanded ? '  [enter] collapse' : '  [enter] expand'}
                      </Text>
                    </Box>
                  );
                })()}
              </Box>
            );
          })}
        </Box>
      )}

      {(() => {
        // Window the stream list to the height budget, keeping the selection
        // visible; hidden rows are announced, never silently dropped.
        const ordered = [...snap.streams.filter((s) => !s.routine), ...snap.streams.filter((s) => s.routine)];
        const selIdx = sel?.type === 'stream' ? ordered.findIndex((s) => s.slug === sel.stream.slug) : 0;
        const start = Math.max(0, Math.min(selIdx - streamsVisible + 1, ordered.length - streamsVisible));
        const windowSet = new Set(ordered.slice(start, start + streamsVisible).map((s) => s.slug));
        const hidden = ordered.length - windowSet.size;
        return (
          <>
            {[
              { label: 'WORKSTREAMS', list: snap.streams.filter((s) => !s.routine && windowSet.has(s.slug)) },
              { label: '↻ ROUTINES', list: snap.streams.filter((s) => s.routine && windowSet.has(s.slug)) },
            ].filter((sec) => sec.list.length).map((sec) => (
      <Box key={sec.label} flexDirection="column" marginTop={1}>
        <Text bold dimColor>{sec.label}</Text>
        {sec.list.map((st) => {
          const isSel = sel?.type === 'stream' && sel.stream.slug === st.slug;
          const d = streamDecoration(st);
          return (
            <Box key={st.slug} flexDirection="column">
              <Text inverse={isSel} wrap="truncate-end">
                <Text color={d.color}> {d.glyph} </Text>
                <Text bold>{`${st.depth ? `${'  '.repeat(st.depth - 1)}↳ ` : ''}${st.slug}`.padEnd(30)}</Text>
                <Text color={d.color}>{d.word.padEnd(11)}</Text>
                {st.error ? (
                  <Text color="red">{st.error}</Text>
                ) : (
                  <>
                    {st.paused ? <Text dimColor> [paused]</Text> : null}
                    {st.activity ? <Text dimColor> {st.activity}</Text> : null}
                    {st.capacityBlock ? (
                      <Text color={d.color}> · {st.capacityBlock.summary}{st.capacityBlock.needsHuman ? ' — needs you' : ''}</Text>
                    ) : st.bucket === 2 && !st.queuedNow && st.nextRun ? (
                      <Text color="blue"> · in {until(st.nextRun)}{st.nextReason ? `: ${waitLabel(st.nextReason)}` : ''}</Text>
                    ) : null}
                  </>
                )}
              </Text>
              {isSel && (
                <>
                  {expanded.has(st.slug) && (() => {
                    // Task card: WHAT this stream is (objective, single-row
                    // slices) + latest standing decision. Exactly 7 lines —
                    // the height budget's streamCardLines must match.
                    const width = Math.max(40, (process.stdout.columns ?? 120) - 10);
                    const wrapped = wrapRows(st.objective, width);
                    const objLines = wrapped.slice(0, 5);
                    while (objLines.length < 5) objLines.push(' ');
                    const truncated = wrapped.length > 5;
                    return (
                      <>
                        <Text wrap="truncate-end">      <Text bold dimColor>objective</Text>{truncated ? <Text dimColor> (start — [i] for all of it)</Text> : null}</Text>
                        {objLines.map((l, j) => (
                          <Text key={`o${j}`} dimColor wrap="truncate-end">      {l}</Text>
                        ))}
                        <Text wrap="truncate-end">      <Text bold dimColor>latest decision</Text><Text dimColor>  {st.latestDecision ?? '(none yet)'}</Text></Text>
                      </>
                    );
                  })()}
                  {st.details.slice(0, 4).map((l, j) => (
                    <Text key={j} dimColor wrap="truncate-end">      {l}</Text>
                  ))}
                  <Text color="cyan" wrap="truncate-end">      [enter] {expanded.has(st.slug) ? 'close card' : 'what is this stream?'}{st.bucket === 5 ? null : <>  [p] {st.paused ? 'resume' : 'pause'}</>}  [P] open printout  [s] steer  [i] full knowledge</Text>
                </>
              )}
            </Box>
          );
        })}
      </Box>
            ))}
            {hidden > 0 && <Text dimColor> … {hidden} more workstream(s) — ↑↓ scrolls the window</Text>}
            {snap.archivedDone > 0 && <Text dimColor> ✓ {snap.archivedDone} finished earlier and left the board — [i] fleet knowledge keeps every record</Text>}
          </>
        );
      })()}

      {resolving ? (
        <Box marginTop={1}>
          {/* Kept short: a wrapped prompt line desyncs Ink like the footer would. */}
          <Text color="cyan">resolve {resolving.attId} — note? (enter dismiss · esc cancel) ▸ </Text>
          <TextInput
            value={resolving.note}
            onChange={(t: string) => setResolving({ ...resolving, note: t })}
            onSubmit={(t: string) => {
              setResolving(null);
              act(
                () => resolveAttention(resolving.slug, resolving.attId, t.trim()),
                t.trim() ? `resolved ${resolving.attId} — note recorded` : `resolved ${resolving.attId}`,
              );
            }}
          />
        </Box>
      ) : steering ? (
        <Box marginTop={1}>
          <Text color="cyan">steer {steering.slug} ▸ </Text>
          <TextInput
            value={steering.text}
            onChange={(t: string) => setSteering({ ...steering, text: t })}
            onSubmit={(t: string) => {
              setSteering(null);
              if (t.trim()) {
                act(
                  () =>
                    addSteering(steering.slug, t.trim(), {
                      ...(steering.answersAttentionId ? { resolvesAttentionId: steering.answersAttentionId } : {}),
                    }),
                  steering.answersAttentionId ? `answered ${steering.slug} — card cleared` : `steered ${steering.slug}`,
                );
              }
            }}
          />
        </Box>
      ) : (
        <Box marginTop={1}>
          {/* ONE line, always truncated — a wrapped footer desyncs Ink's repaint. */}
          <Text dimColor wrap="truncate-end">
            ↑↓ · enter · [/] scroll · a approve · x reject · d resolve · s steer · p pause · P {selSlug ? 'open printout' : 'open fleet printout'} · i {selSlug ? 'knowledge' : 'fleet knowledge'} · q quit
            {toast ? <Text color="green">   {toast}</Text> : null}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export async function runTui(): Promise<void> {
  // ONE command: the dashboard embeds the runner unless one is already live
  // elsewhere (headless `weaver run`, another watch). The singleton lock makes
  // extra dashboards harmless viewers.
  let release = acquireRunnerLock();
  let stopPromotion: (() => void) | undefined;
  const runnerAbort = new AbortController();
  // The embedded runner, its workers, and the SDK all write diagnostics to
  // stderr — every stray line printed into the alt screen shifts Ink's frame
  // and leaves ghost headers. While the dashboard owns the terminal, stderr
  // goes to a log file instead (state/runner.log — tail it for diagnostics).
  const logPath = path.join(weaverHome(), 'runner.log');
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const redirectedStderr = ((chunk: string | Uint8Array) => {
    try {
      fs.appendFileSync(logPath, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    } catch { /* diagnostics must never crash the dashboard */ }
    return true;
  }) as typeof process.stderr.write;
  let instance: ReturnType<typeof render> | undefined;
  let ownsAltScreen = false;
  let stderrRedirected = false;
  const onResize = () => {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    instance?.rerender(<App embeddedRunner={release !== null} />);
  };
  try {
    process.stderr.write = redirectedStderr;
    stderrRedirected = true;
    process.stdout.write('\x1b[?1049h'); // alt screen
    ownsAltScreen = true;
    instance = render(
      <App embeddedRunner={release !== null} />,
      { exitOnCtrlC: true },
    );
    process.stdout.on('resize', onResize);
    const startEmbeddedLoop = () => {
      void runLoop({
        intervalMs: 30_000,
        concurrency: 10,
        signal: runnerAbort.signal,
        log: () => {},
        logError: () => {},
      });
    };
    if (release) {
      startEmbeddedLoop();
    } else {
      // Standby: a viewer opened while another runner held the lock promotes to
      // runner the moment that runner dies and frees the lock — otherwise the
      // fleet stops ticking while this live dashboard renders a frozen view.
      stopPromotion = promoteOnRunnerVacancy((acquired) => {
        release = acquired;
        startEmbeddedLoop();
        instance?.rerender(<App embeddedRunner />);
      });
    }
    await instance.waitUntilExit();
  } finally {
    stopPromotion?.();
    process.stdout.off('resize', onResize);
    runnerAbort.abort();
    // Do not release the singleton while a detached tick may still be inside
    // an SDK call. The CLI exits immediately next, and acquireRunnerLock's
    // process-exit handler releases only when the disposable process is gone.
    if (stderrRedirected) process.stderr.write = origStderrWrite;
    if (ownsAltScreen) process.stdout.write('\x1b[?1049l');
  }
}
