import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalCaseResult } from './types.js';

/**
 * The durable, longitudinal eval ledger: one JSON line per `EvalCaseResult`,
 * checked into git at the repo root so results survive reclones, travel with
 * the repo across machines, and land as reviewable diffs. Append-only — lines
 * are never rewritten — and merged with `merge=union` so appends from
 * different machines never conflict.
 */
export const LEDGER_REPO_PATH = 'evals/ledger.jsonl';

/** The checked-in ledger location, resolved relative to the repo root. */
export function defaultLedgerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', LEDGER_REPO_PATH);
}

/** Identity of one ledger line: (suiteRunId, target.label, caseId, repetition). */
export function ledgerKey(result: EvalCaseResult): string {
  return [result.suiteRunId, result.target.label, result.caseId, String(result.repetition)].join('\u0000');
}

export function loadLedger(path: string): EvalCaseResult[] {
  if (!existsSync(path)) return [];
  const results: EvalCaseResult[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      results.push(JSON.parse(line) as EvalCaseResult);
    } catch {
      throw new Error(`ledger line ${index + 1} of ${path} is not valid JSON — the ledger is append-only and should never be hand-edited`);
    }
  }
  return results;
}

export interface LedgerAppendOutcome {
  appended: number;
  skipped: number;
}

/**
 * Append case results to the ledger, deduplicating on `ledgerKey`. Appending
 * the same results twice is a no-op, so re-ingesting a suite's `results.json`
 * never double-counts.
 */
export function appendToLedger(path: string, results: EvalCaseResult[]): LedgerAppendOutcome {
  const seen = new Set(loadLedger(path).map(ledgerKey));
  const fresh: EvalCaseResult[] = [];
  for (const result of results) {
    const key = ledgerKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(result);
  }
  if (fresh.length) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, fresh.map((result) => JSON.stringify(result) + '\n').join(''));
  }
  return { appended: fresh.length, skipped: results.length - fresh.length };
}

export interface LedgerAggregateRow {
  /** `executor:model` — the routing identity, independent of the run's display label. */
  target: string;
  /** Complete experimental cohort; routing commitments cite this identity so
   * a passing rerun never averages away a failed environment. */
  suiteRunId: string;
  /** Adapter/runtime contract epoch. Schema 1 rows are deliberately `unknown`:
   * their recorded package label did not reliably distinguish Weaver bridge
   * changes, so treating it as routing evidence would mix incompatible runs. */
  harnessVersion: string;
  caseId: string;
  /** Deterministic fixture/grader contract. Schema 1 rows map to version 0. */
  caseVersion: number;
  runs: number;
  hardGatePasses: number;
  /** Per-grade pass vector. `runs` is the whole aggregate size, so a grade
   * absent from an errored run counts honestly as not passed rather than
   * disappearing from the denominator. */
  gradePasses: LedgerGradePass[];
  /** Mean of per-run mean grade scores; null-safe — runs with no scored grades are excluded, never counted as zero. */
  meanScore: number | null;
  medianDurationMs: number;
  /** Sum of the costs that were reported; null when no run in the group reported a cost. */
  knownCostUsd: number | null;
  /** True when at least one run's cost was unavailable, so the sum is a floor, not a total. */
  costIncomplete: boolean;
  lastRunAt: string;
}

export interface LedgerGradePass {
  id: string;
  hardGate: boolean;
  passes: number;
  runs: number;
}

