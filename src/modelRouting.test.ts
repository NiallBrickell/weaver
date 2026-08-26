import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { Assignment } from './types.js';
import type { EvalCaseResult } from './evals/types.js';
import { defaultLedgerPath, loadLedger } from './evals/ledger.js';
import {
  deterministicActionsOnly,
  runnerExecutorCapabilities,
  workerTargetForAssignment,
  workerTargetsForAssignment,
  WORK_MODEL_ROUTES,
  type WorkModelRoute,
} from './modelRouting.js';
import { auditRouteEvidence, auditRoutingRegistry } from './evals/routingEvidence.js';

function assignment(
  profile: NonNullable<Assignment['executionRequirements']>['profile'] = 'general',
  modalities: NonNullable<Assignment['executionRequirements']>['modalities'] = ['text'],
  kind: Assignment['kind'] = 'work',
  complexity?: NonNullable<Assignment['executionRequirements']>['complexity'],
): Assignment {
  return {
    id: 'asg_route',
    objective: 'route one bounded unit',
    briefing: 'A complete brief.',
    kind,
    executionRequirements: { profile, modalities, ...(complexity ? { complexity } : {}) },
    acceptanceCriteria: ['verified'],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: '2026-08-14T00:00:00.000Z',
  };
}

const TEST_ROUTE: WorkModelRoute = {
  id: 'fixture-bounded-code-repair',
  preference: 100,
  match: { profiles: ['bounded-code-repair'], modalities: ['text'] },
  target: { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
  evidence: {
    suiteRunId: '20260814T114654Z',
    executor: 'codex-sdk',
    model: 'gpt-5.6-sol',
    harnessVersion: 'codex-sdk-0.147.0-weaver.2',
    cases: [{
      id: 'code-repair',
      version: 1,
      requiredHardGates: [
        'weaver-submission',
        'artifact-integrity',
        'adoption-separation',
        'target-identity',
        'runtime-completion',
        'workspace-scope',
      ],
      requiredGrades: ['hidden-tests', 'verification-evidence'],
    }],
    minRuns: 3,
  },
};

test('deterministic-only action mode is explicit and fails closed on malformed config', () => {
  const previous = process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY;
  try {
    delete process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY;
    assert.equal(deterministicActionsOnly(), false);
    process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY = '0';
    assert.equal(deterministicActionsOnly(), false);
    process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY = '1';
    assert.equal(deterministicActionsOnly(), true);
    process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY = 'yes';
    assert.throws(() => deterministicActionsOnly(), /must be 0 or 1/);
  } finally {
    if (previous === undefined) delete process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY;
    else process.env.WEAVER_DETERMINISTIC_ACTIONS_ONLY = previous;
  }
});

const ACTIVE_CODEX_ROUTE = WORK_MODEL_ROUTES.find(
  (route) => route.id === 'codex-5-6-sol-bounded-code-repair',
)!;
const ACTIVE_PI_ROUTE = WORK_MODEL_ROUTES.find(
  (route) => route.id === 'pi-kimi-k3-bounded-code-repair',
)!;
const ACTIVE_GLM_ROUTE = WORK_MODEL_ROUTES.find(
  (route) => route.id === 'pi-glm-5-3-bounded-code-repair',
)!;

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
  test('no checked-in route binds to general — the fallback stays unrouted', () => {
    // A route matching `general` would match every unmatched assignment in
    // the fleet, which no eval cohort can justify. Routing code would accept
    // it (routeMatches checks membership only), so the registry auditor is
    // the enforcement site — see docs/execution-profiles.md.
    for (const route of WORK_MODEL_ROUTES) {
      assert.ok(
        !route.match.profiles.includes('general'),
        `route ${route.id} must not match 'general'`,
      );
      assert.ok(route.match.profiles.length > 0, `route ${route.id} must declare a profile`);
    }
  });

  test('the active bounded repair route is ordered ahead of the configured fallback', () => {
    const previousExecutor = process.env.WEAVER_EXECUTOR;
    const previousModel = process.env.WEAVER_WORKER_MODEL;
    process.env.WEAVER_EXECUTOR = 'codex-sdk';
    process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
    try {
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair')), [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5' },
      ]);
      assert.equal(ACTIVE_CODEX_ROUTE.evidence.harnessVersion, 'codex-sdk-0.147.0-weaver.3');
      assert.equal(ACTIVE_CODEX_ROUTE.evidence.minRuns, 10);
    } finally {
      if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
      else process.env.WEAVER_EXECUTOR = previousExecutor;
      if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
      else process.env.WEAVER_WORKER_MODEL = previousModel;
    }
  });

  test('automatic routes cannot cross the configured worker substrate and strand a stock runner', () => {
    const previousExecutor = process.env.WEAVER_EXECUTOR;
    const previousModel = process.env.WEAVER_WORKER_MODEL;
    process.env.WEAVER_EXECUTOR = 'local-sdk';
    process.env.WEAVER_WORKER_MODEL = 'sonnet';
    try {
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair')), [
        { executor: 'local-sdk', provider: 'anthropic', model: 'sonnet' },
      ]);
    } finally {
      if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
      else process.env.WEAVER_EXECUTOR = previousExecutor;
      if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
      else process.env.WEAVER_WORKER_MODEL = previousModel;
    }
  });

  test('glm-5.3 leads the coding routes inside a Pi substrate, and general work stays off the coding plan', () => {
    const previousExecutor = process.env.WEAVER_EXECUTOR;
    const previousModel = process.env.WEAVER_WORKER_MODEL;
    // The production shape: Pi seat on the licence-unrestricted Kimi model,
    // glm-5.3 available only as a reviewed coding route.
    process.env.WEAVER_EXECUTOR = 'pi';
    process.env.WEAVER_WORKER_MODEL = 'openrouter/moonshotai/kimi-k3';
    try {
      // Coding: glm-5.3 (pref 110) leads the Kimi route (pref 100); the Kimi
      // seat dedups against the Kimi route.
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair')), [
        { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' },
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      // General (non-coding) NEVER touches the licence-restricted coding plan:
      // no route matches, so only the Kimi seat serves it.
      assert.deepEqual(workerTargetsForAssignment(assignment('general')), [
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      // The text-only coding routes do not match an image-bearing repair; it
      // falls to the Kimi seat, still off the coding plan.
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair', ['text', 'image'])), [
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      assert.equal(ACTIVE_GLM_ROUTE.evidence.suiteRunId, '20260821T122900Z');
      assert.equal(ACTIVE_GLM_ROUTE.evidence.harnessVersion, 'pi@0.84.2-weaver.4');
      assert.equal(ACTIVE_GLM_ROUTE.evidence.minRuns, 10);
      assert.equal(ACTIVE_GLM_ROUTE.preference > ACTIVE_PI_ROUTE.preference, true);
      assert.equal(ACTIVE_PI_ROUTE.evidence.suiteRunId, '20260815T105214Z');
      assert.equal(ACTIVE_PI_ROUTE.evidence.minRuns, 10);
    } finally {
      if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
      else process.env.WEAVER_EXECUTOR = previousExecutor;
      if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
      else process.env.WEAVER_WORKER_MODEL = previousModel;
    }
  });

  test('only typed bounded text repair selects the preferred Codex target', () => {
    const previousExecutor = process.env.WEAVER_EXECUTOR;
    const previousModel = process.env.WEAVER_WORKER_MODEL;
    process.env.WEAVER_EXECUTOR = 'codex-sdk';
    process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
    try {
      assert.deepEqual(workerTargetForAssignment(assignment('bounded-code-repair'), [TEST_ROUTE]), {
        executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
      });
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair'), [TEST_ROUTE]), [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5' },
      ]);
      assert.deepEqual(workerTargetForAssignment(assignment('general'), [TEST_ROUTE]), {
        executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5',
      });
      assert.deepEqual(workerTargetForAssignment(assignment('bounded-code-repair', ['text', 'image']), [TEST_ROUTE]), {
        executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5',
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

  test('the operator worker ladder is appended after the configured seat and deduped', () => {
    const names = ['WEAVER_EXECUTOR', 'WEAVER_WORKER_MODEL', 'WEAVER_WORKER_FALLBACKS'] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.WEAVER_EXECUTOR = 'codex-sdk';
      process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
      process.env.WEAVER_WORKER_FALLBACKS =
        'codex-sdk:gpt-5.5, pi:zai-coding-plan/glm-5.3, pi:openrouter/moonshotai/kimi-k3';
      // Order: reviewed eval routes, the configured seat, then the ladder —
      // with the ladder's repeat of the configured seat deduped away. The
      // ladder may cross executors: it is operator machine config, unlike
      // automatic eval routes.
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair')), [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5' },
        { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' },
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      assert.deepEqual(workerTargetsForAssignment(assignment('general')), [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5' },
        { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' },
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      // Actions never gain a ladder: the supervised target stays alone.
      assert.deepEqual(workerTargetsForAssignment(assignment('general', ['text'], 'action')), [
        { executor: 'local-sdk', provider: 'anthropic', model: 'sonnet' },
      ]);
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('declared high complexity upgrades only the configured seat model', () => {
    const names = [
      'WEAVER_EXECUTOR',
      'WEAVER_WORKER_MODEL',
      'WEAVER_WORKER_MODEL_COMPLEX',
      'WEAVER_WORKER_FALLBACKS',
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.WEAVER_EXECUTOR = 'codex-sdk';
      process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
      process.env.WEAVER_WORKER_MODEL_COMPLEX = 'gpt-5.6-pro';
      process.env.WEAVER_WORKER_FALLBACKS = 'pi:openrouter/moonshotai/kimi-k3';
      // The complex-tier model replaces the configured seat only: reviewed
      // routes keep their reviewed targets ahead of it, the operator ladder
      // follows unchanged, and the executor (and derived provider) stay put.
      assert.deepEqual(workerTargetsForAssignment(assignment('bounded-code-repair', ['text'], 'work', 'high')), [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-pro' },
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      assert.deepEqual(workerTargetsForAssignment(assignment('general', ['text'], 'work', 'high')), [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-pro' },
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ]);
      // Standard — declared or absent — keeps the standard seat exactly.
      const standardSeat = [
        { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5' },
        { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
      ];
      assert.deepEqual(workerTargetsForAssignment(assignment('general', ['text'], 'work', 'standard')), standardSeat);
      assert.deepEqual(workerTargetsForAssignment(assignment('general')), standardSeat);
      // Actions never enter routing: the supervised target ignores complexity.
      assert.deepEqual(workerTargetsForAssignment(assignment('general', ['text'], 'action', 'high')), [
        { executor: 'local-sdk', provider: 'anthropic', model: 'sonnet' },
      ]);
      // Without a configured complex tier, high-complexity work runs on the
      // standard worker model rather than failing or inventing a target.
      delete process.env.WEAVER_WORKER_MODEL_COMPLEX;
      assert.deepEqual(workerTargetsForAssignment(assignment('general', ['text'], 'work', 'high')), standardSeat);
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('runner capabilities default to configured seats and explicit declarations fail closed', () => {
    const names = [
      'WEAVER_RUNNER_EXECUTORS',
      'WEAVER_EXECUTOR',
      'WEAVER_ACTION_EXECUTOR',
      'WEAVER_COORDINATOR_EXECUTOR',
      'WEAVER_COORDINATOR_FALLBACK_EXECUTOR',
      'WEAVER_COORDINATOR_FALLBACKS',
      'WEAVER_WORKER_FALLBACKS',
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.WEAVER_EXECUTOR = 'codex-sdk';
      process.env.WEAVER_ACTION_EXECUTOR = 'local-sdk';
      process.env.WEAVER_COORDINATOR_EXECUTOR = 'codex-sdk';
      process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR = 'codex-sdk';
      assert.deepEqual([...runnerExecutorCapabilities()], ['codex-sdk', 'local-sdk']);

      // Every executor named in the coordinator chain and the worker ladder
      // joins the default declaration: a host configured to degrade onto a
      // substrate must be willing to claim it.
      process.env.WEAVER_COORDINATOR_FALLBACKS = 'local-sdk:claude-opus-5';
      process.env.WEAVER_WORKER_FALLBACKS = 'pi:openrouter/moonshotai/kimi-k3';
      assert.deepEqual([...runnerExecutorCapabilities()], ['codex-sdk', 'local-sdk', 'pi']);
      delete process.env.WEAVER_COORDINATOR_FALLBACKS;
      delete process.env.WEAVER_WORKER_FALLBACKS;

      process.env.WEAVER_RUNNER_EXECUTORS = ' openhands, pi,codex-sdk,openhands ';
      assert.deepEqual([...runnerExecutorCapabilities()], ['openhands', 'pi', 'codex-sdk']);
      process.env.WEAVER_RUNNER_EXECUTORS = 'managed-agents';
      assert.throws(() => runnerExecutorCapabilities(), /unknown runner executor 'managed-agents'/);
      process.env.WEAVER_RUNNER_EXECUTORS = ' , ';
      assert.throws(() => runnerExecutorCapabilities(), /must declare at least one executor/);

    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('route evidence audit', () => {
  const route = TEST_ROUTE;

  test('requires three exact, versioned repetitions and complete quality vectors', () => {
    const clean = [cleanResult(1), cleanResult(2), cleanResult(3)];
    assert.deepEqual(auditRouteEvidence(route, clean), []);
    assert.match(auditRouteEvidence(route, clean.slice(0, 2))[0]!.message, /2\/3 distinct exact runs/);

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
    assert.match(auditRouteEvidence(route, [legacy, staleCase, staleAdapter])[0]!.message, /0\/3 distinct exact runs/);

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

  test('duplicate or non-contiguous repetitions cannot manufacture a qualifying cohort', () => {
    const duplicate = [cleanResult(1), cleanResult(1), cleanResult(1)];
    assert.ok(
      auditRouteEvidence(route, duplicate).some((failure) => /duplicate repetitions 1/.test(failure.message)),
    );
    assert.ok(
      auditRouteEvidence(route, duplicate).some((failure) => /1\/3 distinct exact runs/.test(failure.message)),
    );

    const gapped = [cleanResult(1), cleanResult(3), cleanResult(4)];
    assert.ok(
      auditRouteEvidence(route, gapped).some((failure) => /missing repetitions 2/.test(failure.message)),
    );
  });

  test('every checked-in route cites a complete clean cohort in the durable ledger', () => {
    assert.deepEqual(auditRoutingRegistry(loadLedger(defaultLedgerPath())), []);
  });
});
