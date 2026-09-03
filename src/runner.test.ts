import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advanceClock, virtualNow } from './clock.js';
import {
  effectiveConcurrency,
  expediteBackoffWakes,
  infraBackoffSlugs,
  pendingManagerNoticeKeys,
  RunnerDispatchTracker,
  runnerDispatchSignature,
  RunnerWorkstreamCache,
  runLoop,
} from './runner.js';
import { arrive, createWorkstream, listRunnerPresence, load } from './store.js';
import type { InfrastructureWait } from './types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-capacity-runner-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  delete process.env.WEAVER_RUNNER_ID;
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

test('runner cache reloads only changed heads and evicts deleted or unreadable documents', async () => {
  await make('alpha');
  await make('beta');
  const docs = new Map([
    ['alpha', await load('alpha')],
    ['beta', await load('beta')],
  ]);
  let heads = [...docs].map(([slug, doc]) => ({ slug, revision: doc.revision }));
  const loads: string[] = [];
  const unreadable = new Set<string>();
  const cache = new RunnerWorkstreamCache(
    async () => heads,
    async (slug) => {
      loads.push(slug);
      if (unreadable.has(slug)) throw new Error('simulated unreadable document');
      const doc = docs.get(slug);
      if (!doc) throw new Error('simulated deletion');
      return structuredClone(doc);
    },
  );

  assert.deepEqual([...await cache.scan()].map(([slug]) => slug), ['alpha', 'beta']);
  assert.deepEqual(loads, ['alpha', 'beta']);
  await cache.scan();
  assert.deepEqual(loads, ['alpha', 'beta'], 'unchanged heads must not retransmit their documents');

  const changed = structuredClone(docs.get('alpha')!);
  changed.revision++;
  changed.workstream.title = 'fresh alpha';
  docs.set('alpha', changed);
  heads = heads.map((head) => head.slug === 'alpha' ? { ...head, revision: changed.revision } : head);
  const afterChange = await cache.scan();
  assert.equal(afterChange.get('alpha')?.workstream.title, 'fresh alpha');
  assert.deepEqual(loads, ['alpha', 'beta', 'alpha'], 'only the changed revision is reloaded');

  heads = heads.filter((head) => head.slug !== 'beta');
  assert.deepEqual([...await cache.scan()].map(([slug]) => slug), ['alpha'], 'deleted heads are evicted');

  unreadable.add('alpha');
  heads = heads.map((head) => ({ ...head, revision: head.revision + 1 }));
  assert.deepEqual([...await cache.scan()], [], 'a failed changed read evicts the formerly cached body');
  assert.deepEqual(loads, ['alpha', 'beta', 'alpha', 'alpha']);
});

test('a later logical scan observes a revision changed after the preceding scan', async () => {
  await make('fresh-between-decisions');
  const cache = new RunnerWorkstreamCache();
  assert.deepEqual(await infraBackoffSlugs(cache), []);

  await arrive('fresh-between-decisions', (doc) => setCapacity(doc, [wait('pass_between_scans')]));
  assert.deepEqual(await infraBackoffSlugs(cache), ['fresh-between-decisions']);
});

test('unchanged quiescent workstreams dispatch once while revisions and due wakes retrigger', async () => {
  await make('dispatch-signature');
  const tracker = new RunnerDispatchTracker();
  const runner = { id: 'mac-primary', placementOnly: false } as const;
  const before = await load('dispatch-signature');
  const wallNow = new Date('2026-08-30T12:00:00.000Z');
  const virtual = new Date('2026-08-30T12:00:00.000Z');
  const first = runnerDispatchSignature(before, runner, [], wallNow, virtual);
  assert.equal(tracker.shouldDispatch('dispatch-signature', first), true);
  tracker.markDispatched('dispatch-signature', first);
  assert.equal(tracker.shouldDispatch('dispatch-signature', first), false,
    'an unchanged idle document must not receive another five-second no-op tick');

  const futureWake = structuredClone(before);
  futureWake.wakes.push({
    id: 'wake_later',
    reason: 'planned check',
    condition: { type: 'wall_time', dueAt: '2026-08-30T12:01:00.000Z' },
    status: 'pending',
    createdAt: wallNow.toISOString(),
  });
  futureWake.revision++;
  const beforeDue = runnerDispatchSignature(futureWake, runner, [], wallNow, virtual);
  assert.equal(tracker.shouldDispatch('dispatch-signature', beforeDue), true, 'a durable revision retriggers');
  tracker.markDispatched('dispatch-signature', beforeDue);
  assert.equal(tracker.shouldDispatch('dispatch-signature', beforeDue), false);
  const afterDue = runnerDispatchSignature(
    futureWake,
    runner,
    [],
    new Date('2026-08-30T12:01:00.000Z'),
    virtual,
  );
  assert.equal(tracker.shouldDispatch('dispatch-signature', afterDue), true,
    'a stored wall wake becoming due retriggers without a document write');
});

