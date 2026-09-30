import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advanceClock, virtualNow } from './clock.js';
import {
  effectiveConcurrency,
  memoryConcurrency,
  availableMemoryMb,
  fleetRecoveredSlugs,
  pendingManagerNoticeKeys,
  probeHoldsToRelease,
  releaseFleetRecovered,
  releaseStaleWaits,
  RunnerDispatchTracker,
  runnerDispatchSignature,
  RunnerWorkstreamCache,
  runLoop,
  staleWaitSlugs,
} from './runner.js';
import { arrive, createWorkstream, heartbeatRunner, listRunnerPresence, listWorkstreamHeads, load, type RunnerOutput } from './store.js';
import type { InfrastructureWait } from './types.js';
import { tick } from './engine.js';
import { __setWorkerExecutorFactoryForTests } from './worker.js';
import { adoptFleetSeatWait, liveSeats, retryCapacityNow, type LiveSeats } from './capacity.js';
import { RUNNER_PRESENCE_TTL_MS } from './coordinatorRunner.js';
import { runCoordinatorPass } from './coordinator.js';
import { claudeCredentialFingerprint, CREDENTIAL_FINGERPRINT_RE, setExecutorSecret } from './secrets.js';
import { readFleetCapacity } from './fleetCapacity.js';

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

/** Live seats in which no runner offers claude-fable-5 (the wait() target). */
const MOVED_ON: LiveSeats = {
  coordinator: new Set(['local-sdk:anthropic:claude-fable-5-1']),
  worker: new Set(['local-sdk:anthropic:sonnet']),
};
const NO_CREDENTIAL = { runnerId: 'mac', fingerprint: null };

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
  assert.deepEqual([...(await staleWaitSlugs(MOVED_ON, NO_CREDENTIAL)).keys()], ['typed']);
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
  assert.deepEqual([...(await staleWaitSlugs(MOVED_ON, NO_CREDENTIAL, cache)).keys()], []);

  await arrive('fresh-between-decisions', (doc) => setCapacity(doc, [wait('pass_between_scans')]));
  assert.deepEqual([...(await staleWaitSlugs(MOVED_ON, NO_CREDENTIAL, cache)).keys()], ['fresh-between-decisions']);
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

test('a Claude credential change never releases a non-Claude executor wait', async () => {
  await make('kimi-wait');
  const infrastructure: InfrastructureWait = {
    ...wait('run_kimi'),
    source: 'worker',
    model: 'openrouter/moonshotai/kimi-k3',
    executor: 'openhands',
    provider: 'openrouter',
  };
  await arrive('kimi-wait', (d) => setCapacity(d, [infrastructure]));
  const changed = { runnerId: 'mac', fingerprint: 'sha256:0123456789abcdef' };
  assert.deepEqual([...(await staleWaitSlugs({}, changed)).keys()], []);
});

// ---------------------------------------------------------------------------
// Waits nothing will ever observe recovering: a seat the fleet moved off, and
// a Claude auth wait whose credential was replaced.

const SEAT_ENV = [
  'WEAVER_COORDINATOR_MODEL', 'WEAVER_COORDINATOR_EXECUTOR', 'WEAVER_COORDINATOR_FALLBACK_MODEL',
  'WEAVER_COORDINATOR_FALLBACKS', 'WEAVER_EXECUTOR', 'WEAVER_WORKER_MODEL', 'WEAVER_WORKER_MODEL_COMPLEX',
  'WEAVER_WORKER_FALLBACKS', 'WEAVER_RUNNER_ID', 'CLAUDE_CONFIG_DIR',
] as const;

