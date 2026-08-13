/**
 * Deterministic contract tests for flat managed Workstreams: no model call,
 * no network, no SDK run anywhere in this file (testing discipline ported
 * from the relay experiment — model quality must never decide whether a
 * durability test passes). The coordinator's three MCP tools
 * (create/inspect/direct_workstream) are thin wrappers over the pure
 * functions in managedWorkstreams.ts tested directly here, the same pattern
 * as conclusion.ts's `conclusionEvidenceLabels` (see printout.test.ts).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ManagedWorkstreamError,
  createManagedWorkstream,
  directManagedWorkstream,
  inspectManagedWorkstream,
} from './managedWorkstreams.js';
import { deliverManagerNotices, tick } from './engine.js';
import { printoutChanges } from './printoutJournal.js';
import { renderStatus } from './status.js';
import { renderWorkstreamHtml } from './inspect.js';
import { capacityHeadlineThatFits, viewOf } from './watch.js';
import {
  RevisionConflictError,
  arrive,
  createWorkstream,
  listManagedBy,
  load,
  mutate,
  newId,
  writeArtifact,
} from './store.js';
import { virtualNow } from './clock.js';

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-managed-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

function makeWorkstream(slug: string) {
  return createWorkstream({
    slug,
    title: `Title for ${slug}`,
    objective: `objective for ${slug}`,
    tags: ['test'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });
}

function makeManaged(managerSlug: string, slug: string) {
  return createManagedWorkstream(managerSlug, {
    slug,
    title: `Title for ${slug}`,
    objective: `objective for ${slug}`,
    successCriteria: [],
    constraints: [],
    tags: [],
  });
}

beforeEach(() => {
  freshHome();
  // Hermetic: never let a stray gated action reach a real pilot daemon.
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
});

// ---------------------------------------------------------------------------

test('create_workstream builds the new doc only from explicit tool args', async () => {
  await makeWorkstream('mgr-a');
  // Give the manager doc decisions/events so leakage would be detectable.
  await arrive('mgr-a', (d, event) => {
    d.decisions.push({
      id: 'dec_secret',
      title: 'Manager-only standing decision',
      rationale: 'CONFIDENTIAL manager reasoning that must never reach a managed stream',
      madeBy: 'coordinator',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
    event('decision.recorded', 'dec_secret "Manager-only standing decision" (CONFIDENTIAL)', ['dec_secret']);
  });

  const args = {
    slug: 'mgr-a-child',
    title: 'Child workstream',
    objective: 'child objective, wholly unrelated to the manager',
    successCriteria: ['done when X ships'],
    constraints: ['never touch Y'],
    tags: ['child-tag'],
  };
  const managed = await createManagedWorkstream('mgr-a', args);

  // Fields equal exactly what was passed — nothing more, nothing less.
  assert.equal(managed.workstream.slug, args.slug);
  assert.equal(managed.workstream.title, args.title);
  assert.equal(managed.workstream.objective, args.objective);
  assert.deepEqual(managed.workstream.successCriteria, args.successCriteria);
  assert.deepEqual(managed.workstream.constraints, args.constraints);
  assert.deepEqual(managed.workstream.tags, args.tags);
  assert.equal(managed.workstream.managedBy?.slug, 'mgr-a');

  // Structural anti-leak: the new doc has no decisions/events at all, and
  // none of the manager's confidential text appears anywhere in it.
  assert.equal(managed.decisions.length, 0);
  assert.ok(!JSON.stringify(managed).includes('CONFIDENTIAL'));
  assert.ok(!JSON.stringify(managed).includes('Manager-only'));

  // Seeded exactly like `weaver create`: one immediate reconciliation wake.
  assert.equal(managed.wakes.length, 1);
  assert.equal(managed.wakes[0]!.condition.type, 'immediate');

  // Delegation is not an operator act: creating a managed workstream must
  // never move the metric the learning loop optimizes against, on either doc.
  assert.equal((await load('mgr-a')).spend.humanInterventions, 0);
  assert.equal(managed.spend.humanInterventions, 0);
});

test('a managed workstream may itself manage another (recursion)', async () => {
  await makeWorkstream('rec-a');
  await makeManaged('rec-a', 'rec-b');
  await makeManaged('rec-b', 'rec-c');

  const managedByA = await listManagedBy('rec-a');
  const managedByB = await listManagedBy('rec-b');
  assert.deepEqual(managedByA.map((m) => m.slug), ['rec-b']);
  assert.deepEqual(managedByB.map((m) => m.slug), ['rec-c']);
  // Never transitive: A's direct-children scan must never surface C.
  assert.ok(!managedByA.some((m) => m.slug === 'rec-c'));
});

test('duplicate notices for the same conclusion are a no-op', async () => {
  await makeWorkstream('note-mgr');
  await makeManaged('note-mgr', 'note-child');

  const child = await load('note-child');
  await mutate('note-child', child.revision, (d, event) => {
    d.workstream.status = 'done';
    d.workstream.conclusion = {
      passId: 'pass_1',
      atVirtual: virtualNow().toISOString(),
      summary: 'objective met',
      evidenceIds: [],
    };
    event('workstream.concluded', 'objective met');
  });

  const first = await deliverManagerNotices('note-child');
  const second = await deliverManagerNotices('note-child');
  assert.equal(first, 1);
  assert.equal(second, 0);

  const notices = (await load('note-mgr')).managerNotices ?? [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.dedupKey, 'finished:pass_1');
  assert.equal(notices[0]!.kind, 'finished');
  assert.equal(notices[0]!.fromWorkstreamSlug, 'note-child');

  // A notice is a system-derived fact re-derived from durable state, not an
  // operator act — it must never move humanInterventions on the manager.
  assert.equal((await load('note-mgr')).spend.humanInterventions, 0);
});

test('manager directions and notices survive as exact typed printout changes', async () => {
  await makeWorkstream('journal-mgr');
  await makeManaged('journal-mgr', 'journal-child');

  const childBeforeDirection = await load('journal-child');
  const direction = await directManagedWorkstream('journal-mgr', 'journal-child', 'record this durable direction');
  const childAfterDirection = await load('journal-child');
  assert.ok(printoutChanges(childBeforeDirection, childAfterDirection).some(
    (change) => change.kind === 'manager_direction' && change.id === direction.id,
  ));

  await arrive('journal-child', (d, event) => {
    d.attention.push({
      id: 'att_journal',
      kind: 'blocker',
      summary: 'durable blocker notice',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    event('attention.raised', 'att_journal [blocker]', ['att_journal']);
  });
  const managerBeforeNotice = await load('journal-mgr');
  assert.equal(await deliverManagerNotices('journal-child'), 1);
  const managerAfterNotice = await load('journal-mgr');
  assert.ok(printoutChanges(managerBeforeNotice, managerAfterNotice).some(
    (change) => change.kind === 'manager_notice' && change.id === managerAfterNotice.managerNotices?.[0]?.id,
  ));
});

test('an open blocker does not re-fire every tick', async () => {
  await makeWorkstream('blk-mgr');
  await makeManaged('blk-mgr', 'blk-child');

  await arrive('blk-child', (d, event) => {
    d.attention.push({
      id: 'att_blk1',
      kind: 'blocker',
      summary: 'stuck on an unresolvable dependency',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    event('attention.raised', 'att_blk1 [blocker] stuck', ['att_blk1']);
  });

  // Three independent ticks of the MANAGED stream, exactly as the live
  // runner would perform across three polls.
  await tick('blk-child', { maxPasses: 0 });
  await tick('blk-child', { maxPasses: 0 });
  await tick('blk-child', { maxPasses: 0 });

  const mgrDoc = await load('blk-mgr');
  const notices = (mgrDoc.managerNotices ?? []).filter((n) => n.dedupKey === 'attention:att_blk1');
  assert.equal(notices.length, 1);
  const noticeWakes = mgrDoc.wakes.filter((w) => w.reason.includes('blk-child'));
  assert.equal(noticeWakes.length, 1);
});

test('notice delivery survives a crash between conclude and delivery', async () => {
  await makeWorkstream('crash-mgr');
  await makeManaged('crash-mgr', 'crash-child');

  // Simulate a coordinator pass that concluded the workstream via a direct
  // mutate (bypassing conclude_workstream's tool wiring, since that dispatch
  // path is not under test here) and then died before any tick ran delivery.
  const child = await load('crash-child');
  await mutate('crash-child', child.revision, (d, event) => {
    d.workstream.status = 'done';
    d.workstream.conclusion = {
      passId: 'pass_crash',
      atVirtual: virtualNow().toISOString(),
      summary: 'done despite the crash',
      evidenceIds: [],
    };
    event('workstream.concluded', 'done despite the crash');
  });
  assert.equal(((await load('crash-mgr')).managerNotices ?? []).length, 0);

  // A later, fresh call (any subsequent tick of the managed stream, from any
  // process) repairs it — candidates are re-derived from durable facts, not
  // consumed from a queue.
  const delivered = await deliverManagerNotices('crash-child');
  assert.equal(delivered, 1);
  const notices = (await load('crash-mgr')).managerNotices ?? [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.dedupKey, 'finished:pass_crash');
});

test('direct_workstream never increments humanInterventions on either doc', async () => {
  await makeWorkstream('dir-mgr');
  await makeManaged('dir-mgr', 'dir-child');

  const before = {
    mgr: (await load('dir-mgr')).spend.humanInterventions,
    child: (await load('dir-child')).spend.humanInterventions,
  };
  await directManagedWorkstream('dir-mgr', 'dir-child', 'please prioritize the login-flow bug');
  const after = {
    mgr: (await load('dir-mgr')).spend.humanInterventions,
    child: (await load('dir-child')).spend.humanInterventions,
  };
  assert.deepEqual(after, before);
  assert.equal(after.mgr, 0);
  assert.equal(after.child, 0);
});

test('direct_workstream refuses a slug the caller does not manage', async () => {
  await makeWorkstream('unrel-a');
  await makeWorkstream('unrel-b'); // independent — NOT managed by unrel-a

  const before = await load('unrel-b');
  await assert.rejects(
    () => directManagedWorkstream('unrel-a', 'unrel-b', 'you must do X'),
    ManagedWorkstreamError,
  );
  await assert.rejects(
    () => inspectManagedWorkstream('unrel-a', 'unrel-b'),
    ManagedWorkstreamError,
  );
  const after = await load('unrel-b');
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.managerDirections ?? [], []);
});

test('authority reaches exactly one hop — a grandparent cannot inspect or direct its manager\'s managed workstream', async () => {
  // top-hop manages mid-hop manages leaf-hop. A naive implementation might
  // walk the `managedBy` chain transitively instead of checking the single
  // immediate pointer; this proves it does not, on both authority-checked
  // tools, with zero side effects on the unreachable target.
  await makeWorkstream('top-hop');
  await makeManaged('top-hop', 'mid-hop');
  await makeManaged('mid-hop', 'leaf-hop');

  const before = await load('leaf-hop');
  await assert.rejects(
    () => inspectManagedWorkstream('top-hop', 'leaf-hop'),
    ManagedWorkstreamError,
  );
  await assert.rejects(
    () => directManagedWorkstream('top-hop', 'leaf-hop', 'skip your direct manager, do this for me'),
    ManagedWorkstreamError,
  );
  // mid-hop, the actual direct manager, still can — proving the refusal above
  // is really about hop distance, not a broken check that refuses everyone.
  await assert.doesNotReject(() => inspectManagedWorkstream('mid-hop', 'leaf-hop'));

  const after = await load('leaf-hop');
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.managerDirections ?? [], []);
});

test("a managed workstream's reconciliation is independent of its manager's status", async () => {
  await makeWorkstream('indep-mgr');
  await makeManaged('indep-mgr', 'indep-child');

  // Pause (and separately, conclude-shaped) the MANAGER's own doc — its
  // status must never be consulted anywhere in the managed stream's engine
  // path.
  await arrive('indep-mgr', (d, event) => {
    d.workstream.status = 'paused';
    event('workstream.paused', 'paused by test');
  });
  assert.equal((await load('indep-mgr')).workstream.status, 'paused');

  // Give the CHILD an approved send — the same deterministic fixture
  // engine.test.ts uses to prove the send lifecycle with no model call.
  const { relPath, hash } = await writeArtifact('indep-child', 'email.md', 'To: x\nSubject: y\nBody: hello');
  const intId = newId('int');
  await arrive('indep-child', (d) => {
    const delId = newId('del');
    d.deliverables.push({
      id: delId,
      title: 'Email',
      kind: 'outreach_email',
      path: relPath,
      contentHash: hash,
      createdAtVirtual: virtualNow().toISOString(),
      adopted: { contentHash: hash, passId: 'test', atVirtual: virtualNow().toISOString() },
    });
    d.interactions.push({
      id: intId,
      kind: 'email_send',
      to: 'someone@example.dev',
      subject: 'y',
      deliverableId: delId,
      pinnedHash: hash,
      status: 'approved',
      approvedBy: 'human',
      approvedAt: new Date().toISOString(),
      replies: [],
    });
  });

  const report = await tick('indep-child', { maxPasses: 0 });
  assert.equal(report.sendsExecuted, 1);
  const int = (await load('indep-child')).interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'sent');
});

test("revision conflict on the manager's audit write does not lose an already-delivered direction", async () => {
  await makeWorkstream('conf-mgr');
  await makeManaged('conf-mgr', 'conf-child');

  const staleRevision = (await load('conf-mgr')).revision;
  // Target-first write (what coordinator.ts's tool wrapper does before its
  // own caller-side audit write) — additive, no CAS needed, so it lands
  // unconditionally.
  const direction = await directManagedWorkstream('conf-mgr', 'conf-child', 'please hurry on this one');

  // An external arrival on the manager's doc between read and the caller-side
  // audit write — the exact race the coordinator's revision-checked `change`
  // helper exists to survive.
  await arrive('conf-mgr', (d, event) => event('external.arrival', 'unrelated external event landed'));

  await assert.rejects(
    () =>
      mutate('conf-mgr', staleRevision, (d, event) => {
        event('managed_workstream.directed', `sent direction ${direction.id} to 'conf-child'`, [direction.id]);
      }),
    RevisionConflictError,
  );

  // The target write stands regardless of the caller-side conflict — nothing
  // was lost.
  const child = await load('conf-child');
  assert.equal((child.managerDirections ?? []).length, 1);
  assert.equal(child.managerDirections![0]!.id, direction.id);
  assert.equal(child.managerDirections![0]!.body, 'please hurry on this one');
});

test("revision conflict on the manager's audit write does not lose an already-created managed workstream", async () => {
  await makeWorkstream('conf-create-mgr');

  const staleRevision = (await load('conf-create-mgr')).revision;
  // Single-doc creation on the new slug (what coordinator.ts's tool wrapper
  // does before its own caller-side audit write) — lands unconditionally,
  // the same as the direction case, because the new slug not existing yet
  // IS the idempotency contract, not a CAS against the manager's revision.
  const managed = await createManagedWorkstream('conf-create-mgr', {
    slug: 'conf-created-child',
    title: 'Created under a race',
    objective: 'exist regardless of what happens to the manager audit write',
    successCriteria: [],
    constraints: [],
    tags: [],
  });

  // An external arrival on the manager's doc between read and the caller-side
  // audit write — the exact race coordinator.ts's revision-checked `change`
  // helper exists to survive.
  await arrive('conf-create-mgr', (d, event) => event('external.arrival', 'unrelated external event landed'));

  await assert.rejects(
    () =>
      mutate('conf-create-mgr', staleRevision, (d, event) => {
        event('managed_workstream.created', `created managed workstream '${managed.workstream.slug}'`, []);
      }),
    RevisionConflictError,
  );

  // The target still exists and is discoverable — the manager's own audit
  // event losing a race costs it a log line, never the created workstream.
  assert.equal((await load('conf-created-child')).workstream.managedBy?.slug, 'conf-create-mgr');
  assert.deepEqual(
    (await listManagedBy('conf-create-mgr')).map((m) => m.slug),
    ['conf-created-child'],
  );
});

test('status/watch/inspect render managed-by/manages as flat one-liners, never a tree', async () => {
  await makeWorkstream('top-mgr');
  await makeManaged('top-mgr', 'mid-mgr');
  await makeManaged('mid-mgr', 'leaf-child');

  const leafDoc = await load('leaf-child');
  const managedByLeaf = await listManagedBy('leaf-child');

  const statusText = renderStatus(leafDoc, managedByLeaf);
  assert.match(statusText, /Managed by: mid-mgr/);
  assert.ok(!statusText.includes('top-mgr'));

  const html = renderWorkstreamHtml(leafDoc, [], managedByLeaf);
  assert.match(html, /managed by mid-mgr/);
  assert.ok(!html.includes('top-mgr'));

  const view = await viewOf('leaf-child');
  assert.ok(view.row.includes('managed by mid-mgr'));
  assert.ok(!view.row.includes('top-mgr'));

  // The mid-level manager's own badges show its child, never its own
  // manager's manager and never mid's child's own children.
  const midDoc = await load('mid-mgr');
  const midStatus = renderStatus(midDoc, await listManagedBy('mid-mgr'));
  assert.match(midStatus, /Managed by: top-mgr/);
  assert.match(midStatus, /Manages: 1 workstream\(s\): leaf-child/);
});

test('compact watch rows show durable elapsed activity, never billing/activity counters as progress', async () => {
  await makeWorkstream('compact-row');
  const before = await load('compact-row');
  await mutate('compact-row', before.revision, (doc) => {
    doc.spend.totalCostUsd = 12.34;
    doc.spend.coordinatorPasses = 7;
    doc.spend.humanInterventions = 3;
    doc.decisions.push({
      id: 'dec_compact', title: 'Keep moving', rationale: 'Evidence', madeBy: 'coordinator',
      status: 'standing', decidedAtVirtual: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    doc.assignments.push({
      id: 'asg_compact', objective: 'work in flight', briefing: 'work', kind: 'work', acceptanceCriteria: [],
      dependsOn: [], state: 'running', attempts: [{ runId: 'run_compact', model: 'sonnet', startedAt: new Date(Date.now() - 12 * 60_000).toISOString() }],
      adoption: { state: 'none' }, createdAtVirtual: new Date().toISOString(),
    });
    const staleWait = {
      kind: 'usage_limit' as const,
      recovery: 'wait_or_enable_usage_credits' as const,
      source: 'coordinator' as const,
      sourceId: 'pass_old_capacity',
      model: 'claude-fable-5',
      executor: 'local-sdk',
      provider: 'anthropic',
      detectedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      retryAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    doc.capacity = {
      state: 'backoff',
      byModel: {
        'local-sdk:anthropic:claude-fable-5': {
          wait: staleWait,
          consecutiveBackoffs: 1,
          firstBackoffAtVirtual: staleWait.detectedAt,
          lastBackoffAtVirtual: staleWait.detectedAt,
        },
      },
    };
  });

  const view = await viewOf('compact-row');
  assert.match(view.row, /WORKING/);
  assert.match(view.row, /12m in flight · decision 1h ago/);
  assert.doesNotMatch(view.row, /\$|passes|interventions|you \d+×|turns|▰|▱/);
  assert.doesNotMatch(view.row, /WAITING/);
  assert.ok(!view.details.some((line) => line.includes('pass_old_capacity')));
});

test('plain watch keeps optional capacity headroom inside a narrow header', () => {
  const headline = '⚠ Claude 5h 18% left · resets in 2h';
  assert.equal(capacityHeadlineThatFits(headline, headline.length + 3), headline);
  assert.equal(capacityHeadlineThatFits(headline, headline.length + 2), undefined);
});
