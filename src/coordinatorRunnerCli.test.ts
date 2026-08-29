import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createWorkstream, load } from './store.js';

let home: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-coordinator-runners-cli-'));
  process.env.WEAVER_HOME = home;
  await createWorkstream({
    slug: 'daily-routine', title: 'Daily routine', objective: 'run every day',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function weaver(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8',
  });
}

test('coordinator-runners sets an ordered durable policy and clear restores fleet-wide claims', async () => {
  const set = weaver('coordinator-runners', 'daily-routine', 'mac-primary', 'gcp-standby');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /mac-primary → gcp-standby/);
  let doc = await load('daily-routine');
  assert.deepEqual(doc.workstream.executionPolicy?.coordinatorRunnerOrder, ['mac-primary', 'gcp-standby']);
  assert.ok(doc.events.some((event) => event.type === 'workstream.coordinator_runner_order_set'));

  const clear = weaver('coordinator-runners', 'daily-routine', '--clear');
  assert.equal(clear.status, 0, clear.stderr);
  doc = await load('daily-routine');
  assert.equal(doc.workstream.executionPolicy, undefined);
  assert.ok(doc.events.some((event) => event.type === 'workstream.coordinator_runner_order_cleared'));
});

test('coordinator-runners rejects duplicate or malformed runner ids without mutating state', async () => {
  const duplicate = weaver('coordinator-runners', 'daily-routine', 'mac-primary', 'mac-primary');
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate runner ids/);
  const malformed = weaver('coordinator-runners', 'daily-routine', 'bad runner');
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /coordinator runner id/);
  assert.equal((await load('daily-routine')).workstream.executionPolicy, undefined);
});
