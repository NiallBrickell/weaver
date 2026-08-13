/** Withdrawing steering the coordinator has not read yet. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPendingSteering, pendingSteering } from './steering.js';
import type { Steering } from './types.js';

function steer(over: Partial<Steering> = {}): Steering {
  return { id: 'steer_1', body: 'do the thing', at: '2026-08-13T17:00:00.000Z', ...over };
}

test('live steering is unread AND unwithdrawn', () => {
  assert.equal(isPendingSteering(steer()), true);
  assert.equal(isPendingSteering(steer({ consumedByPass: 'pass_1' })), false);
  assert.equal(isPendingSteering(steer({ revokedAt: '2026-08-13T17:05:00.000Z' })), false);
});

test('a withdrawn steer leaves the live set but stays on the record', () => {
  const all = [steer({ id: 'a' }), steer({ id: 'b', revokedAt: '2026-08-13T17:05:00.000Z' })];
  assert.deepEqual(pendingSteering(all).map((s) => s.id), ['a']);
  assert.equal(all.length, 2); // withdrawal never deletes what a human said
});

test('withdraw takes the last unread steer, refuses one a pass already read', async () => {
  const previous = process.env.WEAVER_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-steer-revoke-'));
  process.env.WEAVER_HOME = dir;
  try {
    const { createWorkstream, arrive, load } = await import('./store.js');
    const { addSteering, revokeSteering } = await import('./humanActs.js');
    await createWorkstream({
      slug: 'ws', title: 'W', objective: 'o', tags: [],
      successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });

    await addSteering('ws', 'first message');
    await addSteering('ws', 'second message, the regretted one');
    const revoked = await revokeSteering('ws');
    assert.match(revoked.body, /regretted/); // defaults to the most recent

    const after = await load('ws');
    assert.deepEqual(pendingSteering(after.steering).map((s) => s.body), ['first message']);
    assert.equal(after.steering.length, 2); // both still recorded
    assert.ok(after.events.some((e) => e.type === 'steering.revoked'));

    // Once a pass has read it, the effect is already in the record: refuse,
    // rather than pretend it can be taken back.
    await arrive('ws', (d) => { d.steering[0]!.consumedByPass = 'pass_9'; });
    await assert.rejects(
      () => revokeSteering('ws', after.steering[0]!.id),
      /already read by pass pass_9/,
    );
    await assert.rejects(() => revokeSteering('ws'), /no unread steering/);
  } finally {
    if (previous === undefined) delete process.env.WEAVER_HOME;
    else process.env.WEAVER_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
