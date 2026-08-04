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

import { tick, verifyAction } from './engine.js';
import { arrive, createWorkstream, load, newId, writeArtifact } from './store.js';
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

function makeApprovedSend(opts: { driftPin?: boolean } = {}): string {
  createWorkstream({
    slug: SLUG,
    title: 'Send test',
    objective: 'test sends',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const { relPath, hash } = writeArtifact(SLUG, 'email.md', 'To: x\nSubject: y\nBody: hello');
  const intId = newId('int');
  arrive(SLUG, (d) => {
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
});

afterEach(() => {
  delete process.env.WEAVER_SEND_UNKNOWN;
});

test('an approved send executes once and records the provider ref', async () => {
  const intId = makeApprovedSend();
  const report = await tick(SLUG, { maxPasses: 0 });
  assert.equal(report.sendsExecuted, 1);
  const int = load(SLUG).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'sent');
  assert.equal(int.externalRef, `prov_${intId}`);
  assert.equal(fs.readdirSync(outboxDir(SLUG)).length, 1);
});

test('crash after egress leaves UNKNOWN; readback confirms; the provider has exactly one record', async () => {
  const intId = makeApprovedSend();

  process.env.WEAVER_SEND_UNKNOWN = '1';
  // First cycle sends (provider records it, then "crash"); a later cycle in the
  // same tick resolves the unknown by READBACK — even with chaos still on,
  // because readback never sends.
  await tick(SLUG, { maxPasses: 0 });
  const int = load(SLUG).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'confirmed');
  assert.equal(int.externalRef, `prov_${intId}`);

  // The load-bearing assertion: exactly ONE provider record, ever.
  assert.equal(fs.readdirSync(outboxDir(SLUG)).length, 1);

  // And the event trail shows the unknown → readback path, not a resend.
  const types = load(SLUG).events.map((e) => e.type);
  assert.ok(types.includes('send.unknown'));
  assert.ok(types.includes('send.confirmed'));
});

test('a send whose pinned content drifted is refused at egress, not sent', async () => {
  const intId = makeApprovedSend({ driftPin: true });
  await tick(SLUG, { maxPasses: 0 });
  const int = load(SLUG).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'rejected');
  assert.equal(fs.existsSync(outboxDir(SLUG)), false);
});