test('runner dispatch signature observes coordinator failover and expired recovery leases', async () => {
  await make('dispatch-failover');
  const runner = { id: 'standby', placementOnly: false } as const;
  const doc = await load('dispatch-failover');
  doc.workstream.executionPolicy = { coordinatorRunnerOrder: ['primary', 'standby'] };
  doc.wakes.push({
    id: 'wake_now', reason: 'coordinate', condition: { type: 'immediate' }, status: 'pending',
    createdAt: '2026-08-30T12:00:00.000Z',
  });
  doc.lease = {
    passId: 'pass_running', runnerId: 'primary', acquiredAt: '2026-08-30T11:59:00.000Z',
    expiresAt: '2026-08-30T12:02:00.000Z',
  };
  const freshPrimary = [{ runnerId: 'primary', heartbeatAt: '2026-08-30T12:00:00.000Z' }];
  const before = runnerDispatchSignature(
    doc, runner, freshPrimary, new Date('2026-08-30T12:01:00.000Z'), new Date('2026-08-30T12:01:00.000Z'),
  );
  const afterFailoverAndExpiry = runnerDispatchSignature(
    doc, runner, freshPrimary, new Date('2026-08-30T12:03:00.000Z'), new Date('2026-08-30T12:03:00.000Z'),
  );
  assert.notEqual(afterFailoverAndExpiry, before,
    'presence TTL and lease expiry must wake a standby even when the document revision is unchanged');
});

test('Pilot recovery and missing manager notices retrigger without polling settled state', async () => {
  await make('dispatch-managed');
  await make('dispatch-manager');
  const runner = { id: 'mac-primary', placementOnly: false } as const;
  const doc = await load('dispatch-managed');
  const manager = await load('dispatch-manager');
  doc.workstream.managedBy = { slug: 'dispatch-manager', sinceVirtual: virtualNow().toISOString() };
  doc.workstream.status = 'done';
  doc.workstream.conclusion = {
    passId: 'pass_done', atVirtual: virtualNow().toISOString(), summary: 'done', evidenceIds: [],
  };
  doc.assignments.push({
    id: 'asg_pilot', objective: 'approve safely', briefing: 'n/a', kind: 'action',
    acceptanceCriteria: ['n/a'], dependsOn: [], state: 'gated', attempts: [],
    adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    exec: {
      cwd: home, verify: 'true', approvalMode: 'pilot-or-human',
      pilotUnavailableSince: '2026-08-30T12:00:00.000Z',
      pilotRetryAt: '2026-08-30T12:01:00.000Z',
    },
  });
  assert.deepEqual(pendingManagerNoticeKeys(doc, manager), ['finished:pass_done']);
  const before = runnerDispatchSignature(
    doc, runner, [], new Date('2026-08-30T12:00:30.000Z'), new Date('2026-08-30T12:00:30.000Z'), manager,
  );
  const afterPilotDue = runnerDispatchSignature(
    doc, runner, [], new Date('2026-08-30T12:01:00.000Z'), new Date('2026-08-30T12:01:00.000Z'), manager,
  );
  assert.notEqual(afterPilotDue, before, 'the stored Pilot retry becomes runnable at its physical boundary');

  manager.managerNotices = [{
    id: 'note_done', dedupKey: 'finished:pass_done', kind: 'finished',
    fromWorkstreamSlug: 'dispatch-managed', summary: 'done', refId: 'pass_done',
    receivedAtVirtual: virtualNow().toISOString(),
  }];
  assert.deepEqual(pendingManagerNoticeKeys(doc, manager), [], 'delivered notice keys do not poll again');
});

