/**
 * Deterministic engine tests: the send lifecycle (egress revalidation,
 * crash-after-egress → readback-never-resend) and crash recovery, with no
 * model call anywhere — `tick` runs with maxPasses 0 and no runnable worker.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  coordinatorBackoffActive,
  flagImpossibleDependencies,
  runnableAssignments,
  tick,
  verifyAction,
} from './engine.js';
import { runCoordinatorPass } from './coordinator.js';
import { rejectSend } from './humanActs.js';
import { providerSend, readLedger } from './world.js';
import { arrive, createWorkstream, load, newId, writeArtifact } from './store.js';
import { runWorker } from './worker.js';
import { virtualNow } from './clock.js';
import type { Assignment } from './types.js';

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

function outboxDir(slug: string): string {
  return path.join(process.env.WEAVER_HOME!, slug, 'world', 'outbox');
}

const SLUG = 'send-ws';

async function makeApprovedSend(opts: { driftPin?: boolean } = {}): Promise<string> {
  await createWorkstream({
    slug: SLUG,
    title: 'Send test',
    objective: 'test sends',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const { relPath, hash } = await writeArtifact(SLUG, 'email.md', 'To: x\nSubject: y\nBody: hello');
  const intId = newId('int');
  await arrive(SLUG, (d) => {
    const delId = newId('del');
    d.deliverables.push({
      id: delId,
      title: 'Email',
      kind: 'outreach_email',
      path: relPath,
      contentHash: hash,
      createdAtVirtual: virtualNow().toISOString(),
      adopted: { contentHash: hash, passId: 'test', atVirtual: virtualNow().toISOString() },
    });
    d.interactions.push({
      id: intId,
      kind: 'email_send',
      to: 'someone@example.dev',
      subject: 'y',
      deliverableId: delId,
      pinnedHash: opts.driftPin ? 'deadbeef'.repeat(8) : hash,
      status: 'approved',
      approvedBy: 'human',
      approvedAt: new Date().toISOString(),
      replies: [],
    });
  });
  return intId;
}

beforeEach(() => {
  freshHome();
  delete process.env.WEAVER_SEND_UNKNOWN;
  // Hermetic: never let tests reach a REAL pilot daemon on this machine —
  // an unreachable port means the gate fails closed (stays gated), which is
  // the baseline the non-pilot tests assume. Pilot tests stub their own URL.
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
});

afterEach(() => {
  delete process.env.WEAVER_SEND_UNKNOWN;
});

test('a rejection that lands BEFORE the egress claim produces zero external effects', async () => {
  const intId = await makeApprovedSend();
  // The human rejects while the interaction is still 'approved' — the reject
  // wins the race. The engine must make no provider call at all.
  await rejectSend(SLUG, intId);
  const report = await tick(SLUG, { maxPasses: 0 });
  assert.equal(report.sendsExecuted, 0);
  const int = (await load(SLUG)).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'rejected');
  assert.equal(fs.existsSync(outboxDir(SLUG)), false, 'no outbox — provider was never called');
  assert.equal(readLedger(SLUG).filter((e) => e.kind === 'attempt').length, 0);
});

test('a rejection that lands AFTER the send is refused, never overwriting a real effect', async () => {
  const intId = await makeApprovedSend();
  await tick(SLUG, { maxPasses: 0 }); // send executes → 'sent'
  assert.equal((await load(SLUG)).interactions.find((i) => i.id === intId)!.status, 'sent');
  // The rejection lost the race: it must be refused, not silently flip a sent
  // interaction to 'rejected' and lie that it stopped the send.
  await assert.rejects(rejectSend(SLUG, intId), /can no longer be rejected/);
  assert.equal((await load(SLUG)).interactions.find((i) => i.id === intId)!.status, 'sent');
});

test('a rejection is refused once egress is claimed (status sending)', async () => {
  const intId = await makeApprovedSend();
  await arrive(SLUG, (d) => {
    d.interactions.find((i) => i.id === intId)!.status = 'sending';
  });
  await assert.rejects(rejectSend(SLUG, intId), /can no longer be rejected/);
});

test('the provider effect is idempotent on the interaction key: two invocations, one effect', async () => {
  const intId = await makeApprovedSend();
  const first = providerSend(SLUG, intId, { to: 'x', subject: 's', body: 'body-one' });
  const second = providerSend(SLUG, intId, { to: 'x', subject: 's', body: 'body-two' });
  // Two attempts logged, exactly one external effect, and the FIRST content
  // preserved — a duplicate send cannot create a second message or mutate one.
  const ledger = readLedger(SLUG);
  assert.equal(ledger.filter((e) => e.kind === 'attempt').length, 2);
  assert.equal(ledger.filter((e) => e.kind === 'effect').length, 1);
  assert.equal(fs.readdirSync(outboxDir(SLUG)).length, 1);
  assert.equal(first.body, 'body-one');
  assert.equal(second.body, 'body-one');
});

test('a claim crashed BEFORE egress (sending, no effect) completes safely, exactly once', async () => {
  const intId = await makeApprovedSend();
  // Simulate a crash after the durable claim but before the provider call:
  // status 'sending', no provider record exists.
  await arrive(SLUG, (d) => {
    d.interactions.find((i) => i.id === intId)!.status = 'sending';
  });
  await tick(SLUG, { maxPasses: 0 });
  const int = (await load(SLUG)).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'sent');
  assert.equal(readLedger(SLUG).filter((e) => e.kind === 'effect').length, 1);
});

test('a crash AFTER egress leaves exactly one effect and is resolved by readback, never re-sent', async () => {
  const intId = await makeApprovedSend();
  // Chaos stays on for the whole tick: the claim sends, the send "crashes"
  // after egress → 'unknown', and the tick's own next cycle resolves it by
  // readback (never a second send). The idempotency key guarantees at most one
  // external effect; a re-send would show a second attempt in the ledger.
  process.env.WEAVER_SEND_UNKNOWN = '1';
  await tick(SLUG, { maxPasses: 0 });
  const int = (await load(SLUG)).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'confirmed');
  const ledger = readLedger(SLUG);
  assert.equal(ledger.filter((e) => e.kind === 'effect').length, 1, 'exactly one external effect despite the unknown result');
  assert.equal(ledger.filter((e) => e.kind === 'attempt').length, 1, 'readback resolution must not re-send (a re-send would log a second attempt)');
});

test('verifyAction refuses a gated, unapproved action — readback is not a shell backdoor', async () => {
  await makeActionWorkstream('verify-gated-ws', {}); // default: gated, no approval, no attempts
  await assert.rejects(verifyAction('verify-gated-ws', 'asg_act'), /not approved/);
});

test('verifyAction refuses an approved action that never executed', async () => {
  await makeActionWorkstream('verify-noattempt-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'true', approval: { by: 'human', at: new Date().toISOString() } },
    state: 'awaiting_review',
    attempts: [],
  });
  await assert.rejects(verifyAction('verify-noattempt-ws', 'asg_act'), /no execution attempt/);
});

test('an approved send executes once and records the provider ref', async () => {
  const intId = await makeApprovedSend();
  const report = await tick(SLUG, { maxPasses: 0 });
  assert.equal(report.sendsExecuted, 1);
  const int = (await load(SLUG)).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'sent');
  assert.equal(int.externalRef, `prov_${intId}`);
  assert.equal(fs.readdirSync(outboxDir(SLUG)).length, 1);
});

test('crash after egress leaves UNKNOWN; readback confirms; the provider has exactly one record', async () => {
  const intId = await makeApprovedSend();

  process.env.WEAVER_SEND_UNKNOWN = '1';
  // First cycle sends (provider records it, then "crash"); a later cycle in the
  // same tick resolves the unknown by READBACK — even with chaos still on,
  // because readback never sends.
  await tick(SLUG, { maxPasses: 0 });
  const int = (await load(SLUG)).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'confirmed');
  assert.equal(int.externalRef, `prov_${intId}`);

  // The load-bearing assertion: exactly ONE provider record, ever.
  assert.equal(fs.readdirSync(outboxDir(SLUG)).length, 1);

  // And the event trail shows the unknown → readback path, not a resend.
  const types = (await load(SLUG)).events.map((e) => e.type);
  assert.ok(types.includes('send.unknown'));
  assert.ok(types.includes('send.confirmed'));
});

test('a send whose pinned content drifted is refused at egress, not sent', async () => {
  const intId = await makeApprovedSend({ driftPin: true });
  await tick(SLUG, { maxPasses: 0 });
  const int = (await load(SLUG)).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'rejected');
  assert.equal(fs.existsSync(outboxDir(SLUG)), false);
});

test('a paused workstream cannot be advanced by a manual tick or execute approved egress', async () => {
  const intId = await makeApprovedSend();
  await arrive(SLUG, (d, event) => {
    d.workstream.status = 'paused';
    event('workstream.paused', 'test paused the workstream');
  });
  const paused = await load(SLUG);

  const report = await tick(SLUG, { maxPasses: 0 });

  assert.equal(report.cycles, 0);
  assert.match(report.skipped ?? '', /paused/);
  assert.equal((await load(SLUG)).revision, paused.revision);
  assert.equal((await load(SLUG)).interactions.find((i) => i.id === intId)!.status, 'approved');
  assert.equal(fs.existsSync(outboxDir(SLUG)), false);
});

test('worker and coordinator entry points independently refuse paused work', async () => {
  await createWorkstream({
    slug: 'paused-entry',
    title: 'Paused entry guards',
    objective: 'remain stopped',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive('paused-entry', (d) => {
    d.workstream.status = 'paused';
    d.assignments.push({
      id: 'asg_paused',
      objective: 'must not start',
      briefing: 'n/a',
      kind: 'work',
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'queued',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    });
  });
  const paused = await load('paused-entry');

  assert.equal(await runWorker('paused-entry', 'asg_paused'), false);
  await assert.rejects(runCoordinatorPass('paused-entry', ['manual']), /is paused/);
  const unchanged = await load('paused-entry');
  assert.equal(unchanged.revision, paused.revision);
  assert.equal(unchanged.assignments[0]!.state, 'queued');
  assert.deepEqual(unchanged.assignments[0]!.attempts, []);
});

test('a worker-only runner leaves coordinator wakes pending for a capable host', async () => {
  await createWorkstream({
    slug: 'worker-only-runner',
    title: 'Worker-only runner',
    objective: 'do not claim an unsupported coordinator lease',
    tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  await arrive('worker-only-runner', (d) => d.wakes.push({
    id: 'wake_worker_only',
    reason: 'needs coordinator reconciliation',
    condition: { type: 'immediate' },
    status: 'pending',
    createdAt: new Date().toISOString(),
  }));

  const previousExecutors = process.env.WEAVER_RUNNER_EXECUTORS;
  process.env.WEAVER_RUNNER_EXECUTORS = 'openhands';
  let report: Awaited<ReturnType<typeof tick>>;
  try {
    report = await tick('worker-only-runner');
  } finally {
    if (previousExecutors === undefined) delete process.env.WEAVER_RUNNER_EXECUTORS;
    else process.env.WEAVER_RUNNER_EXECUTORS = previousExecutors;
  }
  const doc = await load('worker-only-runner');
  assert.equal(report.passes.length, 0);
  assert.equal(doc.wakes.find((wake) => wake.id === 'wake_worker_only')!.status, 'pending');
  assert.equal(doc.lease, null);
  assert.equal(doc.passes.length, 0);
});

test('a stale running attempt is recovered: crash recorded, assignment re-queued', async () => {
  await createWorkstream({
    slug: 'crash-ws',
    title: 'Crash test',
    objective: 'test recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  // A running assignment whose worker died. It depends on an incomplete
  // assignment so the recovered queue entry is NOT runnable — the tick must
  // not launch a real worker.
  await arrive('crash-ws', (d) => {
    d.assignments.push(
      {
        id: 'asg_dep',
        objective: 'unfinished dependency',
        briefing: 'n/a',
        kind: 'work',
        acceptanceCriteria: ['n/a'],
        dependsOn: [],
        state: 'awaiting_review',
        attempts: [],
        adoption: { state: 'proposed' },
        createdAtVirtual: virtualNow().toISOString(),
      },
      {
        id: 'asg_orphan',
        objective: 'orphaned by a dead worker',
        briefing: 'n/a',
        kind: 'work',
        acceptanceCriteria: ['n/a'],
        dependsOn: ['asg_dep'],
        state: 'running',
        attempts: [{ runId: 'run_dead', startedAt: new Date(Date.now() - 60_000).toISOString() }],
        adoption: { state: 'none' },
        createdAtVirtual: virtualNow().toISOString(),
      },
    );
  });

  process.env.WEAVER_ATTEMPT_STALE_MS = '1000';
  try {
    await tick('crash-ws', { maxPasses: 0 });
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }

  const asg = (await load('crash-ws')).assignments.find((a) => a.id === 'asg_orphan')!;
  assert.equal(asg.state, 'queued');
  const attempt = asg.attempts[0]!;
  assert.equal(attempt.terminalReason, 'crashed');
  assert.ok(attempt.endedAt);
});

test('a typed worker-model wait parks assignments without parsing prose', async () => {
  await createWorkstream({
    slug: 'capacity-ws',
    title: 'Capacity test',
    objective: 'defer model work',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const retryAt = new Date(virtualNow().getTime() + 60_000).toISOString();
  await arrive('capacity-ws', (d) => {
    d.assignments.push(
      {
        id: 'asg_first', objective: 'first', briefing: 'n/a', kind: 'work', acceptanceCriteria: ['n/a'],
        dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
      },
      {
        id: 'asg_second', objective: 'second', briefing: 'n/a', kind: 'work', acceptanceCriteria: ['n/a'],
        dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
      },
    );
    d.wakes.push({
      id: 'wake_capacity',
      reason: 'arbitrary presentation text',
      condition: { type: 'time', dueAtVirtual: retryAt },
      status: 'pending',
      createdAt: new Date().toISOString(),
      infrastructure: {
        kind: 'usage_limit',
        recovery: 'wait_or_enable_usage_credits',
        source: 'worker',
        sourceId: 'run_capacity',
        model: 'sonnet',
        executor: 'local-sdk',
        provider: 'anthropic',
        detectedAt: virtualNow().toISOString(),
        retryAt,
      },
    });
    d.capacity = {
      state: 'backoff',
      byModel: {
        sonnet: {
          wait: d.wakes.at(-1)!.infrastructure!,
          consecutiveBackoffs: 1,
          firstBackoffAtVirtual: virtualNow().toISOString(),
          lastBackoffAtVirtual: virtualNow().toISOString(),
        },
      },
    };
  });

  const doc = await load('capacity-ws');
  assert.deepEqual(runnableAssignments(doc), []);
  const workerEntry = doc.capacity!.byModel.sonnet!;
  doc.capacity = {
    state: 'backoff',
    byModel: {
      'claude-fable-5': {
        ...workerEntry,
        wait: { ...workerEntry.wait, source: 'coordinator', model: 'claude-fable-5' },
      },
    },
  };
  // The primary coordinator is limited, but its fallback remains available.
  assert.equal(coordinatorBackoffActive(doc), false);
  assert.deepEqual(runnableAssignments(doc), ['asg_first', 'asg_second']);
  doc.capacity.byModel['claude-opus-5'] = {
    ...workerEntry,
    wait: { ...workerEntry.wait, source: 'coordinator', model: 'claude-opus-5' },
  };
  assert.equal(coordinatorBackoffActive(doc), true);
  doc.capacity = { state: 'backoff', byModel: { sonnet: workerEntry } };
  assert.equal(coordinatorBackoffActive(doc), false);
  doc.wakes[0]!.condition = { type: 'time', dueAtVirtual: virtualNow().toISOString() };
  doc.wakes[0]!.infrastructure!.retryAt = virtualNow().toISOString();
  doc.capacity!.byModel.sonnet!.wait.retryAt = virtualNow().toISOString();
  assert.deepEqual(runnableAssignments(doc), ['asg_first', 'asg_second']);
});

test('a limited preferred route leaves the declared configured fallback runnable', async () => {
  const previousExecutor = process.env.WEAVER_EXECUTOR;
  const previousModel = process.env.WEAVER_WORKER_MODEL;
  process.env.WEAVER_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
  try {
  await createWorkstream({
    slug: 'routed-capacity',
    title: 'Routed capacity',
    objective: 'keep independent pools moving',
    tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  const retryAt = new Date(virtualNow().getTime() + 60_000).toISOString();
  await arrive('routed-capacity', (d) => {
    d.assignments.push(
      asg({
        id: 'asg_codex',
        executionRequirements: { profile: 'bounded-code-repair', modalities: ['text'] },
      }),
      asg({
        id: 'asg_general',
        executionRequirements: { profile: 'general', modalities: ['text'] },
      }),
    );
  });

  let doc = await load('routed-capacity');
  assert.deepEqual(runnableAssignments(doc), ['asg_codex', 'asg_general']);
  assert.deepEqual(
    runnableAssignments(doc, new Set(['local-sdk'])),
    [],
    'an incapable host reserves healthy preferred work for a capable runner',
  );
  assert.deepEqual(runnableAssignments(doc, new Set(['openhands'])), []);

  await arrive('routed-capacity', (d) => {
    d.capacity = {
      state: 'backoff',
      byModel: {
        'codex-sdk:openai:gpt-5.6-sol': {
          wait: {
            kind: 'rate_limit', recovery: 'automatic_retry', source: 'worker',
            sourceId: 'run_codex', executor: 'codex-sdk', provider: 'openai',
            model: 'gpt-5.6-sol', detectedAt: virtualNow().toISOString(), retryAt,
          },
          consecutiveBackoffs: 1,
          firstBackoffAtVirtual: virtualNow().toISOString(),
          lastBackoffAtVirtual: virtualNow().toISOString(),
        },
      },
    };
  });
  doc = await load('routed-capacity');
  assert.deepEqual(
    runnableAssignments(doc, new Set(['codex-sdk'])),
    ['asg_codex', 'asg_general'],
    'a typed preferred-target backoff makes the configured fallback eligible',
  );

  await arrive('routed-capacity', (d) => {
    const codex = d.capacity!.byModel['codex-sdk:openai:gpt-5.6-sol']!;
    d.capacity!.byModel['codex-sdk:openai:gpt-5.5'] = {
      ...codex,
      wait: {
        ...codex.wait,
        sourceId: 'run_sonnet',
        executor: 'codex-sdk',
        provider: 'openai',
        model: 'gpt-5.5',
      },
    };
  });
  doc = await load('routed-capacity');
  assert.deepEqual(runnableAssignments(doc), [], 'all reviewed targets are parked');
  } finally {
    if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
    else process.env.WEAVER_EXECUTOR = previousExecutor;
    if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
    else process.env.WEAVER_WORKER_MODEL = previousModel;
  }
});

// ---------------------------------------------------------------------------
// Dependency satisfaction: a downstream assignment runs only when its upstream
// both finished AND was adopted — the same rule worker.ts uses to decide which
// dependency artifacts to inject, so the scheduler and the injection agree.

function asg(partial: Partial<Assignment> & { id: string }): Assignment {
  return {
    objective: partial.id,
    briefing: 'n/a',
    kind: 'work',
    acceptanceCriteria: ['n/a'],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: virtualNow().toISOString(),
    ...partial,
  };
}

test('a dependency unblocks downstream ONLY when the upstream is completed AND accepted', async () => {
  freshHome();
  await createWorkstream({
    slug: 'dep-ws', title: 'Dep', objective: 'o', tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const base = await load('dep-ws');
  const downstream = asg({ id: 'asg_down', dependsOn: ['asg_up'], state: 'queued' });

  // Every upstream state the coordinator/engine can leave behind, and whether
  // it should unblock the downstream worker. Only completed+accepted does.
  const cases: Array<[string, Partial<Assignment>, boolean]> = [
    ['completed + accepted', { state: 'completed', adoption: { state: 'accepted' } }, true],
    ['completed + rejected (reject_submission)', { state: 'completed', adoption: { state: 'rejected' } }, false],
    ['completed but NOT accepted', { state: 'completed', adoption: { state: 'none' } }, false],
    ['awaiting_review + proposed', { state: 'awaiting_review', adoption: { state: 'proposed' } }, false],
    ['failed', { state: 'failed', adoption: { state: 'none' } }, false],
    ['cancelled', { state: 'cancelled', adoption: { state: 'none' } }, false],
  ];
  for (const [label, upstream, expectRunnable] of cases) {
    const doc = structuredClone(base);
    doc.assignments = [asg({ id: 'asg_up', ...upstream }), structuredClone(downstream)];
    assert.deepEqual(runnableAssignments(doc), expectRunnable ? ['asg_down'] : [], label);
  }

  // An UNKNOWN dependency id (no matching assignment) can never be satisfied.
  const dangling = structuredClone(base);
  dangling.assignments = [asg({ id: 'asg_down', dependsOn: ['asg_missing'], state: 'queued' })];
  assert.deepEqual(runnableAssignments(dangling), [], 'unknown dependency id never satisfies');
});

test('missing and settled-without-acceptance dependencies each raise one integrity blocker', async () => {
  freshHome();
  await createWorkstream({
    slug: 'dangle-ws', title: 'Dangle', objective: 'o', tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive('dangle-ws', (d) => {
    d.assignments.push(
      asg({ id: 'asg_cancelled', state: 'cancelled' }),
      asg({ id: 'asg_down_missing', dependsOn: ['asg_missing'], state: 'queued' }),
      asg({ id: 'asg_down_cancelled', dependsOn: ['asg_cancelled'], state: 'queued' }),
    );
  });

  // The scheduler blocks both, and the integrity sweep surfaces each once.
  assert.deepEqual(runnableAssignments(await load('dangle-ws')), []);
  assert.equal(await flagImpossibleDependencies('dangle-ws'), 2);
  const open = (await load('dangle-ws')).attention.filter(
    (a) => a.kind === 'blocker' && a.status === 'open',
  );
  assert.equal(open.length, 2);
  assert.match(open.find((a) => a.refId === 'asg_down_missing')!.summary, /asg_missing \(missing\)/);
  assert.match(open.find((a) => a.refId === 'asg_down_cancelled')!.summary, /asg_cancelled \(cancelled\/none\)/);

  // Deduped: a second sweep raises nothing and leaves the same two signals.
  assert.equal(await flagImpossibleDependencies('dangle-ws'), 0);
  assert.equal(
    (await load('dangle-ws')).attention.filter(
      (a) => a.refId === 'asg_down_missing' || a.refId === 'asg_down_cancelled',
    ).length,
    2,
  );
});

// ---------------------------------------------------------------------------
// Action assignments: gated until approval, confirmed only by readback.

async function makeActionWorkstream(slug: string, action: Partial<Assignment>): Promise<void> {
  await createWorkstream({
    slug,
    title: 'Action test',
    objective: 'test actions',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive(slug, (d) => {
    d.assignments.push({
      id: 'asg_act',
      objective: 'perform the act',
      briefing: 'n/a',
      kind: 'action',
      exec: { cwd: process.env.WEAVER_HOME!, verify: 'true' },
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'gated',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
      ...action,
    } as Assignment);
  });
}

test('a gated action never runs: tick launches no worker for it', async () => {
  await makeActionWorkstream('gated-ws', {});
  const report = await tick('gated-ws', { maxPasses: 0 });
  assert.deepEqual(report.workersRun, []);
  assert.equal((await load('gated-ws')).assignments[0]!.state, 'gated');
});

test('readback records CONFIRMED on exit 0 and non-confirming evidence otherwise', async () => {
  await makeActionWorkstream('verify-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'echo effect-present', approval: { by: 'human', at: new Date().toISOString() } },
    state: 'awaiting_review',
    attempts: [{ runId: 'r1', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }],
  });
  assert.equal(await verifyAction('verify-ws', 'asg_act'), true);
  let asg = (await load('verify-ws')).assignments[0]!;
  assert.equal(asg.exec!.verified!.ok, true);
  assert.match(asg.exec!.verified!.output, /effect-present/);

  await makeActionWorkstream('verify-fail-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'echo no-effect >&2; false', approval: { by: 'human', at: new Date().toISOString() } },
    state: 'awaiting_review',
    attempts: [{ runId: 'r1', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }],
  });
  assert.equal(await verifyAction('verify-fail-ws', 'asg_act'), false);
  asg = (await load('verify-fail-ws')).assignments[0]!;
  assert.equal(asg.exec!.verified!.ok, false);
  assert.match(asg.exec!.verified!.output, /no-effect/);
  const types = (await load('verify-fail-ws')).events.map((e) => e.type);
  assert.ok(types.includes('action.verify_failed'));
});

test('crashed action, effect LANDED: never re-run — submitted for review on readback evidence', async () => {
  await makeActionWorkstream('action-crash-ws', {
    state: 'running',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'echo world-already-changed',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    attempts: [{ runId: 'run_dead', startedAt: new Date(Date.now() - 60_000).toISOString() }],
  });

  process.env.WEAVER_ATTEMPT_STALE_MS = '1000';
  try {
    const report = await tick('action-crash-ws', { maxPasses: 0 });
    // The load-bearing assertion: recovery must not blindly re-run the act.
    assert.deepEqual(report.workersRun, []);
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }

  const doc = await load('action-crash-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.attempts[0]!.terminalReason, 'crashed');
  assert.equal(asg.exec!.verified!.ok, true); // readback discovered the effect landed
  assert.equal(asg.state, 'awaiting_review'); // machine-decidable: nothing to redo, review it
  assert.ok(!doc.attention.some((a) => a.refId === 'asg_act' && a.status === 'open'));
});

test('crashed action with a non-confirming verifier stays failed with one blocker and zero second attempts', async () => {
  await makeActionWorkstream('action-unknown-ws', {
    state: 'running',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'echo unsafe-replay >> replayed.txt',
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    attempts: [{ runId: 'run_dead', startedAt: new Date(Date.now() - 60_000).toISOString() }],
  });
  process.env.WEAVER_ATTEMPT_STALE_MS = '1000';
  try {
    await tick('action-unknown-ws', { maxPasses: 0 });
    await tick('action-unknown-ws', { maxPasses: 0 });
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }
  const doc = await load('action-unknown-ws');
  assert.equal(doc.assignments[0]!.state, 'failed');
  assert.equal(doc.assignments[0]!.attempts.length, 1, 'a non-confirming verifier must never authorize a second irreversible attempt');
  assert.equal(fs.existsSync(path.join(process.env.WEAVER_HOME!, 'replayed.txt')), false);
  const blockers = doc.attention.filter((a) => a.kind === 'blocker' && a.refId === 'asg_act' && a.status === 'open');
  assert.equal(blockers.length, 1, 'reconciliation blocker is deduped across ticks');
  assert.match(blockers[0]!.summary, /may already have changed the outside world.*will not run again automatically/);
});

test('crashed action with no runnable verifier stays failed and records zero second attempts', async () => {
  await makeActionWorkstream('action-missing-verifier-ws', {
    state: 'running',
    exec: undefined,
    attempts: [{ runId: 'run_dead', startedAt: new Date(Date.now() - 60_000).toISOString() }],
  });
  process.env.WEAVER_ATTEMPT_STALE_MS = '1000';
  try {
    await tick('action-missing-verifier-ws', { maxPasses: 0 });
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }
  const doc = await load('action-missing-verifier-ws');
  assert.equal(doc.assignments[0]!.state, 'failed');
  assert.equal(doc.assignments[0]!.attempts.length, 1);
  const blockers = doc.attention.filter((a) => a.kind === 'blocker' && a.refId === 'asg_act' && a.status === 'open');
  assert.equal(blockers.length, 1);
  assert.match(blockers[0]!.summary, /verifier could not run/);
});

test('legacy queued actions with prior attempts are held failed, surfaced, and never engine-executed', async () => {
  await makeActionWorkstream('action-one-shot-ws', {
    state: 'queued',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    attempts: [{ runId: 'run_failed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), terminalReason: 'crashed' }],
  });
  let doc = await load('action-one-shot-ws');
  assert.deepEqual(runnableAssignments(doc), []);

  await arrive('action-one-shot-ws', (d) => {
    const action = d.assignments[0]!;
    action.id = 'asg_engine';
    action.exec!.run = 'echo unsafe-replay > replayed.txt';
  });
  await tick('action-one-shot-ws', { maxPasses: 0 });
  doc = await load('action-one-shot-ws');
  assert.equal(doc.assignments[0]!.state, 'failed');
  assert.equal(doc.assignments[0]!.attempts.length, 1);
  assert.equal(fs.existsSync(path.join(process.env.WEAVER_HOME!, 'replayed.txt')), false);
  assert.equal(
    doc.attention.filter((a) => a.kind === 'blocker' && a.refId === 'asg_engine' && a.status === 'open').length,
    1,
  );
  assert.ok(doc.events.some((event) => event.type === 'action.legacy_retry_held'));
});

test('a human-authored exec.run action is executed by the ENGINE (no worker) and judged by readback', async () => {
  await makeActionWorkstream('engine-act-ws', {
    state: 'queued',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'echo did-the-real-thing > effect.txt',
      verify: 'grep -q did-the-real-thing effect.txt',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });
  const report = await tick('engine-act-ws', { maxPasses: 0 });
  assert.deepEqual(report.workersRun, []); // engine path, never a model worker
  const doc = await load('engine-act-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.state, 'awaiting_review');
  assert.equal(asg.attempts[0]!.model, 'engine');
  assert.equal(asg.attempts[0]!.terminalReason, 'executed');
  assert.equal(asg.exec!.verified!.ok, true);
  assert.ok(doc.deliverables.some((d) => d.kind === 'execution_record'));
});

test('an exec.run action without approval is not executed', async () => {
  await makeActionWorkstream('engine-gated-ws', {
    state: 'gated',
    exec: { cwd: process.env.WEAVER_HOME!, run: 'echo nope > leaked.txt', verify: 'true' },
  });
  await tick('engine-gated-ws', { maxPasses: 0 });
  assert.equal((await load('engine-gated-ws')).assignments[0]!.state, 'gated');
  assert.equal(fs.existsSync(path.join(process.env.WEAVER_HOME!, 'leaked.txt')), false);
});

test('human adoption cannot outrank readback: an action without a passing verify is refused', async () => {
  const { adoptSubmission } = await import('./humanActs.js');
  await makeActionWorkstream('adopt-guard-ws', {
    state: 'awaiting_review',
    submission: { summary: 'I did the thing, trust me' },
  });
  await assert.rejects(async () => adoptSubmission('adopt-guard-ws', 'asg_act'), /readback has not run/);

  await makeActionWorkstream('adopt-guard-fail-ws', {
    state: 'awaiting_review',
    submission: { summary: 'claimed success' },
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'false',
      verified: { ok: false, output: 'effect absent', at: new Date().toISOString() },
    },
  });
  await assert.rejects(async () => adoptSubmission('adopt-guard-fail-ws', 'asg_act'), /readback did not CONFIRM/);

  await makeActionWorkstream('adopt-guard-ok-ws', {
    state: 'awaiting_review',
    submission: { summary: 'done' },
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'true',
      verified: { ok: true, output: 'effect present', at: new Date().toISOString() },
    },
  });
  await adoptSubmission('adopt-guard-ok-ws', 'asg_act');
  assert.equal((await load('adopt-guard-ok-ws')).assignments[0]!.adoption.state, 'accepted');
});

test('a second process cannot tick a workstream mid-tick: live lock skips, dead lock is reclaimed', async () => {
  await createWorkstream({
    slug: 'lock-ws',
    title: 'Lock test',
    objective: 'tick exclusion',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const lockDir = path.join(process.env.WEAVER_HOME!, 'lock-ws', '.tick.lock');

  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid)); // this process = alive
  const skipped = await tick('lock-ws', { maxPasses: 0 });
  assert.ok(skipped.skipped);

  fs.writeFileSync(path.join(lockDir, 'pid'), '999999999'); // dead holder → stale
  const ran = await tick('lock-ws', { maxPasses: 0 });
  assert.equal(ran.skipped, undefined);
  assert.equal(fs.existsSync(lockDir), false); // released after the tick
});

test('a fresh running attempt is NOT treated as crashed', async () => {
  await createWorkstream({
    slug: 'fresh-ws',
    title: 'Fresh attempt',
    objective: 'no false recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive('fresh-ws', (d) => {
    d.assignments.push({
      id: 'asg_live',
      objective: 'still genuinely running',
      briefing: 'n/a',
      kind: 'work',
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'running',
      attempts: [{ runId: 'run_live', startedAt: new Date().toISOString() }],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    });
  });
  await tick('fresh-ws', { maxPasses: 0 }); // default 10-minute staleness
  assert.equal((await load('fresh-ws')).assignments[0]!.state, 'running');
});

test('an attempt whose driver process is dead is recovered immediately, no horizon wait', async () => {
  await createWorkstream({
    slug: 'deadpid-ws',
    title: 'Dead driver',
    objective: 'immediate orphan recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive('deadpid-ws', (d) => {
    d.assignments.push(
      {
        id: 'asg_dep_open',
        objective: 'unfinished dependency keeps the orphan non-runnable',
        briefing: 'n/a',
        kind: 'work',
        acceptanceCriteria: ['n/a'],
        dependsOn: [],
        state: 'awaiting_review',
        attempts: [],
        adoption: { state: 'proposed' },
        createdAtVirtual: virtualNow().toISOString(),
      },
      {
        id: 'asg_orphaned',
        objective: 'driver died seconds ago',
        briefing: 'n/a',
        kind: 'work',
        acceptanceCriteria: ['n/a'],
        dependsOn: ['asg_dep_open'],
        state: 'running',
        attempts: [{ runId: 'run_dead', runnerPid: 999999999, startedAt: new Date().toISOString() }],
        adoption: { state: 'none' },
        createdAtVirtual: virtualNow().toISOString(),
      },
    );
  });
  await tick('deadpid-ws', { maxPasses: 0 }); // default 45m horizon — pid check must not wait for it
  const asg = (await load('deadpid-ws')).assignments.find((a) => a.id === 'asg_orphaned')!;
  assert.equal(asg.state, 'queued');
  assert.equal(asg.attempts[0]!.terminalReason, 'crashed');
});

// ---------------------------------------------------------------------------
// Pilot-gated auto-approval: the operator's daemon can clear routine actions.

import * as http from 'node:http';

async function withPilotStub(
  decide: (cmd: string) => string,
  fn: (requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const cmd = JSON.parse(JSON.parse(body).tool_input).command as string;
      requests.push(cmd);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ decision: decide(cmd), reason: 'stub', source: 'test' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  process.env.WEAVER_PILOT_URL = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(requests);
  } finally {
    delete process.env.WEAVER_PILOT_URL;
    server.close();
  }
}

const GATED_WITH_CMDS = {
  briefing: 'Do the thing.\n```bash\ngit log --oneline -5\n```\n',
  exec: { cwd: '', verify: 'test -f out.md' },
};

test('pilot alive → a WORKER action auto-approves (live per-command supervision takes over)', async () => {
  await withPilotStub(() => 'approve', async (requests) => {
    await makeActionWorkstream('pilot-ok-ws', {
      ...GATED_WITH_CMDS,
      exec: { ...GATED_WITH_CMDS.exec, cwd: process.env.WEAVER_HOME! },
      dependsOn: ['asg_hold'],
    });
    await arrive('pilot-ok-ws', (d) => {
      d.assignments.push({
        id: 'asg_hold', objective: 'hold', briefing: 'n/a', kind: 'work',
        acceptanceCriteria: ['n/a'], dependsOn: [], state: 'awaiting_review',
        attempts: [], adoption: { state: 'proposed' }, createdAtVirtual: virtualNow().toISOString(),
      });
    });
    await tick('pilot-ok-ws', { maxPasses: 0 });
    const asg = (await load('pilot-ok-ws')).assignments.find((a) => a.id === 'asg_act')!;
    assert.equal(asg.state, 'queued');
    assert.equal(asg.exec!.approval!.by, 'pilot');
    // The ACT is judged too, not only pilot's liveness: per-command
    // supervision alone let an npm release through, because the operator's
    // own Claude Code settings pass individual commands straight through
    // before pilot's ruleset runs, and the publishing was done by CI off a
    // pushed tag.
    assert.equal(requests.length, 1);
  });
});

test('a human-only action never enters Pilot auto-approval', async () => {
  await withPilotStub(() => 'approve', async (requests) => {
    await makeActionWorkstream('human-only-action-ws', {
      ...GATED_WITH_CMDS,
      exec: {
        ...GATED_WITH_CMDS.exec,
        cwd: process.env.WEAVER_HOME!,
        approvalMode: 'human-only',
      },
    });
    await tick('human-only-action-ws', { maxPasses: 0 });
    const asg = (await load('human-only-action-ws')).assignments.find((a) => a.id === 'asg_act')!;
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.approval, undefined);
    assert.equal(asg.exec!.pilotVerdict, undefined);
    assert.deepEqual(requests, []);

    // Defense in depth: even a stale/corrupt Pilot approval cannot satisfy the
    // persisted human-only mode at scheduling or readback.
    await arrive('human-only-action-ws', (d) => {
      const current = d.assignments.find((a) => a.id === 'asg_act')!;
      current.state = 'queued';
      current.exec!.approval = { by: 'pilot', at: new Date().toISOString() };
    });
    assert.ok(!runnableAssignments(await load('human-only-action-ws')).includes('asg_act'));
    await assert.rejects(
      verifyAction('human-only-action-ws', 'asg_act'),
      /not approved by the required authority/,
    );
  });
});

test('a WORKER action pilot refuses on its objective stays gated for the human', async () => {
  await withPilotStub(() => 'deny', async () => {
    await makeActionWorkstream('pilot-act-deny-ws', {
      ...GATED_WITH_CMDS,
      objective: 'Publish @acme/ui@1.2.3 to npm by pushing the release tag',
      exec: { ...GATED_WITH_CMDS.exec, cwd: process.env.WEAVER_HOME! },
      dependsOn: ['asg_hold'],
    });
    await arrive('pilot-act-deny-ws', (d) => {
      d.assignments.push({
        id: 'asg_hold', objective: 'hold', briefing: 'n/a', kind: 'work',
        acceptanceCriteria: ['n/a'], dependsOn: [], state: 'awaiting_review',
        attempts: [], adoption: { state: 'proposed' }, createdAtVirtual: virtualNow().toISOString(),
      });
    });
    await tick('pilot-act-deny-ws', { maxPasses: 0 });
    const asg = (await load('pilot-act-deny-ws')).assignments.find((a) => a.id === 'asg_act')!;
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.approval, undefined);
    assert.equal((await load('pilot-act-deny-ws')).attention.filter((a) => a.refId === asg.id && a.status === 'open').length, 1);
  });
});

test('an ENGINE-RUN command pilot denies stays gated for the human, verdict cached (no re-ask)', async () => {
  await withPilotStub((cmd) => (cmd.includes('rm -rf') ? 'deny' : 'approve'), async (requests) => {
    await makeActionWorkstream('pilot-deny-ws', {
      exec: {
        cwd: process.env.WEAVER_HOME!,
        run: 'rm -rf /something/important',
        verify: 'true',
      },
    });
    await tick('pilot-deny-ws', { maxPasses: 0 });
    const asg = (await load('pilot-deny-ws')).assignments[0]!;
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.approval, undefined);
    assert.ok(asg.exec!.pilotVerdict);
    const asked = requests.length;
    await tick('pilot-deny-ws', { maxPasses: 0 });
    assert.equal(requests.length, asked); // cached — not re-asked every tick
  });
});

test('pilot unreachable → fails closed: gated, no verdict recorded, retried later', async () => {
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
  try {
    await makeActionWorkstream('pilot-down-ws', {
      ...GATED_WITH_CMDS,
      exec: { ...GATED_WITH_CMDS.exec, cwd: process.env.WEAVER_HOME! },
    });
    await tick('pilot-down-ws', { maxPasses: 0 });
    const asg = (await load('pilot-down-ws')).assignments[0]!;
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.pilotVerdict, undefined);
    assert.ok(asg.exec!.pilotUnavailableSince);
    assert.equal((await load('pilot-down-ws')).attention.length, 0, 'one transient failure is not a human task');

    await arrive('pilot-down-ws', (d) => {
      d.assignments[0]!.exec!.pilotUnavailableSince = new Date(Date.now() - 121_000).toISOString();
    });
    await tick('pilot-down-ws', { maxPasses: 0 });
    assert.equal((await load('pilot-down-ws')).attention.filter((a) => a.refId === 'asg_act' && a.status === 'open').length, 1);
  } finally {
    delete process.env.WEAVER_PILOT_URL;
  }
});

test('steering that answers an attention card resolves it in the same act', async () => {
  const { addSteering } = await import('./humanActs.js');
  await createWorkstream({
    slug: 'answer-ws', title: 'Answer test', objective: 'steer-resolves-attention',
    tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive('answer-ws', (d) => {
    d.attention.push({
      id: 'att_q', kind: 'blocker', summary: 'Which field shows the timezone?',
      status: 'open', createdAt: new Date().toISOString(),
    });
  });
  await addSteering('answer-ws', 'It is the Preferred Callback Time field.', { resolvesAttentionId: 'att_q' });
  const doc = await load('answer-ws');
  assert.equal(doc.attention.find((a) => a.id === 'att_q')!.status, 'resolved');
  assert.equal(doc.steering.length, 1);
  assert.ok(doc.wakes.some((w) => w.status === 'pending')); // coordinator still gets the answer
});

test('an orphaned running pass (no live lease) is swept to no_finish and the stream re-woken', async () => {
  const slug = 'orphan-pass-ws';
  await createWorkstream({
    slug,
    title: 'Orphan pass',
    objective: 'test orphan running-pass recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  // A pass left 'running' with NO lease naming it — the coordinator process
  // died and the lease was already cleared. The existing lease-based recovery
  // never sees it; the orphan sweep must.
  await arrive(slug, (d) => {
    d.passes.push({
      id: 'pass_orphan',
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      baseRevision: d.revision,
      wakeReasons: ['manual'],
      changes: [],
      outcome: 'running',
    });
    d.lease = null;
    // Clear any pending wakes so we can prove the sweep restores one.
    for (const w of d.wakes) w.status = 'cancelled';
  });
  await tick(slug, { maxPasses: 0 });
  const doc = await load(slug);
  assert.equal(doc.passes.find((p) => p.id === 'pass_orphan')!.outcome, 'no_finish');
  assert.ok(doc.wakes.some((w) => w.status === 'pending'), 'a reconciliation wake was restored');
});
