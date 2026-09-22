import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COORDINATOR_SYSTEM_PROMPT,
  COORDINATOR_TEXT_CAPS,
  FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT,
  clearCoordinatorCapacityBackoff,
  passOutcome,
  pickCoordinatorModel,
  pickCoordinatorTarget,
  pickCoordinatorTargetForExecutors,
  recordCoordinatorCapacityBackoff,
  runCoordinatorPass,
} from './coordinator.js';
import { FLEET_ATTENTION_STEWARD_SOURCE_KEY } from './fleetHealth.js';
import { createOrGetFleetAttentionStewardWorkstream } from './ingress.js';
import { arrive, createWorkstream, findBySourceKey, heartbeatRunner, load, writeArtifact } from './store.js';
import { setSecret } from './secrets.js';
import { advanceClock, isCoordinatorCancellableWake, virtualNow, type CancellableWakePage } from './clock.js';
import { buildProjection } from './projection.js';
import { proposePolicy } from './policies.js';
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

test('the fleet steward contract requires durable root-cause ownership without cross-workstream authority', () => {
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /unchanged unresolved operational backlog is not healthy/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /exactly one durable disposition/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /EXISTING ACTIVE managed repair Workstream/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /stable source_key derived from the cause identity/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /producer-level cause and distinguish trigger, failed recovery, and escaped symptom/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /verified stale\/reconciled only from typed evidence/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /human judgment, a credential only the human can supply, or permission to spend/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /rely on one exact current ACTIVE source card/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /two or more ACTIVE source asks share one cause/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /paused source never counts toward the two-source grouping threshold/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /withdraw any duplicate steward card/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /premise can change outside Weaver/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /open source attention record.*never prove the outside-world premise remains current/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /humanNeeds summary is historical evidence at createdAt/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /create\/reuse a bounded managed verification repair first/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /operator report that they already acted is a trigger for immediate verification/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /OWN open attention text exactly current/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /withdraw that whole old card and raise one concise replacement/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /must say NOTHING about a settled clause, not even a parenthetical/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /executable retry\/resume.*may not hitchhike beside a genuine credential\/judgment ask/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /Avoiding queue churn.*never a reason to retain a false or moot sentence/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /PAUSED\/DEFERRED/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /preserve the operator's pause, create NO active repair, global steward attention, or owner Observation/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /Never resolve, withdraw, approve, adopt, conclude, or otherwise mutate an item in another Workstream/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /sends, merges, deploys, pushes, spending.*remain gated and readback-verified/);
  assert.match(FLEET_ATTENTION_STEWARD_COORDINATOR_CONTRACT, /FLEET QUIET.*only when every supplied ask and health signal is covered and no actionable group is unowned/);
});

