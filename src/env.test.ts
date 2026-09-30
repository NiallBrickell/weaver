import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadDotenv } from './env.js';

test('loadDotenv fills unset vars but never overrides what the environment already set', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-env-')), '.env');
  fs.writeFileSync(file, '# a comment\nWEAVER_TEST_FILL=from_file\nWEAVER_TEST_KEEP=from_file\n');

  delete process.env.WEAVER_TEST_FILL;
  process.env.WEAVER_TEST_KEEP = 'from_env';
  try {
    loadDotenv(file);
    assert.equal(process.env.WEAVER_TEST_FILL, 'from_file', 'an unset var is filled from the file');
    assert.equal(process.env.WEAVER_TEST_KEEP, 'from_env', 'an explicit export is never overridden');
  } finally {
    delete process.env.WEAVER_TEST_FILL;
    delete process.env.WEAVER_TEST_KEEP;
  }
});

test('loadDotenv is a no-op when no .env is present', () => {
  const absent = path.join(os.tmpdir(), `weaver-no-such-env-${process.pid}.env`);
  assert.doesNotThrow(() => loadDotenv(absent));
});

test('a CLI spawned under the test runner never reads the checkout .env', () => {
  // The guard keys on NODE_TEST_CONTEXT, which node:test sets for this file and
  // every process it spawns; if it ever stops being inherited the guard is dead.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node:test must mark this process');
  const cli = fs.readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /if \(!process\.env\.NODE_TEST_CONTEXT\) loadDotenv\(\);/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-ctx-'));
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, 'console.log(process.env.NODE_TEST_CONTEXT ?? "")');
  assert.notEqual(execFileSync(process.execPath, [probe], { env: process.env }).toString().trim(), '');
});
