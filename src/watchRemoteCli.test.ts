import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { createFleetAttentionSteward } from './operatorUi.js';
import { FLEET_ATTENTION_STEWARD_SOURCE_KEY } from './fleetHealth.js';
import { arrive, heartbeatRunner, load } from './store.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-remote-watch-cli-'));
  process.env.WEAVER_HOME = home;
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

test('public create cannot claim the built-in steward identity', async () => {
  const attempted = weaver(
    'create', '--slug', 'spoofed-steward', '--title', 'Spoofed steward',
    '--objective', 'Claim the privileged built-in identity.', '--source-key', FLEET_ATTENTION_STEWARD_SOURCE_KEY,
  );
  assert.notEqual(attempted.status, 0);
  assert.match(attempted.stderr, /reserved for Weaver's built-in fleet attention steward/);
  assert.equal(fs.existsSync(path.join(home, 'spoofed-steward')), false);
});

test('watch --on starts one durable attention steward on the exact runner and exits', async () => {
  await heartbeatRunner('weaver-fleet');
  const started = weaver('watch', '--on', 'weaver-fleet');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /durable watch is running on weaver-fleet/);
  assert.match(started.stdout, /resident runner keeps the routine alive/);

  const doc = await load('fleet-attention-steward');
  assert.equal(doc.workstream.assignmentRunnerId, 'weaver-fleet');
  assert.deepEqual(doc.workstream.executionPolicy?.coordinatorRunnerOrder, ['weaver-fleet']);
  assert.equal(doc.workstream.status, 'active');
  assert.ok(doc.wakes.some((wake) => wake.status === 'pending'));
  assert.match(doc.workstream.objective, /dormant routines/);
  assert.match(doc.workstream.objective, /Unchanged counts are not evidence of health/);
  assert.ok(doc.workstream.successCriteria.some((criterion) => /live owner/.test(criterion)));
  assert.ok(doc.workstream.successCriteria.some((criterion) => /explicitly deferred/.test(criterion)));
  assert.ok(doc.workstream.constraints.some((constraint) => /Never call the fleet quiet/.test(constraint)));

  const repeated = weaver('watch', '--on', 'weaver-fleet');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal((await load('fleet-attention-steward')).workstream.sourceKey, 'weaver:fleet-attention-steward:v1');
});

test('watch --on moves an existing paused steward and wakes a dormant course', async () => {
  await createFleetAttentionSteward('test');
  await arrive('fleet-attention-steward', (doc) => {
    doc.workstream.status = 'paused';
    for (const wake of doc.wakes) {
      wake.status = 'fired';
    }
  });

  const moved = weaver('watch', '--on', 'remote-glm');
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /worker placement updated/);
  assert.match(moved.stdout, /coordinator placement updated/);
  assert.match(moved.stdout, /reactivated/);
  assert.match(moved.stdout, /woken/);

  const doc = await load('fleet-attention-steward');
  assert.equal(doc.workstream.status, 'active');
  assert.equal(doc.workstream.assignmentRunnerId, 'remote-glm');
  assert.deepEqual(doc.workstream.executionPolicy?.coordinatorRunnerOrder, ['remote-glm']);
  assert.equal(doc.wakes.filter((wake) => wake.status === 'pending').length, 1);
});

test('watch rejects ambiguous remote options instead of opening a local dashboard', () => {
  for (const args of [
    ['watch', '--on'],
    ['watch', '--on', 'bad runner'],
    ['watch', '--plain', '--on', 'weaver-fleet'],
    ['watch', '--unknown'],
  ]) {
    const result = weaver(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage|runner id|--on must/);
  }
});
