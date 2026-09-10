import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { runCoordinatorPass } from './coordinator.js';
import { preflightApprovedAction, runActionCommand, tick, verifyAction } from './engine.js';
import { acquireRunnerLock, promoteOnRunnerVacancy, runLoop } from './runner.js';
import { assertRunnerEnabled, runnerDisabled } from './runnerIdentity.js';
import { createWorkstream, listRunnerPresence, load } from './store.js';
import { acquireTuiRunnerLock } from './tui.js';
import { runWorker } from './worker.js';

let home: string;
let saved: NodeJS.ProcessEnv;
const keys = ['WEAVER_HOME', 'WEAVER_RUNNER_DISABLED', 'WEAVER_RUNNER_ID', 'WEAVER_RUNNER_PLACEMENT_ONLY'] as const;

beforeEach(async () => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-runner-disabled-'));
  process.env.WEAVER_HOME = home;
  delete process.env.WEAVER_RUNNER_DISABLED;
  delete process.env.WEAVER_RUNNER_PLACEMENT_ONLY;
  process.env.WEAVER_RUNNER_ID = 'operator-mac';
  await createWorkstream({
    slug: 'hosted-work', title: 'Hosted work', objective: 'continue on the hosted runner',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
});

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('host execution defaults to enabled and accepts only explicit 0/1', () => {
  assert.equal(runnerDisabled({}), false);
  assert.equal(runnerDisabled({ WEAVER_RUNNER_DISABLED: '0' }), false);
  assert.equal(runnerDisabled({ WEAVER_RUNNER_DISABLED: '1' }), true);
  assert.doesNotThrow(() => assertRunnerEnabled({}));
  assert.doesNotThrow(() => assertRunnerEnabled({ WEAVER_RUNNER_DISABLED: '0' }));
  for (const value of ['', 'true', 'false', 'yes', ' 1', '2']) {
    assert.throws(() => runnerDisabled({ WEAVER_RUNNER_DISABLED: value }), /must be 0 or 1/);
  }
});

test('disabled or invalid host configuration refuses every execution boundary without touching work', async () => {
  const before = await load('hosted-work');
  const filesBefore = fs.readdirSync(home, { recursive: true }).sort();
  let ticks = 0;
  let heartbeats = 0;
  for (const value of ['1', 'invalid']) {
    process.env.WEAVER_RUNNER_DISABLED = value;
    const refused = /WEAVER_RUNNER_DISABLED/;
    await assert.rejects(runLoop({
      intervalMs: 1, concurrency: 1,
      heartbeat: async () => { heartbeats++; },
      tickFn: async () => { ticks++; throw new Error('must never tick'); },
    }), refused);
    await assert.rejects(tick('hosted-work', { maxPasses: 0 }), refused);
    process.env.WEAVER_RUNNER_PLACEMENT_ONLY = '1';
    await assert.rejects(tick('hosted-work', { engineOnly: true }), refused);
    delete process.env.WEAVER_RUNNER_PLACEMENT_ONLY;
    await assert.rejects(runCoordinatorPass('hosted-work', ['manual']), refused);
    await assert.rejects(runWorker('hosted-work', 'queued-work'), refused);
    await assert.rejects(preflightApprovedAction('hosted-work', 'action'), refused);
    await assert.rejects(verifyAction('hosted-work', 'action'), refused);
    await assert.rejects(runActionCommand('touch must-not-exist', home, {}, 1_000), refused);
    assert.deepEqual(await load('hosted-work'), before, 'no lease, attempt, wake, pause, or placement mutation');
    assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), filesBefore, 'no locks, heartbeat, or action output');
  }
  assert.equal(ticks, 0);
  assert.equal(heartbeats, 0);
  assert.deepEqual(await listRunnerPresence(), []);
});

test('operator-only TUI never claims the initial lock or promotes after a runner exits', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const held = acquireRunnerLock();
  assert.ok(held);
  process.env.WEAVER_RUNNER_DISABLED = '1';
  let promotions = 0;
  const stop = promoteOnRunnerVacancy((release) => { promotions++; release(); }, 5);
  try {
    assert.equal(acquireTuiRunnerLock(), null);
    held();
    t.mock.timers.tick(50);
    assert.equal(promotions, 0);
    assert.equal(acquireTuiRunnerLock(), null, 'a vacant runner slot still leaves the dashboard a viewer');
    assert.equal(fs.existsSync(path.join(home, '.runner.lock')), false);
  } finally {
    stop();
    held();
  }
});

test('a dashboard awaiting promotion honors disablement before its next claim', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let promotions = 0;
  const stop = promoteOnRunnerVacancy((release) => { promotions++; release(); }, 5);
  process.env.WEAVER_RUNNER_DISABLED = '1';
  try {
    t.mock.timers.tick(50);
    assert.equal(promotions, 0);
    assert.equal(fs.existsSync(path.join(home, '.runner.lock')), false);
  } finally {
    stop();
  }
});

test('explicitly enabled TUI still claims a vacant runner slot', () => {
  process.env.WEAVER_RUNNER_DISABLED = '0';
  const release = acquireTuiRunnerLock();
  assert.ok(release);
  release();
});