beforeEach(async () => {
  coordinatorEnv = {
    WEAVER_COORDINATOR_EXECUTOR: process.env.WEAVER_COORDINATOR_EXECUTOR,
    WEAVER_COORDINATOR_MODEL: process.env.WEAVER_COORDINATOR_MODEL,
    WEAVER_COORDINATOR_FALLBACK_EXECUTOR: process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR,
    WEAVER_COORDINATOR_FALLBACK_MODEL: process.env.WEAVER_COORDINATOR_FALLBACK_MODEL,
    WEAVER_COORDINATOR_FALLBACKS: process.env.WEAVER_COORDINATOR_FALLBACKS,
    WEAVER_RUNNER_ID: process.env.WEAVER_RUNNER_ID,
  };
  delete process.env.WEAVER_COORDINATOR_EXECUTOR;
  delete process.env.WEAVER_COORDINATOR_MODEL;
  delete process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR;
  delete process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
  delete process.env.WEAVER_COORDINATOR_FALLBACKS;
  delete process.env.WEAVER_RUNNER_ID;
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

test('only the source-keyed steward can wake an owner with idempotent untrusted repair evidence', async () => {
  await createWorkstream({
    slug: 'source-owner',
    title: 'Source owner',
    objective: 'Own and reconcile one operational repair',
    tags: [], successCriteria: [], constraints: ['deployment remains gated'],
    autonomy: { sendsRequireApproval: true },
  });
  await arrive('source-owner', (doc) => {
    doc.decisions.push({
      id: 'dec_owner', title: 'Keep the repair gated', rationale: 'External effects require readback.',
      madeBy: 'coordinator', status: 'standing', decidedAtVirtual: virtualNow().toISOString(),
    });
    doc.attention.push({
      id: 'att_operational', kind: 'blocker', summary: 'Operational failure needs repair.',
      status: 'open', createdAt: new Date().toISOString(),
    });
    doc.assignments.push({
      id: 'asg_capacity_source', objective: 'Retain the worker capacity provenance', briefing: 'No work.',
      kind: 'work', acceptanceCriteria: [], dependsOn: [], state: 'failed',
      attempts: [{
        runId: 'run_capacity_source', executor: 'local-sdk', provider: 'anthropic', model: 'claude-sonnet',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      }],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    });
    doc.passes.push({
      id: 'pass_capacity_source', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      baseRevision: doc.revision, wakeReasons: ['capacity test'], changes: [], outcome: 'error',
    });
  });
  const sourceBefore = await load('source-owner');

  await createWorkstream({
    slug: 'paused-owner', title: 'Paused owner', objective: 'Remain deliberately deferred',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
  await arrive('paused-owner', (doc) => {
    doc.workstream.status = 'paused';
    doc.decisions.push({
      id: 'dec_paused_source', title: 'Preserve the pause', rationale: 'The operator deferred this outcome.',
      madeBy: 'human', status: 'standing', decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  const pausedBefore = await load('paused-owner');

  await createWorkstream({
    slug: 'done-owner', title: 'Done owner', objective: 'Remain concluded',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
  await arrive('done-owner', (doc) => {
    doc.workstream.status = 'done';
    doc.decisions.push({
      id: 'dec_done_source', title: 'Concluded course', rationale: 'The outcome was concluded.',
      madeBy: 'human', status: 'standing', decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  const doneBefore = await load('done-owner');

  await createOrGetFleetAttentionStewardWorkstream({
    title: 'Fleet attention steward',
    objective: 'Own fleet attention to its root cause',
    tags: ['routine'], successCriteria: [], constraints: [],
  });

  let stewardPrompt = '';
  const outcome = await runCoordinatorPass('fleet-attention-steward', ['manual'], {
    id: 'local-sdk',
    async execute(req) {
      stewardPrompt = req.systemPrompt;
      const report = req.tools.find((definition) => definition.name === 'report_repair_evidence');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(report && finish);
      assert.match(report.description, /wakes an active owner/);
      assert.match(report.description, /paused owner retains the observation and wake until resumed/);
      assert.match(report.description, /cannot resolve\/withdraw attention/);
      const unknownEntity = await report.handler({
        target_slug: 'source-owner',
        source_revision: sourceBefore.revision,
        source_entity_id: 'att_not_real',
        verified_evidence: 'This must not land because the cited entity does not exist.',
      }, {});
      assert.equal(unknownEntity.isError, true);
      assert.match(JSON.stringify(unknownEntity), /no typed entity 'att_not_real'/);
      const args = {
        target_slug: 'source-owner',
        source_revision: sourceBefore.revision,
        source_entity_id: 'att_operational',
        verified_evidence: 'The producer fix is deployed and the recurrence probe passed at the exact repaired revision.',
      };
      const first = await report.handler(args, {});
      const retry = await report.handler(args, {});
      assert.equal(first.isError, undefined);
      assert.equal(retry.isError, undefined);
      assert.match(JSON.stringify(first), /new untrusted observation/);
      assert.match(JSON.stringify(retry), /existing untrusted observation/);

      for (const [sourceEntityId, evidence] of [
        ['pass_capacity_source', 'The coordinator capacity pass has recovered on readback.'],
        ['run_capacity_source', 'The worker capacity run has recovered on readback.'],
        [sourceBefore.workstream.id, 'The dormant Workstream-level health condition has recovered on readback.'],
      ]) {
        const result = await report.handler({
          target_slug: 'source-owner',
          source_revision: sourceBefore.revision,
          source_entity_id: sourceEntityId,
          verified_evidence: evidence,
        }, {});
        assert.equal(result.isError, undefined, `${sourceEntityId} should be a valid typed source`);
      }

      const paused = await report.handler({
        target_slug: 'paused-owner',
        source_revision: pausedBefore.revision,
        source_entity_id: 'dec_paused_source',
        verified_evidence: 'Verified evidence is retained for the paused owner to evaluate after resumption.',
      }, {});
      assert.equal(paused.isError, undefined);

      const done = await report.handler({
        target_slug: 'done-owner',
        source_revision: doneBefore.revision,
        source_entity_id: 'dec_done_source',
        verified_evidence: 'This must not become a dead-letter observation.',
      }, {});
      assert.equal(done.isError, true);
      assert.match(JSON.stringify(done), /is done; no repair observation was written/);
      assert.match(JSON.stringify(done), /Only a human can reopen it with `weaver resume done-owner`/);
      await finish.handler({ summary: 'Reported verified repair evidence to its owner.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  });
  assert.equal(outcome.outcome, 'completed');
  assert.match(stewardPrompt, /Additional contract for the built-in fleet attention steward/);
  assert.match(stewardPrompt, /Use report_repair_evidence only to post verified closure\/reconciliation evidence as an untrusted Observation/);

  const sourceAfter = await load('source-owner');
  assert.equal(sourceAfter.observations.length, 4, 'exact retry deduplicates while each typed source receives one observation');
  assert.match(sourceAfter.observations[0]!.source, /^fleet-attention-steward:/);
  assert.match(sourceAfter.observations[0]!.summary, /revision .*entity att_operational.*producer fix is deployed/i);
  assert.ok(sourceAfter.wakes.some((wake) => wake.status === 'pending' && wake.reason.includes('new observation')));
  assert.deepEqual(sourceAfter.decisions, sourceBefore.decisions, 'untrusted evidence cannot change owner decisions');
  assert.deepEqual(sourceAfter.attention, sourceBefore.attention, 'untrusted evidence cannot resolve owner attention');
  assert.deepEqual(sourceAfter.workstream.autonomy, sourceBefore.workstream.autonomy, 'untrusted evidence cannot widen owner authority');
  assert.deepEqual(sourceAfter.workstream.constraints, sourceBefore.workstream.constraints);

  const pausedAfter = await load('paused-owner');
  assert.equal(pausedAfter.workstream.status, 'paused');
  assert.equal(pausedAfter.observations.length, 1);
  assert.ok(pausedAfter.wakes.some((wake) => wake.status === 'pending' && wake.reason.includes('new observation')));
  assert.deepEqual(pausedAfter.decisions, pausedBefore.decisions);

  const doneAfter = await load('done-owner');
  assert.equal(doneAfter.workstream.status, 'done');
  assert.deepEqual(doneAfter.observations, doneBefore.observations);
  assert.deepEqual(doneAfter.wakes, doneBefore.wakes, 'a concluded owner receives no dead-letter wake');

  let ordinaryPrompt = '';
  await runCoordinatorPass('coordinator-capacity', ['manual'], {
    id: 'local-sdk',
    async execute(req) {
      ordinaryPrompt = req.systemPrompt;
      assert.equal(req.tools.some((definition) => definition.name === 'report_repair_evidence'), false);
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(finish);
      await finish.handler({ summary: 'Finished ordinary reconciliation.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  });
  assert.doesNotMatch(ordinaryPrompt, /Additional contract for the built-in fleet attention steward/);
});

test('a legacy source-key holder with the wrong slug receives no steward capability', async () => {
  await createWorkstream({
    slug: 'spoofed-steward', title: 'Spoofed steward', objective: 'Old caller-supplied source key.',
    sourceKey: FLEET_ATTENTION_STEWARD_SOURCE_KEY, tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  let systemPrompt = '';
  await runCoordinatorPass('spoofed-steward', ['manual'], {
    id: 'local-sdk',
    async execute(req) {
      systemPrompt = req.systemPrompt;
      assert.equal(req.tools.some((definition) => definition.name === 'report_repair_evidence'), false);
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(finish);
      await finish.handler({ summary: 'No privileged capability was exposed.' }, {});
      return { costUsd: 0 };
    },
  });
  assert.doesNotMatch(systemPrompt, /Additional contract for the built-in fleet attention steward/);
});

test('an ordinary coordinator cannot claim the reserved steward source identity', async () => {
  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_workstream');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);
      const spoof = await create.handler({
        slug: 'spoofed-steward',
        title: 'Spoofed steward',
        source_key: FLEET_ATTENTION_STEWARD_SOURCE_KEY,
        objective: 'Claim a built-in capability through a public source key.',
        success_criteria: [], constraints: [], tags: [],
      }, {});
      assert.equal(spoof.isError, true);
      assert.match(JSON.stringify(spoof), /reserved for Weaver's built-in fleet attention steward/);
      await finish.handler({ summary: 'Refused the reserved source identity.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  });
  assert.equal(outcome.outcome, 'completed');
  assert.equal(await findBySourceKey(FLEET_ATTENTION_STEWARD_SOURCE_KEY), null);
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

test('the production chain degrades Claude to Codex to non-Claude OpenRouter', async () => {
  process.env.WEAVER_COORDINATOR_FALLBACKS = 'codex-sdk:gpt-5.6-sol,local-sdk:openrouter/z-ai/glm-5.2';
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
    executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.2',
  });

  // Every seat parked → the primary; the normal backoff machinery owns it.
  doc.capacity.byModel['local-sdk:openrouter:openrouter/z-ai/glm-5.2'] = parked('local-sdk', 'openrouter', 'openrouter/z-ai/glm-5.2');
  assert.deepEqual(pickCoordinatorTarget(doc, now), {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
  });
});

test('a mid-chain capacity failure wakes immediately for non-Claude OpenRouter', async () => {
  process.env.WEAVER_COORDINATOR_FALLBACKS = 'codex-sdk:gpt-5.6-sol,local-sdk:openrouter/z-ai/glm-5.2';
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
    /continue on fallback local-sdk:openrouter\/z-ai\/glm-5\.2 while codex-sdk:gpt-5\.6-sol capacity recovers/,
  );
  // The next selection indeed lands on that named seat.
  assert.deepEqual(pickCoordinatorTarget(doc, virtualNow().toISOString()), {
    executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.2',
  });
});

test('a successful fallback retires covered coordinator retries without clearing the failed pool or real wakes', async () => {
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = 'claude-opus-5';
  await runCoordinatorPass('coordinator-capacity', ['real work'], {
    id: 'local-sdk', async execute() { throw new Error('You have hit your weekly limit'); },
  });
  const failed = await load('coordinator-capacity');
  const retry = failed.wakes.find((wake) => wake.infrastructure?.source === 'coordinator')!;
  assert.ok(retry);
  const capacityBefore = failed.capacity;
  await arrive('coordinator-capacity', (doc) => {
    doc.wakes.push({
      id: 'wake_real_check', reason: 'Review tomorrow', status: 'pending',
      condition: { type: 'time', dueAtVirtual: new Date(Date.now() + 86_400_000).toISOString() },
      createdAt: new Date().toISOString(),
    }, {
      ...retry, id: 'wake_worker_retry',
      infrastructure: { ...retry.infrastructure!, source: 'worker', sourceId: 'run_worker' },
    }, {
      ...retry, id: 'wake_safety',
      executionSafety: { blockedUntil: retry.infrastructure!.retryAt, observedStarts: 30, limit: 30, windowSeconds: 3600 },
    });
  });
  await runCoordinatorPass('coordinator-capacity', ['continue on fallback'], {
    id: 'local-sdk', async execute(req) {
      assert.equal(req.model, 'claude-opus-5');
      await req.tools.find((tool) => tool.name === 'finish_pass')!.handler({ summary: 'Real work reconciled.' }, {});
      return { costUsd: 0 };
    },
  });
  const completed = await load('coordinator-capacity');
  assert.equal(completed.wakes.find((wake) => wake.id === retry.id)!.status, 'cancelled');
  assert.equal(completed.wakes.find((wake) => wake.id === retry.id)!.coordinatorCancellation, undefined);
  for (const id of ['wake_real_check', 'wake_worker_retry', 'wake_safety']) {
    assert.equal(completed.wakes.find((wake) => wake.id === id)!.status, 'pending');
  }
  assert.deepEqual(completed.capacity, capacityBefore, 'fallback success does not claim primary recovery');
  assert.equal(pickCoordinatorTarget(completed, virtualNow().toISOString()).model, 'claude-opus-5');
  assert.equal(pickCoordinatorTarget(completed, retry.infrastructure!.retryAt).model, 'claude-fable-5',
    'the next real wake after reset may use the primary without a separate probe');
  assert.ok(completed.events.some((event) => event.type === 'wake.coordinator_retry_superseded'));
});

for (const ending of ['no_finish', 'conflicted'] as const) {
  test(`a ${ending} fallback preserves retry wakes and concurrent arrivals`, async () => {
    await runCoordinatorPass('coordinator-capacity', ['real work'], {
      id: 'local-sdk', async execute() { throw new Error('You have hit your weekly limit'); },
    });
    const retry = (await load('coordinator-capacity')).wakes.find((wake) => wake.infrastructure)!;
    const result = await runCoordinatorPass('coordinator-capacity', ['continue on fallback'], {
      id: 'local-sdk', async execute(req) {
        if (ending === 'conflicted') {
          await arrive('coordinator-capacity', (doc) => {
            doc.wakes.push({ ...retry, id: 'wake_concurrent' });
          });
          const reply = await req.tools.find((tool) => tool.name === 'finish_pass')!.handler({ summary: 'Stale finish.' }, {});
          assert.equal(reply.isError, true);
        }
        return { costUsd: 0 };
      },
    });
    assert.equal(result.outcome, ending);
    const doc = await load('coordinator-capacity');
    assert.equal(doc.wakes.find((wake) => wake.id === retry.id)!.status, 'pending');
    if (ending === 'conflicted') assert.equal(doc.wakes.find((wake) => wake.id === 'wake_concurrent')!.status, 'pending');
  });
}

test('a completed pass on any seat closes open coordinator capacity cards but keeps the pools\' backoff records', async () => {
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = 'claude-opus-5';
  // Twelve primary usage limits raise the card while no fallback is free.
  await backoff('usage_limit', 12);
  // A worker capacity card on the same workstream must NOT be closed by
  // coordinator progress — rule (ii) is role-scoped.
  await arrive('coordinator-capacity', (doc) => {
    doc.attention.push({
      id: 'att_worker_capacity', kind: 'capacity', summary: 'OpenRouter capacity via openhands (m/usage_limit) has blocked work 12 times.',
      status: 'open', createdAt: new Date().toISOString(),
      resolvesWhen: { any: [{ kind: 'capacity_target_unblocked', role: 'worker', target: { executor: 'openhands', provider: 'openrouter', model: 'm' } }] },
    });
  });
  const parked = await load('coordinator-capacity');
  const card = parked.attention.find((item) => item.kind === 'capacity' && item.id !== 'att_worker_capacity')!;
  assert.deepEqual(card.resolvesWhen, { any: [{
    kind: 'capacity_target_unblocked', role: 'coordinator',
    target: { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' },
  }] }, 'new capacity cards declare their typed fact');
  const interventionsBefore = parked.spend.humanInterventions;

  const result = await runCoordinatorPass('coordinator-capacity', ['continue on fallback'], {
    id: 'local-sdk', async execute(req) {
      assert.equal(req.model, 'claude-opus-5', 'the limited primary is still skipped');
      await req.tools.find((tool) => tool.name === 'finish_pass')!.handler({ summary: 'Reconciled on the fallback.' }, {});
      return { costUsd: 0 };
    },
  });
  assert.equal(result.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  const closed = doc.attention.find((item) => item.id === card.id)!;
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolvedBy, 'engine:capacity-recovered');
  assert.match(closed.resolution!.evidence[0]!.observed, new RegExp(`coordinator pass ${result.passId} completed on local-sdk:anthropic:claude-opus-5`));
  assert.equal(doc.attention.find((item) => item.id === 'att_worker_capacity')!.status, 'open');
  assert.deepEqual(doc.capacity, parked.capacity, 'the primary pool is still limited for routing');
  assert.equal(doc.spend.humanInterventions, interventionsBefore);
  assert.ok(doc.events.some((event) => event.type === 'attention.capacity_recovered'));
});

test('a limited seat with a free fallback opens no new capacity card; an open one is still refreshed', async () => {
  for (let index = 1; index <= 13; index++) {
    await arrive('coordinator-capacity', (doc) => {
      recordCoordinatorCapacityBackoff(doc, wait('usage_limit', index), `wake_${index}`, { fallbackAvailable: true });
    });
  }
  let doc = await load('coordinator-capacity');
  assert.equal(Object.values(doc.capacity!.byModel)[0]!.consecutiveBackoffs, 13, 'the typed backoff streak is still recorded');
  assert.equal(doc.attention.length, 0, 'degradation onto a free fallback is not a needs-you card');

  // Chain exhausted → the card opens; a later failure with a free fallback
  // refreshes that open card rather than hiding it.
  await arrive('coordinator-capacity', (d) => recordCoordinatorCapacityBackoff(d, wait('usage_limit', 14), 'wake_14'));
  await arrive('coordinator-capacity', (d) => recordCoordinatorCapacityBackoff(d, wait('usage_limit', 15), 'wake_15', { fallbackAvailable: true }));
  doc = await load('coordinator-capacity');
  assert.equal(doc.attention.length, 1);
  assert.equal(doc.attention[0]!.refId, 'wake_15');
  assert.match(doc.attention[0]!.summary, /blocked work 15 times/);
});

test('raise_attention stores validated resolves_when facts and refuses unknown or malformed ones', async () => {
  const replies: Array<{ label: string; isError?: boolean; text: string }> = [];
  let description = '';
  await runCoordinatorPass('coordinator-capacity', ['manual'], {
    id: 'local-sdk',
    async execute(req) {
      const raise = req.tools.find((tool) => tool.name === 'raise_attention')!;
      description = raise.description;
      const call = async (label: string, args: Record<string, unknown>) => {
        const reply = await raise.handler(args, {});
        replies.push({ label, isError: reply.isError, text: JSON.stringify(reply.content) });
      };
      await call('valid', {
        kind: 'review',
        summary: 'Merge erdoai/erdo#2686, or clear the Vercel block first?',
        resolves_when: [
          { kind: 'github_pr_state', repo: 'erdoai/erdo', number: 2686, states: ['MERGED', 'CLOSED'] },
          { kind: 'sentry_issue_status', org: 'erdo', shortId: 'go-zx', statuses: ['resolved'] },
        ],
      });
      await call('unknown kind', { kind: 'blocker', summary: 'x', resolves_when: [{ kind: 'linear_issue_state', id: 'ENG-1' }] });
      await call('bad repo', { kind: 'blocker', summary: 'x', resolves_when: [{ kind: 'github_pr_state', repo: 'erdo', number: 1, states: ['MERGED'] }] });
      await call('bad number', { kind: 'blocker', summary: 'x', resolves_when: [{ kind: 'github_pr_state', repo: 'erdoai/erdo', number: -3, states: ['MERGED'] }] });
      await call('bad short id', { kind: 'blocker', summary: 'x', resolves_when: [{ kind: 'sentry_issue_status', org: 'erdo', shortId: 'nope nope', statuses: ['resolved'] }] });
      await call('capacity is harness-owned', { kind: 'blocker', summary: 'x', resolves_when: [{ kind: 'capacity_target_unblocked', role: 'worker', target: { executor: 'a', provider: 'b', model: 'c' } }] });
      await call('too many', { kind: 'blocker', summary: 'x', resolves_when: Array.from({ length: 6 }, (_, i) => ({ kind: 'github_pr_state', repo: 'erdoai/erdo', number: i + 1, states: ['MERGED'] })) });
      await call('plain', { kind: 'blocker', summary: 'A plain card that mentions PR #2686 in prose only.' });
      await req.tools.find((tool) => tool.name === 'finish_pass')!.handler({ summary: 'Raised cards.' }, {});
      return { costUsd: 0 };
    },
  });
  assert.match(description, /declare it in resolves_when so the card closes itself/);
  assert.equal(replies.find((r) => r.label === 'valid')!.isError, undefined);
  assert.match(replies.find((r) => r.label === 'valid')!.text, /closes itself when erdoai\/erdo#2686 is MERGED or CLOSED or Sentry erdo\/GO-ZX is resolved/);
  for (const [label, message] of [
    ['unknown kind', /not a known fact/],
    ['bad repo', /owner\/name/],
    ['bad number', /positive integer/],
    ['bad short id', /short id/],
    ['capacity is harness-owned', /harness-owned/],
    ['too many', /at most 5/],
  ] as const) {
    const reply = replies.find((r) => r.label === label)!;
    assert.equal(reply.isError, true, label);
    assert.match(reply.text, message, label);
    assert.match(reply.text, /nothing was raised/, label);
  }
  const doc = await load('coordinator-capacity');
  assert.equal(doc.attention.length, 2, 'refused declarations raise nothing');
  const declared = doc.attention.find((item) => item.kind === 'review')!;
  assert.deepEqual(declared.resolvesWhen, { any: [
    { kind: 'github_pr_state', repo: 'erdoai/erdo', number: 2686, states: ['MERGED', 'CLOSED'] },
    { kind: 'sentry_issue_status', org: 'erdo', shortId: 'GO-ZX', statuses: ['resolved'] },
  ] });
  const plain = doc.attention.find((item) => item.kind === 'blocker')!;
  assert.equal(plain.resolvesWhen, undefined, 'prose mentioning a PR binds nothing');

  const projection = buildProjection(doc, ['manual'], []);
  assert.match(projection, new RegExp(`${declared.id} \\[review\\] .* — closes itself when erdoai/erdo#2686 is MERGED or CLOSED or Sentry erdo/GO-ZX is resolved`));
  assert.doesNotMatch(projection, new RegExp(`${plain.id} \\[blocker\\] .*closes itself`));
});

test('an SDK limit after a successful finish keeps its new retry wake', async () => {
  await runCoordinatorPass('coordinator-capacity', ['real work'], {
    id: 'local-sdk', async execute() { throw new Error('You have hit your weekly limit'); },
  });
  const priorRetry = (await load('coordinator-capacity')).wakes.find((wake) => wake.infrastructure)!;
  const result = await runCoordinatorPass('coordinator-capacity', ['continue on fallback'], {
    id: 'local-sdk', async execute(req) {
      await req.tools.find((tool) => tool.name === 'finish_pass')!.handler({ summary: 'Reconciled.' }, {});
      return { costUsd: 0, error: 'You have hit your weekly limit' };
    },
  });
  const doc = await load('coordinator-capacity');
  assert.equal(doc.wakes.find((wake) => wake.id === priorRetry.id)!.status, 'cancelled');
  assert.ok(doc.wakes.some((wake) => wake.status === 'pending' && wake.infrastructure?.sourceId === result.passId));
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

test('a fresh preferred runner blocks standby coordination, then stale presence permits a pinned failover pass', async () => {
  process.env.WEAVER_RUNNER_ID = 'gcp-standby';
  await arrive('coordinator-capacity', (doc) => {
    doc.workstream.executionPolicy = { coordinatorRunnerOrder: ['mac-primary', 'gcp-standby'] };
    doc.wakes.push({
      id: 'wake_failover', reason: 'reconcile on the eligible host',
      condition: { type: 'immediate' }, status: 'pending', createdAt: new Date().toISOString(),
    });
  });
  await heartbeatRunner('mac-primary');
  const before = await load('coordinator-capacity');
  await assert.rejects(
    runCoordinatorPass('coordinator-capacity', ['manual'], {
      id: 'local-sdk', async execute() { throw new Error('standby executor must not launch'); },
    }),
    /preferred coordinator runner 'mac-primary'/,
  );
  const blocked = await load('coordinator-capacity');
  assert.equal(blocked.revision, before.revision);
  assert.equal(blocked.lease, null);
  assert.equal(blocked.passes.length, 0);

  await heartbeatRunner('mac-primary', new Date(Date.now() - 120_001).toISOString());
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const running = await load('coordinator-capacity');
      assert.equal(running.lease?.runnerId, 'gcp-standby');
      assert.equal(running.passes.at(-1)?.runnerId, 'gcp-standby');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(finish);
      await finish.handler({ summary: 'Failover reconciliation completed.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'runner-failover' };
    },
  };
  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const completed = await load('coordinator-capacity');
  assert.equal(completed.lease, null);
  assert.equal(completed.passes.at(-1)?.runnerId, 'gcp-standby');
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
        runner_id: 'mac-studio',
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
  assert.equal(assignment.runnerId, 'mac-studio');
  assert.equal(assignment.attempts.length, 0, 'durable requirements do not preselect a disposable target');
});

test('create_assignment inherits the Workstream runner binding and refuses an override', async () => {
  await arrive('coordinator-capacity', (d) => {
    d.workstream.assignmentRunnerId = 'niall-mac-primary';
  });
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);

      const conflict = await create.handler({
        objective: 'must not escape the Workstream runner binding',
        briefing: 'This conflicting placement must be refused.',
        kind: 'work',
        runner_id: 'weaver-fleet',
        acceptance_criteria: ['never launched'],
      }, {});
      assert.equal(conflict.isError, true);
      assert.match((conflict.content[0] as { text: string }).text, /conflicts with this Workstream's assignment runner 'niall-mac-primary'/);

      const inherited = await create.handler({
        objective: 'inspect the machine-local checkout',
        briefing: 'Read the checkout that exists only on the bound runner.',
        kind: 'work',
        acceptance_criteria: ['current checkout evidence recorded'],
      }, {});
      assert.equal(inherited.isError, undefined);
      await finish.handler({ summary: 'Dispatched only bound work.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'bound-assignment' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const assignments = (await load('coordinator-capacity')).assignments;
  assert.equal(assignments.length, 1, 'the conflicting assignment was never persisted');
  assert.equal(assignments[0]!.runnerId, 'niall-mac-primary');
});

test('create_assignment stores only explicitly available work credential names', async () => {
  setSecret('READONLY_API_TOKEN', 'coordinator-selected-secret-value', 'coordinator-capacity');
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);
      const created = await create.handler({
        objective: 'inspect one read-only provider endpoint',
        briefing: 'Use the supplied credential by name and report current evidence.',
        kind: 'work',
        credential_names: ['READONLY_API_TOKEN'],
        acceptance_criteria: ['current provider evidence is cited'],
      }, {});
      assert.equal(created.isError, undefined);

      const unknown = await create.handler({
        objective: 'must not persist unknown access',
        briefing: 'This assignment is invalid.',
        kind: 'work',
        credential_names: ['UNKNOWN_API_TOKEN'],
        acceptance_criteria: ['never launched'],
      }, {});
      assert.equal(unknown.isError, true);
      assert.match(JSON.stringify(unknown), /UNKNOWN_API_TOKEN.*not available/);

      const action = await create.handler({
        objective: 'must not widen an action secret scope',
        briefing: 'This action declaration is invalid.',
        kind: 'action',
        credential_names: ['READONLY_API_TOKEN'],
        acceptance_criteria: ['never launched'],
        exec_cwd: home,
        exec_verify: 'true',
        approval_ask: 'Approve nothing; this invalid declaration must be refused.',
      }, {});
      assert.equal(action.isError, true);
      assert.match(JSON.stringify(action), /credential_names is only valid on kind.*work/);

      await finish.handler({ summary: 'Dispatched only the valid credential-scoped work.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'scoped-credentials' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  assert.equal(doc.assignments.length, 1);
  assert.deepEqual(doc.assignments[0]!.credentialNames, ['READONLY_API_TOKEN']);
  assert.doesNotMatch(JSON.stringify(doc), /coordinator-selected-secret-value/);
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

test('create_assignment persists always-execute only for a deterministic action', async () => {
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const create = req.tools.find((definition) => definition.name === 'create_assignment');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(create && finish);

      const created = await create.handler({
        objective: 'capture a fresh provider observation',
        briefing: 'Run the exact read command once and retain its current output.',
        kind: 'action',
        acceptance_criteria: ['the current observation is recorded and its read source verifies'],
        exec_cwd: home,
        exec_run: 'printf "current observation\\n"',
        exec_verify: 'true',
        exec_preflight_mode: 'always-execute',
        approval_ask: 'Approve one exact observation command. It changes no declared external resource.',
      }, {});
      assert.equal(created.isError, undefined);

      const modelAction = await create.handler({
        objective: 'invalid model action mode',
        briefing: 'This declaration must be refused.',
        kind: 'action',
        acceptance_criteria: ['never launched'],
        exec_cwd: home,
        exec_verify: 'true',
        exec_preflight_mode: 'always-execute',
        approval_ask: 'Approve nothing; this declaration is invalid.',
      }, {});
      assert.equal(modelAction.isError, true);
      assert.match(JSON.stringify(modelAction), /only valid for deterministic kind.*action.*exec_run/);

      const work = await create.handler({
        objective: 'invalid work mode',
        briefing: 'This declaration must be refused.',
        kind: 'work',
        acceptance_criteria: ['never launched'],
        exec_preflight_mode: 'postcondition',
      }, {});
      assert.equal(work.isError, true);
      assert.match(JSON.stringify(work), /only valid for deterministic kind.*action.*exec_run/);

      await finish.handler({ summary: 'Recorded only the valid observational action.', acknowledged_steering: true }, {});
      return { costUsd: 0, sessionId: 'always-execute-action' };
    },
  };

  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  assert.equal(doc.assignments.length, 1);
  assert.equal(doc.assignments[0]!.exec?.preflightMode, 'always-execute');
  assert.equal(doc.assignments[0]!.exec?.run, 'printf "current observation\\n"');
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


// ---------------------------------------------------------------------------
// Course progress: a step is progress, not a decision.

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const resultText = (result: ToolResult): string => result.content.map((c) => c.text ?? '').join('');

/** A standing course plus every kind of fact progress can and cannot cite. */
async function seedProgressFixture(): Promise<void> {
  const at = virtualNow().toISOString();
  await arrive('coordinator-capacity', (doc) => {
    doc.decisions.push(
      { id: 'dec_course', title: 'Run the error sweep every cycle', rationale: 'The recurring commitment.', madeBy: 'coordinator', status: 'standing', decidedAtVirtual: at },
      { id: 'dec_closed', title: 'A finished course', rationale: 'Done.', madeBy: 'coordinator', status: 'closed', closedReason: 'finished', decidedAtVirtual: at },
      { id: 'dec_old', title: 'Replaced course', rationale: 'Old.', madeBy: 'coordinator', status: 'superseded', supersededBy: 'dec_course', decidedAtVirtual: at },
    );
    doc.assignments.push(
      { id: 'asg_live', objective: 'sweep cycle work', briefing: 'b', kind: 'work', acceptanceCriteria: ['a'], dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' }, createdAtVirtual: at },
      { id: 'asg_done', objective: 'earlier work', briefing: 'b', kind: 'work', acceptanceCriteria: ['a'], dependsOn: [], state: 'completed', attempts: [], adoption: { state: 'accepted' }, createdAtVirtual: at },
    );
    doc.deliverables.push(
      { id: 'del_adopted', title: 'baseline report', kind: 'report', path: 'a.md', contentHash: 'a'.repeat(64), producedByAssignment: 'asg_done', createdAtVirtual: at, adopted: { contentHash: 'a'.repeat(64), passId: 'pass_old', atVirtual: at } },
      { id: 'del_candidate', title: 'unreviewed report', kind: 'report', path: 'b.md', contentHash: 'b'.repeat(64), createdAtVirtual: at },
    );
    doc.observations.push(
      { id: 'obs_judged', source: 'monitor', summary: 'error rate fell', atVirtual: at, evaluation: { countsTowardObjective: true, note: 'real', passId: 'pass_old' } },
      { id: 'obs_raw', source: 'monitor', summary: 'unjudged arrival', atVirtual: at },
    );
  });
}

test('record_progress advances a standing course in place, refuses what it cannot rest on, and creates no decision', async () => {
  await seedProgressFixture();
  const before = await load('coordinator-capacity');
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const progress = req.tools.find((definition) => definition.name === 'record_progress');
      const finish = req.tools.find((definition) => definition.name === 'finish_pass');
      assert.ok(progress && finish);
      const record = async (args: Record<string, unknown>) => (await progress.handler(args, {})) as ToolResult;

      const first = await record({
        course_id: 'dec_course', cycle: 1, step: 1, label: 'baseline measured',
        awaiting_ids: ['asg_live'], basis_ids: ['del_adopted', 'obs_judged'], next: 'Adopt the fix PR, then re-measure.',
      });
      assert.equal(first.isError, undefined, resultText(first));
      assert.match(resultText(first), /no decision created/);
      const afterFirst = await load('coordinator-capacity');
      const firstProgress = afterFirst.decisions.find((d) => d.id === 'dec_course')!.progress!;
      assert.equal(firstProgress.cycleStartedAtVirtual, firstProgress.atVirtual, 'a first cycle starts its own clock');

      // Repeating the exact position writes nothing: no revision bump.
      const repeat = await record({
        course_id: 'dec_course', cycle: 1, step: 1, label: 'baseline measured',
        awaiting_ids: ['asg_live'], basis_ids: ['del_adopted', 'obs_judged'], next: 'Adopt the fix PR, then re-measure.',
      });
      assert.equal(repeat.isError, undefined);
      assert.match(resultText(repeat), /no change/);
      assert.equal((await load('coordinator-capacity')).revision, afterFirst.revision);

      advanceClock('2h');
      const step2 = await record({ course_id: 'dec_course', cycle: 1, step: 2, label: 'fix dispatched', awaiting_ids: ['asg_live'] });
      assert.equal(step2.isError, undefined, resultText(step2));
      const sameCycle = (await load('coordinator-capacity')).decisions.find((d) => d.id === 'dec_course')!.progress!;
      assert.equal(sameCycle.cycleStartedAtVirtual, firstProgress.cycleStartedAtVirtual, 'a step keeps the cycle clock');
      assert.notEqual(sameCycle.atVirtual, firstProgress.atVirtual);

      const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{ course_id: 'dec_course', cycle: 1, step: 1, label: 'back a step' }, /never goes backwards/],
        [{ course_id: 'dec_closed', cycle: 1, step: 1, label: 'retired course' }, /is closed, not standing/],
        [{ course_id: 'dec_old', cycle: 1, step: 1, label: 'superseded course' }, /is superseded, not standing.*dec_course/],
        [{ course_id: 'dec_missing', cycle: 1, step: 1, label: 'unknown course' }, /no decision dec_missing/],
        [{ course_id: 'asg_live', cycle: 1, step: 3, label: 'not a decision' }, /no decision asg_live/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'waits on settled work', awaiting_ids: ['asg_done'] }, /asg_done is not a live assignment/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'waits on nothing real', awaiting_ids: ['asg_missing'] }, /asg_missing is not a live/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'unadopted basis', basis_ids: ['del_candidate'] }, /del_candidate is not an adopted deliverable/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'unjudged basis', basis_ids: ['obs_raw'] }, /obs_raw is not/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'self-cited basis', basis_ids: ['dec_course'] }, /dec_course is not/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'x'.repeat(COORDINATOR_TEXT_CAPS.progressLabel + 1) }, /label is 121 characters \(cap 120\)/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'long next', next: 'n'.repeat(COORDINATOR_TEXT_CAPS.progressNext + 1) }, /next is 401 characters/],
        [{ course_id: 'dec_course', cycle: 1, step: 3, label: 'too many', awaiting_ids: Array.from({ length: 11 }, (_, i) => `asg_${i}`) }, /lists 11 ids \(cap 10\)/],
        [{ course_id: 'dec_course', cycle: 0, step: 3, label: 'zero cycle' }, /integers ≥ 1/],
        [{ course_id: 'dec_course', cycle: 1.5, step: 3, label: 'fractional cycle' }, /integers ≥ 1/],
      ];
      for (const [args, message] of refusals) {
        const revision = (await load('coordinator-capacity')).revision;
        const refused = await record(args);
        assert.equal(refused.isError, true, `${JSON.stringify(args).slice(0, 80)} should be refused`);
        assert.match(resultText(refused), message);
        assert.equal((await load('coordinator-capacity')).revision, revision, 'a refusal writes nothing');
      }

      // A new cycle may restart its step count and starts a new cycle clock.
      advanceClock('1d');
      const cycle2 = await record({ course_id: 'dec_course', cycle: 2, step: 1, label: 'cycle 2 sweep', basis_ids: ['del_adopted'] });
      assert.equal(cycle2.isError, undefined, resultText(cycle2));
      const backwardCycle = await record({ course_id: 'dec_course', cycle: 1, step: 9, label: 'an older cycle' });
      assert.equal(backwardCycle.isError, true);
      assert.match(resultText(backwardCycle), /never goes backwards/);

      await finish.handler({ summary: 'Advanced the sweep course to cycle 2.', acknowledged_steering: true }, {});
      return { costUsd: 0 };
    },
  };
  const outcome = await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  assert.equal(outcome.outcome, 'completed');
  const doc = await load('coordinator-capacity');
  assert.equal(doc.decisions.length, before.decisions.length, 'progress never mints a decision');
  assert.deepEqual(
    doc.decisions.map(({ id, status, title, rationale, supersedes, supersededBy }) => ({ id, status, title, rationale, supersedes, supersededBy })),
    before.decisions.map(({ id, status, title, rationale, supersedes, supersededBy }) => ({ id, status, title, rationale, supersedes, supersededBy })),
    'the commitment itself is untouched',
  );
  const course = doc.decisions.find((d) => d.id === 'dec_course')!;
  assert.equal(course.progress!.cycle, 2);
  assert.equal(course.progress!.step, 1);
  assert.equal(course.progress!.cycleStartedAtVirtual, course.progress!.atVirtual);
  assert.deepEqual(course.progress!.basisIds, ['del_adopted']);
  assert.equal(course.progress!.passId, outcome.passId);
  assert.equal(doc.events.filter((e) => e.type === 'course.progress').length, 3);
  assert.equal(doc.events.some((e) => e.type === 'decision.recorded'), false);
  // Position, never authority: nothing else moved.
  assert.equal(doc.assignments.find((a) => a.id === 'asg_live')!.state, 'queued');
  assert.equal(doc.deliverables.find((d) => d.id === 'del_candidate')!.adopted, undefined);
  assert.equal(doc.observations.find((o) => o.id === 'obs_raw')!.evaluation, undefined);
  assert.equal(doc.workstream.status, 'active');
  // A fresh coordinator sees where the course stands, typed.
  assert.match(buildProjection(doc, []), /dec_course \[STANDING[^\n]*\n {2}progress: cycle 2 · step 1 "cycle 2 sweep" · awaiting \[\] · basis \[del_adopted\]/);
});

test('record_progress is revision-checked: an arrival mid-pass conflicts it', async () => {
  await seedProgressFixture();
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const progress = req.tools.find((definition) => definition.name === 'record_progress')!;
      await arrive('coordinator-capacity', (doc) => {
        doc.steering.push({ id: 'steer_mid', body: 'a concurrent human steer', at: new Date().toISOString() });
      });
      const stale = (await progress.handler({ course_id: 'dec_course', cycle: 1, step: 1, label: 'stale write' }, {})) as ToolResult;
      assert.equal(stale.isError, true);
      assert.match(resultText(stale), /REVISION CONFLICT/);
      return { costUsd: 0 };
    },
  };
  await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  const doc = await load('coordinator-capacity');
  assert.equal(doc.decisions.find((d) => d.id === 'dec_course')!.progress, undefined);
  assert.equal(doc.events.some((e) => e.type === 'course.progress'), false);
});

test('coordinator decision text is capped at the schema AND the handler, with a corrective error', async () => {
  await seedProgressFixture();
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const record = req.tools.find((definition) => definition.name === 'record_decision')!;
      const close = req.tools.find((definition) => definition.name === 'close_decision')!;
      const finish = req.tools.find((definition) => definition.name === 'finish_pass')!;
      // Schema: the model-facing surface refuses over-cap text…
      assert.equal(record.inputSchema.rationale!.safeParse('r'.repeat(COORDINATOR_TEXT_CAPS.decisionRationale + 1)).success, false);
      assert.equal(record.inputSchema.rationale!.safeParse('r'.repeat(COORDINATOR_TEXT_CAPS.decisionRationale)).success, true);
      assert.equal(record.inputSchema.title!.safeParse('t'.repeat(COORDINATOR_TEXT_CAPS.decisionTitle + 1)).success, false);
      assert.equal(record.inputSchema.review_when!.safeParse('w'.repeat(COORDINATOR_TEXT_CAPS.decisionReviewWhen + 1)).success, false);
      assert.equal(close.inputSchema.reason!.safeParse('c'.repeat(COORDINATOR_TEXT_CAPS.closeReason + 1)).success, false);
      // …and the handler, which a direct call reaches without zod, refuses too.
      const cases: Array<[typeof record, Record<string, unknown>, RegExp]> = [
        [record, { title: 'Keep the sweep', rationale: 'r'.repeat(1_501) }, /rationale is 1501 characters \(cap 1500\)/],
        [record, { title: 't'.repeat(201), rationale: 'short' }, /title is 201 characters \(cap 200\)/],
        [record, { title: 'Keep the sweep', rationale: 'short', review_when: 'w'.repeat(301) }, /review_when is 301 characters \(cap 300\)/],
        [close, { decision_id: 'dec_course', reason: 'c'.repeat(601) }, /reason is 601 characters \(cap 600\)/],
      ];
      for (const [definition, args, message] of cases) {
        const refused = (await definition.handler(args, {})) as ToolResult;
        assert.equal(refused.isError, true);
        assert.match(resultText(refused), message);
        assert.match(resultText(refused), /deliverables you cite/);
        assert.match(resultText(refused), /record_progress/);
      }
      const within = (await record.handler({ title: 'Keep the sweep weekly', rationale: 'r'.repeat(1_500), review_when: 'w'.repeat(300) }, {})) as ToolResult;
      assert.equal(within.isError, undefined, resultText(within));
      await finish.handler({ summary: 'Recorded one bounded commitment.' }, {});
      return { costUsd: 0 };
    },
  };
  await runCoordinatorPass('coordinator-capacity', ['manual'], executor);
  const doc = await load('coordinator-capacity');
  assert.equal(doc.decisions.filter((d) => d.passId).length, 1, 'only the within-cap decision landed');
  assert.equal(doc.decisions.find((d) => d.id === 'dec_course')!.status, 'standing', 'an over-cap close changed nothing');
});

test('pass boundary events carry an excerpt while the PassRecord keeps the full summary', async () => {
  const summary = `Adopted the sweep result and advanced the course. ${'detail '.repeat(400)}END_OF_SUMMARY`;
  const reason = `wake reason ${'r'.repeat(900)}`;
  const outcome = await runCoordinatorPass('coordinator-capacity', [reason, 'second reason'], {
    id: 'local-sdk',
    async execute(req) {
      await req.tools.find((definition) => definition.name === 'finish_pass')!.handler({ summary }, {});
      return { costUsd: 0 };
    },
  });
  const doc = await load('coordinator-capacity');
  const pass = doc.passes.find((p) => p.id === outcome.passId)!;
  assert.equal(pass.summary, summary, 'the PassRecord keeps the whole account');
  const finished = doc.events.find((e) => e.type === 'pass.finished')!;
  assert.ok(finished.summary.length <= 300 + outcome.passId.length + 3, `pass.finished is ${finished.summary.length} chars`);
  assert.match(finished.summary, /^pass_\S+: Adopted the sweep result and advanced the course\./);
  assert.doesNotMatch(finished.summary, /END_OF_SUMMARY/);
  const started = doc.events.find((e) => e.type === 'pass.started')!;
  assert.ok(started.summary.length < 400, `pass.started is ${started.summary.length} chars`);
  assert.match(started.summary, /\) on local-sdk:/, 'the executor/model suffix survives the excerpt');
  const projection = buildProjection(doc, []);
  assert.doesNotMatch(projection, /END_OF_SUMMARY/);
  assert.doesNotMatch(projection, /r{400}/);
});

test('read_policy returns the full record of a matching policy and nothing outside its scope', async () => {
  await arrive('coordinator-capacity', (doc) => { doc.workstream.tags = ['acme']; });
  const mechanism = `run the readback ${'step '.repeat(200)}MECHANISM_TAIL`;
  const effect = `add a readback before adoption ${'because '.repeat(60)}EFFECT_TAIL`;
  const matching = await proposePolicy({
    statement: 'Confirm the rollout state by readback before adopting a rollout result',
    mechanism, tags: ['acme'], effectKind: 'add_verification', effectDescription: effect,
    workstreamSlug: 'ws-src', passId: 'pass_src', interventionSummary: 'the human asked for a readback',
  });
  const foreign = await proposePolicy({
    statement: 'Draft the release note before tagging',
    tags: ['other'], effectKind: 'advisory', effectDescription: 'x',
    workstreamSlug: 'ws-src', passId: 'pass_src', interventionSummary: 'i',
  });
  await runCoordinatorPass('coordinator-capacity', ['manual'], {
    id: 'local-sdk',
    async execute(req) {
      // The projection carries the statement whole and an excerpt of the prose.
      assert.match(req.prompt, /Confirm the rollout state by readback before adopting a rollout result/);
      assert.doesNotMatch(req.prompt, /MECHANISM_TAIL|EFFECT_TAIL/);
      assert.match(req.prompt, /read_policy for the full text/);
      const read = req.tools.find((definition) => definition.name === 'read_policy')!;
      const full = (await read.handler({ policy_id: matching.id }, {})) as ToolResult;
      assert.equal(full.isError, undefined, resultText(full));
      const record = JSON.parse(resultText(full)) as { id: string; mechanism: string; effect: { description: string }; doctrine: boolean };
      assert.equal(record.id, matching.id);
      assert.equal(record.mechanism, mechanism);
      assert.equal(record.effect.description, effect);
      assert.equal(record.doctrine, false);
      const outside = (await read.handler({ policy_id: foreign.id }, {})) as ToolResult;
      assert.equal(outside.isError, true);
      assert.match(resultText(outside), /no policy pol_\w+ matches this workstream's tags \[acme\]/);
      const missing = (await read.handler({ policy_id: 'pol_missing' }, {})) as ToolResult;
      assert.equal(missing.isError, true);
      await req.tools.find((definition) => definition.name === 'finish_pass')!.handler({ summary: 'Read one policy.' }, {});
      return { costUsd: 0 };
    },
  });
});

test('the prompt makes a step progress, not a decision', () => {
  assert.match(COORDINATOR_SYSTEM_PROMPT, /A step or cycle advance is PROGRESS, not a decision: record_progress updates the standing course in place/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /Supersede ONLY when the commitment itself/);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /its reason is one sentence saying what the check is for, not a handoff note/);
  assert.doesNotMatch(COORDINATOR_SYSTEM_PROMPT, /Record a standing decision first when a periodic check has no narrower course/);
  assert.doesNotMatch(COORDINATOR_SYSTEM_PROMPT, /the list of changes you made/);
});
