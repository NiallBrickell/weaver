import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { runCoordinatorPass, settleShadowRuns } from './coordinator.js';
import type { CoordinatorExecutor, CoordinatorExecutionRequest } from './executor/coordinator.js';
import type { BridgeToolDefinition } from './executor/toolBridge.js';
import { shadowCoordinatorConfig } from './modelConfig.js';
import { buildProjection } from './projection.js';
import {
  buildCaptureTools,
  computeAgreement,
  moveOf,
  passClassOf,
  type ShadowReadPort,
} from './shadowCoordinator.js';
import { aggregateShadowReport, renderShadowReport } from './shadowReport.js';
import { arrive, createWorkstream, load, writeArtifact } from './store.js';
import { virtualNow } from './clock.js';
import { recordCapacityBackoff } from './capacity.js';
import type { Assignment, PassRecord, ShadowMove, ShadowPassRecord, WorkstreamDoc } from './types.js';

const SLUG = 'shadow-seat';
const ENV_NAMES = [
  'WEAVER_SHADOW_COORDINATOR', 'WEAVER_SHADOW_RATE', 'WEAVER_COORDINATOR_EXECUTOR', 'WEAVER_COORDINATOR_MODEL',
  'WEAVER_COORDINATOR_FALLBACKS', 'WEAVER_COORDINATOR_FALLBACK_MODEL', 'WEAVER_COORDINATOR_FALLBACK_EXECUTOR', 'WEAVER_RUNNER_ID',
] as const;
let home: string;
let savedEnv: Record<string, string | undefined>;