test('a stale running attempt is recovered: crash recorded, assignment re-queued', async () => {
  createWorkstream({
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
  arrive('crash-ws', (d) => {
    d.assignments.push(
      {
        id: 'asg_dep',
        objective: 'unfinished dependency',
        briefing: 'n/a',
        kind: 'research',
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
        kind: 'research',
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

  const asg = load('crash-ws').assignments.find((a) => a.id === 'asg_orphan')!;
  assert.equal(asg.state, 'queued');
  const attempt = asg.attempts[0]!;
  assert.equal(attempt.terminalReason, 'crashed');
  assert.ok(attempt.endedAt);
});

// ---------------------------------------------------------------------------
// Action assignments: gated until approval, confirmed only by readback.

function makeActionWorkstream(slug: string, action: Partial<Assignment>): void {
  createWorkstream({
    slug,
    title: 'Action test',
    objective: 'test actions',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  arrive(slug, (d) => {
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
  makeActionWorkstream('gated-ws', {});
  const report = await tick('gated-ws', { maxPasses: 0 });
  assert.deepEqual(report.workersRun, []);
  assert.equal(load('gated-ws').assignments[0]!.state, 'gated');
});

test('readback records CONFIRMED on exit 0 and FAILED (with output) otherwise', () => {
  makeActionWorkstream('verify-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'echo effect-present' },
  });
  assert.equal(verifyAction('verify-ws', 'asg_act'), true);
  let asg = load('verify-ws').assignments[0]!;
  assert.equal(asg.exec!.verified!.ok, true);
  assert.match(asg.exec!.verified!.output, /effect-present/);

  makeActionWorkstream('verify-fail-ws', {
    exec: { cwd: process.env.WEAVER_HOME!, verify: 'echo no-effect >&2; false' },
  });
  assert.equal(verifyAction('verify-fail-ws', 'asg_act'), false);
  asg = load('verify-fail-ws').assignments[0]!;
  assert.equal(asg.exec!.verified!.ok, false);
  assert.match(asg.exec!.verified!.output, /no-effect/);
  const types = load('verify-fail-ws').events.map((e) => e.type);
  assert.ok(types.includes('action.verify_failed'));
});

test('crashed action, effect LANDED: never re-run — submitted for review on readback evidence', async () => {
  makeActionWorkstream('action-crash-ws', {
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

  const doc = load('action-crash-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.attempts[0]!.terminalReason, 'crashed');
  assert.equal(asg.exec!.verified!.ok, true); // readback discovered the effect landed
  assert.equal(asg.state, 'awaiting_review'); // machine-decidable: nothing to redo, review it
  assert.ok(!doc.attention.some((a) => a.refId === 'asg_act' && a.status === 'open'));
});

test('crashed action, effect ABSENT: the approved idempotent act is re-queued, bounded; exhaustion escalates', async () => {
  makeActionWorkstream('action-requeue-ws', {
    state: 'running',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    attempts: [{ runId: 'run_dead', startedAt: new Date(Date.now() - 60_000).toISOString() }],
  });
  process.env.WEAVER_ATTEMPT_STALE_MS = '1000';
  try {
    await tick('action-requeue-ws', { maxPasses: 0 });
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }
  let doc = load('action-requeue-ws');
  // Approval attaches to the ACT: no human attention, straight back in line.
  // (The same tick may already have launched a fresh attempt — queued or
  // running are both "re-queued" from the human's point of view.)
  assert.ok(['queued', 'running', 'failed'].includes(doc.assignments[0]!.state));
  assert.ok(!doc.attention.some((a) => a.kind === 'blocker' && a.status === 'open' && a.summary.includes('judgment')));

  // Exhaustion: with MAX attempts already burned, escalate instead of looping.
  makeActionWorkstream('action-exhausted-ws', {
    state: 'running',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'false',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    attempts: [
      { runId: 'run_a', startedAt: new Date(Date.now() - 300_000).toISOString(), endedAt: new Date().toISOString(), terminalReason: 'crashed' },
      { runId: 'run_b', startedAt: new Date(Date.now() - 200_000).toISOString(), endedAt: new Date().toISOString(), terminalReason: 'crashed' },
      { runId: 'run_dead', startedAt: new Date(Date.now() - 60_000).toISOString() },
    ],
  });
  process.env.WEAVER_ATTEMPT_STALE_MS = '1000';
  try {
    await tick('action-exhausted-ws', { maxPasses: 0 });
  } finally {
    delete process.env.WEAVER_ATTEMPT_STALE_MS;
  }
  doc = load('action-exhausted-ws');
  assert.equal(doc.assignments[0]!.state, 'failed');
  assert.ok(doc.attention.some((a) => a.refId === 'asg_act' && a.status === 'open'));
});

test('a human-authored exec.run action is executed by the ENGINE (no worker) and judged by readback', async () => {
  makeActionWorkstream('engine-act-ws', {
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
  const doc = load('engine-act-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.state, 'awaiting_review');
  assert.equal(asg.attempts[0]!.model, 'engine');
  assert.equal(asg.attempts[0]!.terminalReason, 'executed');
  assert.equal(asg.exec!.verified!.ok, true);
  assert.ok(doc.deliverables.some((d) => d.kind === 'execution_record'));
});

test('an exec.run action without approval is not executed', async () => {
  makeActionWorkstream('engine-gated-ws', {
    state: 'gated',
    exec: { cwd: process.env.WEAVER_HOME!, run: 'echo nope > leaked.txt', verify: 'true' },
  });
  await tick('engine-gated-ws', { maxPasses: 0 });
  assert.equal(load('engine-gated-ws').assignments[0]!.state, 'gated');
  assert.equal(fs.existsSync(path.join(process.env.WEAVER_HOME!, 'leaked.txt')), false);
});

test('human adoption cannot outrank readback: an action without a passing verify is refused', async () => {
  const { adoptSubmission } = await import('./humanActs.js');
  makeActionWorkstream('adopt-guard-ws', {
    state: 'awaiting_review',
    submission: { summary: 'I did the thing, trust me' },
  });
  await assert.rejects(async () => adoptSubmission('adopt-guard-ws', 'asg_act'), /readback has not run/);

  makeActionWorkstream('adopt-guard-fail-ws', {
    state: 'awaiting_review',
    submission: { summary: 'claimed success' },
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'false',
      verified: { ok: false, output: 'effect absent', at: new Date().toISOString() },
    },
  });
  await assert.rejects(async () => adoptSubmission('adopt-guard-fail-ws', 'asg_act'), /readback FAILED/);

  makeActionWorkstream('adopt-guard-ok-ws', {
    state: 'awaiting_review',
    submission: { summary: 'done' },
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'true',
      verified: { ok: true, output: 'effect present', at: new Date().toISOString() },
    },
  });
  adoptSubmission('adopt-guard-ok-ws', 'asg_act');
  assert.equal(load('adopt-guard-ok-ws').assignments[0]!.adoption.state, 'accepted');
});

test('a second process cannot tick a workstream mid-tick: live lock skips, dead lock is reclaimed', async () => {
  createWorkstream({
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
  createWorkstream({
    slug: 'fresh-ws',
    title: 'Fresh attempt',
    objective: 'no false recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  arrive('fresh-ws', (d) => {
    d.assignments.push({
      id: 'asg_live',
      objective: 'still genuinely running',
      briefing: 'n/a',
      kind: 'research',
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'running',
      attempts: [{ runId: 'run_live', startedAt: new Date().toISOString() }],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    });
  });
  await tick('fresh-ws', { maxPasses: 0 }); // default 10-minute staleness
  assert.equal(load('fresh-ws').assignments[0]!.state, 'running');
});
