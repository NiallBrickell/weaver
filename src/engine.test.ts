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

import { runnableAssignments, tick, verifyAction } from './engine.js';
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
  // Hermetic: never let tests reach a REAL pilot daemon on this machine —
  // an unreachable port means the gate fails closed (stays gated), which is
  // the baseline the non-pilot tests assume. Pilot tests stub their own URL.
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
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

test('a typed provider wait parks every model assignment until recovery without parsing prose', () => {
  createWorkstream({
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
  arrive('capacity-ws', (d) => {
    d.assignments.push(
      {
        id: 'asg_first', objective: 'first', briefing: 'n/a', kind: 'research', acceptanceCriteria: ['n/a'],
        dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
      },
      {
        id: 'asg_second', objective: 'second', briefing: 'n/a', kind: 'research', acceptanceCriteria: ['n/a'],
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
        kind: 'sdk_credit_exhausted',
        recovery: 'claim_sdk_credit_or_enable_usage_credits',
        source: 'worker',
        sourceId: 'run_capacity',
        model: 'sonnet',
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

  const doc = load('capacity-ws');
  assert.deepEqual(runnableAssignments(doc), []);
  doc.wakes[0]!.condition = { type: 'time', dueAtVirtual: virtualNow().toISOString() };
  doc.wakes[0]!.infrastructure!.retryAt = virtualNow().toISOString();
  doc.capacity!.byModel.sonnet!.wait.retryAt = virtualNow().toISOString();
  assert.deepEqual(runnableAssignments(doc), ['asg_first', 'asg_second']);
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
  // exec.run keeps the re-run on the ENGINE path — deterministic, no model.
  makeActionWorkstream('action-requeue-ws', {
    state: 'running',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'echo redo',
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
  // Approval attaches to the ACT: no human in the loop — the same tick
  // re-queued it and the engine already re-executed (attempt 2).
  assert.equal(doc.assignments[0]!.attempts.length, 2);
  assert.equal(doc.assignments[0]!.attempts[1]!.model, 'engine');
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

test('an attempt whose driver process is dead is recovered immediately, no horizon wait', async () => {
  createWorkstream({
    slug: 'deadpid-ws',
    title: 'Dead driver',
    objective: 'immediate orphan recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  arrive('deadpid-ws', (d) => {
    d.assignments.push(
      {
        id: 'asg_dep_open',
        objective: 'unfinished dependency keeps the orphan non-runnable',
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
        id: 'asg_orphaned',
        objective: 'driver died seconds ago',
        briefing: 'n/a',
        kind: 'research',
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
  const asg = load('deadpid-ws').assignments.find((a) => a.id === 'asg_orphaned')!;
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
    makeActionWorkstream('pilot-ok-ws', {
      ...GATED_WITH_CMDS,
      exec: { ...GATED_WITH_CMDS.exec, cwd: process.env.WEAVER_HOME! },
      dependsOn: ['asg_hold'],
    });
    arrive('pilot-ok-ws', (d) => {
      d.assignments.push({
        id: 'asg_hold', objective: 'hold', briefing: 'n/a', kind: 'research',
        acceptanceCriteria: ['n/a'], dependsOn: [], state: 'awaiting_review',
        attempts: [], adoption: { state: 'proposed' }, createdAtVirtual: virtualNow().toISOString(),
      });
    });
    await tick('pilot-ok-ws', { maxPasses: 0 });
    const asg = load('pilot-ok-ws').assignments.find((a) => a.id === 'asg_act')!;
    assert.equal(asg.state, 'queued');
    assert.equal(asg.exec!.approval!.by, 'pilot');
    assert.equal(requests.length, 0); // no plan pre-eval — supervision happens per tool call
  });
});

test('an ENGINE-RUN command pilot denies stays gated for the human, verdict cached (no re-ask)', async () => {
  await withPilotStub((cmd) => (cmd.includes('rm -rf') ? 'deny' : 'approve'), async (requests) => {
    makeActionWorkstream('pilot-deny-ws', {
      exec: {
        cwd: process.env.WEAVER_HOME!,
        run: 'rm -rf /something/important',
        verify: 'true',
      },
    });
    await tick('pilot-deny-ws', { maxPasses: 0 });
    const asg = load('pilot-deny-ws').assignments[0]!;
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
    makeActionWorkstream('pilot-down-ws', {
      ...GATED_WITH_CMDS,
      exec: { ...GATED_WITH_CMDS.exec, cwd: process.env.WEAVER_HOME! },
    });
    await tick('pilot-down-ws', { maxPasses: 0 });
    const asg = load('pilot-down-ws').assignments[0]!;
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.pilotVerdict, undefined);
  } finally {
    delete process.env.WEAVER_PILOT_URL;
  }
});

test('steering that answers an attention card resolves it in the same act', async () => {
  const { addSteering } = await import('./humanActs.js');
  createWorkstream({
    slug: 'answer-ws', title: 'Answer test', objective: 'steer-resolves-attention',
    tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  arrive('answer-ws', (d) => {
    d.attention.push({
      id: 'att_q', kind: 'blocker', summary: 'Which field shows the timezone?',
      status: 'open', createdAt: new Date().toISOString(),
    });
  });
  addSteering('answer-ws', 'It is the Preferred Callback Time field.', { resolvesAttentionId: 'att_q' });
  const doc = load('answer-ws');
  assert.equal(doc.attention.find((a) => a.id === 'att_q')!.status, 'resolved');
  assert.equal(doc.steering.length, 1);
  assert.ok(doc.wakes.some((w) => w.status === 'pending')); // coordinator still gets the answer
});
