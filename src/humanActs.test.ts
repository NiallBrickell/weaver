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

import { renameWorkstream, resolveAttention, setAssignmentPlacement } from './humanActs.js';
import { loadPolicies } from './policies.js';
import { arrive, createWorkstream, load, mutatePolicies } from './store.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-human-acts-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  delete process.env.WEAVER_ACTOR;
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

test('assignment placement atomically binds future work and only safe pending assignments', async () => {
  await seedSimple('placed-workstream');
  const ended = '2026-08-29T01:00:00.000Z';
  await arrive('placed-workstream', (d) => {
    const base = {
      briefing: 'b', kind: 'work' as const, acceptanceCriteria: [], dependsOn: [],
      adoption: { state: 'none' as const }, createdAtVirtual: ended,
    };
    d.assignments.push(
      { ...base, id: 'asg_queued', objective: 'queued', state: 'queued', attempts: [] },
      {
        ...base, id: 'asg_queued_retried', objective: 'queued after a settled attempt', state: 'queued',
        runnerId: 'old-runner', attempts: [{ runId: 'run_ended', runnerId: 'old-runner', startedAt: ended, endedAt: ended }],
      },
      {
        ...base, id: 'asg_queued_claimed', objective: 'queued with a live claim', state: 'queued',
        runnerId: 'old-runner', attempts: [{ runId: 'run_live_queued', runnerId: 'old-runner', startedAt: ended }],
      },
      {
        ...base, id: 'asg_gated', objective: 'gated', kind: 'action', state: 'gated', runnerId: 'old-runner',
        exec: { cwd: '/tmp', verify: 'true', ask: 'approve', approvalMode: 'human-only' }, attempts: [],
      },
      {
        ...base, id: 'asg_running', objective: 'running', state: 'running', runnerId: 'old-runner',
        attempts: [{ runId: 'run_live', runnerId: 'old-runner', startedAt: ended }],
      },
      {
        ...base, id: 'asg_review', objective: 'review', state: 'awaiting_review', runnerId: 'old-runner',
        attempts: [{ runId: 'run_review', runnerId: 'old-runner', startedAt: ended, endedAt: ended }],
      },
      { ...base, id: 'asg_completed', objective: 'completed', state: 'completed', runnerId: 'old-runner', attempts: [] },
    );
  });
  process.env.WEAVER_ACTOR = 'placement-test';

  const placed = await setAssignmentPlacement('placed-workstream', 'niall-mac-primary');
  assert.equal(placed.changed, true);
  assert.deepEqual(placed.assignmentsUpdated.sort(), ['asg_gated', 'asg_queued', 'asg_queued_retried']);
  let doc = await load('placed-workstream');
  assert.equal(doc.workstream.assignmentRunnerId, 'niall-mac-primary');
  assert.equal(doc.spend.humanInterventions, 1);
  assert.equal(doc.assignments.find((a) => a.id === 'asg_queued')!.runnerId, 'niall-mac-primary');
  assert.equal(doc.assignments.find((a) => a.id === 'asg_queued_retried')!.runnerId, 'niall-mac-primary');
  assert.equal(doc.assignments.find((a) => a.id === 'asg_gated')!.runnerId, 'niall-mac-primary');
  for (const id of ['asg_queued_claimed', 'asg_running', 'asg_review', 'asg_completed']) {
    assert.equal(doc.assignments.find((a) => a.id === id)!.runnerId, 'old-runner', `${id} must not move`);
  }
  assert.ok(doc.events.some((event) =>
    event.type === 'workstream.assignment_placement_set' &&
    event.summary.includes('placement-test set assignment placement any runner → niall-mac-primary')
  ));

  const cleared = await setAssignmentPlacement('placed-workstream');
  assert.deepEqual(cleared.assignmentsUpdated.sort(), ['asg_gated', 'asg_queued', 'asg_queued_retried']);
  doc = await load('placed-workstream');
  assert.equal(doc.workstream.assignmentRunnerId, undefined);
  assert.equal(doc.spend.humanInterventions, 2);
  for (const id of ['asg_gated', 'asg_queued', 'asg_queued_retried']) {
    assert.equal(doc.assignments.find((a) => a.id === id)!.runnerId, undefined);
  }
  assert.equal(doc.assignments.find((a) => a.id === 'asg_running')!.runnerId, 'old-runner');
});

test('assignment placement validates the durable runner name and is idempotent', async () => {
  await seedSimple('placement-validation');
  await assert.rejects(
    setAssignmentPlacement('placement-validation', 'wrong runner'),
    /assignment runner id must be 1-128 characters matching/,
  );
  assert.equal((await load('placement-validation')).workstream.assignmentRunnerId, undefined);

  await setAssignmentPlacement('placement-validation', 'mac-studio');
  const revision = (await load('placement-validation')).revision;
  const repeated = await setAssignmentPlacement('placement-validation', 'mac-studio');
  assert.equal(repeated.changed, false);
  assert.equal((await load('placement-validation')).revision, revision, 'an exact repeat is read-only');
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
