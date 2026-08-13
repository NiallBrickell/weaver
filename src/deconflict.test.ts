import assert from 'node:assert/strict';
import test from 'node:test';

import { collisionKey, collisionReconciled, detectRepoCollisions, isRepoEgressAction, type OpenPr } from './deconflict.js';
import type { Assignment } from './types.js';

// The pure detector is the proof of the repo-egress deconfliction invariant
// (invariant 8 extended across the git-repo seam): a colliding OPEN PR is a
// "conflicting arrival" on shared external state. No IO, no network, no model.

const pr = (number: number, headRefName: string, author: string, files: string[]): OpenPr => ({
  number,
  headRefName,
  author,
  files,
});

test('overlapping open PR is detected with exactly the intersecting files', () => {
  const collisions = detectRepoCollisions(
    'feat/mine',
    ['src/a.ts', 'src/b.ts', 'docs/x.md'],
    [pr(1993, 'teammate/theirs', 'teammate', ['src/b.ts', 'src/c.ts'])],
  );
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0], {
    number: 1993,
    headRefName: 'teammate/theirs',
    author: 'teammate',
    files: ['src/b.ts'],
  });
});

test('the action own head branch is excluded even when its files overlap', () => {
  const collisions = detectRepoCollisions(
    'feat/mine',
    ['src/a.ts'],
    [pr(2010, 'feat/mine', 'weaver-bot', ['src/a.ts'])],
  );
  assert.deepEqual(collisions, []);
});

test('a non-overlapping open PR is ignored', () => {
  const collisions = detectRepoCollisions(
    'feat/mine',
    ['src/a.ts'],
    [pr(2011, 'other/branch', 'someone', ['src/z.ts', 'README.md'])],
  );
  assert.deepEqual(collisions, []);
});

test('empty ourFiles yields no collisions', () => {
  const collisions = detectRepoCollisions(
    'feat/mine',
    [],
    [pr(2011, 'other/branch', 'someone', ['src/a.ts'])],
  );
  assert.deepEqual(collisions, []);
});

test('multiple colliding PRs are each reported with their own intersecting files', () => {
  const collisions = detectRepoCollisions(
    'feat/mine',
    ['src/a.ts', 'src/b.ts', 'src/d.ts'],
    [
      pr(2010, 'feat/mine', 'self', ['src/a.ts']), // own branch — excluded
      pr(1993, 'human/pr', 'teammate', ['src/a.ts', 'src/e.ts']),
      pr(2012, 'bot/pr', 'weaver-bot', ['src/b.ts', 'src/d.ts']),
      pr(2013, 'unrelated', 'someone', ['src/z.ts']), // no overlap — ignored
    ],
  );
  assert.equal(collisions.length, 2);
  assert.deepEqual(
    collisions.map((c) => [c.number, c.files]),
    [
      [1993, ['src/a.ts']],
      [2012, ['src/b.ts', 'src/d.ts']],
    ],
  );
});

// --- isRepoEgressAction: the predicate that decides which actions the gate
// even applies to (only irreversible repo egress: push, merge, PR-open).

const action = (exec: Partial<NonNullable<Assignment['exec']>> | undefined): Assignment =>
  ({
    id: 'asg_1',
    objective: 'o',
    briefing: 'b',
    kind: 'action',
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: '2026-01-01T00:00:00.000Z',
    ...(exec ? { exec: { cwd: '/tmp', verify: '', ...exec } } : {}),
  }) as Assignment;

test('isRepoEgressAction matches gh pr create / merge and git push in run or verify', () => {
  assert.equal(isRepoEgressAction(action({ run: 'gh pr create --fill' })), true);
  assert.equal(isRepoEgressAction(action({ run: 'gh pr merge 42 --merge' })), true);
  assert.equal(isRepoEgressAction(action({ run: 'git push origin HEAD' })), true);
  assert.equal(isRepoEgressAction(action({ verify: 'git push --dry-run' })), true);
});

