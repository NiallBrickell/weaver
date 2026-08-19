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

import { renameWorkstream, resolveAttention } from './humanActs.js';
import { loadPolicies } from './policies.js';
import { arrive, createWorkstream, load, mutatePolicies } from './store.js';

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

test('resolving a review card without a note stays wake-free — review acts wake elsewhere', async () => {
  await strandedWith('review', 'att_review');
  await resolveAttention('stranded', 'att_review');
  assert.equal((await load('stranded')).wakes.filter((w) => w.status === 'pending').length, 0);
});

test('a resolution carrying a note is an answer and wakes the stream regardless of kind', async () => {
  await strandedWith('review', 'att_decision');
  await resolveAttention('stranded', 'att_decision', 'approved: promote the flag globally');

  const doc = await load('stranded');
  const pending = doc.wakes.filter((w) => w.status === 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.condition.type, 'immediate');
  assert.match(pending[0]!.reason, /att_decision resolved .*promote the flag globally/);
});

// --- renameWorkstream: cross-document pointer repair on top of the store move ---

async function seedSimple(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: `title of ${slug}`,
    objective: 'o',
    tags: ['test'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 10, maxCostUsd: 10 },
  });
}

test('renameWorkstream repairs manager pointers and notices on other docs', async () => {
  await seedSimple('manager-old');
  await seedSimple('managed-child');
  await seedSimple('bystander');
  await arrive('managed-child', (d) => {
    d.workstream.managedBy = { slug: 'manager-old', sinceVirtual: new Date().toISOString() };
    d.managerDirections = [
      { id: 'dir_1', fromWorkstreamSlug: 'manager-old', body: 'advisory', atVirtual: new Date().toISOString() },
    ];
  });
  await arrive('manager-old', (d) => {
    d.managerNotices = [
      {
        id: 'not_1',
        dedupKey: 'k',
        kind: 'finished',
        fromWorkstreamSlug: 'managed-child',
        summary: 's',
        receivedAtVirtual: new Date().toISOString(),
      },
    ];
  });

  const r = await renameWorkstream('manager-old', 'manager-new');
  assert.equal(r.title, 'title of manager-old');
  assert.deepEqual(r.pointersUpdated, ['managed-child']); // the bystander is untouched
  const child = await load('managed-child');
  assert.equal(child.workstream.managedBy!.slug, 'manager-new');
  assert.equal(child.managerDirections![0]!.fromWorkstreamSlug, 'manager-new');
  assert.ok(child.events.some((e) => e.type === 'workstream.manager_renamed'));
  // The renamed manager keeps its own notices (they reference the child, not itself).
  assert.equal((await load('manager-new')).managerNotices![0]!.fromWorkstreamSlug, 'managed-child');
  assert.ok(!child.wakes.some((w) => w.status === 'pending')); // naming is not steering: no wake
});

test('renameWorkstream carries policy attribution to the new name', async () => {
  await seedSimple('proposer-old');
  await mutatePolicies((s) => {
    s.policies.push({
      id: 'pol_rename',
      statement: 'test policy',
      scope: { tags: ['test'] },
      effect: { kind: 'advisory', description: 'd' },
      widensAuthority: false,
      status: 'shadow',
      provenance: { workstreamSlug: 'proposer-old', passId: 'pass_1', interventionSummary: 'i' },
      evidence: [
        { workstreamSlug: 'proposer-old', passId: 'pass_1', note: 'n', interventionFree: true, at: new Date().toISOString() },
      ],
      createdAt: new Date().toISOString(),
    });
  });

  const r = await renameWorkstream('proposer-old', 'proposer-new');
  assert.equal(r.policiesUpdated, 1);
  const pol = (await loadPolicies()).policies.find((p) => p.id === 'pol_rename')!;
  assert.equal('workstreamSlug' in pol.provenance && pol.provenance.workstreamSlug, 'proposer-new');
  assert.equal(pol.evidence[0]!.workstreamSlug, 'proposer-new');
});
