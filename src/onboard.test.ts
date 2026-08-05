import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveFallback, parseDerivation, sanitizeSlug } from './onboard.js';

test('sanitizeSlug: kebabs, bounds, and dodges collisions', () => {
  const taken = new Set(['upload-bug', 'upload-bug-2']);
  assert.equal(sanitizeSlug('Upload BUG!!', new Set()), 'upload-bug');
  assert.equal(sanitizeSlug('upload bug', taken), 'upload-bug-3');
  assert.equal(sanitizeSlug('///', new Set()), 'task');
  assert.ok(sanitizeSlug('x'.repeat(100), new Set()).length <= 40);
});

test('deriveFallback: the message survives verbatim as the objective', () => {
  const msg = 'a user hit an upload issue yesterday, no progress bar, check PostHog';
  const d = deriveFallback(msg, new Set());
  assert.equal(d.objective, msg);
  assert.equal(d.routine, false);
  assert.match(d.slug, /^[a-z0-9-]+$/);
});

test('parseDerivation: fenced JSON parses; garbage and missing fields do not', () => {
  const ok = parseDerivation(
    'Here you go:\n```json\n{"slug":"Fix Upload","title":"t","objective":"o","successCriteria":["a",3],"routine":true}\n```',
    new Set(),
  );
  assert.ok(ok);
  assert.equal(ok.slug, 'fix-upload');
  assert.deepEqual(ok.successCriteria, ['a']);
  assert.equal(ok.routine, true);
  assert.equal(parseDerivation('no json here', new Set()), null);
  assert.equal(parseDerivation('{"title":"only"}', new Set()), null);
});
