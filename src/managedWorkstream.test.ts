/**
 * Deterministic contract tests for flat managed Workstreams: no model call,
 * no network, no SDK run anywhere in this file (testing discipline ported
 * from the relay experiment — model quality must never decide whether a
 * durability test passes). The coordinator's three MCP tools
 * (create/inspect/direct_managed_workstream) are thin wrappers over the pure
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
import { renderStatus } from './status.js';
import { renderWorkstreamHtml } from './inspect.js';
import { viewOf } from './watch.js';
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

test('create_managed_workstream builds the new doc only from explicit tool args', () => {
  makeWorkstream('mgr-a');
  // Give the manager doc decisions/events so leakage would be detectable.
  arrive('mgr-a', (d, event) => {
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
  const managed = createManagedWorkstream('mgr-a', args);

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
  assert.equal(load('mgr-a').spend.humanInterventions, 0);
  assert.equal(managed.spend.humanInterventions, 0);
});

test('a managed workstream may itself manage another (recursion)', () => {
  makeWorkstream('rec-a');
  makeManaged('rec-a', 'rec-b');
  makeManaged('rec-b', 'rec-c');

  const managedByA = listManagedBy('rec-a');
  const managedByB = listManagedBy('rec-b');
  assert.deepEqual(managedByA.map((m) => m.slug), ['rec-b']);
  assert.deepEqual(managedByB.map((m) => m.slug), ['rec-c']);
  // Never transitive: A's direct-children scan must never surface C.
  assert.ok(!managedByA.some((m) => m.slug === 'rec-c'));
});

test('duplicate notices for the same conclusion are a no-op', () => {
  makeWorkstream('note-mgr');
  makeManaged('note-mgr', 'note-child');

  const child = load('note-child');
  mutate('note-child', child.revision, (d, event) => {
    d.workstream.status = 'done';
    d.workstream.conclusion = {
      passId: 'pass_1',
      atVirtual: virtualNow().toISOString(),
      summary: 'objective met',
      evidenceIds: [],
    };
    event('workstream.concluded', 'objective met');
  });

  const first = deliverManagerNotices('note-child');
  const second = deliverManagerNotices('note-child');
  assert.equal(first, 1);
  assert.equal(second, 0);

  const notices = load('note-mgr').managerNotices ?? [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.dedupKey, 'finished:pass_1');
  assert.equal(notices[0]!.kind, 'finished');
  assert.equal(notices[0]!.fromWorkstreamSlug, 'note-child');

  // A notice is a system-derived fact re-derived from durable state, not an
  // operator act — it must never move humanInterventions on the manager.
  assert.equal(load('note-mgr').spend.humanInterventions, 0);
});

test('an open blocker does not re-fire every tick', async () => {
  makeWorkstream('blk-mgr');
  makeManaged('blk-mgr', 'blk-child');

  arrive('blk-child', (d, event) => {
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

  const mgrDoc = load('blk-mgr');
  const notices = (mgrDoc.managerNotices ?? []).filter((n) => n.dedupKey === 'attention:att_blk1');
  assert.equal(notices.length, 1);
  const noticeWakes = mgrDoc.wakes.filter((w) => w.reason.includes('blk-child'));
  assert.equal(noticeWakes.length, 1);
});

test('notice delivery survives a crash between conclude and delivery', () => {
  makeWorkstream('crash-mgr');
  makeManaged('crash-mgr', 'crash-child');

  // Simulate a coordinator pass that concluded the workstream via a direct
  // mutate (bypassing conclude_workstream's tool wiring, since that dispatch
  // path is not under test here) and then died before any tick ran delivery.
  const child = load('crash-child');
  mutate('crash-child', child.revision, (d, event) => {
    d.workstream.status = 'done';
    d.workstream.conclusion = {
      passId: 'pass_crash',
      atVirtual: virtualNow().toISOString(),
      summary: 'done despite the crash',
      evidenceIds: [],
    };
    event('workstream.concluded', 'done despite the crash');
  });
  assert.equal((load('crash-mgr').managerNotices ?? []).length, 0);

  // A later, fresh call (any subsequent tick of the managed stream, from any
  // process) repairs it — candidates are re-derived from durable facts, not
  // consumed from a queue.
  const delivered = deliverManagerNotices('crash-child');
  assert.equal(delivered, 1);
  const notices = load('crash-mgr').managerNotices ?? [];
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.dedupKey, 'finished:pass_crash');
});

test('direct_managed_workstream never increments humanInterventions on either doc', () => {
  makeWorkstream('dir-mgr');
  makeManaged('dir-mgr', 'dir-child');

  const before = {
    mgr: load('dir-mgr').spend.humanInterventions,
    child: load('dir-child').spend.humanInterventions,
  };
  directManagedWorkstream('dir-mgr', 'dir-child', 'please prioritize the login-flow bug');
  const after = {
    mgr: load('dir-mgr').spend.humanInterventions,
    child: load('dir-child').spend.humanInterventions,
  };
  assert.deepEqual(after, before);
  assert.equal(after.mgr, 0);
  assert.equal(after.child, 0);
});

test('direct_managed_workstream refuses a slug the caller does not manage', () => {
  makeWorkstream('unrel-a');
  makeWorkstream('unrel-b'); // independent — NOT managed by unrel-a

  const before = load('unrel-b');
  assert.throws(
    () => directManagedWorkstream('unrel-a', 'unrel-b', 'you must do X'),
    ManagedWorkstreamError,
  );
  assert.throws(
    () => inspectManagedWorkstream('unrel-a', 'unrel-b'),
    ManagedWorkstreamError,
  );
  const after = load('unrel-b');
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.managerDirections ?? [], []);
});

test('authority reaches exactly one hop — a grandparent cannot inspect or direct its manager\'s managed workstream', () => {
  // top-hop manages mid-hop manages leaf-hop. A naive implementation might
  // walk the `managedBy` chain transitively instead of checking the single
  // immediate pointer; this proves it does not, on both authority-checked
  // tools, with zero side effects on the unreachable target.
  makeWorkstream('top-hop');
  makeManaged('top-hop', 'mid-hop');
  makeManaged('mid-hop', 'leaf-hop');

  const before = load('leaf-hop');
  assert.throws(
    () => inspectManagedWorkstream('top-hop', 'leaf-hop'),
    ManagedWorkstreamError,
  );
  assert.throws(
    () => directManagedWorkstream('top-hop', 'leaf-hop', 'skip your direct manager, do this for me'),
    ManagedWorkstreamError,
  );
  // mid-hop, the actual direct manager, still can — proving the refusal above
  // is really about hop distance, not a broken check that refuses everyone.
  assert.doesNotThrow(() => inspectManagedWorkstream('mid-hop', 'leaf-hop'));

  const after = load('leaf-hop');
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.managerDirections ?? [], []);
});

test("a managed workstream's reconciliation is independent of its manager's status", async () => {
  makeWorkstream('indep-mgr');
  makeManaged('indep-mgr', 'indep-child');

  // Pause (and separately, conclude-shaped) the MANAGER's own doc — its
  // status must never be consulted anywhere in the managed stream's engine
  // path.
  arrive('indep-mgr', (d, event) => {
    d.workstream.status = 'paused';
    event('workstream.paused', 'paused by test');
  });
  assert.equal(load('indep-mgr').workstream.status, 'paused');

  // Give the CHILD an approved send — the same deterministic fixture
  // engine.test.ts uses to prove the send lifecycle with no model call.
  const { relPath, hash } = writeArtifact('indep-child', 'email.md', 'To: x\nSubject: y\nBody: hello');
  const intId = newId('int');
  arrive('indep-child', (d) => {
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
  const int = load('indep-child').interactions.find((i) => i.id === intId)!;
  assert.equal(int.status, 'sent');
});

test("revision conflict on the manager's audit write does not lose an already-delivered direction", () => {
  makeWorkstream('conf-mgr');
  makeManaged('conf-mgr', 'conf-child');

  const staleRevision = load('conf-mgr').revision;
  // Target-first write (what coordinator.ts's tool wrapper does before its
  // own caller-side audit write) — additive, no CAS needed, so it lands
  // unconditionally.
  const direction = directManagedWorkstream('conf-mgr', 'conf-child', 'please hurry on this one');

  // An external arrival on the manager's doc between read and the caller-side
  // audit write — the exact race the coordinator's revision-checked `change`
  // helper exists to survive.
  arrive('conf-mgr', (d, event) => event('external.arrival', 'unrelated external event landed'));

  assert.throws(
    () =>
      mutate('conf-mgr', staleRevision, (d, event) => {
        event('managed_workstream.directed', `sent direction ${direction.id} to 'conf-child'`, [direction.id]);
      }),
    RevisionConflictError,
  );

  // The target write stands regardless of the caller-side conflict — nothing
  // was lost.
  const child = load('conf-child');
  assert.equal((child.managerDirections ?? []).length, 1);
  assert.equal(child.managerDirections![0]!.id, direction.id);
  assert.equal(child.managerDirections![0]!.body, 'please hurry on this one');
});

test("revision conflict on the manager's audit write does not lose an already-created managed workstream", () => {
  makeWorkstream('conf-create-mgr');

  const staleRevision = load('conf-create-mgr').revision;
  // Single-doc creation on the new slug (what coordinator.ts's tool wrapper
  // does before its own caller-side audit write) — lands unconditionally,
  // the same as the direction case, because the new slug not existing yet
  // IS the idempotency contract, not a CAS against the manager's revision.
  const managed = createManagedWorkstream('conf-create-mgr', {
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
  arrive('conf-create-mgr', (d, event) => event('external.arrival', 'unrelated external event landed'));

  assert.throws(
    () =>
      mutate('conf-create-mgr', staleRevision, (d, event) => {
        event('managed_workstream.created', `created managed workstream '${managed.workstream.slug}'`, []);
      }),
    RevisionConflictError,
  );

  // The target still exists and is discoverable — the manager's own audit
  // event losing a race costs it a log line, never the created workstream.
  assert.equal(load('conf-created-child').workstream.managedBy?.slug, 'conf-create-mgr');
  assert.deepEqual(
    listManagedBy('conf-create-mgr').map((m) => m.slug),
    ['conf-created-child'],
  );
});

test('status/watch/inspect render managed-by/manages as flat one-liners, never a tree', () => {
  makeWorkstream('top-mgr');
  makeManaged('top-mgr', 'mid-mgr');
  makeManaged('mid-mgr', 'leaf-child');

  const leafDoc = load('leaf-child');
  const managedByLeaf = listManagedBy('leaf-child');

  const statusText = renderStatus(leafDoc, managedByLeaf);
  assert.match(statusText, /Managed by: mid-mgr/);
  assert.ok(!statusText.includes('top-mgr'));

  const html = renderWorkstreamHtml(leafDoc, [], managedByLeaf);
  assert.match(html, /managed by mid-mgr/);
  assert.ok(!html.includes('top-mgr'));

  const view = viewOf('leaf-child');
  assert.ok(view.row.includes('managed by mid-mgr'));
  assert.ok(!view.row.includes('top-mgr'));

  // The mid-level manager's own badges show its child, never its own
  // manager's manager and never mid's child's own children.
  const midDoc = load('mid-mgr');
  const midStatus = renderStatus(midDoc, listManagedBy('mid-mgr'));
  assert.match(midStatus, /Managed by: top-mgr/);
  assert.match(midStatus, /Manages: 1 workstream\(s\): leaf-child/);
});
