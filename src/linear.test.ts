/**
 * Deterministic Linear-intake contract tests: no model, no network. The sweep
 * is driven with hand-built LinearIssue batches; the invariants under test are
 * idempotency (at-least-once delivery → exactly-once state), the marker
 * firewall (Weaver's own egress never re-enters as input), and wake coalescing.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  LinearIssue,
  LinearMirrorState,
  loadMirror,
  mirrorPath,
  saveMirror,
  sweepIssues,
  WEAVER_COMMENT_MARKER,
} from './linear.js';
import { listWorkstreams, load } from './store.js';

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-linear-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'uuid-1',
    identifier: 'ERDO-414',
    title: 'Landing pages: SMS consent disclaimer in modals',
    description: 'Add the disclaimer under the phone field.',
    url: 'https://linear.app/erdoai/issue/ERDO-414/x',
    updatedAt: '2026-08-07T10:00:00.000Z',
    stateName: 'Backlog',
    stateType: 'backlog',
    comments: [],
    ...overrides,
  };
}

function mirror(): LinearMirrorState {
  return { schemaVersion: 1, cursor: null, issues: {} };
}

beforeEach(() => {
  freshHome();
});

test('a labeled issue becomes a workstream: constraints, tags, initial wake, mirror entry', () => {
  const m = mirror();
  const r = sweepIssues([issue()], m);

  assert.equal(r.created.length, 1);
  const slug = r.created[0]!.slug;
  assert.match(slug, /^erdo-414/);
  assert.deepEqual(listWorkstreams(), [slug]);

  const doc = load(slug);
  assert.ok(doc.workstream.tags.includes('linear'));
  assert.ok(doc.workstream.objective.includes('ERDO-414'));
  assert.ok(doc.workstream.objective.includes('Add the disclaimer'));
  // Post-back lifecycle rides constraints; the secret is referenced by NAME.
  const joined = doc.workstream.constraints.join('\n');
  assert.ok(joined.includes('$LINEAR_API_KEY'));
  assert.ok(joined.includes('uuid-1'));
  assert.ok(joined.includes('never re-post'));
  // Creation wakes the coordinator.
  assert.equal(doc.wakes.filter((w) => w.status === 'pending').length, 1);
  assert.equal(m.issues['uuid-1']!.slug, slug);
});

test('re-sweeping the same batch is a no-op: no duplicate workstream, no writes', () => {
  const m = mirror();
  sweepIssues([issue()], m);
  const slug = m.issues['uuid-1']!.slug;
  const before = load(slug).revision;

  const r2 = sweepIssues([issue()], m);
  assert.equal(r2.created.length, 0);
  assert.equal(r2.observations.length, 0);
  assert.equal(load(slug).revision, before, 'idle re-sweep must not bump the revision');
});

test('new comments arrive once as observations with ingressKey, coalesced into one wake', () => {
  const m = mirror();
  sweepIssues([issue()], m);
  const slug = m.issues['uuid-1']!.slug;

  const withComments = issue({
    comments: [
      { id: 'c1', body: 'please also cover the footer form', author: 'Niall', createdAt: '2026-08-07T11:00:00.000Z' },
      { id: 'c2', body: 'and the modal on /contact', author: 'Andrei', createdAt: '2026-08-07T11:01:00.000Z' },
    ],
  });
  const r = sweepIssues([withComments], m);
  assert.deepEqual(r.observations, [{ slug, count: 2 }]);

  const doc = load(slug);
  const obs = doc.observations;
  assert.equal(obs.length, 2);
  assert.equal(obs[0]!.ingressKey, 'linear-comment:c1');
  assert.ok(obs[0]!.summary.includes('Niall'));
  assert.ok(obs[0]!.summary.includes('footer form'));
  // Both comments coalesce into ONE new wake (plus the creation wake).
  assert.equal(doc.wakes.length, 2);

  // At-least-once delivery: the same comments arriving again change nothing.
  const again = sweepIssues([withComments], m);
  assert.equal(again.observations.length, 0);
  assert.equal(load(slug).observations.length, 2);
});

test('comments carrying the weaver marker are egress echoes, never intake', () => {
  const m = mirror();
  sweepIssues([issue()], m);
  const slug = m.issues['uuid-1']!.slug;

  const echo = issue({
    comments: [
      {
        id: 'c9',
        body: `Shipped in PR #12.\n\n${WEAVER_COMMENT_MARKER} ${slug} tok123]`,
        author: 'Niall',
        createdAt: '2026-08-07T12:00:00.000Z',
      },
    ],
  });
  const r = sweepIssues([echo], m);
  assert.equal(r.observations.length, 0);
  assert.equal(load(slug).observations.length, 0);
});

test('an issue already Done/Canceled at first sight is not mirrored', () => {
  const m = mirror();
  const r = sweepIssues([issue({ stateType: 'completed', stateName: 'Done' })], m);
  assert.equal(r.created.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(listWorkstreams(), []);
  assert.equal(m.issues['uuid-1'], undefined);
});

test('a human closing a mirrored issue arrives once as a reconcile observation', () => {
  const m = mirror();
  sweepIssues([issue()], m);
  const slug = m.issues['uuid-1']!.slug;

  const closed = issue({ stateType: 'canceled', stateName: 'Canceled' });
  const r = sweepIssues([closed], m);
  assert.deepEqual(r.observations, [{ slug, count: 1 }]);
  const obs = load(slug).observations;
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.ingressKey, 'linear-state:uuid-1:canceled');
  assert.ok(obs[0]!.summary.includes('conclude or pause'));

  // Redelivery of the closed state is a no-op.
  assert.equal(sweepIssues([closed], m).observations.length, 0);
});

test('Weaver moving the issue to Done does not echo back into the concluded stream', async () => {
  const m = mirror();
  sweepIssues([issue()], m);
  const slug = m.issues['uuid-1']!.slug;
  const { arrive } = await import('./store.js');
  arrive(slug, (d) => {
    d.workstream.status = 'done';
  });
  const rev = load(slug).revision;

  const r = sweepIssues([issue({ stateType: 'completed', stateName: 'Done' })], m);
  assert.equal(r.observations.length, 0);
  assert.equal(load(slug).revision, rev, 'a finished stream must not be woken by its own egress');
});

test('cursor advances to the max updatedAt seen and never regresses', () => {
  const m = mirror();
  sweepIssues(
    [
      issue({ updatedAt: '2026-08-07T10:00:00.000Z' }),
      issue({ id: 'uuid-2', identifier: 'ERDO-415', updatedAt: '2026-08-07T12:00:00.000Z' }),
    ],
    m,
  );
  assert.equal(m.cursor, '2026-08-07T12:00:00.000Z');
  sweepIssues([issue({ updatedAt: '2026-08-07T11:00:00.000Z' })], m);
  assert.equal(m.cursor, '2026-08-07T12:00:00.000Z');
});

test('mirror state round-trips through WEAVER_HOME/linear.json', () => {
  const m = mirror();
  sweepIssues([issue()], m);
  saveMirror(m);
  assert.ok(fs.existsSync(mirrorPath()));
  const back = loadMirror();
  assert.deepEqual(back, m);
});

test('slug collisions with existing workstreams are suffixed, not clobbered', () => {
  const m1 = mirror();
  sweepIssues([issue()], m1);
  // A second, different Linear issue whose identifier+title collide.
  const m2 = mirror();
  const r = sweepIssues([issue({ id: 'uuid-9' })], m2);
  assert.equal(r.created.length, 1);
  assert.notEqual(r.created[0]!.slug, m1.issues['uuid-1']!.slug);
  assert.equal(listWorkstreams().length, 2);
});

test('a poisoned issue is isolated and reported; the rest of the sweep proceeds', async () => {
  // A secret VALUE pasted into an issue body trips the store's write guard.
  // That issue must surface in `skipped` — not wedge the sweep or block
  // sibling issues.
  const { setSecret } = await import('./secrets.js');
  setSecret('POISON_TOKEN', 'sekret-value-123');
  const m = mirror();
  const poisoned = issue({ description: 'creds are sekret-value-123, use them' });
  const good = issue({ id: 'uuid-2', identifier: 'ERDO-500', title: 'A clean issue' });

  const r = sweepIssues([poisoned, good], m);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]!.identifier, 'ERDO-414');
  assert.match(r.skipped[0]!.reason, /secret/i);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0]!.identifier, 'ERDO-500');
  assert.equal(m.issues['uuid-1'], undefined);
});

test('a lost mirror file yields a suffixed sibling, never a clobbered stream', () => {
  // Losing linear.json means the issue looks unmirrored. The sweep creates a
  // suffixed sibling rather than overwriting the existing stream's state —
  // detectable and non-destructive. Pinned so a future "fix" doesn't make
  // recreation silently clobber.
  const m = mirror();
  sweepIssues([issue()], m);
  const rebuilt = mirror(); // simulate lost state
  const r = sweepIssues([issue()], rebuilt);
  assert.equal(r.created.length, 1);
  assert.equal(listWorkstreams().length, 2);
});
