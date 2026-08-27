import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COORDINATOR_SYSTEM_PROMPT,
  clearCoordinatorCapacityBackoff,
  passOutcome,
  pickCoordinatorModel,
  pickCoordinatorTarget,
  pickCoordinatorTargetForExecutors,
  recordCoordinatorCapacityBackoff,
  runCoordinatorPass,
} from './coordinator.js';
import { arrive, createWorkstream, load, writeArtifact } from './store.js';
import { isCoordinatorCancellableWake, virtualNow, type CancellableWakePage } from './clock.js';
import type { CapacityCategory, InfrastructureWait } from './types.js';
import type { CoordinatorExecutor } from './executor/coordinator.js';

let home: string;
let coordinatorEnv: Record<string, string | undefined>;

test('incident briefs must trace trigger, recovery, escape, and every fallback attempt', () => {
  assert.match(COORDINATOR_SYSTEM_PROMPT, /what triggered the failed operation/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /why its recovery\/retry\/fallback did not recover/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /why the failure escaped/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /enumerate EVERY configured attempt/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /missing from telemetry is an observability defect/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /trigger, recovery, containment, detection, and recurrence evidence/);
});

beforeEach(async () => {
  coordinatorEnv = {
    WEAVER_COORDINATOR_EXECUTOR: process.env.WEAVER_COORDINATOR_EXECUTOR,
    WEAVER_COORDINATOR_MODEL: process.env.WEAVER_COORDINATOR_MODEL,
    WEAVER_COORDINATOR_FALLBACK_EXECUTOR: process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR,
    WEAVER_COORDINATOR_FALLBACK_MODEL: process.env.WEAVER_COORDINATOR_FALLBACK_MODEL,
    WEAVER_COORDINATOR_FALLBACKS: process.env.WEAVER_COORDINATOR_FALLBACKS,
  };
  delete process.env.WEAVER_COORDINATOR_EXECUTOR;
  delete process.env.WEAVER_COORDINATOR_MODEL;
  delete process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR;
  delete process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
  delete process.env.WEAVER_COORDINATOR_FALLBACKS;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-coordinator-capacity-'));
  process.env.WEAVER_HOME = home;
  await createWorkstream({
    slug: 'coordinator-capacity',
    title: 'Coordinator capacity',
    objective: 'test deterministic pass finalization state',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  for (const [name, value] of Object.entries(coordinatorEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function wait(category: CapacityCategory, index: number): InfrastructureWait {
  return {
    kind: category,
    recovery: category === 'usage_limit' || category === 'sdk_credit_exhausted'
      ? 'wait_or_enable_usage_credits'
      : category === 'auth'
        ? 'reauthenticate'
        : 'automatic_retry',
    source: 'coordinator',
    sourceId: `pass_${index}`,
    model: 'claude-fable-5',
    executor: 'local-sdk',
    provider: 'anthropic',
    detectedAt: virtualNow().toISOString(),
    retryAt: new Date(virtualNow().getTime() + 15 * 60_000).toISOString(),
  };
}

async function backoff(category: CapacityCategory, count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await arrive('coordinator-capacity', (doc) => {
      recordCoordinatorCapacityBackoff(doc, wait(category, index), `wake_${index}`);
    });
  }
}

test('plan usage state raises one explicit recovery card only after sustained backoff', async () => {
  await backoff('usage_limit', 12);
  let doc = await load('coordinator-capacity');
  assert.equal(Object.values(doc.capacity!.byModel)[0]!.consecutiveBackoffs, 12);
  assert.equal(doc.attention.filter((item) => item.kind === 'capacity').length, 1);
  assert.match(doc.attention[0]!.summary, /`\/usage`/);
  assert.match(doc.attention[0]!.summary, /weaver capacity retry coordinator-capacity/);
  assert.match(doc.attention[0]!.summary, /support\.claude\.com\/en\/articles\/11145838/);
  assert.match(doc.attention[0]!.summary, /support\.claude\.com\/en\/articles\/12429409/);

  await backoff('usage_limit', 1);
  doc = await load('coordinator-capacity');
  assert.equal(doc.attention.filter((item) => item.kind === 'capacity').length, 1);
  assert.match(doc.attention[0]!.summary, /blocked work 13 times/);
});

test('session limits wait quietly until the twelfth consecutive backoff', async () => {
  await backoff('session_limit', 11);
  assert.equal((await load('coordinator-capacity')).attention.length, 0);
  await backoff('session_limit', 1);
  assert.equal((await load('coordinator-capacity')).attention.filter((item) => item.kind === 'capacity').length, 1);
});

test('a recovered coordinator model clears typed state and resolves its card', async () => {
  await backoff('auth', 1);
  await arrive('coordinator-capacity', (doc) => {
    clearCoordinatorCapacityBackoff(doc, 'claude-fable-5');
  });
  const doc = await load('coordinator-capacity');
  assert.equal(doc.capacity, null);
  assert.equal(doc.attention[0]!.status, 'resolved');
  assert.equal(doc.attention[0]!.resolvedBy, 'coordinator');
});

test('a limited primary model degrades the pass to the fallback, and only then', async () => {
  const now = virtualNow().toISOString();
  const future = new Date(virtualNow().getTime() + 60 * 60_000).toISOString();
  const past = new Date(virtualNow().getTime() - 60_000).toISOString();
  const wait = (model: string, retryAt: string): InfrastructureWait => ({
    kind: 'rate_limit', recovery: 'automatic_retry', source: 'coordinator',
    sourceId: 'pass_x', model, detectedAt: now, retryAt,
  });
  const doc = await load('coordinator-capacity');

  // No capacity state at all → primary.
  assert.equal(pickCoordinatorModel(doc, now), 'claude-fable-5');

  // Primary limited, fallback clear → fallback.
  const capacity = { state: 'backoff' as const, byModel: { 'claude-fable-5': { wait: wait('claude-fable-5', future), consecutiveBackoffs: 1, firstBackoffAtVirtual: now, lastBackoffAtVirtual: now } } };
  doc.capacity = capacity;
  assert.equal(pickCoordinatorModel(doc, now), 'claude-opus-4-8');

  // Primary limited but its retryAt has passed → primary again (probe/retry).
  capacity.byModel['claude-fable-5']!.wait = wait('claude-fable-5', past);
  assert.equal(pickCoordinatorModel(doc, now), 'claude-fable-5');

  // Both pools limited → primary (normal backoff machinery owns it).
  capacity.byModel['claude-fable-5']!.wait = wait('claude-fable-5', future);
  (capacity.byModel as Record<string, unknown>)['claude-opus-4-8'] = { wait: wait('claude-opus-4-8', future), consecutiveBackoffs: 1, firstBackoffAtVirtual: now, lastBackoffAtVirtual: now };
  assert.equal(pickCoordinatorModel(doc, now), 'claude-fable-5');
});

test('a limited Anthropic primary can degrade to an exact Codex/OpenAI target', async () => {
  process.env.WEAVER_COORDINATOR_EXECUTOR = 'local-sdk';
  process.env.WEAVER_COORDINATOR_MODEL = 'claude-fable-5';
  process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = 'gpt-5.6-sol';
  const now = virtualNow().toISOString();
  const doc = await load('coordinator-capacity');
  doc.capacity = {
    state: 'backoff',
    byModel: {
      'local-sdk:anthropic:claude-fable-5': {
        wait: {
          kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits',
          source: 'coordinator', sourceId: 'pass_primary',
          executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
          detectedAt: now,
          retryAt: new Date(virtualNow().getTime() + 60 * 60_000).toISOString(),
        },
        consecutiveBackoffs: 1,
        firstBackoffAtVirtual: now,
        lastBackoffAtVirtual: now,
      },
    },
  };

  assert.deepEqual(pickCoordinatorTarget(doc, now), {
    executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
  });
  assert.deepEqual(pickCoordinatorTargetForExecutors(doc, now, new Set(['codex-sdk'])), {
    executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
  });
  assert.equal(
    pickCoordinatorTargetForExecutors(doc, now, new Set(['local-sdk'])),
    null,
    'a fallback-incapable runner must not claim the limited primary instead',
  );
  assert.equal(pickCoordinatorTargetForExecutors(doc, now, new Set(['openhands'])), null);

  doc.capacity!.byModel['local-sdk:anthropic:claude-fable-5']!.wait.retryAt = now;
  assert.deepEqual(pickCoordinatorTargetForExecutors(doc, now, new Set(['local-sdk'])), {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
  });
  assert.equal(
    pickCoordinatorTargetForExecutors(doc, now, new Set(['codex-sdk'])),
    null,
    'a fallback-only runner must reserve a healthy primary for its capable host',
  );
});

test('a three-deep chain degrades seat by seat and returns the primary only when all are parked', async () => {
  process.env.WEAVER_COORDINATOR_FALLBACKS = 'codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5';
  const now = virtualNow().toISOString();
  const future = new Date(virtualNow().getTime() + 60 * 60_000).toISOString();
  const parked = (executor: string, provider: string, model: string) => ({
    wait: {
      kind: 'rate_limit' as const, recovery: 'automatic_retry' as const,
      source: 'coordinator' as const, sourceId: 'pass_x',
      executor, provider, model, detectedAt: now, retryAt: future,
    },
    consecutiveBackoffs: 1, firstBackoffAtVirtual: now, lastBackoffAtVirtual: now,
  });
  const doc = await load('coordinator-capacity');

  // No capacity state → primary.
  assert.deepEqual(pickCoordinatorTarget(doc, now), {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
  });

  // Primary parked → the second seat.
  doc.capacity = {
    state: 'backoff',
    byModel: {
      'local-sdk:anthropic:claude-fable-5': parked('local-sdk', 'anthropic', 'claude-fable-5'),
    },
  };
  assert.deepEqual(pickCoordinatorTarget(doc, now), {
    executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
  });

  // First two parked → the third seat.
  doc.capacity.byModel['codex-sdk:openai:gpt-5.6-sol'] = parked('codex-sdk', 'openai', 'gpt-5.6-sol');
  assert.deepEqual(pickCoordinatorTarget(doc, now), {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5',
  });

  // Every seat parked → the primary; the normal backoff machinery owns it.
  doc.capacity.byModel['local-sdk:anthropic:claude-opus-5'] = parked('local-sdk', 'anthropic', 'claude-opus-5');
  assert.deepEqual(pickCoordinatorTarget(doc, now), {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
  });
});

test('a mid-chain capacity failure wakes immediately when a later seat is free', async () => {
  process.env.WEAVER_COORDINATOR_FALLBACKS = 'codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5';
  // Park the primary so the pass selects the second seat.
  await arrive('coordinator-capacity', (doc) => {
    recordCoordinatorCapacityBackoff(doc, wait('rate_limit', 1), 'wake_primary');
  });
  const executor: CoordinatorExecutor = {
    id: 'codex-sdk',
    async execute() {
      throw new Error('429 rate limit exceeded');
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'error');
  const doc = await load('coordinator-capacity');
  const pass = doc.passes.at(-1)!;
  assert.equal(pass.executor, 'codex-sdk');
  assert.equal(pass.model, 'gpt-5.6-sol');
  assert.equal(pass.infrastructure!.kind, 'rate_limit');
  assert.equal(pass.infrastructure!.executor, 'codex-sdk');
  // Both the primary and the second seat now hold typed waits...
  const parkedTargets = Object.values(doc.capacity!.byModel).map((entry) =>
    `${entry.wait.executor}:${entry.wait.model}`,
  ).sort();
  assert.deepEqual(parkedTargets, ['codex-sdk:gpt-5.6-sol', 'local-sdk:claude-fable-5']);
  // ...and the degrade wake names the third seat, so the next pass continues.
  const degradeWake = doc.wakes.find((w) =>
    w.status === 'pending' && w.condition.type === 'immediate' &&
    /continue on fallback/.test(w.reason),
  );
  assert.ok(degradeWake, 'a free later seat must produce an immediate continuation wake');
  assert.match(
    degradeWake!.reason,
    /continue on fallback local-sdk:claude-opus-5 while codex-sdk:gpt-5\.6-sol capacity recovers/,
  );
  // The next selection indeed lands on that named seat.
  assert.deepEqual(pickCoordinatorTarget(doc, virtualNow().toISOString()), {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5',
  });
});

test('a runner without the selected coordinator executor cannot claim a pass lease', async () => {
  const before = await load('coordinator-capacity');
  await assert.rejects(
    runCoordinatorPass('coordinator-capacity', ['manual'], undefined, new Set(['openhands'])),
    /does not declare selected coordinator executor/,
  );
  const after = await load('coordinator-capacity');
  assert.equal(after.revision, before.revision);
  assert.equal(after.lease, null);
  assert.equal(after.passes.length, 0);
});

test('a pass pins executor, provider, and model while a fake Codex loop finishes through the real tool closure', async () => {
  process.env.WEAVER_COORDINATOR_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_COORDINATOR_MODEL = 'gpt-5.6-sol';
  process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = 'gpt-5.6-sol';
  const executor: CoordinatorExecutor = {
    id: 'codex-sdk',
    async execute(req) {
      assert.equal(req.model, 'gpt-5.6-sol');
      assert.match(req.prompt, /A wake fired/);
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(finish);
      const reply = await finish.handler({
        summary: 'Reconciled the typed state and exited cleanly.',
        acknowledged_steering: true,
      }, {});
      assert.equal(reply.isError, undefined);
      return { costUsd: 0, sessionId: 'codex-thread-fixture' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  const pass = doc.passes.at(-1)!;
  assert.equal(pass.executor, 'codex-sdk');
  assert.equal(pass.provider, 'openai');
  assert.equal(pass.model, 'gpt-5.6-sol');
  assert.equal(pass.sessionId, 'codex-thread-fixture');
  assert.equal(pass.outcome, 'completed');
});

test('a coordinator cancels only a specific obsolete pending wake', async () => {
  await arrive('coordinator-capacity', (doc) => {
    const createdAt = new Date().toISOString();
    const due = (minutes: number) =>
      new Date(virtualNow().getTime() + minutes * 60_000).toISOString();
    const infrastructure = wait('rate_limit', 77);
    const currentCycleHash = 'a'.repeat(64);
    const unrelatedHash = 'b'.repeat(64);
    const assignment = (id: string) => ({
      id, objective: `Completed ${id}`, briefing: 'bounded test work', kind: 'work' as const,
      acceptanceCriteria: [], dependsOn: [], state: 'completed' as const, attempts: [],
      adoption: { state: 'accepted' as const, passId: 'pass_prior' }, createdAtVirtual: createdAt,
    });
    doc.assignments.push(assignment('asg_cycle'), assignment('asg_unrelated'));
    doc.deliverables.push({
      id: 'del_current_cycle', title: 'Adopted current cycle result', kind: 'report',
      path: 'current-cycle.md', contentHash: currentCycleHash, createdAtVirtual: createdAt,
      producedByAssignment: 'asg_cycle',
      adopted: { contentHash: currentCycleHash, passId: 'pass_prior', atVirtual: createdAt },
    }, {
      id: 'del_unrelated', title: 'Real but unrelated adopted result', kind: 'report',
      path: 'unrelated.md', contentHash: unrelatedHash, createdAtVirtual: createdAt,
      producedByAssignment: 'asg_unrelated',
      adopted: { contentHash: unrelatedHash, passId: 'pass_prior', atVirtual: createdAt },
    });
    doc.decisions.push({
      id: 'dec_unrelated', title: 'A standing decision with no supersession lineage',
      rationale: 'Being standing alone is not cancellation evidence.', madeBy: 'coordinator',
      status: 'standing', decidedAtVirtual: createdAt,
    }, {
      id: 'dec_kept_cycle', title: 'The real next cadence remains standing',
      rationale: 'This course is intentionally not closed.', madeBy: 'coordinator',
      status: 'standing', decidedAtVirtual: createdAt,
    }, {
      id: 'dec_old_cycle', title: 'Earlier detection cadence',
      rationale: 'Replaced by the current cadence.', madeBy: 'coordinator',
      status: 'superseded', supersededBy: 'dec_current_cycle', decidedAtVirtual: createdAt,
    }, {
      id: 'dec_current_cycle', title: 'Current detection cadence',
      rationale: 'The typed successor to the earlier cadence.', madeBy: 'coordinator',
      status: 'standing', supersedes: 'dec_old_cycle', decidedAtVirtual: createdAt,
    });
    doc.wakes.push(
      {
        id: 'wake_obsolete',
        reason: 'safety net for a submission that has already been adopted',
        condition: { type: 'time', dueAtVirtual: due(60) },
        status: 'pending',
        createdAt,
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_kept', reason: 'the one real next check',
        condition: { type: 'time', dueAtVirtual: due(120) }, status: 'pending', createdAt,
        organizationalCourseId: 'dec_kept_cycle',
      },
      {
        id: 'wake_old_detection', reason: 'superseded cycle detection check',
        condition: { type: 'time', dueAtVirtual: due(30) }, status: 'pending', createdAt,
        organizationalCourseId: 'dec_old_cycle',
      },
      {
        id: 'wake_old_safety_net', reason: 'superseded cycle safety net',
        condition: { type: 'time', dueAtVirtual: due(60) }, status: 'pending', createdAt,
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_already_fired',
        reason: 'historical fired wake',
        condition: { type: 'time', dueAtVirtual: due(3) },
        status: 'fired',
        createdAt,
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_already_cancelled', reason: 'historical cancelled wake',
        condition: { type: 'time', dueAtVirtual: due(4) }, status: 'cancelled', createdAt,
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_infrastructure', reason: 'provider recovery',
        condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
        status: 'pending', createdAt, infrastructure, organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_execution_safety', reason: 'rolling execution guard',
        condition: { type: 'time', dueAtVirtual: due(6) }, status: 'pending', createdAt,
        executionSafety: { blockedUntil: due(6), observedStarts: 16, limit: 16, windowSeconds: 600 },
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_immediate', reason: 'arrival reconciliation',
        condition: { type: 'immediate' }, status: 'pending', createdAt,
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_wall_time', reason: 'harness containment timer',
        condition: { type: 'wall_time', dueAt: due(8) }, status: 'pending', createdAt,
        organizationalCourseId: 'asg_cycle',
      },
      {
        id: 'wake_overdue', reason: 'engine reconciliation is already due',
        condition: { type: 'time', dueAtVirtual: due(-1) }, status: 'pending', createdAt,
        organizationalCourseId: 'asg_cycle',
      },
    );
  });
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const cancel = req.tools.find((definition) => definition.name === 'cancel_wake');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(cancel);
      assert.ok(finish);
      const cancellationBasis = new Map([
        ['wake_obsolete', 'del_current_cycle'],
        ['wake_old_detection', 'dec_current_cycle'],
        ['wake_old_safety_net', 'del_current_cycle'],
      ]);
      for (const [wakeId, basisId] of cancellationBasis) {
        const cancelled = await cancel.handler({
          wake_id: wakeId,
          reason: 'the adopted current-cycle result superseded this earlier cycle check',
          basis_ids: [basisId],
        }, {});
        assert.equal(cancelled.isError, undefined);
      }
      for (const basisIds of [[], ['basis_missing'], ['dec_unrelated'], ['del_current_cycle'], ['del_unrelated']]) {
        const refusedBasis = await cancel.handler({
          wake_id: 'wake_kept', reason: 'invented prose is not evidence', basis_ids: basisIds,
        }, {});
        assert.equal(refusedBasis.isError, true, `basis ${basisIds.join(',') || '(empty)'} should be refused`);
      }
      for (const wakeId of [
        'wake_already_fired',
        'wake_already_cancelled',
        'wake_infrastructure',
        'wake_execution_safety',
        'wake_immediate',
        'wake_wall_time',
        'wake_overdue',
        'wake_missing',
      ]) {
        const refused = await cancel.handler({
          wake_id: wakeId,
          reason: 'must not rewrite or suppress a harness-owned wake',
          basis_ids: ['del_current_cycle'],
        }, {});
        assert.equal(refused.isError, true, `${wakeId} should be refused`);
      }
      await finish.handler({ summary: 'Removed only the obsolete future wake.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'cancel-obsolete-wake' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  for (const wakeId of ['wake_obsolete', 'wake_old_detection', 'wake_old_safety_net']) {
    assert.equal(doc.wakes.find((wake) => wake.id === wakeId)!.status, 'cancelled');
  }
  assert.equal(doc.wakes.find((wake) => wake.id === 'wake_already_fired')!.status, 'fired');
  assert.equal(doc.wakes.find((wake) => wake.id === 'wake_already_cancelled')!.status, 'cancelled');
  for (const wakeId of [
    'wake_kept',
    'wake_infrastructure',
    'wake_execution_safety',
    'wake_immediate',
    'wake_wall_time',
    'wake_overdue',
  ]) {
    assert.equal(doc.wakes.find((wake) => wake.id === wakeId)!.status, 'pending');
  }
  assert.equal(
    doc.wakes.filter((wake) => wake.reason.startsWith('quiescence backstop')).length,
    0,
    'the retained real check prevents a replacement backstop',
  );
  assert.ok(doc.events.some((event) =>
    event.type === 'wake.cancelled' &&
    event.refs?.includes('wake_obsolete') &&
    event.refs.includes('del_current_cycle')
  ));
  assert.deepEqual(
    doc.wakes.find((wake) => wake.id === 'wake_obsolete')!.coordinatorCancellation,
    {
      kind: 'course-retired',
      passId: doc.passes.at(-1)!.id,
      reason: 'the adopted current-cycle result superseded this earlier cycle check',
      basisIds: ['del_current_cycle'],
    },
  );
  assert.deepEqual(
    doc.wakes.filter((wake) => isCoordinatorCancellableWake(wake)).map((wake) => wake.id),
    ['wake_kept'],
    'three superseded organizational checks collapse to the one real next check',
  );
});

test('a bounded typed tool pages every cancellable wake hidden beyond the projection head', async () => {
  const now = virtualNow().getTime();
  await arrive('coordinator-capacity', (doc) => {
    doc.decisions.push({
      id: 'dec_page_course', title: 'Inspect the pageable wake backlog',
      rationale: 'Keep this exact course live during pagination.', madeBy: 'coordinator',
      status: 'standing', decidedAtVirtual: new Date(now).toISOString(),
    });
    for (let index = 0; index < 60; index++) {
      doc.wakes.push({
        id: `wake_page_${String(index).padStart(2, '0')}`,
        reason: `pageable organizational check ${index}`,
        condition: { type: 'time', dueAtVirtual: new Date(now + (index + 60) * 60_000).toISOString() },
        status: 'pending', createdAt: new Date().toISOString(),
        organizationalCourseId: 'dec_page_course',
      });
    }
  });
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      assert.match(req.prompt, /60 total/);
      assert.ok(req.prompt.length < 20_000, `projection grew to ${req.prompt.length} characters`);
      const list = req.tools.find((definition) => definition.name === 'list_cancellable_wakes');
      const schedule = req.tools.find((definition) => definition.name === 'schedule_wake');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(list);
      assert.ok(schedule);
      assert.ok(finish);
      const readPage = async (afterWakeId?: string): Promise<CancellableWakePage> => {
        const result = await list.handler(afterWakeId ? { after_wake_id: afterWakeId } : {}, {});
        assert.equal(result.isError, undefined);
        return JSON.parse((result.content[0] as { text: string }).text) as CancellableWakePage;
      };
      const first = await readPage();
      assert.equal(first.total, 60);
      assert.equal(first.wakes.length, 25);
      assert.equal(first.wakes[0]!.id, 'wake_page_00');
      const second = await readPage(first.nextAfterWakeId);
      assert.equal(second.wakes.length, 25);
      assert.equal(second.wakes[0]!.id, 'wake_page_25');
      const third = await readPage(second.nextAfterWakeId);
      assert.equal(third.wakes.length, 10);
      assert.equal(third.wakes.at(-1)!.id, 'wake_page_59');
      assert.equal(third.nextAfterWakeId, undefined);
      const badCursor = await list.handler({ after_wake_id: 'wake_missing_cursor' }, {});
      assert.equal(badCursor.isError, true);
      const unlinked = await schedule.handler({
        reason: 'must not schedule without a real course', after: '4h', course_id: 'course_missing',
      }, {});
      assert.equal(unlinked.isError, true);
      const linked = await schedule.handler({
        reason: 'linked follow-up', after: '4h', course_id: 'dec_page_course',
      }, {});
      assert.equal(linked.isError, undefined);
      await finish.handler({ summary: 'Read the bounded wake pages without mutation.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'page-cancellable-wakes' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  assert.equal(
    (await load('coordinator-capacity')).wakes.filter((wake) => isCoordinatorCancellableWake(wake)).length,
    61,
  );
});

test('create_assignment persists typed requirements without choosing a model', async () => {
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create);
      assert.ok(finish);
      const created = await create.handler({
        objective: 'repair one bounded selector defect',
        briefing: 'Fix the declared selector and run its deterministic tests.',
        kind: 'work',
        execution_profile: 'bounded-code-repair',
        input_modalities: ['text'],
        acceptance_criteria: ['hidden selector tests pass'],
      }, {});
      assert.equal(created.isError, undefined);
      await finish.handler({ summary: 'Dispatched typed work.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'typed-requirements' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const assignment = (await load('coordinator-capacity')).assignments[0]!;
  assert.deepEqual(assignment.executionRequirements, {
    profile: 'bounded-code-repair',
    modalities: ['text'],
    complexity: 'standard',
  });
  assert.equal(assignment.attempts.length, 0, 'durable requirements do not preselect a disposable target');
});

test('create_assignment persists declared high complexity without choosing a model', async () => {
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create);
      assert.ok(finish);
      const created = await create.handler({
        objective: 'redesign the retry seam across the executor adapters',
        briefing: 'Trace every adapter, judge the shared seam, and restructure it.',
        kind: 'work',
        execution_complexity: 'high',
        acceptance_criteria: ['every adapter passes its deterministic retry tests'],
      }, {});
      assert.equal(created.isError, undefined);
      await finish.handler({ summary: 'Dispatched demanding typed work.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'typed-complexity' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const assignment = (await load('coordinator-capacity')).assignments.at(-1)!;
  assert.deepEqual(assignment.executionRequirements, {
    profile: 'general',
    modalities: ['text'],
    complexity: 'high',
  });
  assert.equal(assignment.attempts.length, 0, 'durable requirements do not preselect a disposable target');
});

test('create_assignment persists a human-reserved action as human-only', async () => {
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);
      const created = await create.handler({
        objective: 'delete one exact test row after human approval',
        briefing: 'Fail closed unless the exact row and revision preconditions match.',
        kind: 'action',
        acceptance_criteria: ['exact row absent and every sibling row unchanged'],
        exec_cwd: home,
        exec_verify: 'test ! -f exact-row',
        approval_ask: 'Approve deletion of exactly one named test row. No other row may change.',
        approval_mode: 'human-only',
      }, {});
      assert.equal(created.isError, undefined);
      await finish.handler({ summary: 'Recorded the human-only gate.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const assignment = (await load('coordinator-capacity')).assignments[0]!;
  assert.equal(assignment.state, 'gated');
  assert.equal(assignment.exec?.approvalMode, 'human-only');
  assert.equal((await load('coordinator-capacity')).attention.length, 1, 'an explicit human-only gate is immediately visible');
});

test('a routine PR action defaults to Pilot review without opening a human card', async () => {
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);
      const created = await create.handler({
        objective: 'push the reviewed branch and open its pull request',
        briefing: 'Push the exact clean branch head and open one PR with that head.',
        kind: 'action',
        acceptance_criteria: ['the remote PR exists at the exact local head'],
        exec_cwd: home,
        exec_verify: 'gh pr list --head fix/routine --json url --jq ".[0].url" | grep .',
        approval_ask: 'Approve pushing the reviewed branch and opening its pull request. Only that branch and one PR may be created.',
      }, {});
      assert.equal(created.isError, undefined);
      await finish.handler({ summary: 'Recorded the routine PR gate.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  assert.equal(doc.assignments[0]!.exec?.approvalMode, 'pilot-or-human');
  assert.equal(doc.attention.length, 0, 'Pilot-pending routine work is not a needs-you item');
});

test('create_assignment refuses a dependency already settled without acceptance', async () => {
  await arrive('coordinator-capacity', (doc) => {
    doc.assignments.push({
      id: 'asg_cancelled', objective: 'obsolete attempt', briefing: 'n/a', kind: 'work',
      acceptanceCriteria: ['accepted input'], dependsOn: [], state: 'cancelled', attempts: [],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    });
  });
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);
      const refused = await create.handler({
        objective: 'consume an impossible input',
        briefing: 'This must never remain silently queued.',
        kind: 'work',
        acceptance_criteria: ['input is accepted'],
        depends_on: ['asg_cancelled'],
      }, {});
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused), /asg_cancelled.*cancelled\/none.*can no longer become accepted/);
      await finish.handler({ summary: 'Refused the impossible dependency.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  assert.equal((await load('coordinator-capacity')).assignments.length, 1);
});

test('an incomplete hard-wall checkpoint is readable but cannot be adopted', async () => {
  const { relPath, hash } = await writeArtifact(
    'coordinator-capacity',
    'checkpoint.md',
    `# Interrupted checkpoint\n\n${'Verified evidence preserved before the hard wall. '.repeat(8)}`,
  );
  await arrive('coordinator-capacity', (doc) => {
    doc.deliverables.push({
      id: 'del_checkpoint', title: 'Interrupted checkpoint', kind: 'worker_checkpoint',
      path: relPath, contentHash: hash, producedByAssignment: 'asg_checkpoint',
      createdAtVirtual: virtualNow().toISOString(),
    });
    doc.assignments.push({
      id: 'asg_checkpoint', objective: 'complete the bounded work', briefing: 'n/a', kind: 'work',
      acceptanceCriteria: ['complete result'], dependsOn: [], state: 'awaiting_review', attempts: [],
      submission: {
        summary: 'Incomplete evidence preserved at the worker wall.',
        deliverableId: 'del_checkpoint',
        completeness: 'checkpoint',
      },
      adoption: { state: 'proposed' }, createdAtVirtual: virtualNow().toISOString(),
    });
  });

  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const read = req.tools.find((definition) => definition.name === 'read_artifact');
      const adopt = req.tools.find((definition) => definition.name === 'adopt_submission');
      const reject = req.tools.find((definition) => definition.name === 'reject_submission');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(read && adopt && reject && finish);
      assert.match(req.prompt, /INCOMPLETE CHECKPOINT \(cannot adopt\)/);
      const artifact = await read.handler({ deliverable_id: 'del_checkpoint' }, {});
      assert.equal(artifact.isError, undefined);
      const refused = await adopt.handler({
        assignment_id: 'asg_checkpoint',
        reason: 'It contains useful evidence.',
      }, {});
      assert.equal(refused.isError, true);
      assert.match(JSON.stringify(refused), /incomplete hard-wall checkpoint/);
      const rejected = await reject.handler({
        assignment_id: 'asg_checkpoint',
        reason: 'Preserve the evidence and dispatch only the missing bounded work.',
      }, {});
      assert.equal(rejected.isError, undefined);
      await finish.handler({
        summary: 'Rejected the incomplete checkpoint without losing its evidence.',
        acknowledged_steering: true,
      }, {});
      return { costUsd: 0, sessionId: 'checkpoint-review' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['checkpoint ready'], executor);
  assert.equal(outcome.outcome, 'completed');
  const assignment = (await load('coordinator-capacity')).assignments[0]!;
  assert.equal(assignment.adoption.state, 'rejected');
  assert.equal(assignment.state, 'completed');
});

test('passOutcome: a conflicted finish is never recorded as completed', () => {
  // The P0: finished was set before the finish write ran, so a conflict still
  // finalized as completed. finishConflicted must win over finished.
  assert.equal(passOutcome({ hadError: false, finishConflicted: true, finished: true }), 'conflicted');
  assert.equal(passOutcome({ hadError: false, finishConflicted: false, finished: true }), 'completed');
  assert.equal(passOutcome({ hadError: false, finishConflicted: false, finished: false }), 'no_finish');
  // An SDK/infra error dominates either way.
  assert.equal(passOutcome({ hadError: true, finishConflicted: true, finished: true }), 'error');
});
