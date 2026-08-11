import assert from 'node:assert/strict';
import test from 'node:test';

import { detectRepoCollisions, isRepoEgressAction, type OpenPr } from './deconflict.js';
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

test('isRepoEgressAction ignores non-egress and non-action assignments', () => {
  assert.equal(isRepoEgressAction(action({ run: 'gh pr view 42', verify: 'gh pr list' })), false);
  assert.equal(isRepoEgressAction(action(undefined)), false);
  const work = action({ run: 'git push' });
  work.kind = 'work';
  delete work.exec;
  assert.equal(isRepoEgressAction(work), false);
});
