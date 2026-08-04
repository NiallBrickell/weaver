/**
 * `weaver watch` — the interactive dashboard (Ink).
 *
 * The design center is the NEEDS-YOU queue: the only turns a human should
 * spend on a workstream are judgment calls, so those are the first thing on
 * screen and every one is answerable with a single keypress. Everything else
 * (running workers, wakes, budgets) is glanceable context below.
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
import { acquireRunnerLock, liveRunnerPid, runLoop } from './runner.js';
import { listWorkstreams, workstreamDir, weaverHome } from './store.js';
import type { WorkstreamDoc } from './types.js';

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
  paused: boolean;
  spent: number;
  maxCost: number;
  passes: number;
  maxPasses: number;
  interventions: number;
  details: string[];
  error?: string;
}

interface Snapshot {
  items: NeedsYouItem[];
  streams: StreamRow[];
}

function elapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function snapshot(): Snapshot {
  const items: NeedsYouItem[] = [];
  const streams: StreamRow[] = [];
  for (const slug of listWorkstreams()) {
    let doc: WorkstreamDoc;
    try {
      doc = JSON.parse(
        fs.readFileSync(path.join(workstreamDir(slug), 'workstream.json'), 'utf8'),
      ) as WorkstreamDoc;
    } catch (e) {
      streams.push({
        slug, bucket: 4, queuedNow: false, routine: false, paused: false, spent: 0, maxCost: 0, passes: 0, maxPasses: 0,
        interventions: 0, details: [], error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const ws = doc.workstream;

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
    for (const a of doc.attention.filter((x) => x.status === 'open')) {
      if (a.refId && approvableIds.has(a.refId)) {
        commentary.set(a.refId, [...(commentary.get(a.refId) ?? []), a.summary]);
        continue;
      }
      if (a.refId && seenRefs.has(a.refId)) continue;
      if (a.refId) seenRefs.add(a.refId);
      needsYou++;
      items.push({
        key: `${slug}:${a.id}`, slug, kind: 'attention', refId: a.id,
        title: a.summary.split('\n')[0]!.slice(0, 120),
        body: a.summary,
      });
    }
    for (const a of gated) {
      needsYou++;
      const notes = commentary.get(a.id);
      // The card is the plain-language ask, then THE ACTUAL COMMANDS (pulled
      // from the briefing's fenced code blocks) — what gets executed is the
      // thing being approved, so it is never buried. Full briefing last.
      const ask = a.exec?.ask ?? a.objective;
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
    const nowV = virtualNow().toISOString();
    const pending = doc.wakes.filter((w) => w.status === 'pending');
    const dueNow = pending.filter((w) => w.condition.type === 'immediate' || w.condition.dueAtVirtual <= nowV).length;
    if (dueNow && !working) details.push(`○ ${dueNow} wake(s) due — in line for the runner`);
    const last = doc.events[doc.events.length - 1];
    if (last) details.push(`  last [${last.at.slice(11, 19)}] ${last.type}: ${last.summary.slice(0, 90)}`);

    const bucket: StreamRow['bucket'] =
      ws.status === 'paused' && !needsYou ? 3
      : needsYou ? 0
      : working || queued ? 1
      : ws.status === 'active' && pending.length ? 2
      : 3;

    // Steering must be VISIBLY acknowledged the moment it lands: an
    // unconsumed steer means "heard — the next coordinator pass acts on it".
    const pendingSteers = doc.steering.filter((s) => !s.consumedByPass).length;
    if (pendingSteers) {
      details.unshift(`✉ steering received — coordinator acts on it next pass (${pendingSteers} pending)`);
    }

    const nextRun = pending
      .filter((w) => w.condition.type === 'time' && w.condition.dueAtVirtual > nowV)
      .map((w) => (w.condition as { dueAtVirtual: string }).dueAtVirtual)
      .sort()[0];
    streams.push({
      slug,
      bucket: ws.status === 'done' ? 5 : bucket,
      queuedNow: dueNow > 0 || pendingSteers > 0,
      routine: ws.tags.includes('routine'),
      nextRun, paused: ws.status === 'paused',
      spent: doc.spend.totalCostUsd, maxCost: ws.budget.maxCostUsd,
      passes: doc.spend.coordinatorPasses, maxPasses: ws.budget.maxCoordinatorPasses,
      interventions: doc.spend.humanInterventions ?? 0,
      details,
    });
  }
  streams.sort((a, b) => a.bucket - b.bucket || a.slug.localeCompare(b.slug));
  items.sort((a, b) => a.slug.localeCompare(b.slug));
  return { items, streams };
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

function Bar({ spent, max }: { spent: number; max: number }): React.JSX.Element {
  const cells = 8;
  const frac = max > 0 ? Math.min(1, spent / max) : 0;
  const filled = Math.round(frac * cells);
  const color = frac > 0.9 ? 'red' : frac > 0.7 ? 'yellow' : 'cyan';
  return (
    <Text>
      <Text color={color}>{'▰'.repeat(filled)}</Text>
      <Text dimColor>{'▱'.repeat(cells - filled)}</Text>
    </Text>
  );
}

function App({ embeddedRunner }: { embeddedRunner: boolean }): React.JSX.Element {
  const { exit } = useApp();
  const [snap, setSnap] = useState<Snapshot>(() => snapshot());
  const [runnerState, setRunnerState] = useState<'embedded' | 'external' | 'none'>(
    embeddedRunner ? 'embedded' : liveRunnerPid() !== null ? 'external' : 'none',
  );
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scroll, setScroll] = useState(0);
  const [steering, setSteering] = useState<{ slug: string; text: string } | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const t = setInterval(() => {
      setSnap(snapshot());
      if (!embeddedRunner) setRunnerState(liveRunnerPid() !== null ? 'external' : 'none');
    }, 2000);
    return () => clearInterval(t);
  }, [embeddedRunner]);

  const refresh = (msg: string) => {
    setSnap(snapshot());
    setToast(msg);
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
  const sel = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

  useInput((input, key) => {
    if (steering) return; // TextInput owns the keyboard
    if (input === 'q') { exit(); return; }
    if (input === 'i') {
      // The dashboard is the only surface: i opens the knowledge inspector
      // (decision lineage, policies, interventions) in the browser — scoped
      // to the selected workstream, or the fleet overview otherwise.
      try {
        const slug = sel?.type === 'stream' ? sel.stream.slug : sel?.type === 'item' ? sel.item.slug : undefined;
        const out = runInspect(slug);
        if (process.platform === 'darwin') execFile('open', [out]);
        setToast(`inspector → ${out}`);
      } catch (e) {
        setToast(`✗ ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    if (key.upArrow || input === 'k') { setCursor((c) => Math.max(0, c - 1)); setScroll(0); }
    if (key.downArrow || input === 'j') { setCursor((c) => Math.min(rows.length - 1, c + 1)); setScroll(0); }
    if (key.pageDown || input === ']') setScroll((s) => s + 12);
    if (key.pageUp || input === '[') setScroll((s) => Math.max(0, s - 12));
    if (!sel) return;
    try {
      if (sel.type === 'item') {
        const it = sel.item;
        if (input === 'a') {
          if (it.kind === 'action') { approveAction(it.slug, it.refId); refresh(`approved ${it.refId} — runner will execute + verify`); }
          else if (it.kind === 'send') { approveSend(it.slug, it.refId); refresh(`approved ${it.refId} — runner will send`); }
        } else if (input === 'x') {
          if (it.kind === 'action') { rejectAction(it.slug, it.refId); refresh(`rejected ${it.refId}`); }
          else if (it.kind === 'send') { rejectSend(it.slug, it.refId); refresh(`rejected ${it.refId}`); }
        } else if (input === 'd' && it.kind === 'attention') {
          resolveAttention(it.slug, it.refId);
          refresh(`resolved ${it.refId}`);
        } else if (input === 's') {
          setSteering({ slug: it.slug, text: '' });
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
        else if (input === 'p') { setPaused(st.slug, !st.paused); refresh(`${st.slug} ${st.paused ? 'resumed' : 'paused'}`); }
        else if (key.return) {
          setExpanded((e) => {
            const n = new Set(e);
            n.has(st.slug) ? n.delete(st.slug) : n.add(st.slug);
            return n;
          });
        }
      }
    } catch (e) {
      setToast(`✗ ${e instanceof Error ? e.message : e}`);
    }
  });

  const counts = [0, 0, 0, 0, 0, 0];
  for (const s of snap.streams) counts[s.bucket]! += 1;
  const now = new Date();
  const vNow = virtualNow();
  const drift = Math.abs(vNow.getTime() - now.getTime()) > 60_000;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderDimColor paddingX={1} justifyContent="space-between">
        <Text>
          <Text bold color="white">W E A V E R</Text>
          <Text>   </Text>
          {snap.items.length ? <Text bold color="red">{snap.items.length} need you</Text> : <Text dimColor>0 need you</Text>}
          <Text dimColor> · </Text><Text color="cyan">{counts[1]} working</Text>
          <Text dimColor> · </Text><Text color="blue">{counts[2]} waiting</Text>
          <Text dimColor> · </Text><Text dimColor>{counts[3]} idle</Text>
          {counts[5] ? <><Text dimColor> · </Text><Text color="green">{counts[5]} done</Text></> : null}
          {counts[4] ? <Text bold color="red"> · {counts[4]} UNREADABLE</Text> : null}
        </Text>
        <Text dimColor>
          {runnerState === 'embedded' ? <Text color="green">runner ✓ </Text>
            : runnerState === 'external' ? <Text color="green">runner ✓ (external) </Text>
            : <Text bold color="red">NO RUNNER — nothing will advance! </Text>}
          {drift ? `virtual ${vNow.toISOString().slice(0, 16)}  ` : ''}{now.toTimeString().slice(0, 8)}
        </Text>
      </Box>

      {snap.items.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="red">⚡ NEEDS YOU</Text>
          {snap.items.map((it) => {
            const isSel = rows[cursor]?.type === 'item' && (rows[cursor] as { item: NeedsYouItem }).item.key === it.key;
            return (
              <Box key={it.key} flexDirection="column">
                <Text inverse={isSel} wrap="truncate-end">
                  <Text color="red"> ● </Text>
                  <Text bold>{it.slug}</Text>
                  <Text>  {it.title}</Text>
                </Text>
                {(isSel || expanded.has(it.key)) && (() => {
                  const all = it.body.split('\n');
                  const isExpanded = expanded.has(it.key);
                  const pane = 14;
                  const from = isExpanded ? Math.min(scroll, Math.max(0, all.length - pane)) : 0;
                  const shown = all.slice(from, from + (isExpanded ? pane : 4));
                  return (
                    <Box flexDirection="column" marginLeft={4} marginBottom={0}>
                      {shown.map((l, j) => (
                        <Text key={j} dimColor wrap="wrap">{l}</Text>
                      ))}
                      {isExpanded && all.length > pane && (
                        <Text color="cyan">— lines {from + 1}–{Math.min(from + pane, all.length)} of {all.length} · [ / ] (or PgUp/PgDn) to scroll —</Text>
                      )}
                      <Text color="yellow">
                        {it.kind === 'attention' ? '[d] done/resolve  [s] steer  [enter] full text' : '[a] approve  [x] reject  [s] steer  [enter] details'}
                      </Text>
                    </Box>
                  );
                })()}
              </Box>
            );
          })}
        </Box>
      )}

      {[
        { label: 'WORKSTREAMS', list: snap.streams.filter((s) => !s.routine) },
        { label: '↻ ROUTINES', list: snap.streams.filter((s) => s.routine) },
      ].filter((sec) => sec.list.length).map((sec) => (
      <Box key={sec.label} flexDirection="column" marginTop={1}>
        <Text bold dimColor>{sec.label}</Text>
        {sec.list.map((st) => {
          const isSel = rows[cursor]?.type === 'stream' && (rows[cursor] as { stream: StreamRow }).stream.slug === st.slug;
          const d = st.bucket === 2 && st.queuedNow ? { color: 'blueBright', word: 'QUEUED', glyph: '●' } : DOT[st.bucket]!;
          return (
            <Box key={st.slug} flexDirection="column">
              <Text inverse={isSel} wrap="truncate-end">
                <Text color={d.color}> {d.glyph} </Text>
                <Text bold>{st.slug.padEnd(30)}</Text>
                <Text color={d.color}>{d.word.padEnd(11)}</Text>
                {st.error ? (
                  <Text color="red">{st.error}</Text>
                ) : (
                  <>
                    <Bar spent={st.spent} max={st.maxCost} />
                    <Text dimColor> ~${st.spent.toFixed(2)} est · passes {st.passes} · you {st.interventions}×{st.paused ? ' [paused]' : ''}</Text>
                    {st.routine && st.bucket === 2 && st.nextRun ? (
                      <Text color="blue"> · next run {st.nextRun.slice(5, 16).replace('T', ' ')}</Text>
                    ) : null}
                  </>
                )}
              </Text>
              {(isSel || expanded.has(st.slug)) && (
                <>
                  {st.details.map((l, j) => (
                    <Text key={j} dimColor wrap="truncate-end">      {l}</Text>
                  ))}
                  {isSel && (
                    <Text color="yellow">      [p] {st.paused ? 'resume' : 'pause (stops new work; state kept)'}  [s] steer  [i] inspect knowledge  [enter] expand</Text>
                  )}
                </>
              )}
            </Box>
          );
        })}
      </Box>
      ))}

      {steering ? (
        <Box marginTop={1}>
          <Text color="yellow">steer {steering.slug} ▸ </Text>
          <TextInput
            value={steering.text}
            onChange={(t: string) => setSteering({ ...steering, text: t })}
            onSubmit={(t: string) => {
              setSteering(null);
              if (t.trim()) {
                try {
                  addSteering(steering.slug, t.trim());
                  refresh(`steered ${steering.slug}`);
                } catch (e) {
                  setToast(`✗ ${e instanceof Error ? e.message : e}`);
                }
              }
            }}
          />
        </Box>
      ) : (
        <Box marginTop={1} justifyContent="space-between">
          <Text dimColor>↑↓ select · enter expand · [/] scroll · a approve · x reject · d resolve · s steer · p pause · i inspect · q quit</Text>
          {toast ? <Text color="green">{toast}</Text> : <Text dimColor>{weaverHome()}</Text>}
        </Box>
      )}
    </Box>
  );
}

export async function runTui(): Promise<void> {
  // ONE command: the dashboard embeds the runner unless one is already live
  // elsewhere (headless `weaver run`, another watch). The singleton lock makes
  // extra dashboards harmless viewers.
  const release = acquireRunnerLock();
  if (release) {
    void runLoop({
      intervalMs: 30_000,
      concurrency: 10,
      log: () => {},
      logError: () => {},
    });
  }
  process.stdout.write('\x1b[?1049h'); // alt screen
  const instance = render(<App embeddedRunner={release !== null} />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
  process.stdout.write('\x1b[?1049l');
}
