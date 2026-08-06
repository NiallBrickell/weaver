import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { advanceClock, virtualNow } from './clock.js';
import { expediteBackoffWakes, infraBackoffSlugs } from './runner.js';
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

function make(slug: string): void {
  createWorkstream({
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
    detectedAt: virtualNow().toISOString(),
    retryAt: new Date(virtualNow().getTime() + 60_000).toISOString(),
  };
}

function setCapacity(d: ReturnType<typeof load>, waits: InfrastructureWait[]): void {
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

test('runner discovers only pending typed infrastructure waits, never magic prose', () => {
  make('typed');
  make('prose');
  make('paused');
  arrive('typed', (d) => {
    const infrastructure = wait();
    d.wakes.push({
      id: 'wake_typed', reason: 'wording may change', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    setCapacity(d, [infrastructure]);
  });
  arrive('prose', (d) => d.wakes.push({
    id: 'wake_prose', reason: 'retry after infrastructure failure', condition: { type: 'time', dueAtVirtual: wait().retryAt },
    status: 'pending', createdAt: new Date().toISOString(),
  }));
  arrive('paused', (d) => {
    const infrastructure = wait();
    d.workstream.status = 'paused';
    d.wakes.push({
      id: 'wake_paused', reason: 'typed but paused', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    setCapacity(d, [infrastructure]);
  });
  assert.deepEqual(infraBackoffSlugs(), ['typed']);
});

test('successful probe expedition uses virtual time and unblocks worker attempts', () => {
  make('expedite');
  advanceClock('5d');
  const infrastructure = wait('run_wait');
  arrive('expedite', (d) => {
    d.wakes.push({
      id: 'wake_wait', reason: 'opaque', condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt: new Date().toISOString(), infrastructure,
    });
    d.attention.push({
      id: 'att_auth', kind: 'blocker', summary: 'Claude authentication needs attention', refId: 'wake_wait',
      status: 'open', createdAt: new Date().toISOString(),
    });
    d.assignments.push({
      id: 'asg_wait', objective: 'resume', briefing: 'n/a', kind: 'research', acceptanceCriteria: ['n/a'],
      dependsOn: [], state: 'queued', attempts: [{ runId: 'run_wait', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), infrastructure }],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    });
    setCapacity(d, [infrastructure]);
  });

  expediteBackoffWakes(['expedite'], () => {});
  const doc = load('expedite');
  const wake = doc.wakes[0]!;
  assert.equal(wake.condition.type, 'time');
  assert.ok(wake.condition.type === 'time' && wake.condition.dueAtVirtual <= virtualNow().toISOString());
  assert.equal(doc.assignments[0]!.attempts[0]!.infrastructure!.retryAt, wake.condition.type === 'time' ? wake.condition.dueAtVirtual : '');
  assert.equal(doc.attention[0]!.status, 'resolved');
  assert.equal(doc.capacity, null);
});

test('a model probe expedites only waits for the model that actually recovered', () => {
  make('models');
  const fable = wait('pass_fable');
  const sonnet = { ...wait('run_sonnet'), source: 'worker' as const, model: 'sonnet' };
  arrive('models', (d) => {
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

  expediteBackoffWakes(['models'], () => {}, 'claude-fable-5');
  const [fableWake, sonnetWake] = load('models').wakes;
  assert.ok(fableWake!.condition.type === 'time' && fableWake!.condition.dueAtVirtual <= virtualNow().toISOString());
  assert.equal(sonnetWake!.condition.type === 'time' ? sonnetWake!.condition.dueAtVirtual : '', sonnet.retryAt);
  assert.equal(load('models').capacity!.byModel.sonnet!.wait.model, 'sonnet');
});
