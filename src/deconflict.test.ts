import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkStrandedPush,
  collisionKey,
  detectRepoCollisions,
  isRepoEgressAction,
  judgeBranchPrs,
  pushTargetBranch,
  strandedPushKey,
  type BranchPr,
  type OpenPr,
  type StrandedPushIO,
} from './deconflict.js';
import { guardRepoEgress } from './engine.js';
import { arrive, createWorkstream, load } from './store.js';
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

test('a PR on the action own head branch is our own PR, not a competing arrival', () => {
  // Pushing to an existing PR looks exactly like this. Treating it as a second
  // writer held legitimate work; a genuinely moved remote is caught by
  // `git push --force-with-lease`, which this gate cannot see anyway.
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
      pr(2010, 'feat/mine', 'self', ['src/a.ts']), // our own PR — excluded
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

test('isRepoEgressAction matches literal deterministic repo writes', () => {
  assert.equal(isRepoEgressAction(action({ run: 'gh pr create --fill' })), true);
  assert.equal(isRepoEgressAction(action({ run: 'gh pr merge 42 --merge' })), true);
  assert.equal(isRepoEgressAction(action({ run: 'git push origin HEAD' })), true);
});

test('isRepoEgressAction does not infer egress from deterministic read-only probes', () => {
  assert.equal(
    isRepoEgressAction(action({
      run: 'gh pr view 42 --json state && gh api repos/acme/widgets/commits/main > /workspace/head.json',
      verify: 'test -s /workspace/head.json && gh pr list --state open --json number',
    })),
    false,
  );
  assert.equal(
    isRepoEgressAction(action({ run: 'gh api repos/acme/widgets/commits/main', verify: 'test -f /tmp/probe.done' })),
    false,
  );
  // A deterministic run is authoritative even when its verify resembles the
  // proxy used for a model-driven write.
  assert.equal(
    isRepoEgressAction(action({ run: 'gh pr view 42', verify: 'gh pr list --head fix/x --json url' })),
    false,
  );
});

test('isRepoEgressAction retains the readback proxy when no deterministic run exists', () => {
  assert.equal(isRepoEgressAction(action({ verify: 'git push --dry-run' })), true);
});

// REGRESSION (coordinator, PR #58): every real PR-opening action in production
// is a WORKER-action — exec.run is undefined and the egress happens inside the
// model run — so the ONLY durable signal is exec.verify, a PR/branch READBACK.
// A narrow `gh pr create|merge` / `git push` match saw none of these, making
// the gate a no-op on the exact incident shape. These fixtures keep the
// incident's exact command shapes; org and branch names are genericized.
test('isRepoEgressAction fires on the incident PR/branch READBACK verifies', () => {
  const prUrlReadback =
    "gh pr list --repo acme/widgets --head widgets-420-voice-live-transfer --state open --json url --jq '.[0].url' | grep .";
  const headOidReadback =
    'test "$(gh pr list --repo acme/widgets --head niall/widgets-414-x --json headRefOid --jq \'.[0].headRefOid\')" = "6e84abc"';
  const pushRemoteRefReadback =
    'git -C /work/wt fetch origin && git -C /work/wt merge-base --is-ancestor 6e84abc origin/niall/widgets-414-x';

  assert.equal(isRepoEgressAction(action({ verify: prUrlReadback })), true);
  assert.equal(isRepoEgressAction(action({ verify: headOidReadback })), true);
  assert.equal(isRepoEgressAction(action({ verify: pushRemoteRefReadback })), true);
  // The matching push run (exec.run form) is still recognised.
  assert.equal(
    isRepoEgressAction(action({ run: 'git -C /work/wt push origin niall/widgets-414-x:niall/widgets-414-x' })),
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


test('overlap is reported so the author knows who else is in the file, and never blocks', () => {
  const ours = ['backend/voice/service_widget.go'];
  const found = detectRepoCollisions('fix/mine', ours, [
    { number: 2019, headRefName: 'fix/theirs', author: 'someone', files: ours },
    { number: 2035, headRefName: 'fix/other', author: 'another', files: ours },
  ]);
  // Both are surfaced — that knowledge is what the #1993 incident needed…
  assert.deepEqual(found.map((c) => c.number), [2019, 2035]);
  // …but separate refs are ordinary parallel development: git merges them and
  // a real textual conflict shows up at merge time.
  assert.deepEqual(found.filter((c) => c.headRefName === 'fix/mine'), []);

  // A PR sharing our branch but no files is not a collision either.
  assert.deepEqual(detectRepoCollisions('fix/mine', ours, [
    { number: 2041, headRefName: 'other/ref', author: 'someone', files: ['docs/other.md'] },
  ]), []);
});

// --- Settled-branch egress -------------------------------------------------
// The stranded-commit incident: a workstream in a worktree on
// feat/knock-crm-integration finished a follow-up refactor and pushed it 43
// minutes AFTER that branch's PR (erdoai/erdo #2176) merged. The commit landed
// on a settled branch carried by no PR, and had to be re-homed by hand. Nothing
// checked the target branch's PR state before egress; this is that check.

const branchPr = (number: number, state: string): BranchPr => ({ number, state });

test('a MERGED PR on the push target strands the commit', () => {
  const v = judgeBranchPrs('feat/knock-crm-integration', [branchPr(2176, 'MERGED')]);
  assert.deepEqual(v, {
    verdict: 'stranded',
    branch: 'feat/knock-crm-integration',
    prNumber: 2176,
    state: 'MERGED',
  });
});

test('an OPEN PR on the push target is ordinary iteration, and outranks settled siblings', () => {
  assert.deepEqual(judgeBranchPrs('feat/x', [branchPr(10, 'OPEN')]), { verdict: 'clear' });
  // A branch reopened as a second PR after an earlier one closed: the open PR
  // is a live vehicle, so pushing reaches review.
  assert.deepEqual(
    judgeBranchPrs('feat/x', [branchPr(9, 'CLOSED'), branchPr(11, 'OPEN')]),
    { verdict: 'clear' },
  );
});

test('no PR at all is the first push of a new branch', () => {
  assert.deepEqual(judgeBranchPrs('feat/brand-new', []), { verdict: 'clear' });
});

test('the newest settled PR is the one named, and an unknown state is not evidence', () => {
  const v = judgeBranchPrs('feat/x', [branchPr(9, 'MERGED'), branchPr(21, 'CLOSED')]);
  assert.deepEqual(v, { verdict: 'stranded', branch: 'feat/x', prNumber: 21, state: 'CLOSED' });
  // A state this check does not recognise never blocks: it only fails closed on
  // a fact it actually read.
  assert.deepEqual(judgeBranchPrs('feat/x', [branchPr(30, 'DRAFT_LIMBO')]), { verdict: 'clear' });
});

test('pushTargetBranch reads the destination out of the push forms the gate sees', () => {
  // Named destinations win — the push writes there, not to the checkout's HEAD.
  assert.equal(pushTargetBranch('git push origin feat/x'), 'feat/x');
  assert.equal(
    pushTargetBranch('git -C /work/wt push origin niall/widgets-414-x:niall/widgets-414-x'),
    'niall/widgets-414-x',
  );
  assert.equal(pushTargetBranch('git push --force-with-lease origin HEAD:refs/heads/feat/y'), 'feat/y');
  assert.equal(
    pushTargetBranch('git push --force-with-lease=feat/z:abc123 -u origin feat/z'),
    'feat/z',
  );
  // No destination named → the checkout is the answer, so the parser abstains.
  assert.equal(pushTargetBranch('git push'), null);
  assert.equal(pushTargetBranch('git push origin HEAD'), null);
  // The incident's PR readback names its branch outright.
  assert.equal(
    pushTargetBranch(
      "gh pr list --repo acme/widgets --head feat/knock-crm-integration --state open --json url --jq '.[0].url' | grep .",
    ),
    'feat/knock-crm-integration',
  );
});

const io = (prs: BranchPr[] | null, branch: string | null = 'feat/knock-crm-integration'): StrandedPushIO => ({
  branchOf: () => branch,
  prsForBranch: () => prs,
});

test('checkStrandedPush falls back to the checkout branch and fails open on gh failure', async () => {
  const merged = [branchPr(2176, 'MERGED')];
  // `git push origin HEAD` names no ref; the world supplies the branch.
  assert.deepEqual(await checkStrandedPush('/nope', 'git push origin HEAD', io(merged)), {
    verdict: 'stranded',
    branch: 'feat/knock-crm-integration',
    prNumber: 2176,
    state: 'MERGED',
  });
  // gh would not answer → abstain with a reason, never a block.
  const dead = await checkStrandedPush('/nope', 'git push origin HEAD', io(null));
  assert.equal(dead.verdict, 'unknown');
  // Unreadable checkout and no named ref → nothing to query.
  const noBranch = await checkStrandedPush('/nope', 'git push', io(merged, null));
  assert.equal(noBranch.verdict, 'unknown');
});

test('checkStrandedPush skips egresses that write no commits', async () => {
  const merged = io([branchPr(2176, 'MERGED')]);
  // Merging a PR leaves it MERGED by design — holding it would block the action
  // exactly when it had succeeded.
  assert.deepEqual(await checkStrandedPush('/nope', 'gh pr merge 2176 --merge', merged), { verdict: 'clear' });
  assert.deepEqual(
    await checkStrandedPush('/nope', 'gh pr merge 2176 --merge\ngh pr view 2176 --json state', merged),
    { verdict: 'clear' },
  );
  assert.deepEqual(await checkStrandedPush('/nope', 'gh pr view 2176', merged), { verdict: 'clear' });
  // Deleting the merged branch is the CLEANUP this gate exists to make
  // possible; holding it would block the very fix a stranded push needs.
  for (const del of [
    'git push origin --delete feat/knock-crm-integration',
    'git -C /work/wt push origin :feat/knock-crm-integration',
    'git push origin -d feat/knock-crm-integration',
  ]) {
    assert.deepEqual(await checkStrandedPush('/nope', del, merged), { verdict: 'clear' }, del);
  }
  // A tag push writes no branch history.
  assert.deepEqual(await checkStrandedPush('/nope', 'git push --tags origin', merged), { verdict: 'clear' });
});

// --- the gate itself: a settled branch HOLDS the action --------------------

const EGRESS_CWD = path.join(os.tmpdir(), 'weaver-no-such-worktree');

function egressAction(): Assignment {
  return action({
    cwd: EGRESS_CWD,
    verify:
      "gh pr list --repo acme/widgets --head feat/knock-crm-integration --state open --json url --jq '.[0].url' | grep .",
  });
}

async function withStore<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-stranded-'));
  process.env.WEAVER_HOME = home;
  try {
    await createWorkstream({
      slug,
      title: slug,
      objective: 'settled-branch gate',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
    });
    await arrive(slug, (d) => {
      d.assignments.push(egressAction());
    });
    return await fn();
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a MERGED PR on the target branch holds the egress and tells the stream to use a fresh branch', async () => {
  await withStore('stranded-ws', async () => {
    const proceed = await guardRepoEgress('stranded-ws', egressAction(), io([branchPr(2176, 'MERGED')]));
    assert.equal(proceed, false, 'the push must not fire into a merged branch');

    const doc = await load('stranded-ws');
    const token = strandedPushKey('asg_1', 'feat/knock-crm-integration', 2176);
    const held = doc.events.find((e) => e.type === 'action.repo_egress_settled_branch');
    assert.ok(held, 'the hold is on the record');
    assert.ok(held!.summary.includes(token), 'deduped on action + branch + PR');
    assert.ok(held!.summary.includes('already MERGED as PR #2176'));

    const wake = doc.wakes.find((w) => w.reason.includes('#2176'));
    assert.ok(wake, 'the stream is woken with the instruction');
    assert.equal(wake!.condition.type, 'immediate');
    assert.match(wake!.reason, /FRESH branch/);
    assert.match(wake!.reason, /open a NEW PR/);
    assert.match(wake!.reason, /Do not re-push feat\/knock-crm-integration/);
    assert.match(wake!.reason, /do not reopen #2176/);

    // A merged PR never reopens, so the hold repeats every tick — it must not
    // repeat the card.
    assert.equal(await guardRepoEgress('stranded-ws', egressAction(), io([branchPr(2176, 'MERGED')])), false);
    const after = await load('stranded-ws');
    assert.equal(after.events.filter((e) => e.type === 'action.repo_egress_settled_branch').length, 1);
    assert.equal(after.wakes.filter((w) => w.reason.includes('#2176')).length, 1);
  });
});

test('an open PR, a branch with no PR, and a dead gh all let the egress proceed', async () => {
  await withStore('unheld-ws', async () => {
    const cases: [string, StrandedPushIO][] = [
      ['an OPEN PR is the branch this push belongs to', io([branchPr(2176, 'OPEN')])],
      ['a brand-new branch has no PR yet', io([])],
      ['gh could not answer — fail open', io(null)],
      ['the checkout is unreadable — fail open', io(null, null)],
    ];
    for (const [why, stranded] of cases) {
      assert.equal(await guardRepoEgress('unheld-ws', egressAction(), stranded), true, why);
    }
    const doc = await load('unheld-ws');
    assert.deepEqual(doc.events.filter((e) => e.type === 'action.repo_egress_settled_branch'), []);
    assert.deepEqual(doc.wakes, [], 'nothing to reconcile, nothing to wake for');
  });
});