function resultScore(result: EvalCaseResult): number | null {
  const scores = result.grades
    .map((grade) => grade.score)
    .filter((score): score is number => score !== null);
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function caseVersion(result: EvalCaseResult): number {
  return result.schemaVersion === 2 && Number.isInteger(result.caseVersion) && result.caseVersion! > 0
    ? result.caseVersion!
    : 0;
}

function harnessVersion(result: EvalCaseResult): string {
  return result.schemaVersion === 2
    ? (result.execution?.harnessVersion ?? 'unknown')
    : 'unknown';
}

function aggregateGradePasses(group: EvalCaseResult[]): LedgerGradePass[] {
  const grades = new Map<string, { id: string; hardGate: boolean; passes: number }>();
  for (const result of group) {
    const resultPasses = new Map<string, boolean>();
    for (const grade of result.grades) {
      const key = `${grade.hardGate ? 'hard' : 'quality'}\u0000${grade.id}`;
      const current = grades.get(key) ?? {
        id: grade.id,
        hardGate: grade.hardGate,
        passes: 0,
      };
      grades.set(key, current);
      // A malformed result that repeats one grade cannot contribute more than
      // one pass. If the duplicates disagree, retain the failure.
      resultPasses.set(key, (resultPasses.get(key) ?? true) && grade.passed);
    }
    for (const [key, passed] of resultPasses) {
      if (passed) grades.get(key)!.passes += 1;
    }
  }
  return [...grades.values()]
    .map((grade) => ({ ...grade, runs: group.length }))
    .sort((a, b) => Number(b.hardGate) - Number(a.hardGate) || a.id.localeCompare(b.id));
}

/** Per-cohort × (executor:model:harnessVersion) × case@version aggregation —
 * the versioned evidence a model-routing policy consumes. */
export function aggregateLedger(results: EvalCaseResult[]): LedgerAggregateRow[] {
  const groups = new Map<string, EvalCaseResult[]>();
  for (const result of results) {
    const key = [
      `${result.target.executor}:${result.target.model}`,
      result.suiteRunId,
      harnessVersion(result),
      result.caseId,
      String(caseVersion(result)),
    ].join('\u0000');
    const group = groups.get(key);
    if (group) group.push(result);
    else groups.set(key, [result]);
  }
  const rows: LedgerAggregateRow[] = [];
  for (const [key, group] of groups) {
    const [target, suiteRunId, epoch, caseId, version] = key.split('\u0000') as [string, string, string, string, string];
    const scores = group.map(resultScore).filter((score): score is number => score !== null);
    const knownCosts = group
      .map((result) => result.execution?.costUsd ?? null)
      .filter((cost): cost is number => cost !== null);
    rows.push({
      target,
      suiteRunId,
      harnessVersion: epoch,
      caseId,
      caseVersion: Number(version),
      runs: group.length,
      hardGatePasses: group.filter((result) => result.passedHardGates).length,
      gradePasses: aggregateGradePasses(group),
      meanScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      medianDurationMs: median(group.map((result) => result.durationMs)),
      knownCostUsd: knownCosts.length ? knownCosts.reduce((sum, cost) => sum + cost, 0) : null,
      costIncomplete: knownCosts.length < group.length,
      lastRunAt: group.map((result) => result.endedAt).sort().at(-1)!,
    });
  }
  return rows.sort((a, b) =>
    a.target.localeCompare(b.target) ||
    a.suiteRunId.localeCompare(b.suiteRunId) ||
    a.harnessVersion.localeCompare(b.harnessVersion) ||
    a.caseId.localeCompare(b.caseId) ||
    a.caseVersion - b.caseVersion,
  );
}

export function renderLedgerHistory(rows: LedgerAggregateRow[]): string {
  if (!rows.length) return 'The ledger is empty — run the suite or ingest a results.json first.\n';
  const header = ['Target', 'Cohort', 'Harness', 'Case', 'Runs', 'Gates', 'Grade passes', 'Score', 'Median wall', 'Cost', 'Last run'];
  const body = rows.map((row) => [
    row.target,
    row.suiteRunId,
    row.harnessVersion,
    `${row.caseId}@v${row.caseVersion}`,
    String(row.runs),
    `${row.hardGatePasses}/${row.runs} (${Math.round((row.hardGatePasses / row.runs) * 100)}%)`,
    row.gradePasses
      .map((grade) => `${grade.hardGate ? 'H' : 'Q'}:${grade.id}=${grade.passes}/${grade.runs}`)
      .join(', ') || '—',
    row.meanScore === null ? '—' : row.meanScore.toFixed(2),
    `${(row.medianDurationMs / 1000).toFixed(1)}s`,
    row.knownCostUsd === null ? '—' : `$${row.knownCostUsd.toFixed(4)}${row.costIncomplete ? ' (+unknown)' : ''}`,
    row.lastRunAt.slice(0, 10),
  ]);
  const table = [header, ...body];
  const widths = header.map((_, column) => Math.max(...table.map((cells) => cells[column]!.length)));
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join('\n') + '\n';
}
