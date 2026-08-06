import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrintoutArgs, requestedPrintoutScope } from './printoutControls.js';

test('uppercase P follows selection and the fleet header; lowercase p does not open', () => {
  assert.deepEqual(requestedPrintoutScope('P', 'alpha'), { requested: true, slug: 'alpha' });
  assert.deepEqual(requestedPrintoutScope('P', undefined), { requested: true });
  assert.deepEqual(requestedPrintoutScope('p', 'alpha'), { requested: false });
});

test('CLI printout args accept one slug and --text in either order', () => {
  assert.deepEqual(parsePrintoutArgs([]), { text: false });
  assert.deepEqual(parsePrintoutArgs(['alpha']), { slug: 'alpha', text: false });
  assert.deepEqual(parsePrintoutArgs(['alpha', '--text']), { slug: 'alpha', text: true });
  assert.deepEqual(parsePrintoutArgs(['--text', 'alpha']), { slug: 'alpha', text: true });
  assert.throws(() => parsePrintoutArgs(['alpha', 'beta']), /at most one/);
  assert.throws(() => parsePrintoutArgs(['--json']), /unknown printout option/);
});
