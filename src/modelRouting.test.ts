import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { Assignment } from './types.js';
import type { EvalCaseResult } from './evals/types.js';
import { defaultLedgerPath, loadLedger } from './evals/ledger.js';
import {
  workerTargetForAssignment,
  WORK_MODEL_ROUTES,
  type WorkModelRoute,
} from './modelRouting.js';
import { auditRouteEvidence, auditRoutingRegistry } from './evals/routingEvidence.js';

function assignment(
  profile: NonNullable<Assignment['executionRequirements']>['profile'] = 'general',
  modalities: NonNullable<Assignment['executionRequirements']>['modalities'] = ['text'],
  kind: Assignment['kind'] = 'work',
): Assignment {
  return {
    id: 'asg_route',
    objective: 'route one bounded unit',
    briefing: 'A complete brief.',
    kind,
    executionRequirements: { profile, modalities },
    acceptanceCriteria: ['verified'],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: '2026-08-14T00:00:00.000Z',
  };
}

function cleanResult(
  repetition: number,
  overrides: Partial<EvalCaseResult> = {},
): EvalCaseResult {
  return {
    schemaVersion: 2,
    suiteRunId: '20260814T114654Z',
    caseId: 'code-repair',
    caseVersion: 1,
    repetition,
    target: {
      executor: 'codex-sdk',
      model: 'gpt-5.6-sol',
      label: 'codex-sdk:gpt-5.6-sol',
    },
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:01:00.000Z',
    durationMs: 60_000,
    execution: {
      executor: 'codex-sdk',
      modelRequested: 'gpt-5.6-sol',
      providerResolved: 'openai',
      modelResolved: 'gpt-5.6-sol',
      harnessVersion: 'codex-sdk-0.147.0-weaver.2',
      isolation: 'host-process',
      startedAt: '2026-08-14T00:00:00.000Z',
      endedAt: '2026-08-14T00:01:00.000Z',
      durationMs: 60_000,
      startupMs: 100,
      timeToSubmissionMs: 50_000,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
      },
      costUsd: null,
      sessionId: `session-${repetition}`,
      terminalReason: 'completed',
      error: null,
    },
    submitted: true,
    adoptionState: 'proposed',
    grades: [
      { id: 'weaver-submission', hardGate: true, passed: true, score: null, detail: 'submitted' },
      { id: 'artifact-integrity', hardGate: true, passed: true, score: null, detail: 'pinned' },
      { id: 'adoption-separation', hardGate: true, passed: true, score: null, detail: 'proposed' },
      { id: 'target-identity', hardGate: true, passed: true, score: null, detail: 'matched' },
      { id: 'runtime-completion', hardGate: true, passed: true, score: null, detail: 'completed' },
      { id: 'workspace-scope', hardGate: true, passed: true, score: null, detail: 'one file' },
      { id: 'hidden-tests', hardGate: false, passed: true, score: 1, detail: 'passed' },
      { id: 'verification-evidence', hardGate: false, passed: true, score: 1, detail: 'named' },
    ],
    passedHardGates: true,
    artifactPath: 'report.md',
    artifactHash: 'abc',
    error: null,
    ...overrides,
  };
}

describe('reviewed worker routes', () => {
  test('only typed bounded text repair selects the preferred Codex target', () => {
    const previousExecutor = process.env.WEAVER_EXECUTOR;
    const previousModel = process.env.WEAVER_WORKER_MODEL;
    process.env.WEAVER_EXECUTOR = 'local-sdk';
    process.env.WEAVER_WORKER_MODEL = 'sonnet';
    try {
      assert.deepEqual(workerTargetForAssignment(assignment('bounded-code-repair')), {
        executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
      });
      assert.deepEqual(workerTargetForAssignment(assignment('general')), {
        executor: 'local-sdk', provider: 'anthropic', model: 'sonnet',
      });
      assert.deepEqual(workerTargetForAssignment(assignment('bounded-code-repair', ['text', 'image'])), {
        executor: 'local-sdk', provider: 'anthropic', model: 'sonnet',
      });
    } finally {
      if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
      else process.env.WEAVER_EXECUTOR = previousExecutor;
      if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
      else process.env.WEAVER_WORKER_MODEL = previousModel;
    }
  });

  test('actions ignore performance routes and retain the supervised target', () => {
    const previousExecutor = process.env.WEAVER_EXECUTOR;
    const previousModel = process.env.WEAVER_WORKER_MODEL;
    process.env.WEAVER_EXECUTOR = 'codex-sdk';
    process.env.WEAVER_WORKER_MODEL = 'gpt-5.6-sol';
    try {
      assert.deepEqual(workerTargetForAssignment(assignment('bounded-code-repair', ['text'], 'action')), {
        executor: 'local-sdk', provider: 'anthropic', model: 'sonnet',
      });
    } finally {
      if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
      else process.env.WEAVER_EXECUTOR = previousExecutor;
      if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
      else process.env.WEAVER_WORKER_MODEL = previousModel;
    }
  });
});

describe('route evidence audit', () => {
  const route = WORK_MODEL_ROUTES[0]!;

  test('requires three exact, versioned repetitions and complete quality vectors', () => {
    const clean = [cleanResult(1), cleanResult(2), cleanResult(3)];
    assert.deepEqual(auditRouteEvidence(route, clean), []);
    assert.match(auditRouteEvidence(route, clean.slice(0, 2))[0]!.message, /2\/3 exact runs/);

    const hardFailure = cleanResult(3, { passedHardGates: false });
    assert.match(auditRouteEvidence(route, [clean[0]!, clean[1]!, hardFailure])[0]!.message, /hard gate/);

    const omittedGate = cleanResult(3, {
      grades: cleanResult(3).grades.filter((grade) => grade.id !== 'workspace-scope'),
    });
    assert.match(auditRouteEvidence(route, [clean[0]!, clean[1]!, omittedGate])[0]!.message, /omitted hard gate workspace-scope/);

    const qualityFailure = cleanResult(3, {
      grades: cleanResult(3).grades.map((grade) =>
        grade.id === 'hidden-tests' ? { ...grade, passed: false, score: 0 } : grade,
      ),
    });
    assert.match(auditRouteEvidence(route, [clean[0]!, clean[1]!, qualityFailure])[0]!.message, /hidden-tests/);
  });

  test('rejects legacy, stale adapter, and stale case epochs while null cost is irrelevant', () => {
    const legacy = cleanResult(1, { schemaVersion: 1, caseVersion: undefined });
    const staleCase = cleanResult(2, { caseVersion: 2 });
    const staleAdapter = cleanResult(3, {
      execution: { ...cleanResult(3).execution!, harnessVersion: 'codex-sdk-old' },
    });
    assert.match(auditRouteEvidence(route, [legacy, staleCase, staleAdapter])[0]!.message, /0\/3 exact runs/);

    const unknownCosts = [cleanResult(1), cleanResult(2), cleanResult(3)];
    assert.ok(unknownCosts.every((result) => result.execution?.costUsd === null));
    assert.deepEqual(auditRouteEvidence(route, unknownCosts), []);
  });

  test('cited evidence cannot be attached to a different production target', () => {
    const mismatched: WorkModelRoute = {
      ...route,
      target: { executor: 'openhands', provider: 'openrouter', model: route.target.model },
    };
    assert.match(auditRouteEvidence(mismatched, [cleanResult(1), cleanResult(2), cleanResult(3)])[0]!.message, /does not exactly match/);
  });

  test('every checked-in route cites a complete clean cohort in the durable ledger', () => {
    assert.deepEqual(auditRoutingRegistry(loadLedger(defaultLedgerPath())), []);
  });
});
