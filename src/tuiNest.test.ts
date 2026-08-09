/** The board's manager-child nesting: order, depth, section inheritance. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nestUnderManagers } from './tui.js';

function row(slug: string, routine: boolean, managedBy?: string) {
  return { slug, routine, managedBy, depth: 0 } as Parameters<typeof nestUnderManagers>[0][number];
}

test('children follow their manager, indented, inheriting its section', () => {
  const streams = [
    row('fix-a', false, 'thread-review'),
    row('one-shot', false),
    row('sentry-sweep', true),
    row('thread-review', true),
  ];
  const nested = nestUnderManagers(streams);
  assert.deepEqual(nested.map((s) => s.slug), ['one-shot', 'sentry-sweep', 'thread-review', 'fix-a']);
  const fixA = nested.find((s) => s.slug === 'fix-a')!;
  assert.equal(fixA.depth, 1);
  assert.equal(fixA.routine, true, 'a child renders in its manager section');
});

test('dangling or cyclic managers fall back to root instead of vanishing', () => {
  const nested = nestUnderManagers([
    row('orphan', false, 'gone-manager'),
    row('cyc-a', false, 'cyc-b'),
    row('cyc-b', false, 'cyc-a'),
  ]);
  assert.equal(nested.length, 3);
  assert.ok(nested.every((s) => typeof s.depth === 'number'));
});
