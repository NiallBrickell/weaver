/**
 * Read-only replay: how many recorded coordinator passes woken by a worker or
 * action completion would a "hold the completion wake while a sibling runs"
 * rule (docs/cost-reduction-plan.md, Phase 1) have absorbed?
 *
 * Usage:
 *   npx tsx scripts/replay-completion-batching.ts <state-dir> [--since ISO] [--window-min 15]
 *
 * <state-dir> is a filesystem-backend WEAVER_HOME snapshot: one
 * `<slug>/workstream.json` per workstream (plus `_archive/<slug>/…`). The
 * script only reads those files. It never opens a store, takes a lock, or
 * writes anything, so it is safe against a copy of a live fleet.
 *
 * Definitions (all from typed records; wake reasons are matched only against
 * the exact harness-authored completion templates):
 * - completion pass: every wake reason of the pass is a completion reason
 *   ("assignment X submitted a result for review", "human-authored action X
 *   was executed by the engine and awaits review", "action X readback
 *   confirmed its effect after worker infrastructure backoff").
 * - held: at the pass's startedAt, another assignment of the same workstream
 *   had an attempt with startedAt <= t and no endedAt (while still running in
 *   the snapshot) or endedAt > t. "Queued and runnable" siblings cannot be
 *   reconstructed exactly from history and are reported separately as an
 *   upper bound (created before t, first attempt after t, no dependsOn).
 * - saved: a held pass whose workstream's next pass started within the
 *   window would have been coalesced into that pass; a held pass with no
 *   pass inside the window fires at the deadline and saves nothing.
 *
 * It also classifies each single-completion pass by the dispatch that
 * created its assignment, because a completion can only be batched when the
 * pass that dispatched it also dispatched siblings.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Assignment, PassRecord, WorkstreamDoc } from '../src/types.js';

const COMPLETION = [
  /^assignment (\S+) submitted a result for review$/,
  /^human-authored action (\S+) was executed by the engine and awaits review$/,
  /^action (\S+) readback confirmed its effect after worker infrastructure backoff$/,
];

function completedId(reason: string): string | undefined {
  for (const pattern of COMPLETION) {
    const match = pattern.exec(reason);
    if (match) return match[1];
  }
  return undefined;
}

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

function runningAt(assignment: Assignment, t: number): boolean {
  return assignment.attempts.some((attempt) => {
    const started = ms(attempt.startedAt);
    if (started === undefined || started > t) return false;
    const ended = ms(attempt.endedAt);
    // An attempt with no end is running only while the snapshot still says so;
    // an unended attempt on a settled assignment is a legacy crash remnant.
    return ended === undefined ? assignment.state === 'running' : ended > t;
  });
}

function queuedIndependentAt(assignment: Assignment, t: number): boolean {
  const created = ms(assignment.createdAtVirtual);
  const firstStart = ms(assignment.attempts[0]?.startedAt);
  return created !== undefined && firstStart !== undefined &&
    created <= t && firstStart > t && assignment.dependsOn.length === 0;
}

function docPaths(root: string): string[] {
  const out: string[] = [];
  for (const base of [root, path.join(root, '_archive')]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = path.join(base, entry, 'workstream.json');
      if (existsSync(file)) out.push(file);
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = args.find((arg) => !arg.startsWith('--'));
  if (!root) {
    process.stderr.write('usage: replay-completion-batching.ts <state-dir> [--since ISO] [--window-min 15]\n');
    process.exit(2);
  }
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const since = ms(flag('--since')) ?? 0;
  const windowMs = Number(flag('--window-min') ?? 15) * 60_000;

  const totals = {
    workstreams: 0,
    passes: 0,
    passCost: 0,
    completionPasses: 0,
    completionCost: 0,
    singleCompletionPasses: 0,
    singleCompletionCost: 0,
    held: 0,
    heldCost: 0,
    saved: 0,
    savedCost: 0,
    queuedIndependentUpperBound: 0,
  };
  const shapes = new Map<string, { passes: number; cost: number }>();
  const addShape = (key: string, cost: number) => {
    const entry = shapes.get(key) ?? { passes: 0, cost: 0 };
    entry.passes += 1;
    entry.cost += cost;
    shapes.set(key, entry);
  };
  let first: number | undefined;
  let last: number | undefined;

  for (const file of docPaths(root)) {
    let doc: WorkstreamDoc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as WorkstreamDoc;
    } catch {
      continue;
    }
    totals.workstreams += 1;
    const passes = [...(doc.passes ?? [])]
      .filter((pass) => (ms(pass.startedAt) ?? 0) >= since)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const byId = new Map(doc.assignments.map((assignment) => [assignment.id, assignment]));
    passes.forEach((pass: PassRecord, index) => {
      const t = ms(pass.startedAt);
      if (t === undefined) return;
      const cost = pass.costUsd ?? 0;
      totals.passes += 1;
      totals.passCost += cost;
      first = first === undefined ? t : Math.min(first, t);
      last = last === undefined ? t : Math.max(last, t);
      const reasons = pass.wakeReasons ?? [];
      const ids = reasons.map(completedId);
      if (!reasons.length || ids.some((id) => id === undefined)) return;
      const completed = new Set(ids as string[]);
      totals.completionPasses += 1;
      totals.completionCost += cost;
      const siblings = doc.assignments.filter((assignment) => !completed.has(assignment.id));
      const held = siblings.some((assignment) => runningAt(assignment, t));
      if (siblings.some((assignment) => queuedIndependentAt(assignment, t))) totals.queuedIndependentUpperBound += 1;
      if (held) {
        totals.held += 1;
        totals.heldCost += cost;
        const next = ms(passes[index + 1]?.startedAt);
        if (next !== undefined && next - t <= windowMs) {
          totals.saved += 1;
          totals.savedCost += cost;
        }
      }
      if (completed.size !== 1) return;
      totals.singleCompletionPasses += 1;
      totals.singleCompletionCost += cost;
      const assignment = byId.get([...completed][0]!);
      if (!assignment?.createdInPass) {
        addShape('assignment not created by a recorded pass', cost);
        return;
      }
      const dispatchedTogether = doc.assignments.filter((candidate) =>
        candidate.createdInPass === assignment.createdInPass && candidate.id !== assignment.id);
      if (!dispatchedTogether.length) {
        addShape('dispatched alone (no sibling from the same pass)', cost);
        return;
      }
      const states = new Set(dispatchedTogether.map((sibling) => {
        const firstStart = ms(sibling.attempts[0]?.startedAt);
        if (firstStart === undefined) return 'never started';
        if (firstStart > t) return sibling.dependsOn.length ? 'started later (dependsOn)' : 'started later (independent)';
        return runningAt(sibling, t) ? 'running at t' : 'settled before t';
      }));
      addShape(`dispatched with siblings: ${[...states].sort().join(', ')}`, cost);
    });
  }

  const usd = (value: number) => `$${value.toFixed(2)}`;
  const pct = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a');
  const lines = [
    `snapshot: ${root}`,
    `range: ${first ? new Date(first).toISOString() : '-'} .. ${last ? new Date(last).toISOString() : '-'}`,
    `workstreams: ${totals.workstreams}; passes: ${totals.passes} (${usd(totals.passCost)})`,
    `completion passes: ${totals.completionPasses} (${usd(totals.completionCost)}); single-completion: ${totals.singleCompletionPasses} (${usd(totals.singleCompletionCost)})`,
    `held (a sibling had a live attempt at startedAt): ${totals.held} = ${pct(totals.held, totals.completionPasses)} of completion passes (${usd(totals.heldCost)})`,
    `saved (next pass within ${windowMs / 60_000} min): ${totals.saved} passes, ${usd(totals.savedCost)} = ${pct(totals.savedCost, totals.completionCost)} of completion spend`,
    `upper bound incl. queued independent siblings: ${totals.queuedIndependentUpperBound} more completion passes had one`,
    '',
    'single-completion passes by the dispatch that created the completed assignment:',
    ...[...shapes.entries()]
      .sort((a, b) => b[1].passes - a[1].passes)
      .map(([key, value]) => `  ${String(value.passes).padStart(6)}  ${usd(value.cost).padStart(10)}  ${key}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
