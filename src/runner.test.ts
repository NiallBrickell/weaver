import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advanceClock, virtualNow } from './clock.js';
import { effectiveConcurrency, expediteBackoffWakes, infraBackoffSlugs, runLoop } from './runner.js';
import { arrive, createWorkstream, load } from './store.js';
import type { InfrastructureWait } from './types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-capacity-runner-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function make(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'test typed recovery',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

function wait(sourceId = 'pass_wait'): InfrastructureWait {
  return {
    kind: 'auth',
    recovery: 'reauthenticate',
    source: 'coordinator',
    sourceId,
    model: 'claude-fable-5',
    executor: 'local-sdk',
    provider: 'anthropic',
    detectedAt: virtualNow().toISOString(),
    retryAt: new Date(virtualNow().getTime() + 60_000).toISOString(),
  };
}

function setCapacity(d: Awaited<ReturnType<typeof load>>, waits: InfrastructureWait[]): void {
  d.capacity = {
    state: 'backoff',
    byModel: Object.fromEntries(waits.map((infrastructure) => [
      infrastructure.model,
      {
        wait: infrastructure,
        consecutiveBackoffs: 1,
        firstBackoffAtVirtual: infrastructure.detectedAt,
        lastBackoffAtVirtual: infrastructure.detectedAt,
      },
    ])),
  };
}

