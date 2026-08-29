import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { arrive, createWorkstream, load } from './store.js';

let home: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-placement-cli-'));
  process.env.WEAVER_HOME = home;
  await createWorkstream({
    slug: 'machine-routine',
    title: 'Machine routine',
    objective: 'keep machine-local work on its execution host',
    tags: ['routine'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  await arrive('machine-routine', (d) => {
    d.assignments.push({
      id: 'asg_pending', objective: 'inspect the local daemon', briefing: 'b', kind: 'work',
      acceptanceCriteria: [], dependsOn: [], state: 'queued', attempts: [],
      adoption: { state: 'none' }, createdAtVirtual: new Date().toISOString(),
    });
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

test('placement CLI binds and clears the Workstream plus safely pending assignments', async () => {
  const placed = weaver('placement', 'machine-routine', 'niall-mac-primary');
  assert.equal(placed.status, 0, placed.stderr);
  assert.match(placed.stdout, /assignments bound to niall-mac-primary; 1 queued\/gated assignment\(s\) updated/);
  let doc = await load('machine-routine');
  assert.equal(doc.workstream.assignmentRunnerId, 'niall-mac-primary');
  assert.equal(doc.assignments[0]!.runnerId, 'niall-mac-primary');

  const cleared = weaver('placement', 'machine-routine', 'any');
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stdout, /assignments restored to fleet-wide placement; 1 queued\/gated assignment\(s\) updated/);
  doc = await load('machine-routine');
  assert.equal(doc.workstream.assignmentRunnerId, undefined);
  assert.equal(doc.assignments[0]!.runnerId, undefined);
});

test('placement CLI rejects malformed or ambiguous targets without changing state', async () => {
  const invalid = weaver('placement', 'machine-routine', 'wrong runner');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /runner id must be 1-128 characters matching/);

  const extra = weaver('placement', 'machine-routine', 'niall-mac-primary', 'extra');
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /usage: weaver placement/);

  const doc = await load('machine-routine');
  assert.equal(doc.workstream.assignmentRunnerId, undefined);
  assert.equal(doc.assignments[0]!.runnerId, undefined);
});
