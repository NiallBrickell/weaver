/**
 * The worker-container memory ceiling is a host-survival invariant (the
 * 2026-09-18 freeze): every container gets one by default, the operator can
 * size or explicitly remove it, and a value Docker might read differently is
 * refused before any container starts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORKER_MEMORY_LIMIT, workerMemoryLimitArgs } from './containerLimits.js';

test('an unconfigured host caps every worker container at the default with no extra swap', () => {
  assert.equal(DEFAULT_WORKER_MEMORY_LIMIT, '4g');
  assert.deepEqual(workerMemoryLimitArgs(undefined), ['--memory', '4g', '--memory-swap', '4g']);
  assert.deepEqual(workerMemoryLimitArgs(''), ['--memory', '4g', '--memory-swap', '4g']);
  assert.deepEqual(workerMemoryLimitArgs('  '), ['--memory', '4g', '--memory-swap', '4g']);
});

test('an operator override is passed through normalized, and swap always equals the limit', () => {
  assert.deepEqual(workerMemoryLimitArgs('3072m'), ['--memory', '3072m', '--memory-swap', '3072m']);
  assert.deepEqual(workerMemoryLimitArgs(' 6G '), ['--memory', '6g', '--memory-swap', '6g']);
  assert.deepEqual(workerMemoryLimitArgs('512m'), ['--memory', '512m', '--memory-swap', '512m']);
  assert.deepEqual(workerMemoryLimitArgs(String(2 * 1024 ** 3)), [
    '--memory', '2147483648', '--memory-swap', '2147483648',
  ]);
});

test('only an explicit 0/none/off removes the ceiling', () => {
  for (const optOut of ['0', 'none', 'off', 'OFF', ' None ']) {
    assert.deepEqual(workerMemoryLimitArgs(optOut), [], optOut);
  }
});

test('garbage and unit mistakes are refused with the variable named, never passed to docker', () => {
  for (const bad of ['4gb', '1.5g', '4 g', '-1g', '4t', 'lots', 'unlimited', '4g;rm', '0x10g', 'false']) {
    assert.throws(() => workerMemoryLimitArgs(bad), /WEAVER_WORKER_MEMORY_LIMIT=.* is not a Docker memory size/, bad);
  }
  // A bare number is bytes to Docker; 4096 almost certainly meant megabytes.
  for (const tooSmall of ['4096', '511m', '64k', '00']) {
    assert.throws(() => workerMemoryLimitArgs(tooSmall), /needs at least 512m/, tooSmall);
  }
  assert.throws(() => workerMemoryLimitArgs('99999999999999999999g'), /outside the usable range/);
});