test('runner discovers only pending typed infrastructure waits, never magic prose', async () => {
  await make('typed');
  await make('prose');
  await make('paused');
  await arrive('typed', (d) => {
    const infrastructure = wait();
    d.wakes.push({
      id: 'wake_typed', reason: 'wording may change', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    setCapacity(d, [infrastructure]);
  });
  await arrive('prose', (d) => d.wakes.push({
    id: 'wake_prose', reason: 'retry after infrastructure failure', condition: { type: 'time', dueAtVirtual: wait().retryAt },
    status: 'pending', createdAt: new Date().toISOString(),
  }));
  await arrive('paused', (d) => {
    const infrastructure = wait();
    d.workstream.status = 'paused';
    d.wakes.push({
      id: 'wake_paused', reason: 'typed but paused', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    setCapacity(d, [infrastructure]);
  });
  assert.deepEqual(await infraBackoffSlugs(), ['typed']);
});

test('Claude credential changes never probe a non-Claude executor wait', async () => {
  await make('kimi-wait');
  const infrastructure: InfrastructureWait = {
    ...wait('run_kimi'),
    source: 'worker',
    model: 'openrouter/moonshotai/kimi-k3',
    executor: 'openhands',
    provider: 'openrouter',
  };
  await arrive('kimi-wait', (d) => setCapacity(d, [infrastructure]));
  assert.deepEqual(await infraBackoffSlugs(), []);
});

test('successful probe expedition uses virtual time and unblocks worker attempts', async () => {
  await make('expedite');
  advanceClock('5d');
  const infrastructure = wait('run_wait');
  await arrive('expedite', (d) => {
    d.wakes.push({
      id: 'wake_wait', reason: 'opaque', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    d.attention.push({
      id: 'att_auth', kind: 'blocker', summary: 'Claude authentication needs attention', refId: 'wake_wait',
      status: 'open', createdAt: new Date().toISOString(),
    });
    d.assignments.push({
      id: 'asg_wait', objective: 'resume', briefing: 'n/a', kind: 'work', acceptanceCriteria: ['n/a'],
      dependsOn: [], state: 'queued', attempts: [{ runId: 'run_wait', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), infrastructure }],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    });
    setCapacity(d, [infrastructure]);
  });

  await expediteBackoffWakes(['expedite'], () => {});
  const doc = await load('expedite');
  const wake = doc.wakes[0]!;
  assert.equal(wake.condition.type, 'time');
  assert.ok(wake.condition.type === 'time' && wake.condition.dueAtVirtual <= virtualNow().toISOString());
  assert.equal(doc.assignments[0]!.attempts[0]!.infrastructure!.retryAt, wake.condition.type === 'time' ? wake.condition.dueAtVirtual : '');
  assert.equal(doc.attention[0]!.status, 'resolved');
  assert.equal(doc.capacity, null);
});

test('a model probe expedites only waits for the model that actually recovered', async () => {
  await make('models');
  const fable = wait('pass_fable');
  const sonnet = { ...wait('run_sonnet'), source: 'worker' as const, model: 'sonnet' };
  await arrive('models', (d) => {
    d.wakes.push(
      {
        id: 'wake_fable', reason: 'fable', condition: { type: 'time', dueAtVirtual: fable.retryAt },
        status: 'pending', createdAt: new Date().toISOString(), infrastructure: fable,
      },
      {
        id: 'wake_sonnet', reason: 'sonnet', condition: { type: 'time', dueAtVirtual: sonnet.retryAt },
        status: 'pending', createdAt: new Date().toISOString(), infrastructure: sonnet,
      },
    );
    setCapacity(d, [fable, sonnet]);
  });

  await expediteBackoffWakes(['models'], () => {}, 'claude-fable-5');
  const [fableWake, sonnetWake] = (await load('models')).wakes;
  assert.ok(fableWake!.condition.type === 'time' && fableWake!.condition.dueAtVirtual <= virtualNow().toISOString());
  assert.equal(sonnetWake!.condition.type === 'time' ? sonnetWake!.condition.dueAtVirtual : '', sonnet.retryAt);
  assert.equal((await load('models')).capacity!.byModel.sonnet!.wait.model, 'sonnet');
});

test('an embedded runner whose owner aborts returns instead of pinning the process', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.doesNotReject(
    runLoop({ intervalMs: 30_000, concurrency: 1, signal: abort.signal }),
  );
});

test('a stale lock left by a heartbeating dead runner is reclaimed, not wedged', async () => {
  const { spawnSync } = await import('node:child_process');
  const { acquireRunnerLock, liveRunnerPid } = await import('./runner.js');
  const lock = path.join(home, '.runner.lock');
  fs.mkdirSync(lock, { recursive: true });
  // The exact wedge from production: a legacy pid-file owner that died, plus
  // the heartbeat old runners wrote inside the lock dir. Two files made the
  // snapshot malformed, so the dead owner was never reclaimed.
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  fs.writeFileSync(path.join(lock, 'pid'), String(dead));
  fs.writeFileSync(path.join(lock, 'heartbeat'), String(Date.now()));

  assert.equal(liveRunnerPid(), null);
  const release = acquireRunnerLock();
  assert.notEqual(release, null, 'the dead runner lock must be reclaimable');
  release!();
});

test('a standby dashboard promotes to runner only once the held lock is freed', async () => {
  const { acquireRunnerLock, promoteOnRunnerVacancy } = await import('./runner.js');
  // A live runner holds the lock; the standby dashboard is a pure viewer.
  const held = acquireRunnerLock();
  assert.notEqual(held, null, 'first acquirer must win the free lock');

  let promoted: (() => void) | null = null;
  const stop = promoteOnRunnerVacancy((release) => { promoted = release; }, 5);
  try {
    // While the lock is held, the standby keeps failing to acquire.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(promoted, null, 'a viewer must not promote while a runner holds the lock');

    // The runner dies / exits and frees the lock — the standby takes over.
    held!();
    await new Promise((r) => setTimeout(r, 40));
    assert.notEqual(promoted, null, 'the standby must promote once the lock is free');
  } finally {
    stop();
    (promoted as (() => void) | null)?.();
  }
});

test('the loop heartbeat lives beside the lock dir, never inside it', async () => {
  const { runLoop } = await import('./runner.js');
  const abort = new AbortController();
  const loop = runLoop({ intervalMs: 10, concurrency: 1, signal: abort.signal, log: () => {}, logError: () => {} });
  await new Promise((r) => setTimeout(r, 60));
  abort.abort();
  await loop;
  assert.ok(fs.existsSync(path.join(home, '.runner.heartbeat')));
  assert.ok(!fs.existsSync(path.join(home, '.runner.lock', 'heartbeat')));
});

test('load-aware concurrency runs full width with headroom and throttles toward 1 when oversubscribed', () => {
  // At or below core capacity: the configured width, untouched.
  assert.equal(effectiveConcurrency(10, 7, 14), 10, 'half-loaded box keeps full width');
  assert.equal(effectiveConcurrency(10, 14, 14), 10, 'a box at exactly capacity is not throttled');
  // Oversubscribed: scale down inversely with the overload ratio.
  assert.equal(effectiveConcurrency(10, 28, 14), 5, '2x oversubscribed halves the slots');
  assert.equal(effectiveConcurrency(10, 127, 14), 1, 'a thrashing box (9x) drops to a single slot');
  // Never below 1 — the fleet must always make some progress — and never above
  // the configured cap, whatever the sampler reports.
  assert.equal(effectiveConcurrency(10, 1_000_000, 14), 1, 'extreme overload still leaves one slot');
  assert.equal(effectiveConcurrency(4, 1, 14), 4, 'a low load never inflates past the configured cap');
  // Degenerate samples never throttle (fail open, not closed).
  assert.equal(effectiveConcurrency(10, 0, 14), 10, 'a zero/absent load reading is not a throttle signal');
  assert.equal(effectiveConcurrency(10, Number.NaN, 14), 10, 'an unreadable load average fails open');
  assert.equal(effectiveConcurrency(10, 50, 0), 10, 'an unknown core count fails open');
});

test('the poll loop throttles its slot cap when the injected load sampler reports oversubscription', async () => {
  const { runLoop } = await import('./runner.js');
  const lines: string[] = [];
  const abort = new AbortController();
  const loop = runLoop({
    intervalMs: 10,
    concurrency: 10,
    signal: abort.signal,
    log: (l) => lines.push(l),
    logError: () => {},
    loadSample: () => ({ load1: 140, cores: 14 }),
  });
  await new Promise((r) => setTimeout(r, 60));
  abort.abort();
  await loop;
  assert.ok(
    lines.some((l) => /throttling parallel ticks 10→1\b/.test(l)),
    `expected a throttle line, got: ${JSON.stringify(lines)}`,
  );
});
