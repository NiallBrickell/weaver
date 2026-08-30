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
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  coordinatorBackoffActive,
  flagImpossibleDependencies,
  guardRepoEgress,
  runnableAssignments,
  tick,
  preflightApprovedAction,
  verifyAction,
} from './engine.js';
import { runCoordinatorPass } from './coordinator.js';
import { rejectSend } from './humanActs.js';
import { providerSend, readLedger } from './world.js';
import { arrive, createWorkstream, heartbeatRunner, load, newId, readArtifact, writeArtifact } from './store.js';
import { runWorker } from './worker.js';
import { setExecutorSecret } from './secrets.js';
import { virtualNow } from './clock.js';
import type { Assignment } from './types.js';
import {
  __resetGitHubAppForTests,
  __setGitHubAppTestDependencies,
} from './githubApp.js';

const githubTestPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();

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
  delete process.env.WEAVER_RUNNER_ID;
  delete process.env.WEAVER_RUNNER_PLACEMENT_ONLY;
  __resetGitHubAppForTests();
});

afterEach(() => {
  delete process.env.WEAVER_SEND_UNKNOWN;
  delete process.env.WEAVER_RUNNER_ID;
  delete process.env.WEAVER_RUNNER_PLACEMENT_ONLY;
  __resetGitHubAppForTests();
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

test('preflight confirms an approved action whose postcondition already holds, without executing', async () => {
  await makeActionWorkstream('preflight-satisfied-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'echo already-there', approval: { by: 'human', at: new Date().toISOString() } },
    state: 'queued',
    attempts: [],
  });
  assert.equal(await preflightApprovedAction('preflight-satisfied-ws', 'asg_act'), true);
  const asg = (await load('preflight-satisfied-ws')).assignments.find((a) => a.id === 'asg_act')!;
  assert.equal(asg.state, 'awaiting_review');
  assert.equal(asg.attempts.length, 0, 'the action must never have executed');
  assert.equal(asg.exec!.verified?.ok, true);
  assert.match(asg.submission!.summary, /never re-run/);
});

test('preflight is a no-op when the postcondition does not hold yet', async () => {
  await makeActionWorkstream('preflight-pending-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'false', approval: { by: 'human', at: new Date().toISOString() } },
    state: 'queued',
    attempts: [],
  });
  assert.equal(await preflightApprovedAction('preflight-pending-ws', 'asg_act'), false);
  const asg = (await load('preflight-pending-ws')).assignments.find((a) => a.id === 'asg_act')!;
  assert.equal(asg.state, 'queued', 'a pending action stays queued for ordinary execution');
  assert.equal(asg.exec!.verified, undefined);
});

test('preflight refuses a gated, unapproved action — same boundary as readback', async () => {
  await makeActionWorkstream('preflight-gated-ws', {}); // gated, no approval
  assert.equal(await preflightApprovedAction('preflight-gated-ws', 'asg_act'), false);
  const asg = (await load('preflight-gated-ws')).assignments.find((a) => a.id === 'asg_act')!;
  assert.equal(asg.state, 'gated', 'an unapproved action never runs its model-authored verifier');
});

