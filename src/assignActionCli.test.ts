import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { arrive, createWorkstream, load } from './store.js';

let home: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-assign-action-cli-'));
  process.env.WEAVER_HOME = home;
  await createWorkstream({
    slug: 'placed-action',
    title: 'Placed action',
    objective: 'prove exact action placement survives the CLI boundary',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function weaver(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
}

const required = [
  'assign-action', 'placed-action',
  '--objective', 'read the local daemon state',
  '--briefing', 'Run exactly the supplied observation command.',
  '--cwd', '/tmp',
  '--verify', 'test -f /tmp/daemon-status',
];

test('assign-action persists exact runner placement and observation preflight without changing human authority', async () => {
  const result = weaver(
    ...required,
    '--run', 'cat /tmp/daemon-status',
    '--runner-id', 'niall-mac-encore',
    '--preflight-mode', 'always-execute',
    '--depends-on', 'asg_prior',
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /created \(human-authored, pre-approved\)/);
  const doc = await load('placed-action');
  assert.equal(doc.assignments.length, 1);
  const assignment = doc.assignments[0]!;
  assert.equal(assignment.kind, 'action');
  assert.equal(assignment.runnerId, 'niall-mac-encore');
  assert.equal(assignment.exec?.run, 'cat /tmp/daemon-status');
  assert.equal(assignment.exec?.preflightMode, 'always-execute');
  assert.equal(assignment.exec?.approval?.by, 'human');
  assert.deepEqual(assignment.dependsOn, ['asg_prior']);
  assert.equal(assignment.state, 'queued');
  assert.equal(doc.spend.humanInterventions, 1);
  assert.ok(doc.events.some((event) => event.type === 'action.human_authored'));
});

test('assign-action rejects malformed runner placement before authoring durable work', async () => {
  const result = weaver(...required, '--run', 'true', '--runner-id', 'wrong runner');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--runner-id must be 1-128 characters matching/);
  assert.equal((await load('placed-action')).assignments.length, 0);
});

test('assign-action accepts preflight mode only for exact deterministic runs', async () => {
  const missingRun = weaver(...required, '--preflight-mode', 'always-execute');
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /--preflight-mode requires --run/);

  const invalidMode = weaver(...required, '--run', 'true', '--preflight-mode', 'sometimes');
  assert.notEqual(invalidMode.status, 0);
  assert.match(invalidMode.stderr, /--preflight-mode must be postcondition or always-execute/);
  assert.equal((await load('placed-action')).assignments.length, 0);
});

test('assign-action keeps fleet-wide placement and postcondition defaults when flags are omitted', async () => {
  const result = weaver(...required, '--run', 'true');

  assert.equal(result.status, 0, result.stderr);
  const assignment = (await load('placed-action')).assignments[0]!;
  assert.equal(assignment.runnerId, undefined);
  assert.equal(assignment.exec?.preflightMode, undefined);
  assert.equal(assignment.exec?.approval?.by, 'human');
});

test('assign-action inherits the Workstream runner binding and refuses a conflicting flag', async () => {
  await arrive('placed-action', (d) => {
    d.workstream.assignmentRunnerId = 'niall-mac-primary';
  });

  const inherited = weaver(...required, '--run', 'true');
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal((await load('placed-action')).assignments[0]!.runnerId, 'niall-mac-primary');

  const conflict = weaver(...required, '--run', 'true', '--runner-id', 'weaver-fleet');
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /conflicts with this Workstream's assignment runner 'niall-mac-primary'/);
  assert.equal((await load('placed-action')).assignments.length, 1, 'conflicting action was never persisted');
});