// REGRESSION (coordinator, PR #58): every real PR-opening action in production
// is a WORKER-action — exec.run is undefined and the egress happens inside the
// model run — so the ONLY durable signal is exec.verify, a PR/branch READBACK.
// A narrow `gh pr create|merge` / `git push` match saw none of these, making
// the gate a no-op on the exact incident shape. These are the literal verify
// strings from the incident's actions, copied verbatim as fixtures.
test('isRepoEgressAction fires on the incident PR/branch READBACK verifies', () => {
  const prUrlReadback =
    "gh pr list --repo erdoai/erdo --head erdo-420-voice-live-transfer --state open --json url --jq '.[0].url' | grep .";
  const headOidReadback =
    'test "$(gh pr list --repo erdoai/erdo --head niall/erdo-414-x --json headRefOid --jq \'.[0].headRefOid\')" = "6e84abc"';
  const pushRemoteRefReadback =
    'git -C /work/wt fetch origin && git -C /work/wt merge-base --is-ancestor 6e84abc origin/niall/erdo-414-x';

  assert.equal(isRepoEgressAction(action({ verify: prUrlReadback })), true);
  assert.equal(isRepoEgressAction(action({ verify: headOidReadback })), true);
  assert.equal(isRepoEgressAction(action({ verify: pushRemoteRefReadback })), true);
  // The matching push run (exec.run form) is still recognised.
  assert.equal(
    isRepoEgressAction(action({ run: 'git -C /work/wt push origin niall/erdo-414-x:niall/erdo-414-x' })),
    true,
  );
});

test('isRepoEgressAction ignores non-egress and non-action assignments', () => {
  // Plain non-egress readbacks: no PR inspection, no remote ref, no push.
  assert.equal(isRepoEgressAction(action({ verify: 'go test ./...' })), false);
  assert.equal(isRepoEgressAction(action({ verify: 'gh issue view 5' })), false);
  assert.equal(isRepoEgressAction(action({ run: 'gh issue comment 5 --body hi', verify: 'test -f evidence.md' })), false);
  assert.equal(isRepoEgressAction(action(undefined)), false);
  const work = action({ run: 'git push' });
  work.kind = 'work';
  delete work.exec;
  assert.equal(isRepoEgressAction(work), false);
});

// The reconciliation predicate closes the gate's loop with the human: the hold
// fails closed TO the human, so their resolved card for the SAME collision set
// must count as the answer — and only for that exact set.
test('collisionReconciled honors a resolved card for the exact collision set only', () => {
  const token = '[repo-collision asg_1:1988,1993]';
  // Human resolved the card carrying this token → reconciled, proceed.
  assert.equal(
    collisionReconciled([{ status: 'resolved', summary: `held … reconcile … ${token}` }], token),
    true,
  );
  // Card still open → not reconciled, keep holding.
  assert.equal(
    collisionReconciled([{ status: 'open', summary: `held … ${token}` }], token),
    false,
  );
  // Resolution for a DIFFERENT collision set (new PR joined) → still holds.
  assert.equal(
    collisionReconciled(
      [{ status: 'resolved', summary: 'held … [repo-collision asg_1:1988]' }],
      token,
    ),
    false,
  );
  // No attention at all → holds.
  assert.equal(collisionReconciled([], token), false);
});

test('a new colliding PR over already-contended files is not a new question', () => {
  const files = ['backend/voice/service_widget.go'];
  // #2019 alone, then #2035 joins it over the same file: same key, so a human
  // who reconciled once is not asked again. Keying on PR numbers asked three
  // times in one evening.
  assert.equal(collisionKey('asg_1', files), collisionKey('asg_1', files));
  const resolved = [{ status: 'resolved', summary: `reconciled ${collisionKey('asg_1', files)}` }];
  assert.equal(collisionReconciled(resolved, collisionKey('asg_1', files)), true);

  // A collision pulling in a file nobody has ruled on IS new, and still holds.
  const wider = [...files, 'backend/mcp/tools.go'];
  assert.equal(collisionReconciled(resolved, collisionKey('asg_1', wider)), false);

  // Order and duplicates never change the identity of the same file set.
  assert.equal(collisionKey('asg_1', ['b.go', 'a.go', 'a.go']), collisionKey('asg_1', ['a.go', 'b.go']));
  // And a different action asking about the same files is its own question.
  assert.notEqual(collisionKey('asg_2', files), collisionKey('asg_1', files));
});