test('resident runner reconciles an unchanged revision once and wakes on the next revision', async () => {
  await make('revision-driven-loop');
  const abort = new AbortController();
  let calls = 0;
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 1,
    signal: abort.signal,
    sourceStale: () => false,
    tickFn: async () => {
      calls++;
      return { cycles: 1, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, 'five-second polling must not mean five-second no-op ticks');
  await arrive('revision-driven-loop', (doc) => { doc.workstream.title = 'changed'; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  abort.abort();
  await loop;
  assert.equal(calls, 2, 'a new durable revision receives one fresh reconciliation');
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

test('an aborted runner drains in-flight ticks before returning', async () => {
  await make('drain-me');
  const abort = new AbortController();
  let tickSettled = false;
  const loop = runLoop({
    intervalMs: 10,
    concurrency: 1,
    signal: abort.signal,
    tickFn: async () => {
      // Abort lands while this tick is mid-flight; the loop must wait for it.
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 300));
      tickSettled = true;
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
    log: () => {},
    logError: () => {},
  });
  await loop;
  assert.equal(tickSettled, true, 'runLoop returned while a tick still held live work');
});

test('the drain window is bounded — a hung tick cannot pin the exit forever', async () => {
  await make('drain-hung');
  const abort = new AbortController();
  const errors: string[] = [];
  const started = Date.now();
  await runLoop({
    intervalMs: 10,
    concurrency: 1,
    signal: abort.signal,
    drainMs: 200,
    tickFn: async () => {
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
    log: () => {},
    logError: (line) => errors.push(line),
  });
  assert.ok(Date.now() - started < 5_000, 'drain must give up at the bounded window');
  assert.ok(errors.some((l) => l.includes('drain window elapsed')), 'the abandoned tick is reported, never silent');
});

test('source replacement leaves polling immediately and bounds the in-flight drain', async () => {
  await make('source-stale-drain');
  let stale = false;
  let announceTickStarted!: () => void;
  const tickStarted = new Promise<void>((resolve) => { announceTickStarted = resolve; });
  let releaseTick!: () => void;
  const heldTick = new Promise<void>((resolve) => { releaseTick = resolve; });
  let tickSettled = false;
  const logs: string[] = [];
  const errors: string[] = [];
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 1,
    drainMs: 25,
    sourceStale: () => stale,
    tickFn: async () => {
      stale = true;
      announceTickStarted();
      await heldTick;
      tickSettled = true;
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });

  await tickStarted;
  // A reverted source-stale branch would wait on heldTick forever. Release it
  // after a generous backstop so the regression fails rather than wedging CI.
  const failureBackstop = setTimeout(releaseTick, 2_000);
  await loop;
  clearTimeout(failureBackstop);

  assert.equal(tickSettled, false, 'source-stale drain must not wait for the held tick');
  assert.equal(
    errors.filter((line) => line.includes('Weaver source changed since startup')).length,
    1,
    'source replacement is announced once',
  );
  assert.ok(logs.some((line) => line.includes('stopping — draining 1 in-flight tick')));
  assert.ok(errors.some((line) => line.includes('drain window elapsed')));
  releaseTick();
});

test('a runner whose checkout changed stops before heartbeat or dispatch', async () => {
  await make('stale-source');
  const errors: string[] = [];
  let ticks = 0;
  await runLoop({
    intervalMs: 10,
    concurrency: 1,
    sourceStale: () => true,
    tickFn: async () => {
      ticks++;
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
    log: () => {},
    logError: (line) => errors.push(line),
  });
  assert.equal(ticks, 0);
  assert.ok(!fs.existsSync(path.join(home, '.runner.heartbeat')));
  assert.deepEqual(errors, [
    '[run] Weaver source changed since startup — stopping before further dispatch; restart Weaver',
  ]);
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
  process.env.WEAVER_RUNNER_ID = 'mac-primary';
  const { runLoop } = await import('./runner.js');
  const abort = new AbortController();
  const loop = runLoop({ intervalMs: 10, concurrency: 1, signal: abort.signal, log: () => {}, logError: () => {} });
  await new Promise((r) => setTimeout(r, 60));
  abort.abort();
  await loop;
  assert.ok(fs.existsSync(path.join(home, '.runner.heartbeat')));
  assert.ok(!fs.existsSync(path.join(home, '.runner.lock', 'heartbeat')));
  assert.equal((await listRunnerPresence()).find((presence) => presence.runnerId === 'mac-primary')?.runnerId, 'mac-primary');
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

test('a runner slot remains owned until its exact tick settles', async () => {
  await make('slot-a');
  await make('slot-b');
  const abort = new AbortController();
  const releases: Array<() => void> = [];
  const calls: string[] = [];
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 1,
    signal: abort.signal,
    log: () => {},
    logError: () => {},
    loadSample: () => ({ load1: 1, cores: 8 }),
    tickFn: async (slug) => {
      calls.push(slug);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 1, 'an unsettled tick must keep the only slot');

    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 2, 'the next workstream may start once the slot owner settles');
  } finally {
    abort.abort();
    for (const release of releases) release();
    await loop;
  }
});

test('a runner whose every iteration fails before the store answers exits for its supervisor', async () => {
  const errors: string[] = [];
  const exit = await runLoop({
    intervalMs: 5,
    concurrency: 1,
    storeOutageExitMs: 40,
    sourceStale: () => false,
    heartbeat: async () => { throw new Error('getaddrinfo ENOTFOUND thomas.proxy.rlwy.net'); },
    log: () => {},
    logError: (line) => errors.push(line),
  });
  assert.equal(exit, 'store-unreachable', 'an unbroken outage past the window ends the loop');
  assert.ok(errors.filter((l) => l.includes('loop iteration failed')).length >= 2, 'the failures themselves stay visible');
  assert.ok(errors.some((l) => l.includes('exiting so the supervisor restarts')), 'the exit names its cause');
});

test('one iteration that reaches the store again resets the outage clock', async () => {
  await make('outage-recovers');
  const abort = new AbortController();
  let attempts = 0;
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 1,
    storeOutageExitMs: 200,
    signal: abort.signal,
    sourceStale: () => false,
    // Three failures, one success, repeat: never 200ms of unbroken failure.
    heartbeat: async () => { attempts++; if (attempts % 4 !== 0) throw new Error('read EHOSTUNREACH'); },
    tickFn: async () => ({ cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] }),
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  abort.abort();
  assert.equal(await loop, 'aborted', 'intermittent failures with a success between them never trip the outage exit');
  assert.ok(attempts >= 8, 'the loop kept polling through the transient failures');
});
