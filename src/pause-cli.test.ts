import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { arrive, createWorkstream, load } from './store.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-pause-cli-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function make(slug: string, status: 'active' | 'paused' | 'done' = 'active'): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: `advance ${slug}`,
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  if (status !== 'active') {
    await arrive(slug, (doc) => {
      doc.workstream.status = status;
    });
  }
}

function weaver(...args: string[]): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
}

async function revisions(slugs: string[]): Promise<Record<string, number>> {
  return Object.fromEntries(await Promise.all(slugs.map(async (slug) => [slug, (await load(slug)).revision])));
}

test('pause without a slug pauses the active fleet and is idempotent', async () => {
  // Deliberately create these out of lexical order: output is stable and
  // useful to an operator regardless of filesystem enumeration order.
  await make('active-zulu');
  await make('done-one', 'done');
  await make('paused-one', 'paused');
  await make('active-alpha');
  const slugs = ['active-alpha', 'active-zulu', 'paused-one', 'done-one'];
  const before = await revisions(slugs);

  const firstOutput = weaver('pause');

  assert.equal(
    firstOutput,
    'paused 2 active workstream(s): active-alpha, active-zulu\n' +
      'unchanged: 1 already paused (paused-one); 1 done (done-one)\n',
  );
  assert.equal((await load('active-alpha')).workstream.status, 'paused');
  assert.equal((await load('active-zulu')).workstream.status, 'paused');
  assert.equal((await load('paused-one')).workstream.status, 'paused');
  assert.equal((await load('done-one')).workstream.status, 'done');

  const afterFirst = await revisions(slugs);
  assert.equal(afterFirst['active-alpha'], before['active-alpha']! + 1);
  assert.equal(afterFirst['active-zulu'], before['active-zulu']! + 1);
  assert.equal(afterFirst['paused-one'], before['paused-one']);
  assert.equal(afterFirst['done-one'], before['done-one']);

  const secondOutput = weaver('pause');

  assert.equal(
    secondOutput,
    'paused 0 active workstream(s)\n' +
      'unchanged: 3 already paused (active-alpha, active-zulu, paused-one); 1 done (done-one)\n',
  );
  assert.deepEqual(await revisions(slugs), afterFirst);
});

test('pause and resume with a slug remain targeted and never revive done work', async () => {
  await make('target');
  await make('untouched');
  await make('finished', 'done');

  const untouchedRevision = (await load('untouched')).revision;
  assert.equal(weaver('pause', 'target'), 'target is now paused\n');
  assert.equal((await load('target')).workstream.status, 'paused');
  assert.equal((await load('untouched')).workstream.status, 'active');
  assert.equal((await load('untouched')).revision, untouchedRevision);

  assert.equal(weaver('resume', 'target'), 'target is now active\n');
  assert.equal((await load('target')).workstream.status, 'active');
  assert.equal((await load('untouched')).workstream.status, 'active');
  assert.equal((await load('untouched')).revision, untouchedRevision);

  const doneRevision = (await load('finished')).revision;
  assert.equal(weaver('pause', 'finished'), 'finished is done; status unchanged\n');
  assert.equal(weaver('resume', 'finished'), 'finished is done; status unchanged\n');
  assert.equal((await load('finished')).workstream.status, 'done');
  assert.equal((await load('finished')).revision, doneRevision);
});

test('fleet pause changes healthy streams but fails loudly when one record is unreadable', async () => {
  await make('healthy');
  const brokenDir = path.join(home, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'workstream.json'), '{ invalid json');

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'pause'],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /paused 1 active workstream\(s\): healthy/);
  assert.match(result.stderr, /failed to pause 1 workstream\(s\): broken:/);
  assert.equal((await load('healthy')).workstream.status, 'paused');
});
