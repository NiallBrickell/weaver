import assert from 'node:assert/strict';
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