test('always-execute returns before invoking the preflight verifier', async () => {
  const marker = path.join(process.env.WEAVER_HOME!, 'preflight-verifier-ran');
  await makeActionWorkstream('preflight-always-execute-ws', {
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'printf "fresh observation\\n"',
      verify: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`,
      preflightMode: 'always-execute',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    state: 'queued',
    attempts: [],
  });

  assert.equal(await preflightApprovedAction('preflight-always-execute-ws', 'asg_act'), false);
  assert.equal(fs.existsSync(marker), false, 'always-execute must not call verify before the action claim');
  const asg = (await load('preflight-always-execute-ws')).assignments[0]!;
  assert.equal(asg.state, 'queued');
  assert.equal(asg.attempts.length, 0);
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

test('an ineligible standby leaves coordinator wakes pending without blocking other tick lanes', async () => {
  process.env.WEAVER_RUNNER_ID = 'gcp-standby';
  await createWorkstream({
    slug: 'preferred-coordinator-runner', title: 'Preferred coordinator runner',
    objective: 'keep reconciliation on the preferred host while it is live',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    executionPolicy: { coordinatorRunnerOrder: ['mac-primary', 'gcp-standby'] },
  });
  await arrive('preferred-coordinator-runner', (doc) => doc.wakes.push({
    id: 'wake_preferred', reason: 'coordinate now', condition: { type: 'immediate' },
    status: 'pending', createdAt: new Date().toISOString(),
  }));
  await heartbeatRunner('mac-primary');
  const report = await tick('preferred-coordinator-runner', {
    coordinatorExecutor: {
      id: 'local-sdk', async execute() { throw new Error('standby coordinator must not launch'); },
    },
  });
  assert.equal(report.passes.length, 0);
  const doc = await load('preferred-coordinator-runner');
  assert.equal(doc.wakes.find((wake) => wake.id === 'wake_preferred')?.status, 'pending');
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
  doc.capacity.byModel['claude-opus-4-8'] = {
    ...workerEntry,
    wait: { ...workerEntry.wait, source: 'coordinator', model: 'claude-opus-4-8' },
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

test('engine-only tick executes one matching placed command and touches no other execution lane', async () => {
  const slug = 'placed-engine-only';
  const home = process.env.WEAVER_HOME!;
  process.env.WEAVER_RUNNER_ID = 'gcp-runner';
  await createWorkstream({
    slug,
    title: 'Placed machine action',
    objective: 'run one machine-local exact action',
    tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  await arrive(slug, (doc) => doc.assignments.push({
    id: 'asg_mac_exact',
    objective: 'touch the Mac-local daemon',
    briefing: 'exact engine action',
    kind: 'action',
    runnerId: 'mac-runner',
    exec: {
      cwd: home,
      run: 'printf done > placed-action.out',
      verify: 'test "$(cat placed-action.out)" = done',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    acceptanceCriteria: ['readback confirms the exact file'],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: virtualNow().toISOString(),
  }));

  const gcp = await tick(slug, { maxPasses: 0 });
  assert.deepEqual(gcp.workersRun, []);
  assert.equal((await load(slug)).assignments[0]!.state, 'queued');
  assert.equal(fs.existsSync(path.join(home, 'placed-action.out')), false);

  process.env.WEAVER_RUNNER_ID = 'mac-runner';
  process.env.WEAVER_RUNNER_PLACEMENT_ONLY = '1';
  const { relPath, hash } = await writeArtifact(slug, 'queued-send.md', 'approved but not sent here');
  await arrive(slug, (doc) => {
    const deliverableId = 'del_engine_only_send';
    doc.deliverables.push({
      id: deliverableId,
      title: 'queued send',
      kind: 'communication_draft',
      path: relPath,
      contentHash: hash,
      createdAtVirtual: virtualNow().toISOString(),
    });
    doc.interactions.push({
      id: 'int_engine_only',
      kind: 'email_send',
      to: 'nobody@example.test',
      subject: 'must stay queued',
      deliverableId,
      pinnedHash: hash,
      status: 'approved',
      approvedBy: 'human',
      approvedAt: new Date().toISOString(),
      replies: [],
    });
    doc.assignments.push(
      {
        id: 'asg_unplaced_exact',
        objective: 'must remain for the general fleet',
        briefing: 'unplaced exact action',
        kind: 'action',
        exec: {
          cwd: home,
          run: 'printf wrong > unplaced-action.out',
          verify: 'test -f unplaced-action.out',
          approval: { by: 'human', at: new Date().toISOString() },
        },
        acceptanceCriteria: ['not run here'], dependsOn: [], state: 'queued', attempts: [],
        adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
      },
      {
        id: 'asg_placed_model_action',
        objective: 'model action must not launch',
        briefing: 'model-backed action',
        kind: 'action',
        runnerId: 'mac-runner',
        exec: {
          cwd: home,
          verify: 'false',
          approval: { by: 'human', at: new Date().toISOString() },
        },
        acceptanceCriteria: ['not run here'], dependsOn: [], state: 'queued', attempts: [],
        adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
      },
      ...(['asg_placed_work', 'asg_unplaced_work'] as const).map((id) => ({
        id,
        objective: 'model work must not launch',
        briefing: 'model-backed work',
        kind: 'work' as const,
        ...(id === 'asg_placed_work' ? { runnerId: 'mac-runner' } : {}),
        acceptanceCriteria: ['not run here'], dependsOn: [], state: 'queued' as const, attempts: [],
        adoption: { state: 'none' as const }, createdAtVirtual: virtualNow().toISOString(),
      })),
    );
  });

  const report = await tick(slug, { engineOnly: true });
  assert.deepEqual(report.workersRun, []);
  assert.equal(report.passes.length, 0);
  assert.equal(report.sendsExecuted, 0);
  assert.equal(report.unknownsResolved, 0);
  assert.equal(fs.readFileSync(path.join(home, 'placed-action.out'), 'utf8'), 'done');
  assert.equal(fs.existsSync(path.join(home, 'unplaced-action.out')), false);
  const doc = await load(slug);
  const exact = doc.assignments.find((assignment) => assignment.id === 'asg_mac_exact')!;
  assert.equal(exact.state, 'awaiting_review');
  assert.equal(exact.attempts.length, 1);
  assert.equal(exact.attempts[0]!.runnerId, 'mac-runner');
  assert.equal(exact.exec!.verified!.ok, true);
  for (const id of ['asg_unplaced_exact', 'asg_placed_model_action', 'asg_placed_work', 'asg_unplaced_work']) {
    const untouched = doc.assignments.find((assignment) => assignment.id === id)!;
    assert.equal(untouched.state, 'queued', id);
    assert.equal(untouched.attempts.length, 0, id);
  }
  assert.equal(doc.interactions[0]!.status, 'approved');
  assert.equal(fs.existsSync(outboxDir(slug)), false);

  await tick(slug, { engineOnly: true });
  assert.equal((await load(slug)).assignments.find((assignment) => assignment.id === 'asg_mac_exact')!.attempts.length, 1);
});

test('engine-only tick fails closed outside explicit placement-only runner config', async () => {
  await createWorkstream({
    slug: 'engine-only-config', title: 'config', objective: 'config', tags: [],
    successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
  await assert.rejects(tick('engine-only-config', { engineOnly: true }), /requires WEAVER_RUNNER_PLACEMENT_ONLY=1/);
  process.env.WEAVER_RUNNER_ID = 'mac-runner';
  process.env.WEAVER_RUNNER_PLACEMENT_ONLY = '1';
  await assert.rejects(
    tick('engine-only-config', { maxPasses: 0 }),
    /requires `weaver tick <slug> --engine-only`/,
  );
});

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

test('an always-execute observational action runs once even when its verifier already passes', async () => {
  await makeActionWorkstream('engine-observation-ws', {
    state: 'queued',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'printf "fresh-observation-from-run\\n"',
      // This proves only that the observation source is readable. It already
      // passes before the command and therefore cannot be a postcondition.
      verify: 'true',
      preflightMode: 'always-execute',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });

  const first = await tick('engine-observation-ws', { maxPasses: 0 });
  const second = await tick('engine-observation-ws', { maxPasses: 0 });
  assert.deepEqual(first.workersRun, []);
  assert.deepEqual(second.workersRun, []);
  const doc = await load('engine-observation-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.state, 'awaiting_review');
  assert.equal(asg.attempts.length, 1, 'always-execute retains the ordinary one-shot claim');
  assert.equal(asg.attempts[0]!.terminalReason, 'executed');
  assert.equal(asg.exec!.verified!.ok, true, 'the same post-execution readback remains mandatory');
  const record = doc.deliverables.find((deliverable) => deliverable.kind === 'execution_record');
  assert.ok(record, 'the command stdout must survive as an inspectable execution record');
  assert.match(await readArtifact('engine-observation-ws', record.path), /fresh-observation-from-run/);
});

test('the default postcondition mode still skips a deterministic action whose verifier already passes', async () => {
  const marker = path.join(process.env.WEAVER_HOME!, 'default-preflight-command-ran');
  await makeActionWorkstream('engine-default-preflight-ws', {
    state: 'queued',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`,
      verify: 'true',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });

  await tick('engine-default-preflight-ws', { maxPasses: 0 });
  const doc = await load('engine-default-preflight-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.state, 'awaiting_review');
  assert.equal(asg.attempts.length, 0, 'legacy/absent mode remains a no-execution postcondition check');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(doc.deliverables.filter((deliverable) => deliverable.kind === 'execution_record').length, 0);
  assert.ok(doc.events.some((event) => event.type === 'action.already_satisfied'));
});

test('an engine action with an uncreatable cwd settles once and never escapes or reruns', async () => {
  const blocker = path.join(process.env.WEAVER_HOME!, 'cwd-blocker');
  const cwd = path.join(blocker, 'cannot-be-a-directory');
  const marker = path.join(process.env.WEAVER_HOME!, 'command-ran');
  fs.writeFileSync(blocker, 'regular file');
  await makeActionWorkstream('engine-cwd-fail-ws', {
    state: 'queued',
    exec: {
      cwd,
      run: `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'`,
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });

  const first = await tick('engine-cwd-fail-ws', { maxPasses: 0 });
  const second = await tick('engine-cwd-fail-ws', { maxPasses: 0 });
  assert.deepEqual(first.workersRun, []);
  assert.deepEqual(second.workersRun, []);

  const doc = await load('engine-cwd-fail-ws');
  const action = doc.assignments[0]!;
  assert.equal(action.state, 'awaiting_review');
  assert.equal(action.attempts.length, 1, 'a claimed action is one-shot even when cwd preparation fails');
  assert.equal(action.attempts[0]!.terminalReason, 'command_failed');
  assert.ok(action.attempts[0]!.endedAt);
  assert.equal(action.exec!.verified!.ok, false, 'ordinary declared readback still runs');
  assert.equal(fs.existsSync(marker), false, 'the command was never spawned');
  assert.equal(doc.deliverables.filter((d) => d.kind === 'execution_record').length, 1);
  assert.match(
    await readArtifact('engine-cwd-fail-ws', doc.deliverables.find((d) => d.kind === 'execution_record')!.path),
    /ENOTDIR|not a directory/i,
  );
});

test('a read-only GitHub engine action receives read scope for gh and Git fetch', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-read-engine-'));
  const fixedNow = Date.parse('2026-08-26T12:00:00.000Z');
  const requests: Array<{ contents: string; repository: string[] }> = [];
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/repo.git'], { cwd });
  setExecutorSecret('WEAVER_GITHUB_APP_ID', '12345');
  setExecutorSecret('WEAVER_GITHUB_APP_INSTALLATION_ID', '67890');
  setExecutorSecret(
    'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64',
    Buffer.from(githubTestPrivateKey).toString('base64'),
  );
  __setGitHubAppTestDependencies({
    now: () => fixedNow,
    fetch: (async (_input, init = {}) => {
      const body = JSON.parse(String(init.body)) as {
        permissions: { contents: string };
        repositories: string[];
      };
      requests.push({ contents: body.permissions.contents, repository: body.repositories });
      return Response.json({
        token: 'read-installation-token',
        expires_at: new Date(fixedNow + 60 * 60_000).toISOString(),
        repositories: [{ full_name: 'octo/repo' }],
      }, { status: 201 });
    }) as typeof globalThis.fetch,
  });

  await makeActionWorkstream('github-read-engine-scope-ws', {
    state: 'queued',
    exec: {
      cwd,
      run: 'if false; then gh api repos/octo/repo; git fetch origin; fi; test "$GH_TOKEN" = read-installation-token && touch effect.txt',
      verify: 'test "$GH_TOKEN" = read-installation-token && test -f effect.txt',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });
  try {
    await tick('github-read-engine-scope-ws', { maxPasses: 0 });
    const action = (await load('github-read-engine-scope-ws')).assignments[0]!;
    assert.equal(action.state, 'awaiting_review');
    assert.equal(action.attempts.length, 1);
    assert.equal(action.exec!.verified!.ok, true);
    assert.deepEqual(requests, [{ contents: 'read', repository: ['repo'] }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a GitHub read action with a non-repository cwd settles before claim exactly once', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-invalid-cwd-'));
  const marker = path.join(process.env.WEAVER_HOME!, 'must-not-run');
  setExecutorSecret('WEAVER_GITHUB_APP_ID', '12345');
  setExecutorSecret('WEAVER_GITHUB_APP_INSTALLATION_ID', '67890');
  setExecutorSecret(
    'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64',
    Buffer.from(githubTestPrivateKey).toString('base64'),
  );
  __setGitHubAppTestDependencies({
    fetch: (async () => {
      throw new Error('token mint must not happen without an exact repository');
    }) as typeof globalThis.fetch,
  });
  await makeActionWorkstream('github-invalid-cwd-ws', {
    state: 'queued',
    exec: {
      cwd,
      run: `if false; then gh api repos/octo/repo; fi; touch ${JSON.stringify(marker)}`,
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });

  const persisted = (await load('github-invalid-cwd-ws')).assignments[0]!;
  const writeProbe = structuredClone(persisted);
  writeProbe.exec!.run = 'gh pr create --fill';
  assert.equal(
    await guardRepoEgress('github-invalid-cwd-ws', writeProbe),
    true,
    'the deconfliction gate abstains so preflight can durably settle the cwd failure',
  );

  await tick('github-invalid-cwd-ws', { maxPasses: 0 });
  await tick('github-invalid-cwd-ws', { maxPasses: 0 });
  const doc = await load('github-invalid-cwd-ws');
  const action = doc.assignments[0]!;
  assert.equal(action.state, 'failed');
  assert.equal(action.attempts.length, 0, 'failure before claim is known to have zero external attempts');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(doc.deliverables.length, 0);
  assert.equal(doc.attention.length, 0, 'configuration repair belongs to the coordinator, not Needs You');
  assert.equal(doc.events.filter((event) => event.type === 'action.preparation_failed').length, 1);
  const wakes = doc.wakes.filter((wake) => wake.reason.includes('failed before the one-shot claim'));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.condition.type, 'immediate');
  assert.equal(wakes[0]!.status, 'pending');
});

test('a transient GitHub mint failure cannot be mislabeled as a durable zero-effect preparation failure', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-transient-'));
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/repo.git'], { cwd });
  setExecutorSecret('WEAVER_GITHUB_APP_ID', '12345');
  setExecutorSecret('WEAVER_GITHUB_APP_INSTALLATION_ID', '67890');
  setExecutorSecret(
    'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64',
    Buffer.from(githubTestPrivateKey).toString('base64'),
  );
  __setGitHubAppTestDependencies({
    fetch: (async () => {
      throw new Error('transient provider outage');
    }) as typeof globalThis.fetch,
  });
  await makeActionWorkstream('github-transient-mint-ws', {
    state: 'queued',
    exec: {
      cwd,
      run: 'gh api repos/octo/repo',
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });

  try {
    await assert.rejects(
      tick('github-transient-mint-ws', { maxPasses: 0 }),
      /GitHub App token request could not reach GitHub/,
    );
    const doc = await load('github-transient-mint-ws');
    const action = doc.assignments[0]!;
    assert.equal(action.state, 'queued');
    assert.equal(action.attempts.length, 0);
    assert.equal(doc.events.some((event) => event.type === 'action.preparation_failed'), false);
    assert.equal(doc.wakes.length, 0);
    assert.equal(doc.attention.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a model-backed action uses the same typed pre-claim GitHub failure settlement', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-worker-invalid-'));
  setExecutorSecret('WEAVER_GITHUB_APP_ID', '12345');
  setExecutorSecret('WEAVER_GITHUB_APP_INSTALLATION_ID', '67890');
  setExecutorSecret(
    'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64',
    Buffer.from(githubTestPrivateKey).toString('base64'),
  );
  await makeActionWorkstream('github-worker-invalid-cwd-ws', {
    state: 'queued',
    exec: {
      cwd,
      verify: 'gh pr list --head fix/example --json url',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });

  await tick('github-worker-invalid-cwd-ws', { maxPasses: 0 });
  const doc = await load('github-worker-invalid-cwd-ws');
  assert.equal(doc.assignments[0]!.state, 'failed');
  assert.equal(doc.assignments[0]!.attempts.length, 0);
  assert.equal(doc.events.filter((event) => event.type === 'action.preparation_failed').length, 1);
  assert.deepEqual(doc.attention, []);
});

test('a repo engine action gets write scope only for execution and read scope for checks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-engine-'));
  const fixedNow = Date.parse('2026-08-26T12:00:00.000Z');
  const requests: Array<{ access: 'read' | 'write'; repository: string[] }> = [];
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/repo.git'], { cwd });
  setExecutorSecret('WEAVER_GITHUB_APP_ID', '12345');
  setExecutorSecret('WEAVER_GITHUB_APP_INSTALLATION_ID', '67890');
  setExecutorSecret(
    'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64',
    Buffer.from(githubTestPrivateKey).toString('base64'),
  );
  __setGitHubAppTestDependencies({
    now: () => fixedNow,
    fetch: (async (_input, init = {}) => {
      const body = JSON.parse(String(init.body)) as {
        permissions: { contents: string };
        repositories: string[];
      };
      const access = body.permissions.contents === 'write' ? 'write' : 'read';
      requests.push({ access, repository: body.repositories });
      return Response.json({
        token: `${access}-installation-token`,
        expires_at: new Date(fixedNow + 60 * 60_000).toISOString(),
        repositories: [{ full_name: 'octo/repo' }],
      }, { status: 201 });
    }) as typeof globalThis.fetch,
  });

  await makeActionWorkstream('github-engine-scope-ws', {
    state: 'queued',
    exec: {
      cwd,
      run: 'if false; then gh pr merge 1; fi; test "$GH_TOKEN" = write-installation-token && touch effect.txt',
      verify: 'test "$GH_TOKEN" = read-installation-token && test -f effect.txt',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });
  try {
    const report = await tick('github-engine-scope-ws', { maxPasses: 0 });
    assert.deepEqual(report.workersRun, []);
    const action = (await load('github-engine-scope-ws')).assignments[0]!;
    assert.equal(action.state, 'awaiting_review');
    assert.equal(action.exec!.verified!.ok, true);
    assert.deepEqual(requests, [
      { access: 'read', repository: ['repo'] },
      { access: 'write', repository: ['repo'] },
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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

test('foreign runner work and actions remain untouched even beyond the stale threshold', async () => {
  process.env.WEAVER_RUNNER_ID = 'gcp-runner';
  process.env.WEAVER_ATTEMPT_STALE_MS = '1';
  await createWorkstream({
    slug: 'foreign-runner-pid', title: 'Foreign runner pid', objective: 'do not invent an orphan',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
  const staleStartedAt = new Date(Date.now() - 60_000).toISOString();
  await arrive('foreign-runner-pid', (doc) => doc.assignments.push(
    {
      id: 'asg_foreign_work', objective: 'Mac-local live work', briefing: 'n/a', kind: 'work',
      runnerId: 'mac-runner', acceptanceCriteria: [], dependsOn: [], state: 'running',
      attempts: [{
        runId: 'run_foreign_work', runnerId: 'mac-runner', runnerPid: 999999999,
        startedAt: staleStartedAt,
      }],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    },
    {
      id: 'asg_foreign_action', objective: 'Mac-local live action', briefing: 'n/a', kind: 'action',
      runnerId: 'mac-runner', acceptanceCriteria: [], dependsOn: [], state: 'running',
      exec: {
        cwd: process.env.WEAVER_HOME!, verify: 'false',
        approval: { by: 'human', at: new Date().toISOString() },
      },
      attempts: [{
        runId: 'run_foreign_action', runnerId: 'mac-runner', runnerPid: 999999999,
        startedAt: staleStartedAt,
      }],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    },
  ));
  try {
    await tick('foreign-runner-pid', { maxPasses: 0 });
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }
  const doc = await load('foreign-runner-pid');
  for (const assignment of doc.assignments) {
    assert.equal(assignment.state, 'running', assignment.id);
    assert.equal(assignment.attempts[0]!.endedAt, undefined, assignment.id);
    assert.equal(assignment.attempts[0]!.terminalReason, undefined, assignment.id);
  }
  assert.equal(doc.events.some((event) => event.type === 'worker.crash_recovered'), false);
});

// ---------------------------------------------------------------------------
// Pilot-gated auto-approval: the operator's daemon can clear routine actions.

import * as http from 'node:http';

async function withPilotStub(
  decide: (cmd: string) => string,
  fn: (requests: string[], authorizations: Array<string | undefined>) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      authorizations.push(req.headers.authorization);
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
    await fn(requests, authorizations);
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
  await withPilotStub(() => 'approve', async (requests, authorizations) => {
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
    assert.deepEqual(authorizations, [undefined], 'tokenless loopback Pilot remains compatible');
  });
});

test('engine Pilot evaluations carry the registered bearer without persisting it', async () => {
  const token = 'pilot-engine-bearer-value-4829';
  setExecutorSecret('WEAVER_PILOT_TOKEN', token);
  await withPilotStub(() => 'approve', async (_requests, authorizations) => {
    await makeActionWorkstream('pilot-auth-engine-ws', {
      exec: {
        cwd: process.env.WEAVER_HOME!,
        run: 'true',
        verify: 'true',
      },
    });
    await tick('pilot-auth-engine-ws', { maxPasses: 0 });
    assert.deepEqual(authorizations, [
      `Bearer ${token}`,
      `Bearer ${token}`,
    ]);

    const durable = fs.readFileSync(
      path.join(process.env.WEAVER_HOME!, 'pilot-auth-engine-ws', 'workstream.json'),
      'utf8',
    );
    assert.doesNotMatch(durable, new RegExp(token));
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
      dependsOn: ['asg_hold'],
    });
    await arrive('pilot-down-ws', (d) => {
      d.assignments.push({
        id: 'asg_hold', objective: 'hold', briefing: 'n/a', kind: 'work',
        acceptanceCriteria: ['n/a'], dependsOn: [], state: 'awaiting_review',
        attempts: [], adoption: { state: 'proposed' }, createdAtVirtual: virtualNow().toISOString(),
      });
    });
    await tick('pilot-down-ws', { maxPasses: 0 });
    const asg = (await load('pilot-down-ws')).assignments[0]!;
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.pilotVerdict, undefined);
    assert.ok(asg.exec!.pilotUnavailableSince);
    assert.ok(asg.exec!.pilotRetryAt);
    assert.equal((await load('pilot-down-ws')).attention.length, 0, 'one transient failure is not a human task');

    await tick('pilot-down-ws', { maxPasses: 0 });
    assert.equal((await load('pilot-down-ws')).attention.filter((a) => a.refId === 'asg_act' && a.status === 'open').length, 0, 'a shared dependency outage never becomes one human card per action');
  } finally {
    delete process.env.WEAVER_PILOT_URL;
  }

  await arrive('pilot-down-ws', (d) => {
    const action = d.assignments.find((assignment) => assignment.id === 'asg_act')!;
    action.exec!.pilotRetryAt = new Date(Date.now() - 1).toISOString();
  });

  await withPilotStub(() => 'approve', async () => {
    await tick('pilot-down-ws', { maxPasses: 0 });
    const recovered = (await load('pilot-down-ws')).assignments.find((assignment) => assignment.id === 'asg_act')!;
    assert.equal(recovered.state, 'queued');
    assert.equal(recovered.exec!.approval!.by, 'pilot');
    assert.equal(recovered.exec!.pilotUnavailableSince, undefined);
    assert.equal(recovered.exec!.pilotRetryAt, undefined);
    assert.equal((await load('pilot-down-ws')).attention.filter((attention) => attention.refId === recovered.id && attention.status === 'open').length, 0);
  });
});

test('a recovered Pilot escalation replaces legacy outage noise with the actual deny reason', async () => {
  await makeActionWorkstream('pilot-outage-deny-ws', {
    ...GATED_WITH_CMDS,
    objective: 'Publish the release tag',
    exec: { ...GATED_WITH_CMDS.exec, cwd: process.env.WEAVER_HOME! },
    dependsOn: ['asg_hold'],
  });
  await arrive('pilot-outage-deny-ws', (doc) => {
    doc.assignments.push({
      id: 'asg_hold', objective: 'hold', briefing: 'n/a', kind: 'work',
      acceptanceCriteria: ['n/a'], dependsOn: [], state: 'awaiting_review',
      attempts: [], adoption: { state: 'proposed' }, createdAtVirtual: virtualNow().toISOString(),
    });
  });
  await tick('pilot-outage-deny-ws', { maxPasses: 0 });
  await arrive('pilot-outage-deny-ws', (doc) => {
    doc.assignments.find((assignment) => assignment.id === 'asg_act')!.exec!.pilotRetryAt =
      new Date(Date.now() - 1).toISOString();
    doc.attention.push({
      id: 'att_legacy_outage',
      kind: 'approval',
      refId: 'asg_act',
      summary: 'Pilot has been unavailable for two minutes; restart it or approve manually.',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });

  await withPilotStub(() => 'deny', async () => {
    await tick('pilot-outage-deny-ws', { maxPasses: 0 });
  });
  const doc = await load('pilot-outage-deny-ws');
  const action = doc.assignments.find((assignment) => assignment.id === 'asg_act')!;
  assert.equal(action.exec!.pilotVerdict?.decision, 'deny');
  assert.equal(action.exec!.pilotUnavailableSince, undefined);
  assert.equal(doc.attention.find((attention) => attention.id === 'att_legacy_outage')?.status, 'resolved');
  const open = doc.attention.filter((attention) => attention.refId === action.id && attention.status === 'open');
  assert.equal(open.length, 1);
  assert.match(open[0]!.summary, /Pilot denied this action: stub/);
  assert.doesNotMatch(open[0]!.summary, /unavailable|restart/i);
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