function assignment(id: string, deliverableId?: string): Assignment {
  return {
    id,
    objective: `Objective for ${id}`,
    briefing: `Brief for ${id}`,
    kind: 'work',
    acceptanceCriteria: ['it works'],
    dependsOn: [],
    state: 'awaiting_review',
    attempts: [],
    submission: { summary: `done ${id}`, ...(deliverableId ? { deliverableId } : {}) },
    adoption: { state: 'proposed' },
    createdAtVirtual: virtualNow().toISOString(),
  };
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-shadow-seat-'));
  process.env.WEAVER_HOME = home;
  await createWorkstream({
    slug: SLUG,
    title: 'Shadow seat',
    objective: 'measure a cheaper coordinator seat without giving it authority',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  const artifact = await writeArtifact(SLUG, 'report.md', 'the verified report');
  await arrive(SLUG, (doc) => {
    doc.deliverables.push({
      id: 'del_a', title: 'Report', kind: 'report', path: artifact.relPath, contentHash: artifact.hash,
      producedByAssignment: 'asg_a', createdAtVirtual: virtualNow().toISOString(),
    });
    doc.assignments.push(assignment('asg_a', 'del_a'), assignment('asg_b'));
  });
});

afterEach(async () => {
  await settleShadowRuns();
  delete process.env.WEAVER_HOME;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function tool(req: CoordinatorExecutionRequest, name: string): BridgeToolDefinition {
  const found = req.tools.find((definition) => definition.name === name);
  assert.ok(found, `tool ${name} is exposed`);
  return found;
}

const text = (result: { content: unknown[] }) => JSON.stringify(result.content);

/** Real seat: verify both submissions, then dispatch the next step. */
function realExecutor(seen: { prompt?: string; systemPrompt?: string; toolNames?: string[] } = {}): CoordinatorExecutor {
  return {
    id: 'local-sdk',
    async execute(req) {
      seen.prompt = req.prompt;
      seen.systemPrompt = req.systemPrompt;
      seen.toolNames = req.tools.map((definition) => definition.name);
      assert.equal((await tool(req, 'read_artifact').handler({ deliverable_id: 'del_a' }, {})).isError, undefined);
      assert.equal((await tool(req, 'adopt_submission').handler({ assignment_id: 'asg_a', reason: 'meets criteria' }, {})).isError, undefined);
      assert.equal((await tool(req, 'reject_submission').handler({ assignment_id: 'asg_b', reason: 'no evidence' }, {})).isError, undefined);
      // A refused call is not a move.
      assert.equal((await tool(req, 'adopt_submission').handler({ assignment_id: 'asg_missing', reason: 'x' }, {})).isError, true);
      assert.equal((await tool(req, 'create_assignment').handler({
        objective: 'next step', briefing: 'do the next step', kind: 'work', acceptance_criteria: ['done'],
      }, {})).isError, undefined);
      await tool(req, 'finish_pass').handler({ summary: 'Adopted asg_a, rejected asg_b, dispatched the next step.' }, {});
      return { costUsd: 1.25 };
    },
  };
}

test('shadow config: unset or rate 0 is off, bad values fail loudly, a worker-only executor is refused', () => {
  assert.equal(shadowCoordinatorConfig(), null);
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
  assert.equal(shadowCoordinatorConfig(), null, 'rate defaults to 0');
  process.env.WEAVER_SHADOW_RATE = '0';
  assert.equal(shadowCoordinatorConfig(), null);
  process.env.WEAVER_SHADOW_RATE = '0.25';
  assert.deepEqual(shadowCoordinatorConfig(), {
    target: { executor: 'local-sdk', provider: 'anthropic', model: 'claude-sonnet-5' },
    rate: 0.25,
  });
  process.env.WEAVER_SHADOW_RATE = '1.5';
  assert.throws(() => shadowCoordinatorConfig(), /WEAVER_SHADOW_RATE/);
  process.env.WEAVER_SHADOW_RATE = '1';
  process.env.WEAVER_SHADOW_COORDINATOR = 'pi:openrouter/moonshotai/kimi-k3';
  assert.throws(() => shadowCoordinatorConfig(), /not a coordinator executor/);
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:a,codex-sdk:b';
  assert.throws(() => shadowCoordinatorConfig(), /exactly one/);
});

test('unset or rate 0 runs no shadow and records nothing', async () => {
  for (const rate of [undefined, '0']) {
    if (rate === undefined) delete process.env.WEAVER_SHADOW_RATE;
    else {
      process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
      process.env.WEAVER_SHADOW_RATE = rate;
    }
    await arrive(SLUG, (doc) => {
      doc.assignments = doc.assignments.filter((a) => a.id === 'asg_a' || a.id === 'asg_b');
      for (const a of doc.assignments) {
        a.state = 'awaiting_review';
        a.adoption = { state: 'proposed' };
      }
    });
    let shadowCalls = 0;
    const outcome = await runCoordinatorPass(SLUG, ['manual'], realExecutor(), undefined, {
      shadowExecutor: { id: 'local-sdk', async execute() { shadowCalls += 1; return { costUsd: 0 }; } },
      shadowSample: () => 0,
    });
    await settleShadowRuns();
    assert.equal(outcome.outcome, 'completed');
    assert.equal(shadowCalls, 0);
    assert.equal((await load(SLUG)).passes.at(-1)!.shadow, undefined);
  }
});

test('a sampled shadow sees the exact projection, cannot write, and its moves are compared with the real pass', async () => {
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
  process.env.WEAVER_SHADOW_RATE = '0.5';
  const seen: { prompt?: string; systemPrompt?: string; toolNames?: string[] } = {};
  let shadowReq: CoordinatorExecutionRequest | undefined;
  let before: WorkstreamDoc | undefined;
  let after: WorkstreamDoc | undefined;
  const shadowExecutor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      shadowReq = req;
      before = await load(SLUG);
      const artifact = await tool(req, 'read_artifact').handler({ deliverable_id: 'del_a' }, {});
      assert.match(text(artifact), /the verified report/, 'reads serve the snapshot');
      assert.equal((await tool(req, 'adopt_submission').handler({ assignment_id: 'asg_a', reason: 'ok' }, {})).isError, undefined);
      // Disagreement: the shadow adopts what the real seat rejected.
      assert.equal((await tool(req, 'adopt_submission').handler({ assignment_id: 'asg_b', reason: 'fine' }, {})).isError, undefined);
      assert.equal((await tool(req, 'adopt_submission').handler({ assignment_id: 'asg_b', reason: 'again' }, {})).isError, true);
      const created = await tool(req, 'create_assignment').handler({
        objective: 'next', briefing: 'next', kind: 'work', acceptance_criteria: ['done'],
      }, {});
      assert.match(text(created), /created assignment asg_[0-9a-f]{8}/);
      assert.equal((await tool(req, 'raise_attention').handler({ kind: 'review', summary: 'look' }, {})).isError, undefined);
      assert.equal((await tool(req, 'conclude_workstream').handler({ summary: 'done', evidence_ids: ['del_a'] }, {})).isError, true);
      await tool(req, 'record_decision').handler({ title: 't', rationale: 'r' }, {});
      await tool(req, 'schedule_wake').handler({ reason: 'check', after: '1d', course_id: 'asg_a' }, {});
      await tool(req, 'finish_pass').handler({ summary: 'shadow done' }, {});
      after = await load(SLUG);
      return { costUsd: 0.11 };
    },
  };

  const outcome = await runCoordinatorPass(SLUG, ['manual'], realExecutor(seen), undefined, {
    shadowExecutor,
    shadowSample: () => 0.4,
  });
  assert.equal(outcome.outcome, 'completed');
  const realDone = await load(SLUG);
  await settleShadowRuns();

  // Same inputs as the real seat.
  assert.ok(shadowReq);
  assert.equal(shadowReq.prompt, seen.prompt);
  assert.equal(shadowReq.systemPrompt, seen.systemPrompt);
  assert.deepEqual(shadowReq.tools.map((definition) => definition.name), seen.toolNames);
  assert.equal(shadowReq.model, 'claude-sonnet-5');

  // Zero write path: every capture call above left the store byte-identical.
  assert.ok(before && after);
  assert.equal(after.revision, before.revision);
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal(after.assignments.find((a) => a.id === 'asg_b')!.adoption.state, 'rejected');
  assert.equal(after.assignments.length, 3, 'only the real dispatch exists');
  assert.equal(after.attention.filter((a) => a.status === 'open').length, 0);
  assert.equal(after.decisions.length, 0);

  // The single harness write adds only PassRecord.shadow: no event, no wake.
  const recorded = await load(SLUG);
  assert.equal(recorded.revision, realDone.revision + 1);
  assert.deepEqual(recorded.events, realDone.events);
  assert.deepEqual(recorded.wakes, realDone.wakes);
  const { shadow, ...pass } = recorded.passes.at(-1)!;
  assert.deepEqual(pass, realDone.passes.at(-1));
  assert.ok(shadow);
  assert.equal(shadow.seat, 'local-sdk:claude-sonnet-5');
  assert.equal(shadow.passClass, 'verify-then-dispatch');
  assert.equal(shadow.costUsd, 0.11);
  assert.deepEqual(shadow.realMoves, [
    { tool: 'adopt_submission', targets: ['asg_a'] },
    { tool: 'reject_submission', targets: ['asg_b'] },
    { tool: 'create_assignment', targets: [] },
  ]);
  assert.deepEqual(shadow.moves.map((m) => m.tool), [
    'adopt_submission', 'adopt_submission', 'create_assignment', 'raise_attention', 'record_decision', 'schedule_wake',
  ]);
  assert.ok(shadow.agreement);
  assert.equal(shadow.agreement.adoptReject.agree, false);
  assert.deepEqual(shadow.agreement.adoptReject.shadow, { adopt: ['asg_a', 'asg_b'], reject: [] });
  assert.equal(shadow.agreement.dispatch.agree, true);
  assert.equal(shadow.agreement.conclude.agree, true);
  assert.equal(shadow.agreement.raiseAttention.agree, false);
  assert.equal(shadow.agreement.headline, false);
  assert.equal(shadow.agreement.toolMultiset, false);
  assert.ok(JSON.stringify(shadow).length < 2_000, 'the record stays small: ids and tool names only');
});

test('a sample above the rate is not shadowed', async () => {
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
  process.env.WEAVER_SHADOW_RATE = '0.5';
  let calls = 0;
  await runCoordinatorPass(SLUG, ['manual'], realExecutor(), undefined, {
    shadowExecutor: { id: 'local-sdk', async execute() { calls += 1; return { costUsd: 0 }; } },
    shadowSample: () => 0.5,
  });
  await settleShadowRuns();
  assert.equal(calls, 0);
  assert.equal((await load(SLUG)).passes.at(-1)!.shadow, undefined);
});

test('a shadow seat parked on capacity is not launched', async () => {
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
  process.env.WEAVER_SHADOW_RATE = '1';
  await arrive(SLUG, (doc) => {
    recordCapacityBackoff(doc, {
      kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator', sourceId: 'pass_x',
      model: 'claude-sonnet-5', executor: 'local-sdk', provider: 'anthropic',
      detectedAt: virtualNow().toISOString(), retryAt: new Date(virtualNow().getTime() + 3_600_000).toISOString(),
    });
  });
  let calls = 0;
  await runCoordinatorPass(SLUG, ['manual'], realExecutor(), undefined, {
    shadowExecutor: { id: 'local-sdk', async execute() { calls += 1; return { costUsd: 0 }; } },
    shadowSample: () => 0,
  });
  await settleShadowRuns();
  assert.equal(calls, 0);
  assert.equal((await load(SLUG)).passes.at(-1)!.shadow, undefined);
});

test('a shadow failure is swallowed and recorded; the real pass is untouched', async () => {
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
  process.env.WEAVER_SHADOW_RATE = '1';
  let calls = 0;
  const outcome = await runCoordinatorPass(SLUG, ['manual'], realExecutor(), undefined, {
    shadowExecutor: {
      id: 'local-sdk',
      async execute() {
        calls += 1;
        throw new Error('rate limited: shadow seat out of quota');
      },
    },
    shadowSample: () => 0,
  });
  assert.equal(outcome.outcome, 'completed');
  const realDone = await load(SLUG);
  await settleShadowRuns();
  assert.equal(calls, 1, 'never retried');
  const doc = await load(SLUG);
  const { shadow, ...pass } = doc.passes.at(-1)!;
  assert.deepEqual(pass, realDone.passes.at(-1));
  assert.match(shadow?.error ?? '', /out of quota/);
  assert.equal(shadow?.agreement, undefined);
  // No capacity wait, backoff, or attention was recorded for the shadow seat.
  assert.deepEqual(doc.wakes, realDone.wakes);
  assert.deepEqual(doc.attention, realDone.attention);
  assert.deepEqual(doc.capacity, realDone.capacity);
});

test('a shadow result is dropped rather than written while another pass holds the lease', async () => {
  process.env.WEAVER_SHADOW_COORDINATOR = 'local-sdk:claude-sonnet-5';
  process.env.WEAVER_SHADOW_RATE = '1';
  let leased: WorkstreamDoc | undefined;
  await runCoordinatorPass(SLUG, ['manual'], realExecutor(), undefined, {
    shadowExecutor: {
      id: 'local-sdk',
      async execute() {
        leased = await arrive(SLUG, (doc) => {
          doc.lease = {
            passId: 'pass_next', runnerId: 'test', acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        });
        return { costUsd: 0 };
      },
    },
    shadowSample: () => 0,
  });
  await settleShadowRuns();
  const doc = await load(SLUG);
  assert.equal(doc.revision, leased!.revision, 'a running pass never conflicts on a shadow record');
  assert.equal(doc.passes.at(-1)!.shadow, undefined);
});

test('capture tools never call a real handler, and every write is captured rather than applied', async () => {
  const called: string[] = [];
  const names = [
    'record_decision', 'close_decision', 'record_progress', 'create_assignment', 'cancel_assignment', 'read_artifact',
    'adopt_submission', 'reject_submission', 'request_send', 'evaluate_reply', 'evaluate_observation', 'raise_attention',
    'withdraw_attention', 'conclude_workstream', 'propose_policy', 'record_policy_outcome', 'supersede_policy',
    'revise_policy_mechanism', 'read_policy', 'resolve_attention', 'list_cancellable_wakes', 'cancel_wake',
    'schedule_wake', 'schedule_probe', 'create_workstream', 'inspect_workstream', 'direct_workstream',
    'report_repair_evidence', 'finish_pass', 'some_future_tool',
  ];
  const definitions: BridgeToolDefinition[] = names.map((name) => ({
    name,
    description: `real ${name}`,
    inputSchema: { anything: z.string().optional() },
    async handler() {
      called.push(name);
      throw new Error(`real handler ${name} must never run in a shadow`);
    },
  }));
  const reads: ShadowReadPort = {
    async readDeliverable() { return { content: [{ type: 'text', text: 'read' }] }; },
    async readProbeArtifact() { return { content: [{ type: 'text', text: 'read' }] }; },
    readPolicy() { return { content: [{ type: 'text', text: 'read' }] }; },
    listCancellableWakes() { return { content: [{ type: 'text', text: 'read' }] }; },
    async inspectWorkstream() { return { content: [{ type: 'text', text: 'read' }] }; },
  };
  const snapshot = await load(SLUG);
  const moves: ShadowMove[] = [];
  const capture = buildCaptureTools(definitions, { snapshot, reads, moves });
  assert.deepEqual(capture.map((d) => [d.name, d.description, d.inputSchema]), definitions.map((d) => [d.name, d.description, d.inputSchema]));
  for (const [index, definition] of capture.entries()) {
    assert.notEqual(definition.handler, definitions[index]!.handler);
    await definition.handler({ deliverable_id: 'del_a', assignment_id: 'asg_a', slug: 'x', kind: 'work' }, {});
  }
  assert.deepEqual(called, []);
  assert.equal(JSON.stringify(await load(SLUG)), JSON.stringify(snapshot));
  assert.ok(moves.every((move) => !['read_artifact', 'read_policy', 'list_cancellable_wakes', 'inspect_workstream', 'finish_pass'].includes(move.tool)));
  assert.ok(moves.some((move) => move.tool === 'some_future_tool'), 'an unknown tool is captured, not dropped or forwarded');
});

test('the shadow module has no import that could reach a write path', () => {
  const source = fs.readFileSync(new URL('./shadowCoordinator.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2]! }));
  const runtime = imports.filter((i) => !i.typeOnly).map((i) => i.from).sort();
  assert.deepEqual(runtime, ['./wall.js', 'node:crypto']);
  const wall = fs.readFileSync(new URL('./wall.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(wall, /from '\.\/(store|engine|coordinator|ingress|policies|managedWorkstreams)/);
});

test('agreement is computed per move type', () => {
  const m = (tool: string, ...targets: string[]): ShadowMove => ({ tool, targets });
  const same = computeAgreement([m('adopt_submission', 'asg_1'), m('create_assignment')], [m('create_assignment'), m('adopt_submission', 'asg_1')]);
  assert.equal(same.headline, true);
  assert.equal(same.toolMultiset, true);

  const verdict = computeAgreement([m('adopt_submission', 'asg_1')], [m('reject_submission', 'asg_1')]);
  assert.equal(verdict.adoptReject.agree, false);
  assert.deepEqual(verdict.adoptReject.real, { adopt: ['asg_1'], reject: [] });
  assert.deepEqual(verdict.adoptReject.shadow, { adopt: [], reject: ['asg_1'] });
  assert.equal(verdict.headline, false);

  const omitted = computeAgreement([m('adopt_submission', 'asg_1'), m('adopt_submission', 'asg_2')], [m('adopt_submission', 'asg_1')]);
  assert.equal(omitted.adoptReject.agree, false, 'a verdict only one seat gave is a disagreement');

  const dispatch = computeAgreement([m('create_assignment'), m('create_assignment')], [m('create_assignment')]);
  assert.deepEqual(dispatch.dispatch, { agree: false, real: 2, shadow: 1 });
  assert.equal(dispatch.headline, true, 'dispatch count is reported, not a headline');

  const conclude = computeAgreement([m('conclude_workstream', 'del_1')], []);
  assert.deepEqual(conclude.conclude, { agree: false, real: true, shadow: false });
  assert.equal(conclude.headline, false);

  const raise = computeAgreement([m('raise_attention')], [m('raise_attention'), m('raise_attention', 'asg_1')]);
  assert.equal(raise.raiseAttention.agree, true, 'raising at all is the agreement');
  assert.equal(raise.toolMultiset, false);

  const supersede = computeAgreement(
    [m('record_decision', 'dec_1'), m('supersede_policy', 'pol_1')],
    [m('record_decision'), m('supersede_policy', 'pol_1')],
  );
  assert.deepEqual(supersede.supersede, { agree: false, real: ['dec_1', 'pol_1'], shadow: ['pol_1'] });
});

test('pass class is derived from the real pass\'s typed moves', () => {
  const m = (tool: string): ShadowMove => ({ tool, targets: [] });
  assert.equal(passClassOf([m('adopt_submission'), m('create_assignment')]), 'verify-then-dispatch');
  assert.equal(passClassOf([m('reject_submission'), m('create_assignment'), m('record_progress')]), 'verify-then-dispatch');
  assert.equal(passClassOf([m('create_assignment')]), 'dispatch-only');
  assert.equal(passClassOf([]), 'wait-only');
  assert.equal(passClassOf([m('schedule_wake'), m('record_progress')]), 'wait-only');
  assert.equal(passClassOf([m('adopt_submission'), m('conclude_workstream')]), 'conclude');
  assert.equal(passClassOf([m('adopt_submission'), m('schedule_wake')]), 'other');
  assert.equal(passClassOf([m('raise_attention')]), 'other');
});

test('moves carry tool names and existing ids only', () => {
  assert.equal(moveOf('read_artifact', { deliverable_id: 'del_1' }), null);
  assert.equal(moveOf('finish_pass', { summary: 'long prose' }), null);
  assert.deepEqual(moveOf('record_decision', { title: 'prose', rationale: 'prose', applied_policy_ids: ['pol_1'] }), { tool: 'record_decision', targets: [] });
  assert.deepEqual(moveOf('record_decision', { title: 'p', rationale: 'p', supersedes_decision_id: 'dec_1' }), { tool: 'record_decision', targets: ['dec_1'] });
  assert.deepEqual(moveOf('create_assignment', { briefing: 'prose', depends_on: ['asg_1'] }), { tool: 'create_assignment', targets: ['asg_1'] });
  assert.deepEqual(moveOf('conclude_workstream', { summary: 'prose', evidence_ids: ['del_1', 'del_2'] }), { tool: 'conclude_workstream', targets: ['del_1', 'del_2'] });
  assert.deepEqual(moveOf('some_future_tool', { thing_id: 'x_1', note: 'prose' }), { tool: 'some_future_tool', targets: ['x_1'] });
});

function shadowRecord(passClass: ShadowPassRecord['passClass'], real: ShadowMove[], moves: ShadowMove[], extra: Partial<ShadowPassRecord> = {}): ShadowPassRecord {
  return {
    seat: 'local-sdk:claude-sonnet-5', at: '2026-09-20T00:00:00.000Z', passClass, realMoves: real, moves,
    costUsd: 0.1, agreement: computeAgreement(real, moves), ...extra,
  };
}

function pass(id: string, startedAt: string, shadow?: ShadowPassRecord): PassRecord {
  return { id, startedAt, baseRevision: 1, wakeReasons: [], changes: [], outcome: 'completed', costUsd: 1.2, ...(shadow ? { shadow } : {}) };
}

test('the projection never reads a pass\'s shadow record', async () => {
  const doc = await load(SLUG);
  doc.passes.push(pass('pass_1', '2026-09-20T00:00:00.000Z'));
  // The render stamps the virtual clock to the millisecond; only that line may differ between two renders.
  const render = () => buildProjection(doc, ['manual']).replace(/^- virtual now: .*$/m, '- virtual now: <now>');
  const plain = render();
  doc.passes[0]!.shadow = shadowRecord('other', [], [{ tool: 'conclude_workstream', targets: ['SHADOW_SENTINEL'] }], {
    seat: 'local-sdk:SHADOW_SEAT_SENTINEL', error: 'SHADOW_ERROR_SENTINEL',
  });
  assert.equal(render(), plain);
});

test('the report aggregates agreement per pass class with denominators, cost, and disagreeing passes', async () => {
  const m = (tool: string, ...targets: string[]): ShadowMove => ({ tool, targets });
  const doc = await load(SLUG);
  doc.passes = [
    pass('pass_agree', '2026-09-20T00:00:00.000Z', shadowRecord('verify-then-dispatch',
      [m('adopt_submission', 'asg_1'), m('create_assignment')], [m('adopt_submission', 'asg_1'), m('create_assignment')])),
    pass('pass_flip', '2026-09-21T00:00:00.000Z', shadowRecord('verify-then-dispatch',
      [m('adopt_submission', 'asg_2'), m('create_assignment')], [m('reject_submission', 'asg_2'), m('create_assignment')])),
    pass('pass_wait', '2026-09-22T00:00:00.000Z', shadowRecord('wait-only', [], [m('raise_attention')])),
    pass('pass_err', '2026-09-23T00:00:00.000Z', {
      seat: 'local-sdk:claude-sonnet-5', at: '2026-09-23T00:00:00.000Z', passClass: 'dispatch-only',
      realMoves: [m('create_assignment')], moves: [], error: 'quota',
    }),
    pass('pass_old', '2026-09-01T00:00:00.000Z', shadowRecord('conclude', [m('conclude_workstream', 'del_1')], [])),
    pass('pass_plain', '2026-09-24T00:00:00.000Z'),
  ];
  const report = aggregateShadowReport([doc], '2026-09-10T00:00:00.000Z');
  const row = (c: string) => report.rows.find((r) => r.passClass === c)!;
  assert.deepEqual(
    [row('verify-then-dispatch').sampled, row('verify-then-dispatch').compared, row('verify-then-dispatch').adoptReject, row('verify-then-dispatch').headline, row('verify-then-dispatch').dispatch],
    [2, 2, 1, 1, 2],
  );
  assert.equal(row('verify-then-dispatch').realCostUsd.toFixed(2), '2.40');
  assert.equal(row('verify-then-dispatch').shadowCostUsd.toFixed(2), '0.20');
  assert.deepEqual([row('wait-only').compared, row('wait-only').raiseAttention], [1, 0]);
  assert.deepEqual([row('dispatch-only').sampled, row('dispatch-only').errors, row('dispatch-only').compared], [1, 1, 0]);
  assert.equal(row('conclude').sampled, 0, '--since excludes older passes');
  assert.deepEqual(report.disagreements.map((d) => [d.passId, d.dimensions]), [
    ['pass_flip', ['adopt/reject']],
    ['pass_wait', ['raise_attention']],
  ]);
  assert.deepEqual(report.failures.map((f) => f.passId), ['pass_err']);
  const rendered = renderShadowReport(report);
  assert.match(rendered, /verify-then-dispatch: 2 sampled, 2 compared, 0 failed/);
  assert.match(rendered, /adopt\/reject 1\/2 \(50%\)/);
  assert.match(rendered, /shadow-seat pass_flip \[verify-then-dispatch\] on adopt\/reject/);
  assert.match(rendered, /operator's decision/);
  assert.match(renderShadowReport(aggregateShadowReport([])), /No shadowed passes recorded/);
});
