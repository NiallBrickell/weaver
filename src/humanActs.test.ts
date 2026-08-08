/**
 * Human acts must never strand a stream. The strike-triple path leaves no
 * pending wakes and its open blocker suppresses the quiescence backstop, so
 * resolving that card is the stream's only lifeline — it must wake.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveAttention } from './humanActs.js';
import { arrive, createWorkstream, load } from './store.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-human-acts-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function strandedWith(kind: 'blocker' | 'budget' | 'review', attId: string): Promise<void> {
  await createWorkstream({
    slug: 'stranded',
    title: 'stranded',
    objective: 'prove resolution wakes',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 10, maxCostUsd: 10 },
  });
  await arrive('stranded', (d) => {
    d.attention.push({
      id: attId,
      kind,
      summary: `Three coordinator passes in a row failed (${kind}) — the workstream cannot make progress without you`,
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  });
}

test('resolving a blocker card wakes the stranded stream', async () => {
  await strandedWith('blocker', 'att_strike');
  assert.equal((await load('stranded')).wakes.filter((w) => w.status === 'pending').length, 0);

  await resolveAttention('stranded', 'att_strike', 'environment repaired');

  const doc = await load('stranded');
  const pending = doc.wakes.filter((w) => w.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.condition.type, 'immediate');
  assert.match(pending[0]!.reason, /att_strike resolved .*environment repaired/);
  assert.equal(doc.attention[0]!.status, 'resolved');
});

test('resolving a review card stays wake-free — review acts wake elsewhere', async () => {
  await strandedWith('review', 'att_review');
  await resolveAttention('stranded', 'att_review');
  assert.equal((await load('stranded')).wakes.filter((w) => w.status === 'pending').length, 0);
});
