/**
 * Deterministic store-contract tests: no model, no network, no SDK run.
 * (Testing discipline ported from the relay experiment: model quality must
 * never be able to make a durability test pass or fail.)
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  RevisionConflictError,
  createWorkstream,
  load,
  mutate,
  arrive,
  newId,
  writeArtifact,
  verifyArtifact,
  artifactsDir,
} from './store.js';
import { virtualNow } from './clock.js';

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

function makeWorkstream(slug = 'test-ws') {
  return createWorkstream({
    slug,
    title: 'Test',
    objective: 'test objective',
    tags: ['test'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

beforeEach(() => {
  freshHome();
});

test('a stale write is rejected with RevisionConflictError and mutates nothing', () => {
  makeWorkstream();
  const doc = load('test-ws');
  assert.throws(
    () => mutate('test-ws', doc.revision - 1, (d) => (d.workstream.title = 'clobbered')),
    RevisionConflictError,
  );
  assert.throws(() => mutate('test-ws', doc.revision + 1, () => {}), RevisionConflictError);
  assert.equal(load('test-ws').workstream.title, 'Test');
  assert.equal(load('test-ws').revision, doc.revision);
});

test('a checked write bumps the revision by exactly one and appends an event', () => {
  makeWorkstream();
  const before = load('test-ws');
  mutate('test-ws', before.revision, (d, event) => {
    event('test.event', 'hello');
  });
  const after = load('test-ws');
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.events[after.events.length - 1]!.summary, 'hello');
});

test('an external arrival between read and write conflicts an in-flight coordinator write', () => {
  makeWorkstream();
  const coordinatorRead = load('test-ws').revision;
  // External arrival (steer/reply/completion) lands after the coordinator read.
  arrive('test-ws', (d, event) => event('external.arrival', 'reply landed'));
  assert.throws(
    () => mutate('test-ws', coordinatorRead, (d) => (d.workstream.title = 'stale winner')),
    RevisionConflictError,
  );
});

test('simultaneous cross-process arrivals serialize without losing a revision', async () => {
  makeWorkstream();
  const home = process.env.WEAVER_HOME!;
  const gate = path.join(home, 'arrival-gate');
  const storeUrl = pathToFileURL(path.resolve('src/store.ts')).href;
  const count = 8;
  const children = Array.from({ length: count }, (_, index) => {
    const ready = path.join(home, `ready-${index}`);
    const code = `
      import fs from 'node:fs';
      const { arrive } = await import(${JSON.stringify(storeUrl)});
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
      arrive('test-ws', (doc) => doc.workstream.constraints.push(${JSON.stringify(`arrival-${index}`)}));
    `;
    return new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
        cwd: process.cwd(),
        env: { ...process.env, WEAVER_HOME: home },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (exitCode) => resolve({ code: exitCode, stderr }));
    });
  });
  const deadline = Date.now() + 10_000;
  while (fs.readdirSync(home).filter((name) => name.startsWith('ready-')).length < count) {
    if (Date.now() > deadline) throw new Error('child arrival barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(gate, 'go');
  const results = await Promise.all(children);
  assert.deepEqual(results, Array.from({ length: count }, () => ({ code: 0, stderr: '' })));
  const doc = load('test-ws');
  assert.equal(doc.revision, count);
  assert.deepEqual([...doc.workstream.constraints].sort(), Array.from({ length: count }, (_, index) => `arrival-${index}`));
  assert.equal(fs.readdirSync(path.join(home, 'test-ws', 'printout', 'revisions')).length, count + 1);
});

test('adoption pins the exact content hash and integrity verification catches tampering', () => {
  makeWorkstream();
  const { relPath, hash } = writeArtifact('test-ws', 'draft.md', 'the exact adopted content');
  arrive('test-ws', (d) => {
    d.deliverables.push({
      id: newId('del'),
      title: 'Draft',
      kind: 'document',
      path: relPath,
      contentHash: hash,
      createdAtVirtual: virtualNow().toISOString(),
      adopted: { contentHash: hash, passId: 'test', atVirtual: virtualNow().toISOString() },
    });
  });
  assert.ok(verifyArtifact('test-ws', relPath, hash));

  // Tamper with the on-disk artifact: the pinned hash must catch it.
  fs.writeFileSync(path.join(artifactsDir('test-ws'), relPath), 'silently drifted content');
  assert.equal(verifyArtifact('test-ws', relPath, hash), false);
});

test('artifact content is content-addressed: identical content yields the identical hash', () => {
  makeWorkstream();
  const a = writeArtifact('test-ws', 'a.md', 'same content');
  const b = writeArtifact('test-ws', 'b.md', 'same content');
  assert.equal(a.hash, b.hash);
  const c = writeArtifact('test-ws', 'c.md', 'different content');
  assert.notEqual(a.hash, c.hash);
});
