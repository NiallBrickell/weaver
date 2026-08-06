import { test } from 'node:test';
import assert from 'node:assert/strict';

import { printoutModalCommand, requestedPrintoutScope } from './printoutControls.js';

test('uppercase P follows selection and the fleet header; lowercase p does not open', () => {
  assert.deepEqual(requestedPrintoutScope('P', 'alpha'), { requested: true, slug: 'alpha' });
  assert.deepEqual(requestedPrintoutScope('P', undefined), { requested: true });
  assert.deepEqual(requestedPrintoutScope('p', 'alpha'), { requested: false });
});

test('modal keys pin close, copy, line/page scrolling, resize clamping, and mutation swallowing', () => {
  assert.deepEqual(printoutModalCommand('', { escape: true }, 10, 20, 5), { kind: 'close' });
  assert.deepEqual(printoutModalCommand('C', {}, 0, 20, 5), { kind: 'copy' });
  assert.deepEqual(printoutModalCommand('j', {}, 2, 20, 5), { kind: 'scroll', to: 3 });
  assert.deepEqual(printoutModalCommand('', { upArrow: true }, 2, 20, 5), { kind: 'scroll', to: 1 });
  assert.deepEqual(printoutModalCommand(']', {}, 18, 20, 5), { kind: 'scroll', to: 20 });
  assert.deepEqual(printoutModalCommand('[', {}, 3, 20, 5), { kind: 'scroll', to: 0 });
  assert.deepEqual(printoutModalCommand('k', {}, 99, 20, 5), { kind: 'scroll', to: 19 });
  assert.deepEqual(printoutModalCommand('a', {}, 4, 20, 5), { kind: 'ignore' });
  assert.deepEqual(printoutModalCommand('p', {}, 4, 20, 5), { kind: 'ignore' });
});
