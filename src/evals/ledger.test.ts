import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  aggregateLedger,
  appendToLedger,
  defaultLedgerPath,
  loadLedger,
  renderLedgerHistory,
} from './ledger.js';
import type { EvalCaseResult, EvalGrade } from './types.js';

function grade(overrides: Partial<EvalGrade> = {}): EvalGrade {
  return { id: 'check', hardGate: true, passed: true, score: null, detail: 'ok', ...overrides };
}

function makeResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    schemaVersion: 1,
    suiteRunId: 'suite-1',
    caseId: 'code-repair',
    repetition: 1,
    target: { executor: 'codex-sdk', model: 'test-model', label: 'codex-sdk:test-model' },
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z',
    durationMs: 1_000,
    execution: null,
    submitted: true,
    adoptionState: 'proposed',
    grades: [grade()],
    passedHardGates: true,
    artifactPath: null,
    artifactHash: null,
    error: null,
    ...overrides,
  };
}

function costOnlyExecution(costUsd: number | null): EvalCaseResult['execution'] {
  return {
    executor: 'codex-sdk', modelRequested: 'test-model', providerResolved: null, modelResolved: null,
    harnessVersion: 'fake', isolation: 'host-process', startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:00:01.000Z', durationMs: 1_000, startupMs: null, timeToSubmissionMs: null,
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
    costUsd, sessionId: null, terminalReason: 'completed', error: null,
  };
}

test('the default ledger path is the checked-in repo-root evals/ledger.jsonl', () => {
  assert.match(defaultLedgerPath(), /\/evals\/ledger\.jsonl$/);
});

test('appended case results survive a reload byte-for-byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-ledger-roundtrip-'));
  const path = join(root, 'evals', 'ledger.jsonl');
  try {
    const first = makeResult({ repetition: 1 });
    const second = makeResult({ repetition: 2, passedHardGates: false, error: 'boom' });
    const outcome = appendToLedger(path, [first, second]);
    assert.deepEqual(outcome, { appended: 2, skipped: 0 });
    assert.deepEqual(loadLedger(path), [first, second]);
    const later = makeResult({ suiteRunId: 'suite-2' });
    appendToLedger(path, [later]);
    assert.deepEqual(loadLedger(path), [first, second, later]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-ingesting the same results is a no-op and never rewrites existing lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-ledger-dedupe-'));
  const path = join(root, 'ledger.jsonl');
  try {
    const results = [makeResult({ repetition: 1 }), makeResult({ repetition: 2 })];
    assert.deepEqual(appendToLedger(path, results), { appended: 2, skipped: 0 });
    const before = readFileSync(path, 'utf8');
    assert.deepEqual(appendToLedger(path, results), { appended: 0, skipped: 2 });
    assert.equal(readFileSync(path, 'utf8'), before);
    // A partially overlapping batch appends only the genuinely new line.
    const mixed = [makeResult({ repetition: 2 }), makeResult({ repetition: 3 })];
    assert.deepEqual(appendToLedger(path, mixed), { appended: 1, skipped: 1 });
    assert.equal(loadLedger(path).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity distinguishes suite run, target label, case, and repetition', () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-ledger-identity-'));
  const path = join(root, 'ledger.jsonl');
  try {
    const base = makeResult();
    appendToLedger(path, [base]);
    const variants = [
      makeResult({ suiteRunId: 'suite-9' }),
      makeResult({ target: { executor: 'codex-sdk', model: 'other', label: 'codex-sdk:other' } }),
      makeResult({ caseId: 'ui-build' }),
      makeResult({ repetition: 7 }),
    ];
    assert.deepEqual(appendToLedger(path, variants), { appended: 4, skipped: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicate batch never creates the ledger file just to record a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-ledger-empty-'));
  const path = join(root, 'nested', 'ledger.jsonl');
  try {
    assert.deepEqual(appendToLedger(path, []), { appended: 0, skipped: 0 });
    assert.equal(existsSync(path), false);
    assert.deepEqual(loadLedger(path), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregation groups by executor:model and case with null-safe score and cost', () => {
  const group = [
    makeResult({
      repetition: 1,
      durationMs: 1_000,
      endedAt: '2026-08-10T00:00:01.000Z',
      execution: costOnlyExecution(0.01),
      grades: [grade({ score: 1 }), grade({ score: null })],
    }),
    makeResult({
      repetition: 2,
      durationMs: 3_000,
      endedAt: '2026-08-12T00:00:01.000Z',
      execution: costOnlyExecution(null),
      grades: [grade({ score: null })], // no scored grades: excluded from the mean, never zero
    }),
    makeResult({
      repetition: 3,
      durationMs: 2_000,
      endedAt: '2026-08-11T00:00:01.000Z',
      execution: costOnlyExecution(0.02),
      passedHardGates: false,
      grades: [grade({ score: 0.5, passed: false })],
    }),
  ];
  const other = makeResult({
    caseId: 'ui-build',
    target: { executor: 'claude-sdk', model: 'sonnet', label: 'claude-sdk:sonnet' },
    execution: null,
    grades: [grade({ score: null })],
  });
  const rows = aggregateLedger([...group, other]);
  assert.equal(rows.length, 2);
  const [claude, codex] = rows;
  assert.equal(codex!.target, 'codex-sdk:test-model');
  assert.equal(codex!.caseId, 'code-repair');
  assert.equal(codex!.runs, 3);
  assert.equal(codex!.hardGatePasses, 2);
  assert.equal(codex!.meanScore, 0.75); // mean of per-run scores 1 and 0.5; the null-score run is excluded
  assert.equal(codex!.medianDurationMs, 2_000);
  assert.equal(codex!.knownCostUsd, 0.01 + 0.02);
  assert.equal(codex!.costIncomplete, true);
  assert.equal(codex!.lastRunAt, '2026-08-12T00:00:01.000Z');
  assert.equal(claude!.target, 'claude-sdk:sonnet');
  assert.equal(claude!.meanScore, null);
  assert.equal(claude!.knownCostUsd, null);
});

test('the history table marks unknown costs and never renders a null as zero', () => {
  const rows = aggregateLedger([
    makeResult({ execution: costOnlyExecution(0.05) }),
    makeResult({ repetition: 2, execution: costOnlyExecution(null) }),
    makeResult({ caseId: 'ui-build', execution: null, grades: [grade({ score: null })] }),
  ]);
  const table = renderLedgerHistory(rows);
  assert.match(table, /\$0\.0500 \(\+unknown\)/);
  assert.match(table, /—/);
  assert.doesNotMatch(table, /\$0\.0000/);
  assert.match(renderLedgerHistory([]), /ledger is empty/i);
});

test('a corrupted ledger line fails loudly instead of silently dropping history', () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-ledger-corrupt-'));
  const path = join(root, 'ledger.jsonl');
  try {
    appendToLedger(path, [makeResult()]);
    appendFileSync(path, '{not json\n');
    assert.throws(() => loadLedger(path), /line 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