async function withSeats<T>(env: Partial<Record<typeof SEAT_ENV[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(SEAT_ENV.map((name) => [name, process.env[name]]));
  for (const name of SEAT_ENV) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const name of SEAT_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

function strandedCoordinatorWait(model: string, executor = 'local-sdk', provider = 'anthropic'): InfrastructureWait {
  return {
    kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator', sourceId: 'pass_old',
    model, executor, provider,
    detectedAt: virtualNow().toISOString(),
    retryAt: new Date(virtualNow().getTime() + 6 * 60 * 60_000).toISOString(),
  };
}

async function strand(slug: string, infrastructure: InfrastructureWait): Promise<void> {
  await make(slug);
  await arrive(slug, (d) => {
    d.wakes.push({
      id: `wake_${slug}`, reason: 'provider retry', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    d.capacity = {
      state: 'backoff',
      byModel: {
        [`${infrastructure.executor}:${infrastructure.provider}:${infrastructure.model}`]: {
          wait: infrastructure, consecutiveBackoffs: 3,
          firstBackoffAtVirtual: infrastructure.detectedAt, lastBackoffAtVirtual: infrastructure.detectedAt,
        },
      },
    };
  });
}

/** A resident runner whose ticks are real engine ticks with a stub coordinator
 * on the host's one seat, recording each model a pass actually launched on. */
async function runRealTicks(ms: number, executorId = 'codex-sdk'): Promise<string[]> {
  const launched: string[] = [];
  const abort = new AbortController();
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 4,
    executorCapabilities: new Set(['codex-sdk', 'local-sdk']),
    signal: abort.signal,
    sourceStale: () => false,
    loadSample: () => ({ load1: 0.1, cores: 8 }),
    memorySample: () => undefined,
    log: () => {},
    logError: () => {},
    tickFn: (slug, opts) => tick(slug, {
      ...opts,
      coordinatorExecutor: {
        id: executorId,
        async execute(req) {
          launched.push(req.model);
          await req.tools.find((tool) => tool.name === 'finish_pass')!.handler({ summary: 'Reconciled on the current seat.' }, {});
          return { costUsd: 0 };
        },
      },
    }),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    abort.abort();
    await loop;
  }
  return launched;
}

const CODEX_HOST = {
  WEAVER_RUNNER_ID: 'gcp', WEAVER_COORDINATOR_EXECUTOR: 'codex-sdk', WEAVER_COORDINATOR_MODEL: 'gpt-5.5',
  WEAVER_COORDINATOR_FALLBACKS: '',
};

test('a wait for a model no live runner offers is released as history and the job runs on the current seat', async () => {
  await withSeats(CODEX_HOST, async () => {
    await strand('stranded', strandedCoordinatorWait('claude-opus-5'));
    const launched = await runRealTicks(300);

    assert.deepEqual(launched, ['gpt-5.5'], 'the parked job ran once, on the seat the fleet offers now');
    const doc = await load('stranded');
    const entry = doc.capacity?.byModel['local-sdk:anthropic:claude-opus-5'];
    assert.ok(entry, 'the capacity record is kept as history, never deleted');
    assert.equal(entry.wait.released?.reason, 'unseated');
    assert.equal(entry.consecutiveBackoffs, 3, 'releasing is not a backoff and rewrites no count');
    assert.ok(entry.wait.retryAt <= virtualNow().toISOString(), 'the released wait no longer holds anything');
    const released = doc.events.filter((event) => event.type === 'capacity.unseated_released');
    assert.equal(released.length, 1, 'one typed event, however many polls saw the stream');
    assert.match(released[0]!.summary, /wait for claude-opus-5 released: no runner offers that model any more/);
    assert.notEqual(doc.wakes.find((wake) => wake.id === 'wake_stranded')!.status, 'pending');
  });
});

test('a wait for a model a live runner still seats stays held until its retry', async () => {
  await withSeats(CODEX_HOST, async () => {
    await strand('still-seated', strandedCoordinatorWait('gpt-5.5', 'codex-sdk', 'openai'));
    // Another live runner still seats claude-opus-5, so that wait holds too.
    await heartbeatRunner('mac', new Date().toISOString(),
      [{ executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5' }], undefined, undefined, []);
    await strand('seated-elsewhere', strandedCoordinatorWait('claude-opus-5'));

    const launched = await runRealTicks(150);

    assert.deepEqual(launched, [], 'nothing launches while every wait still targets a live seat');
    for (const slug of ['still-seated', 'seated-elsewhere']) {
      const doc = await load(slug);
      const entry = Object.values(doc.capacity!.byModel)[0]!;
      assert.equal(entry.wait.released, undefined);
      assert.ok(entry.wait.retryAt > virtualNow().toISOString());
      assert.equal(doc.wakes.find((wake) => wake.id === `wake_${slug}`)!.status, 'pending');
      assert.ok(!doc.events.some((event) => event.type === 'capacity.unseated_released'));
    }
  });
});

test('a runner that publishes no worker seats makes worker waits unknown, never unseated', async () => {
  // An older runner (no workerSeats) is live: a worker wait on a model this
  // host does not seat might still be seated there.
  await heartbeatRunner('old', new Date().toISOString(), []);
  await heartbeatRunner('new', new Date().toISOString(), [], undefined, undefined,
    [{ executor: 'local-sdk', provider: 'anthropic', model: 'sonnet' }]);
  const seats = liveSeats(await listRunnerPresence(), Date.now(), RUNNER_PRESENCE_TTL_MS);
  assert.equal(seats.worker, undefined);
  await strand('worker-unknown', { ...strandedCoordinatorWait('claude-opus-4-8'), source: 'worker', sourceId: 'run_old' });
  assert.deepEqual([...(await staleWaitSlugs(seats, NO_CREDENTIAL)).keys()], []);
});

test('the seat set comes from presence rows and stale-wait discovery reads each body once through the runner cache', async () => {
  await strand('cached-a', strandedCoordinatorWait('claude-fable-5'));
  await strand('cached-b', strandedCoordinatorWait('claude-fable-5-1'));
  await heartbeatRunner('gcp', new Date().toISOString(),
    [{ executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5-1' }], undefined, undefined, []);
  const loads: string[] = [];
  const cache = new RunnerWorkstreamCache(listWorkstreamHeads, async (slug) => {
    loads.push(slug);
    return load(slug);
  });
  // liveSeats is a pure function of the presence rows: no document involved.
  const seats = liveSeats(await listRunnerPresence(), Date.now(), RUNNER_PRESENCE_TTL_MS);
  assert.deepEqual([...seats.coordinator!], ['local-sdk:anthropic:claude-fable-5-1']);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual([...(await staleWaitSlugs(seats, NO_CREDENTIAL, cache)).keys()], ['cached-a']);
  }
  assert.deepEqual(loads.sort(), ['cached-a', 'cached-b'], 'three polls read every unchanged body exactly once');
});

test('releasing is idempotent, re-derived under the current revision, and coalesces with a concurrent re-park', async () => {
  await strand('idempotent', strandedCoordinatorWait('claude-fable-5'));
  await strand('re-parked', strandedCoordinatorWait('claude-fable-5'));
  const stale = await staleWaitSlugs(MOVED_ON, NO_CREDENTIAL);
  assert.deepEqual([...stale.keys()].sort(), ['idempotent', 're-parked']);
  // Between the scan and the release, a real attempt re-records a fresh wait
  // on a seat the fleet does offer: the release must act on that newer state.
  await arrive('re-parked', (d) => {
    const seated = { ...strandedCoordinatorWait('claude-fable-5-1'), sourceId: 'pass_new' };
    d.capacity = { state: 'backoff', byModel: { 'local-sdk:anthropic:claude-fable-5-1': {
      wait: seated, consecutiveBackoffs: 1, firstBackoffAtVirtual: seated.detectedAt, lastBackoffAtVirtual: seated.detectedAt,
    } } };
    for (const wake of d.wakes) wake.status = 'cancelled';
  });
  const reParkedRevision = (await load('re-parked')).revision;
  await releaseStaleWaits(stale, MOVED_ON, NO_CREDENTIAL, () => {});
  const reParked = await load('re-parked');
  assert.equal(reParked.revision, reParkedRevision, 'nothing stale remained, so nothing was written');
  assert.equal(reParked.capacity!.byModel['local-sdk:anthropic:claude-fable-5-1']!.wait.released, undefined);

  const first = await load('idempotent');
  assert.equal(first.capacity!.byModel['local-sdk:anthropic:claude-fable-5']!.wait.released?.reason, 'unseated');
  // At-least-once delivery: the same release again is a no-op.
  await releaseStaleWaits(stale, MOVED_ON, NO_CREDENTIAL, () => {});
  const second = await load('idempotent');
  assert.equal(second.revision, first.revision, 'a duplicate release writes nothing');
  assert.equal(second.events.filter((event) => event.type === 'capacity.unseated_released').length, 1);
});

test('a replaced executor-only setup-token releases a Claude auth wait; an unchanged one does not; no secret is stored', async () => {
  await withSeats({
    WEAVER_RUNNER_ID: 'gcp', WEAVER_COORDINATOR_EXECUTOR: 'local-sdk', WEAVER_COORDINATOR_MODEL: 'claude-fable-5-1',
    WEAVER_COORDINATOR_FALLBACKS: '', CLAUDE_CONFIG_DIR: path.join(home, 'no-claude-login'),
  }, async () => {
    const oldToken = 'sk-ant-oat01-OLD-token-value-never-stored';
    setExecutorSecret('CLAUDE_CODE_OAUTH_TOKEN', oldToken);
    const before = claudeCredentialFingerprint();
    assert.match(before!, CREDENTIAL_FINGERPRINT_RE);

    await make('auth-parked');
    await arrive('auth-parked', (d) => immediateWake(d, 'wake_work'));
    await runCoordinatorPass('auth-parked', ['work'], {
      id: 'local-sdk', async execute() { throw new Error('401 Unauthorized: authentication failed'); },
    });
    const parked = await load('auth-parked');
    const entry = parked.capacity!.byModel['local-sdk:anthropic:claude-fable-5-1']!;
    assert.equal(entry.wait.kind, 'auth');
    assert.deepEqual(entry.wait.credential, { runnerId: 'gcp', fingerprint: before });
    assert.notEqual(entry.wait.credential!.fingerprint, oldToken);
    assert.match(entry.wait.credential!.fingerprint!, CREDENTIAL_FINGERPRINT_RE);
    assert.ok(!JSON.stringify(parked).includes('OLD-token'), 'the stored document never contains the secret');

    const unchanged = { runnerId: 'gcp', fingerprint: claudeCredentialFingerprint() };
    assert.deepEqual([...(await staleWaitSlugs({}, unchanged)).keys()], [], 'the same credential keeps the wait');
    const elsewhere = { runnerId: 'mac', fingerprint: 'sha256:ffffffffffffffff' };
    assert.deepEqual([...(await staleWaitSlugs({}, elsewhere)).keys()], [], "another host's credential proves nothing here");

    // push-env replaces the registered setup-token (and restarts the runner:
    // the baseline lives on the wait, so a restart loses nothing).
    setExecutorSecret('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-NEW-token-value');
    const after = { runnerId: 'gcp', fingerprint: claudeCredentialFingerprint() };
    assert.notEqual(after.fingerprint, before);
    const stale = await staleWaitSlugs({}, after);
    assert.deepEqual([...stale.keys()], ['auth-parked']);
    await releaseStaleWaits(stale, {}, after, () => {});

    const released = await load('auth-parked');
    const kept = released.capacity!.byModel['local-sdk:anthropic:claude-fable-5-1']!;
    assert.equal(kept.wait.released?.reason, 'credential_changed');
    assert.ok(kept.wait.retryAt <= virtualNow().toISOString());
    const retryWake = released.wakes.find((wake) => wake.infrastructure?.kind === 'auth')!;
    assert.ok(retryWake.condition.type === 'time' && retryWake.condition.dueAtVirtual <= virtualNow().toISOString(),
      'the parked retry is due now');
    assert.ok(released.events.some((event) => event.type === 'capacity.credential_changed_released'));
    assert.ok(!JSON.stringify(released).includes('NEW-token'));
  });
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
  const presence = (await listRunnerPresence()).find((candidate) => candidate.runnerId === 'mac-primary');
  assert.equal(presence?.runnerId, 'mac-primary');
  // Presence names the coordinator seats this host can launch a pass on, so a
  // standby can distinguish a live preferred runner from a seated one.
  assert.ok(presence?.coordinatorSeats?.length, 'a resident runner publishes its coordinator seats');
  assert.deepEqual(Object.keys(presence!.coordinatorSeats![0]!).sort(), ['executor', 'model', 'provider']);
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

test('memory admission replays the 2026-09-18 freeze: the third fast worker waits', () => {
  // ~4.5 GB free, nothing running: two budgets fit beside the host reserve.
  assert.equal(memoryConcurrency(4, 0, 4600, 0), 2);
  // Two slots granted seconds ago have not grown yet — their budgets are held.
  assert.equal(memoryConcurrency(4, 2, 4400, 2), 2, 'no third slot while the first two are ramping');
  assert.equal(memoryConcurrency(4, 2, 7800, 0), 4, 'plenty of memory keeps the configured width');
  assert.equal(memoryConcurrency(4, 3, 900, 0), 3, 'running ticks are never revoked, only not added');
  assert.equal(memoryConcurrency(4, 0, 200, 0), 1, 'an idle runner always takes one tick');
  assert.equal(memoryConcurrency(4, 1, undefined, 3), 4, 'an unknown reading applies no gate');
  assert.equal(memoryConcurrency(4, 1, Number.NaN, 0), 4, 'an unreadable reading applies no gate');
});

test('available memory is read from MemAvailable, not MemFree', () => {
  const meminfo = 'MemTotal:        8141312 kB\nMemFree:          412000 kB\nMemAvailable:    6172672 kB\n';
  assert.equal(availableMemoryMb(meminfo), 6028);
  assert.equal(availableMemoryMb('MemTotal: 1 kB\n'), undefined);
});

test('the poll loop holds its slot cap when available memory is short', async () => {
  const { runLoop } = await import('./runner.js');
  const lines: string[] = [];
  const abort = new AbortController();
  const loop = runLoop({
    intervalMs: 10,
    concurrency: 4,
    signal: abort.signal,
    log: (l) => lines.push(l),
    logError: () => {},
    loadSample: () => ({ load1: 0.1, cores: 2 }),
    memorySample: () => 1500,
  });
  await new Promise((r) => setTimeout(r, 60));
  abort.abort();
  await loop;
  assert.ok(
    lines.some((l) => /1500 MB available with 0 tick\(s\) running — memory holds parallel ticks at 1\b/.test(l)),
    `expected a memory hold line, got: ${JSON.stringify(lines)}`,
  );
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

test('a settled tick stops holding memory the moment it frees its slot', async () => {
  // 2026-09-21: counting finished coordinator passes as still ramping held a
  // fresh hosted runner to one slot with 6 GB free.
  await make('mem-a');
  await make('mem-b');
  const abort = new AbortController();
  const lines: string[] = [];
  let calls = 0;
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 4,
    signal: abort.signal,
    log: (l) => lines.push(l),
    logError: () => {},
    loadSample: () => ({ load1: 0.1, cores: 8 }),
    // Room for two budgets beside the host reserve, never three.
    memorySample: () => 4200,
    tickFn: async () => {
      calls += 1;
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(calls >= 2, 'both due workstreams were ticked');
    assert.ok(
      !lines.some((l) => /memory holds parallel ticks at 1\b/.test(l)),
      `finished ticks must not keep holding memory: ${JSON.stringify(lines)}`,
    );
  } finally {
    abort.abort();
    await loop;
  }
});

test('a runner whose state directory cannot take a write publishes why, dispatches nothing, and resumes when it can', async () => {
  await make('degraded-home');
  const abort = new AbortController();
  const errors: string[] = [];
  const logs: string[] = [];
  const beats: (string | undefined)[] = [];
  let ticks = 0;
  let writable = false;
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 2,
    signal: abort.signal,
    sourceStale: () => false,
    homeHealth: () => (writable ? { ok: true } : { ok: false, reason: 'state directory /x is not writable (ENOSPC: no space left on device)' }),
    heartbeat: async (_runnerId, degraded) => { beats.push(degraded); },
    tickFn: async () => {
      ticks++;
      return { cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] } as never;
    },
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ticks, 0, 'a tick that cannot commit is never launched');
  assert.ok(beats.length >= 3, 'presence keeps flowing so the host is not mistaken for dead');
  assert.ok(beats.every((b) => b?.includes('ENOSPC')), 'every heartbeat while degraded carries the reason');
  assert.equal(errors.filter((l) => l.includes('DEGRADED')).length, 1, 'the reason is logged on the transition, not every iteration');

  writable = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
  abort.abort();
  await loop;
  assert.ok(ticks >= 1, 'dispatch resumes once the directory is writable');
  assert.equal(beats.at(-1), undefined, 'a healthy heartbeat clears the reason');
  assert.ok(logs.some((l) => l.includes('writable again')), 'recovery is logged');
});

test('a healthy heartbeat published after a scan carries what that scan actually observed', async () => {
  // AGENTS.md: "a fresh heartbeat is not health" — an external monitor needs
  // what the runner's own scan produced, not just that it is still ticking.
  await make('output-ws');
  await arrive('output-ws', (doc) => {
    doc.passes.push({
      id: 'pass_done', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:05:00.000Z',
      baseRevision: 0, wakeReasons: [], changes: [], outcome: 'completed',
    });
  });
  const abort = new AbortController();
  const beats: (RunnerOutput | undefined)[] = [];
  const loop = runLoop({
    intervalMs: 5,
    concurrency: 1,
    signal: abort.signal,
    sourceStale: () => false,
    heartbeat: async (_runnerId, _degraded, output) => { beats.push(output); },
    tickFn: async () => ({ cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] } as never),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(beats.length >= 2, 'at least two heartbeats were published');
    // Presence publishes BEFORE the scan (so a preferred coordinator host is
    // visible before a standby considers a claim), so the very first
    // heartbeat of the process precedes any scan and carries no output yet.
    assert.equal(beats[0], undefined, 'the first heartbeat precedes any scan');
    assert.ok(
      beats.slice(1).some((output) => output?.lastCompletedPassAt === '2026-01-01T00:05:00.000Z'),
      `a later heartbeat must carry the previous scan's observed output: ${JSON.stringify(beats)}`,
    );
  } finally {
    abort.abort();
    await loop;
  }
});

test('the default state-directory probe reports a read-only home and a breached free-space floor', async () => {
  const { runnerHomeHealth, runnerMinFreeBytes } = await import('./runner.js');
  assert.deepEqual(runnerHomeHealth(0), { ok: true });
  const floored = runnerHomeHealth(Number.MAX_SAFE_INTEGER);
  assert.equal(floored.ok, false);
  assert.match((floored as { reason: string }).reason, /free, below the .* floor \(WEAVER_RUNNER_MIN_FREE_MB\)/);
  assert.equal(runnerMinFreeBytes({}), 512 * 1024 * 1024);
  assert.equal(runnerMinFreeBytes({ WEAVER_RUNNER_MIN_FREE_MB: '2048' }), 2048 * 1024 * 1024);
  assert.throws(() => runnerMinFreeBytes({ WEAVER_RUNNER_MIN_FREE_MB: 'lots' }), /non-negative number/);
  if (process.getuid?.() !== 0) {
    fs.rmSync(path.join(home, '.runner.heartbeat'), { force: true });
    fs.chmodSync(home, 0o500);
    try {
      const sealed = runnerHomeHealth(0);
      assert.equal(sealed.ok, false);
      assert.match((sealed as { reason: string }).reason, /is not writable \(EACCES/);
    } finally {
      fs.chmodSync(home, 0o700);
    }
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
    storeOutageExitMs: 600,
    signal: abort.signal,
    sourceStale: () => false,
    // Three failures, one success, repeat: never 600ms of unbroken failure.
    heartbeat: async () => { attempts++; if (attempts % 4 !== 0) throw new Error('read EHOSTUNREACH'); },
    tickFn: async () => ({ cycles: 0, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] }),
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  abort.abort();
  assert.equal(await loop, 'aborted', 'intermittent failures with a success between them never trip the outage exit');
  assert.ok(attempts >= 8, 'the loop kept polling through the transient failures');
});

// ---------------------------------------------------------------------------
// Fleet-shared seat waits at the runner: derived from the cache, retriggered by
// the deferral wake, released by shared success evidence, and probed by ONE
// tick when they expire unrefuted.

const FLEET_ENV = ['WEAVER_COORDINATOR_MODEL', 'WEAVER_COORDINATOR_EXECUTOR', 'WEAVER_COORDINATOR_FALLBACK_MODEL', 'WEAVER_COORDINATOR_FALLBACKS'] as const;

async function withSingleSeatCoordinator<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(FLEET_ENV.map((name) => [name, process.env[name]]));
  for (const name of FLEET_ENV) delete process.env[name];
  // One Codex seat keeps these fleet tests independent of the host's Claude
  // chain; their ticks pass stub executors or stop before any launch.
  process.env.WEAVER_COORDINATOR_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_COORDINATOR_MODEL = 'gpt-5.5';
  process.env.WEAVER_COORDINATOR_FALLBACKS = '';
  try {
    return await fn();
  } finally {
    for (const name of FLEET_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const SEAT = { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5' } as const;
const SEAT_KEY = 'codex-sdk:openai:gpt-5.5';
const GLM = { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' } as const;

function limitAt(target: { executor: string; provider: string; model: string }, detectedMs: number, retryMs: number, sourceId: string): InfrastructureWait {
  return {
    kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator', sourceId, ...target,
    detectedAt: new Date(Date.now() + detectedMs).toISOString(),
    retryAt: new Date(Date.now() + retryMs).toISOString(),
  };
}

function ownWait(d: Awaited<ReturnType<typeof load>>, wait: InfrastructureWait): void {
  d.capacity = {
    state: 'backoff',
    byModel: {
      [`${wait.executor}:${wait.provider}:${wait.model}`]: {
        wait, consecutiveBackoffs: 1, firstBackoffAtVirtual: wait.detectedAt, lastBackoffAtVirtual: wait.detectedAt,
      },
    },
  };
}

function completedPass(target: { executor: string; provider: string; model: string }, id: string) {
  const at = new Date().toISOString();
  return { id, startedAt: at, endedAt: at, baseRevision: 1, wakeReasons: [], changes: [], outcome: 'completed' as const, ...target };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function immediateWake(d: Awaited<ReturnType<typeof load>>, id: string): void {
  d.wakes.push({ id, reason: 'due organizational work', condition: { type: 'immediate' }, status: 'pending', createdAt: new Date().toISOString() });
}

const quietLoop = {
  intervalMs: 5,
  concurrency: 8,
  executorCapabilities: new Set(['local-sdk', 'codex-sdk', 'pi']),
  sourceStale: () => false,
  loadSample: () => ({ load1: 0.1, cores: 8 }),
  memorySample: () => undefined,
  log: () => {},
  logError: () => {},
};

test('the fleet snapshot comes from the runner cache with no extra document reads', async () => {
  // This host seats GLM on its worker ladder, so the parked wait is live
  // (never released as unseated) and the stream sees no write of its own.
  await withSeats({ WEAVER_WORKER_FALLBACKS: 'pi:zai-coding-plan/glm-5.3' }, async () => {
    await make('glm-limited');
    await make('bystander');
    const wait = limitAt(GLM, -60_000, 30 * 60_000, 'run_glm');
    await arrive('glm-limited', (d) => ownWait(d, { ...wait, source: 'worker' }));

    const loads: string[] = [];
    const cache = new RunnerWorkstreamCache(listWorkstreamHeads, async (slug) => {
      loads.push(slug);
      return load(slug);
    });
    const snapshots: Array<ReadonlyMap<string, InfrastructureWait> | undefined> = [];
    const abort = new AbortController();
    const loop = runLoop({
      ...quietLoop,
      signal: abort.signal,
      workstreamCache: cache,
      tickFn: async (_slug, opts) => {
        snapshots.push(opts?.fleetCapacity);
        return { cycles: 1, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
      },
    });
    try {
      await waitFor(() => snapshots.length >= 2, 'both streams to be reconciled');
      // Several more polls, each running three cache scans.
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      abort.abort();
      await loop;
    }
    assert.deepEqual(loads.sort(), ['bystander', 'glm-limited'],
      'several polls and three scans each still read every document exactly once');
    assert.equal(snapshots.length, 2, 'one reconciliation per unchanged stream');
    for (const snapshot of snapshots) {
      const shared = snapshot?.get('pi:zai-coding-plan:zai-coding-plan/glm-5.3');
      assert.equal(shared?.observedIn, 'glm-limited');
      assert.equal(shared?.retryAt, wait.retryAt);
    }
  });
});

test('the deferral wake retriggers the dispatch signature exactly at the borrowed retry', async () => {
  await withSingleSeatCoordinator(async () => {
    await make('deferred');
    await arrive('deferred', (d) => immediateWake(d, 'wake_org'));
    const borrowed = { ...limitAt(SEAT, -60_000, 20 * 60_000, 'pass_elsewhere'), observedIn: 'limited-elsewhere' };
    // Stub executors on both lanes: this real tick can never reach a model.
    __setWorkerExecutorFactoryForTests(() => ({ async execute() { throw new Error('worker launched'); } }));
    try {
      await tick('deferred', {
        fleetCapacity: new Map([[SEAT_KEY, borrowed]]),
        coordinatorExecutor: { id: 'codex-sdk', async execute() { throw new Error('parked seat launched'); } },
      });
    } finally {
      __setWorkerExecutorFactoryForTests();
    }
    const doc = await load('deferred');
    assert.equal(doc.passes.length, 0);
    const runner = { id: 'mac-primary', placementOnly: false } as const;
    const now = virtualNow();
    const before = runnerDispatchSignature(doc, runner, [], now, now);
    const later = new Date(now.getTime() + 60_000);
    assert.equal(runnerDispatchSignature(doc, runner, [], later, later), before,
      'waiting on a borrowed retry is quiescent: no tight dispatch loop');
    const retryAt = new Date(borrowed.retryAt);
    assert.notEqual(runnerDispatchSignature(doc, runner, [], retryAt, retryAt), before,
      'the stored deferral wake falls due at the borrowed retry without any write');
  });
});

test('a success recorded in another workstream releases a borrowed wait on every host', async () => {
  await make('limited-source');
  await make('borrower');
  await make('proving');
  const wait = limitAt(GLM, -60_000, 45 * 60_000, 'run_limited');
  await arrive('limited-source', (d) => ownWait(d, wait));
  await arrive('borrower', (d) => { adoptFleetSeatWait(d, { ...wait, observedIn: 'limited-source' }); });

  assert.equal((await fleetRecoveredSlugs()).size, 0, 'the fleet still holds the wait it lent');

  await arrive('proving', (d) => { d.passes.push(completedPass(GLM, 'pass_proof')); });
  const recovered = await fleetRecoveredSlugs();
  assert.deepEqual([...recovered.keys()].sort(), ['borrower', 'limited-source']);
  await releaseFleetRecovered(recovered, () => {});
  assert.equal((await load('borrower')).capacity, null);
  assert.equal((await load('limited-source')).capacity, null);
  assert.deepEqual(readFleetCapacity().recovered, {},
    "the evidence was the shared documents, not this host's ledger");
});

test('a borrowed wait whose source retried at its origin is released for the one probe to test', async () => {
  await make('limited-source');
  await make('borrower');
  const wait = limitAt(GLM, -60_000, 45 * 60_000, 'run_limited');
  await arrive('limited-source', (d) => ownWait(d, wait));
  await arrive('borrower', (d) => { adoptFleetSeatWait(d, { ...wait, observedIn: 'limited-source' }); });
  await arrive('limited-source', (d) => { retryCapacityNow(d, virtualNow().toISOString()); });
  assert.deepEqual([...(await fleetRecoveredSlugs()).keys()], ['borrower']);
});

test('three streams due on an expired, unrefuted seat admit ONE probe tick until its outcome lands', async () => {
  await withSingleSeatCoordinator(async () => {
    await make('lapsed-source');
    await arrive('lapsed-source', (d) => ownWait(d, limitAt(SEAT, -20 * 60_000, -60_000, 'pass_lapsed')));
    for (const slug of ['probe-a', 'probe-b', 'probe-c']) {
      await make(slug);
      await arrive(slug, (d) => immediateWake(d, `wake_${slug}`));
    }
    const calls: string[] = [];
    let releaseProbe!: () => void;
    const probeHeld = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const abort = new AbortController();
    const loop = runLoop({
      ...quietLoop,
      signal: abort.signal,
      tickFn: async (slug) => {
        calls.push(slug);
        if (slug !== 'lapsed-source' && calls.filter((c) => c !== 'lapsed-source').length === 1) await probeHeld;
        return { cycles: 1, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
      },
    });
    const probeCalls = () => calls.filter((slug) => slug.startsWith('probe-'));
    try {
      await waitFor(() => probeCalls().length >= 1, 'the probe tick');
      // Give the loop many polls in which it could (wrongly) admit the others.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(probeCalls().length, 1, `only one probe may be in flight, got ${JSON.stringify(calls)}`);
      const probe = probeCalls()[0]!;

      // The probe's pass got through: its success refutes the expired wait.
      await arrive(probe, (d) => { d.passes.push(completedPass(SEAT, 'pass_probe')); });
      releaseProbe();
      await waitFor(() => new Set(probeCalls()).size === 3, 'the held streams to dispatch');
      assert.deepEqual([...new Set(probeCalls())].sort(), ['probe-a', 'probe-b', 'probe-c'],
        'held streams were never acknowledged, so they dispatch once the outcome lands');
    } finally {
      releaseProbe();
      abort.abort();
      await loop;
    }
  });
});

async function probeHoldScenario(
  duringHold: (probe: string) => Promise<void>,
): Promise<{ probe: string; snapshots: Map<string, Array<ReadonlyMap<string, InfrastructureWait> | undefined>>; probeSettled: boolean }> {
  await make('lapsed-source');
  await arrive('lapsed-source', (d) => ownWait(d, limitAt(SEAT, -20 * 60_000, -60_000, 'pass_lapsed')));
  for (const slug of ['probe-a', 'probe-b', 'probe-c']) {
    await make(slug);
    await arrive(slug, (d) => immediateWake(d, `wake_${slug}`));
  }
  const snapshots = new Map<string, Array<ReadonlyMap<string, InfrastructureWait> | undefined>>();
  let probe: string | undefined;
  let probeSettled = false;
  let releaseProbe!: () => void;
  const probeHeld = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const abort = new AbortController();
  const loop = runLoop({
    ...quietLoop,
    probeHoldMs: 40,
    signal: abort.signal,
    tickFn: async (slug, opts) => {
      snapshots.set(slug, [...(snapshots.get(slug) ?? []), opts?.fleetCapacity]);
      if (slug.startsWith('probe-') && probe === undefined) {
        // The probe's worker keeps running long past the hold window.
        probe = slug;
        await probeHeld;
        probeSettled = true;
      }
      return { cycles: 1, sendsExecuted: 0, unknownsResolved: 0, workersRun: [], passes: [] };
    },
  });
  try {
    await waitFor(() => probe !== undefined, 'the probe tick');
    await duringHold(probe!);
    // Well past the 40ms hold window.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { probe: probe!, snapshots, probeSettled };
  } finally {
    releaseProbe();
    abort.abort();
    await loop;
  }
}

test('a probe still running past the hold window with no new limit releases the rest', async () => {
  await withSingleSeatCoordinator(async () => {
    const { probe, snapshots, probeSettled } = await probeHoldScenario(async () => {});
    assert.equal(probeSettled, false, 'the probe tick is still in flight');
    const others = ['probe-a', 'probe-b', 'probe-c'].filter((slug) => slug !== probe);
    for (const slug of others) {
      const handed = snapshots.get(slug);
      assert.ok(handed?.length, `${slug} is admitted once the seat is treated as serving`);
      assert.equal(handed![0]?.has(SEAT_KEY), false, 'and launches, holding no wait for the seat');
    }
  });
});

test('a newer limit recorded by the probe re-defers the rest instead of releasing them', async () => {
  await withSingleSeatCoordinator(async () => {
    const { probe, snapshots, probeSettled } = await probeHoldScenario(async (probing) => {
      // The probe's launch was rejected: its backoff lands within seconds.
      await arrive(probing, (d) => ownWait(d, limitAt(SEAT, 0, 30 * 60_000, 'pass_probe_rejected')));
    });
    assert.equal(probeSettled, false);
    for (const slug of ['probe-a', 'probe-b', 'probe-c'].filter((candidate) => candidate !== probe)) {
      for (const snapshot of snapshots.get(slug) ?? []) {
        assert.equal(snapshot?.get(SEAT_KEY)?.sourceId, 'pass_probe_rejected',
          `${slug} may only tick to re-defer on the probe's new limit, never with the seat treated as serving`);
      }
    }
  });
});

test('a probe hold ends early only when its window passes with no newer limit on that exact seat', () => {
  const key = SEAT_KEY;
  const probed = { ...limitAt(SEAT, -20 * 60_000, -60_000, 'pass_lapsed'), observedIn: 'lapsed-source' };
  const holds = new Map([[key, { slug: 'probe-a', admittedAt: 1_000, detectedAt: probed.detectedAt }]]);
  const view = (active: InfrastructureWait[], expired: InfrastructureWait[]) => ({
    active: new Map(active.map((wait) => [key, wait])),
    expired: new Map(expired.map((wait) => [key, wait])),
  });
  // Inside the window nothing is released, whatever the fleet shows.
  assert.deepEqual(probeHoldsToRelease(holds, view([], [probed]), 1_000 + 299_999, 300_000), []);
  // Past it, silence on the same expired wait means the seat is serving...
  assert.deepEqual(probeHoldsToRelease(holds, view([], [probed]), 1_000 + 300_000, 300_000), [key]);
  // ...and so does a success that refuted it outright.
  assert.deepEqual(probeHoldsToRelease(holds, view([], []), 1_000 + 300_000, 300_000), [key]);
  // A newer limit — still active, or already expired — keeps the hold.
  const rejected = { ...limitAt(SEAT, -1_000, 30 * 60_000, 'pass_probe_rejected'), observedIn: 'probe-a' };
  assert.deepEqual(probeHoldsToRelease(holds, view([rejected], []), 1_000 + 300_000, 300_000), []);
  const shortRejection = { ...rejected, retryAt: new Date(Date.now() - 1).toISOString() };
  assert.deepEqual(probeHoldsToRelease(holds, view([], [shortRejection]), 1_000 + 300_000, 300_000), []);
});

test('live 2026-09-29 shape: a past-due GLM deferral never holds a stream whose chain leads with a healthy Claude seat', async () => {
  // evals-health / session-replay-review / axiom-monitor-triage on the shared
  // store: coordinatorRunnerOrder=[weaver-fleet], a pending fleet deferral wake
  // for the third seat (GLM, borrowed from ci-deploy-pipeline-health) already
  // past its time, a borrowed weekly limit on the retired primary
  // claude-opus-5, expired August session waits, and due immediates — a human
  // steer, a submitted result, a manager notice, a no_finish re-reconcile.
  await withSeats({
    WEAVER_RUNNER_ID: 'weaver-fleet', WEAVER_COORDINATOR_EXECUTOR: 'local-sdk',
    WEAVER_COORDINATOR_MODEL: 'claude-fable-5-1',
    WEAVER_COORDINATOR_FALLBACKS: 'local-sdk:claude-opus-5-5,local-sdk:openrouter/z-ai/glm-5.3',
  }, async () => {
    const glm = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
    // The GLM limit is still live at its source, so the fleet keeps lending it.
    await make('ci-deploy-pipeline-health');
    await arrive('ci-deploy-pipeline-health', (d) => ownWait(d, limitAt(glm, -3 * 60 * 60_000, 60 * 60_000, 'pass_b2f8bed3')));

    await make('evals-health');
    const borrowedGlm: InfrastructureWait = {
      ...limitAt(glm, -3 * 60 * 60_000, -8 * 60_000, 'pass_b2f8bed3'), observedIn: 'ci-deploy-pipeline-health',
    };
    const borrowedOpus: InfrastructureWait = {
      ...limitAt({ executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5' }, -34 * 60 * 60_000, 26 * 60 * 60_000, 'pass_weekly'),
      rateLimitType: 'seven_day', observedIn: 'retired-source',
    };
    const expiredSession: InfrastructureWait = {
      ...limitAt({ executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-4-8' }, -37 * 24 * 60 * 60_000, -8 * 60_000, 'pass_eda93367'),
      kind: 'session_limit', recovery: 'automatic_retry',
    };
    const reasons = [
      'pass pass_cb8cc7de ended \'no_finish\' — its wakes were consumed; re-reconcile',
      'human steering arrived: "Cost plan phase 2"',
      'assignment asg_ab1c0167 submitted a result for review',
      'notice(s) received from managed workstream erdo-onboarding-plan-step-drop',
    ];
    await arrive('evals-health', (d) => {
      d.workstream.executionPolicy = { coordinatorRunnerOrder: ['weaver-fleet'] };
      d.capacity = { state: 'backoff', byModel: Object.fromEntries([borrowedGlm, borrowedOpus, expiredSession].map((w) => [
        `${w.executor}:${w.provider}:${w.model}`,
        { wait: w, consecutiveBackoffs: w.observedIn ? 0 : 1, firstBackoffAtVirtual: w.detectedAt, lastBackoffAtVirtual: w.detectedAt },
      ])) };
      d.wakes.push({
        id: 'wake_a78b25e3', reason: 'fleet capacity: OpenRouter usage is limited for openrouter/z-ai/glm-5.3',
        condition: { type: 'time', dueAtVirtual: borrowedGlm.retryAt }, status: 'pending',
        createdAt: new Date().toISOString(), infrastructure: { ...borrowedGlm },
      });
      reasons.forEach((reason, index) => d.wakes.push({
        id: `wake_due_${index}`, reason, condition: { type: 'immediate' }, status: 'pending', createdAt: new Date().toISOString(),
      }));
    });

    const launched = await runRealTicks(400, 'local-sdk');

    assert.deepEqual(launched, ['claude-fable-5-1'], 'served once, on the healthy primary');
    const doc = await load('evals-health');
    const pass = doc.passes.at(-1)!;
    for (const reason of reasons) assert.ok(pass.wakeReasons.includes(reason), `served: ${reason}`);
    assert.ok(!pass.wakeReasons.some((reason) => reason.startsWith('fleet capacity:')), 'the deferral is never a pass reason');
    assert.equal(doc.wakes.find((wake) => wake.id === 'wake_a78b25e3')!.status, 'cancelled',
      'a past-due deferral is retired, never left holding anything');
    assert.ok(doc.wakes.every((wake) => wake.status !== 'pending' || !wake.id.startsWith('wake_due_')));
    const opus = doc.capacity?.byModel['local-sdk:anthropic:claude-opus-5'];
    assert.ok(!opus || opus.wait.retryAt <= virtualNow().toISOString(),
      'the borrowed limit on a model no runner seats no longer holds anything');
  });
});
