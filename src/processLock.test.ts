import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { acquireProcessLock, pidIsLive } from './processLock.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-process-lock-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('only ESRCH proves a pid dead; EPERM and unknown probe failures fail closed', () => {
  const failure = (code?: string) => () => {
    throw Object.assign(new Error(code ?? 'opaque probe failure'), code ? { code } : {});
  };

  assert.equal(pidIsLive(123, failure('ESRCH')), false);
  assert.equal(pidIsLive(123, failure('EPERM')), true);
  assert.equal(pidIsLive(123, failure()), true);
  assert.equal(pidIsLive(123, () => true), true);
});

test('a live legacy owner is preserved and a dead legacy owner is reclaimed', () => {
  const lockDir = path.join(root, '.test.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));

  assert.equal(acquireProcessLock(lockDir), null);
  assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), String(process.pid));

  fs.writeFileSync(path.join(lockDir, 'pid'), '999999999');
  const release = acquireProcessLock(lockDir);
  assert.ok(release);
  assert.equal(fs.existsSync(path.join(lockDir, 'pid')), false);
  release();
  assert.equal(fs.existsSync(lockDir), false);
});

test('a predecessor release cannot delete a replacement lock', () => {
  const lockDir = path.join(root, '.test.lock');
  const releasePredecessor = acquireProcessLock(lockDir);
  assert.ok(releasePredecessor);

  // Simulate the old failure mode: another process has replaced the pathname
  // while the predecessor still retains its release callback.
  fs.rmSync(lockDir, { recursive: true });
  const releaseSuccessor = acquireProcessLock(lockDir);
  assert.ok(releaseSuccessor);

  releasePredecessor();
  assert.equal(fs.existsSync(lockDir), true);
  assert.equal(acquireProcessLock(lockDir), null);

  releaseSuccessor();
  assert.equal(fs.existsSync(lockDir), false);
});
