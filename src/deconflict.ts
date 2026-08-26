/**
 * Repo-egress deconfliction: tell a workstream who else is editing the files
 * it is about to push.
 *
 * The original worry was sound — the roadmap-intake routine opened PRs
 * (#2010/#2012/#2014) into files a teammate's open PR (#1993) was actively
 * editing, and nobody knew until review. The response was to fail closed at
 * egress and make a human reconcile first. That was the wrong lever, for two
 * reasons that only showed up in use.
 *
 * First, two branches editing one file is ordinary parallel development: they
 * are separate refs, git merges them, and a real textual conflict surfaces at
 * merge time where a rebase settles it. Holding egress asks a person to
 * pre-approve what git already handles, constantly — a busy repo always has
 * PRs touching shared files, and five held actions produced seven cards in one
 * evening over overlaps that were hundreds of lines apart in the same file.
 *
 * Second, the failure this could actually prevent — a second writer discarding
 * our commits — is not visible here. An open PR on our own head ref is OUR
 * PR, which is what pushing to an existing PR looks like; and a genuine
 * concurrent push is caught by `git push --force-with-lease`, which aborts
 * when the remote has moved. A gate that cannot see the danger it was built
 * for, while blocking the safe case constantly, is worse than no gate.
 *
 * So this reports and never blocks: the collisions are recorded on the
 * workstream, where the author and the reviewer can see who else is in these
 * files. That is what the incident actually needed — knowledge, not a lock.
 *
 * There is one repo egress that IS a lost update, and it is the case the
 * overlap detector deliberately skips. A branch whose PR has already merged is
 * finished external state: the commits are in the trunk, the PR is closed to
 * further review, and a push onto that ref lands a commit no PR carries. It is
 * not merged, not reviewed, and not visible to anyone except as GitHub's "had
 * recent pushes" banner. A workstream that starts a follow-up refactor before
 * the merge and finishes after it does exactly this — one did, forty-three
 * minutes after erdoai/erdo #2176 merged, and the commit had to be re-homed on
 * a fresh branch by hand. Unlike a file overlap, this has no benign reading and
 * git settles nothing at merge time: there is no merge left to have.
 *
 * So a settled PR on the push target fails CLOSED (checkStrandedPush →
 * guardRepoEgress), with the instruction the situation actually calls for —
 * fresh branch, new PR — because re-pushing the merged ref and reopening the
 * merged PR are both wrong.
 */

import { execFileSync } from 'node:child_process';

import type { Assignment } from './types.js';

/** One open PR as reported by `gh pr list`, reduced to what deconfliction
 * needs: the PR number, its head branch, its author's login, and the paths it
 * changes. */
export interface OpenPr {
  number: number;
  headRefName: string;
  author: string;
  files: string[];
}

/** A detected collision: another open PR whose changed files intersect ours. */
export interface Collision {
  number: number;
  headRefName: string;
  author: string;
  /** The file paths present in BOTH our change and the colliding PR. */
  files: string[];
}

/**
 * PURE collision detector — no IO, fully unit-testable. Given our head branch,
 * the paths our action changes, and the currently-open PRs, return every PR
 * that (a) is not our own head branch and (b) changes at least one file we also
 * change. Empty `ourFiles` → no collisions (nothing of ours to collide with).
 */
export function detectRepoCollisions(
  ourHead: string,
  ourFiles: string[],
  openPRs: OpenPr[],
): Collision[] {
  if (ourFiles.length === 0) return [];
  const ours = new Set(ourFiles);
  const collisions: Collision[] = [];
  for (const pr of openPRs) {
    // A PR on our own head ref is OUR PR — pushing to an existing PR is the
    // normal case, not a competing arrival.
    if (pr.headRefName === ourHead) continue;
    const intersecting = pr.files.filter((f) => ours.has(f));
    if (intersecting.length === 0) continue;
    collisions.push({
      number: pr.number,
      headRefName: pr.headRefName,
      author: pr.author,
      files: intersecting,
    });
  }
  return collisions;
}

/** Run a git/gh command in `cwd`, returning trimmed stdout, or `null` on ANY
 * failure (tool missing, not a repo, network down, non-zero exit). The gate
 * fails OPEN on tooling failure (see repoEgressCollisions), so callers treat a
 * null the same as "no data". */
function tryRun(
  bin: string,
  args: string[],
  cwd: string,
  environment: Record<string, string> = {},
): string | null {
  try {
    return execFileSync(bin, args, {
      cwd,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Derive the live repo collisions for an egress happening in `cwd`, via
 * `git` and `gh`. Steps:
 *   1. current branch    — `git rev-parse --abbrev-ref HEAD`
 *   2. our changed paths — merge-base against `origin/HEAD` (fall back to
 *      `origin/main`), then `git diff --name-only <base>...HEAD`
 *   3. open PRs          — `gh pr list --state open --json number,headRefName,author,files`
 *   4. detectRepoCollisions(...)
 *
 * FAIL-OPEN / FAIL-CLOSED ASYMMETRY (deliberate, load-bearing):
 *   - On any TOOLING failure (no gh, not a repo, network, detached HEAD, no
 *     commits ahead of base) this returns `[]` and NEVER throws. A broken `gh`
 *     must not wedge every action in the fleet — an unavailable detector is
 *     treated as "no known collision", so work still ships.
 *   - On a DETECTED collision the caller (the engine gate) fails CLOSED: it
 *     holds the action for the human. Detection is trusted; absence of
 *     detection is not proof of safety, only absence of evidence.
 * This mirrors invariant 7 (an UNKNOWN send result triggers readback, never a
 * second send) and invariant 8 (a conflicting arrival fails the write): a
 * KNOWN conflict blocks; the unknown case degrades to today's behaviour rather
 * than to a competing write.
 */
export async function repoEgressCollisions(
  cwd: string,
  environment: Record<string, string> = {},
): Promise<Collision[]> {
  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, environment);
  // Detached HEAD (or unreadable) → nothing to deconflict.
  if (!branch || branch === 'HEAD') return [];

  // Base to diff against: the merge-base with the repo's default remote head,
  // falling back to origin/main. Either may be absent in a given checkout.
  let base: string | null = null;
  for (const ref of ['origin/HEAD', 'origin/main']) {
    base = tryRun('git', ['merge-base', ref, 'HEAD'], cwd, environment);
    if (base) break;
  }
  if (!base) return [];

  const diff = tryRun('git', ['diff', '--name-only', `${base}...HEAD`], cwd, environment);
  // No commits ahead of base (empty diff) → nothing of ours to collide.
  if (diff === null) return [];
  const ourFiles = diff.split('\n').map((l) => l.trim()).filter(Boolean);
  if (ourFiles.length === 0) return [];

  const prsJson = tryRun(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,author,files'],
    cwd,
    environment,
  );
  if (prsJson === null) return [];
  let openPRs: OpenPr[];
  try {
    const raw = JSON.parse(prsJson) as {
      number: number;
      headRefName: string;
      author?: { login?: string };
      files?: { path: string }[];
    }[];
    openPRs = raw.map((p) => ({
      number: p.number,
      headRefName: p.headRefName,
      author: p.author?.login ?? '',
      files: (p.files ?? []).map((f) => f.path),
    }));
  } catch {
    return [];
  }

  return detectRepoCollisions(branch, ourFiles, openPRs);
}

/**
 * Recognise a repo egress from a declared command — either the WRITE itself
 * (`gh pr create`/`gh pr merge`, `git … push`) OR the READBACK that proves one
 * happened.
 *
 * The incident's real actions were WORKER-actions: `exec.run` is undefined and
 * the model runs `gh pr create`/`git push` internally, so the only durable
 * signal Weaver holds is `exec.verify` — which inspects the PR or the pushed
 * remote branch, never re-runs the write. Their real shapes:
 *   - `gh pr list --repo … --head … --state open --json url --jq '.[0].url' | grep .`
 *   - `test "$(gh pr list … --json headRefOid --jq '.[0].headRefOid')" = "6e84…"`
 *   - push case, verify: `git -C … fetch origin && git -C … merge-base --is-ancestor <sha> origin/<branch>`
 * A narrow `gh pr create|merge` / `git push` match sees NONE of these, so the
 * gate never fired on the exact case it exists for. You only read a PR or a
 * remote ref BACK after creating/pushing it, so a PR-inspecting or remote-ref
 * readback is a reliable proxy for the egress.
 *
 * FALSE-POSITIVE SAFETY: over-matching here cannot wrongly block work, because
 * `guardRepoEgress` only ever HOLDS when `git diff --name-only <base>...HEAD`
 * is non-empty (see repoEgressCollisions). A read-only action with no commits
 * ahead yields zero changed files and proceeds regardless of its verify string.
 */
function matchesRepoEgress(cmd: string): boolean {
  if (!cmd) return false;
  // The write commands themselves, plus the two gh-based PR readbacks.
  if (/\bgh\s+pr\s+(create|merge|list|view)\b/.test(cmd)) return true;
  // `git … push` — the branch/-C flags sit between `git` and `push`.
  if (/\bgit\b[^&|;\n]*\bpush\b/.test(cmd)) return true;
  // Remote-ref readbacks: you inspect a head-oid or ls-remote only after
  // pushing, and a `merge-base --is-ancestor … origin/…` verifies a pushed
  // branch landed on the remote.
  if (/\bheadRefOid\b/.test(cmd)) return true;
  if (/\bls-remote\b/.test(cmd)) return true;
  if (/origin\//.test(cmd) && /\bmerge-base\b[^&|;\n]*--is-ancestor\b/.test(cmd)) return true;
  return false;
}

/**
 * True when an action assignment's declared command is a repo egress — an
 * `exec.run` the engine executes, or an `exec.verify` readback — matching the
 * irreversible push/merge/PR-open surface (write OR its readback; see
 * matchesRepoEgress). Only `kind: 'action'` assignments carry `exec`; a plain
 * `work` assignment never reaches this gate.
 */
export function isRepoEgressAction(asg: Assignment): boolean {
  if (asg.kind !== 'action' || !asg.exec) return false;
  return matchesRepoEgress(asg.exec.run ?? '') || matchesRepoEgress(asg.exec.verify ?? '');
}

/**
 * The dedup identity of a collision hold: the action, plus the FILES it
 * contends on — never the colliding PR numbers.
 *
 * Which PRs happen to be open is churn: a fifth PR touching a file two others
 * already touch tells the human nothing new, but keying on the PR set made it a
 * different token and therefore a fresh card. One held action asked the same
 * question three times in an evening that way, and a queue that repeats itself
 * is one a person stops reading. The files are the substance — a collision over
 * a file nobody has ruled on IS new information and does earn a card.
 */
export function collisionKey(asgId: string, files: readonly string[]): string {
  return `[repo-collision ${asgId}:${[...new Set(files)].sort().join(',')}]`;
}

// --- Settled-branch egress: the push that strands a commit -------------------

/** One PR whose head ref is the branch an egress targets, reduced to the two
 * facts that decide whether pushing strands work: which PR it is and whether it
 * is still open. `state` is GitHub's, uppercase: OPEN | MERGED | CLOSED. */
export interface BranchPr {
  number: number;
  state: string;
}

/**
 * The verdict of the settled-branch check. Three outcomes, not two, because
 * "we could not look" must never read as "nothing there": `unknown` is an
 * abstention the caller logs and proceeds through, exactly like the overlap
 * detector's fail-open on tooling failure.
 */
export type StrandedPush =
  | { verdict: 'clear' }
  | { verdict: 'stranded'; branch: string; prNumber: number; state: 'MERGED' | 'CLOSED' }
  | { verdict: 'unknown'; reason: string };

/**
 * PURE verdict — no IO. Given the branch an egress targets and every PR whose
 * head ref is that branch, decide whether pushing strands the commit.
 *
 *   - no PRs at all      → clear. The first push of a new branch is the normal
 *                          way a PR comes to exist; there is nothing to strand.
 *   - any OPEN PR        → clear. The branch still has a vehicle, and pushing
 *                          to an open PR is ordinary iteration.
 *   - only settled PRs   → stranded, naming the newest one. The push would land
 *                          a commit that no PR carries.
 *
 * An unrecognised state is not evidence of anything, so it yields `clear`
 * rather than a block — the check only ever fails closed on a fact it read.
 */
export function judgeBranchPrs(branch: string, prs: readonly BranchPr[]): StrandedPush {
  if (prs.some((p) => p.state === 'OPEN')) return { verdict: 'clear' };
  const settled = prs
    .filter((p) => p.state === 'MERGED' || p.state === 'CLOSED')
    .sort((a, b) => b.number - a.number);
  const newest = settled[0];
  if (!newest) return { verdict: 'clear' };
  return {
    verdict: 'stranded',
    branch,
    prNumber: newest.number,
    state: newest.state as 'MERGED' | 'CLOSED',
  };
}

/**
 * Which egresses can strand a commit: the ones that WRITE COMMITS to a branch —
 * a push, a PR opened from a branch, or the readback that proves one of those
 * happened (the incident's actions were worker-actions whose only durable
 * signal is `exec.verify`; see matchesRepoEgress).
 *
 * This is deliberately NARROWER than matchesRepoEgress. `gh pr merge` writes no
 * commits and its whole purpose is to leave the PR merged, so running the
 * settled-branch check on it would hold a merge action against its own
 * postcondition — the action would be blocked precisely when it had succeeded.
 * A command that merges is therefore excluded outright, even if it also pushes:
 * a merged PR is that action's intended end state, not a stranding.
 */
function writesCommitsToBranch(cmd: string): boolean {
  if (!cmd) return false;
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) return false;
  if (deletesOrTagsOnly(cmd)) return false;
  if (/\bgit\b[^&|;\n]*\bpush\b/.test(cmd)) return true;
  if (/\bgh\s+pr\s+create\b/.test(cmd)) return true;
  // Readbacks that only exist because a push or a PR-open happened.
  if (/\bheadRefOid\b/.test(cmd)) return true;
  if (/\bls-remote\b/.test(cmd)) return true;
  if (/\bgh\s+pr\s+list\b[^&|;\n]*--head\b/.test(cmd)) return true;
  if (/origin\//.test(cmd) && /\bmerge-base\b[^&|;\n]*--is-ancestor\b/.test(cmd)) return true;
  return false;
}

/**
 * Pushes that put no commit on a branch: deleting a remote ref
 * (`push origin --delete x`, `push origin :x`) and pushing tags.
 *
 * Deleting the branch is the CLEANUP after a merge — the exact remediation the
 * stranded-commit incident needed — so holding it would block the fix and leave
 * the stale ref in place. A tag push writes no branch history either.
 */
function deletesOrTagsOnly(cmd: string): boolean {
  const push = /\bgit\b[^&|;\n]*?\bpush\b([^&|;\n]*)/.exec(cmd);
  if (!push) return false;
  const args = push[1] ?? '';
  if (/(^|\s)(--delete|-d)(\s|$)/.test(args)) return true;
  if (/(^|\s)--tags(\s|$)/.test(args)) return true;
  // An empty source half deletes the destination.
  if (/(^|\s):[^\s]+/.test(args)) return true;
  return false;
}

/**
 * The branch an egress command names explicitly, or null when it names none.
 *
 * The world is the primary source — a checkout's current branch is what an
 * unqualified `git push` lands on, and that is how ownership is derived
 * everywhere else in the harness (prConflicts.ts). But a command may name a
 * DIFFERENT ref than HEAD, and then the checkout is the wrong answer in both
 * directions: we would query a branch the push does not touch, and miss the one
 * it does. So an explicitly named destination wins, and everything else falls
 * back to the checkout.
 *
 * Recognised: the destination half of a refspec (`push origin src:dst`), a bare
 * branch argument (`push origin feat/x`, with `--force-with-lease` and friends
 * skipped), and the `--head <branch>` of a PR readback. `HEAD` and `refs/…`
 * prefixes are normalised; `push origin HEAD` names no branch and falls back.
 */
export function pushTargetBranch(cmd: string): string | null {
  if (!cmd) return null;
  // The push's own destination outranks a readback's `--head`: the push is what
  // writes, so where it writes is the branch that can be stranded. A push that
  // names no destination (`git push`, `git push origin HEAD`) falls through.
  const push = /\bgit\b[^&|;\n]*?\bpush\b([^&|;\n]*)/.exec(cmd);
  if (push) {
    const args = (push[1] ?? '')
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean)
      // Flags and their inline values (`--force-with-lease=ref:sha`) are not refs.
      .filter((a) => !a.startsWith('-'));
    // First positional is the remote, the second (if any) is the refspec.
    const refspec = args[1];
    if (refspec) {
      const dst = refspec.includes(':') ? refspec.slice(refspec.indexOf(':') + 1) : refspec;
      const named = normaliseRef(dst);
      if (named) return named;
    }
  }
  const head = /--head[= ]\s*([^\s'"]+)/.exec(cmd);
  return head?.[1] ? normaliseRef(head[1]) : null;
}

function normaliseRef(ref: string): string | null {
  const name = ref.replace(/^\+/, '').replace(/^refs\/heads\//, '').trim();
  if (!name || name === 'HEAD') return null;
  return name;
}

/** Injectable IO seam so the check is unit-testable without git/gh, matching
 * prConflicts.ts's `PrConflictIO`. */
export interface StrandedPushIO {
  /** Current branch of the checkout at cwd, or null when unreadable. */
  branchOf(cwd: string, environment?: Record<string, string>): string | null;
  /** Every PR whose head ref is `branch` in the repo cwd belongs to, in ANY
   * state — null when gh could not answer at all. */
  prsForBranch(cwd: string, branch: string, environment?: Record<string, string>): BranchPr[] | null;
}

export const liveStrandedPushIO: StrandedPushIO = {
  branchOf(cwd, environment = {}) {
    const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, environment);
    return branch && branch !== 'HEAD' ? branch : null;
  },
  prsForBranch(cwd, branch, environment = {}) {
    const json = tryRun(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,number'],
      cwd,
      environment,
    );
    if (json === null) return null;
    try {
      const raw = JSON.parse(json) as BranchPr[];
      return Array.isArray(raw) ? raw : null;
    } catch {
      return null;
    }
  },
};

/**
 * Would this egress land a commit on a branch whose PR has already settled?
 *
 * `command` is the action's declared shell — `exec.run` and `exec.verify`
 * together, since a worker-action carries only the readback. Non-commit-writing
 * egresses (a merge, a plain `gh pr view`) return `clear` untouched.
 *
 * Fails OPEN, loudly: an unreadable checkout or a `gh` that will not answer
 * returns `unknown` with a reason for the caller to log, never a block. A
 * network blip must not wedge legitimate pushes — but it must not pass silently
 * as a clean bill of health either.
 */
export async function checkStrandedPush(
  cwd: string,
  command: string,
  io: StrandedPushIO = liveStrandedPushIO,
  environment: Record<string, string> = {},
): Promise<StrandedPush> {
  if (!writesCommitsToBranch(command)) return { verdict: 'clear' };
  const branch = pushTargetBranch(command) ?? io.branchOf(cwd, environment);
  if (!branch) {
    return { verdict: 'unknown', reason: `no target branch readable for the egress in ${cwd}` };
  }
  const prs = io.prsForBranch(cwd, branch, environment);
  if (prs === null) {
    return { verdict: 'unknown', reason: `gh could not list PRs for head ${branch} in ${cwd}` };
  }
  return judgeBranchPrs(branch, prs);
}

/**
 * The dedup identity of a settled-branch hold: the action, the branch, and the
 * PR that settled. Same shape and reasoning as collisionKey — a hold repeats
 * every tick because a merged PR never reopens, and a queue that repeats itself
 * is one a person stops reading. A different branch or a newer settled PR is
 * genuinely new information and earns its own record.
 */
export function strandedPushKey(asgId: string, branch: string, prNumber: number): string {
  return `[settled-branch ${asgId}:${branch}#${prNumber}]`;
}

/**
 * What the workstream is told. The two wrong moves are the tempting ones —
 * re-push the merged ref (the commit stays stranded, now with a banner) and
 * reopen the merged PR (GitHub refuses a merged PR, and a closed one reopened
 * carries settled review) — so both are named as refusals rather than left to
 * inference. Wake reasons are presentation and are never parsed.
 */
export function strandedPushGuidance(v: Extract<StrandedPush, { verdict: 'stranded' }>): string {
  const settled = v.state === 'MERGED' ? 'has already MERGED' : 'is CLOSED';
  return (
    `branch ${v.branch} ${settled} as PR #${v.prNumber}, so a push there lands a commit no PR carries — ` +
    `it would sit on a settled branch as a "had recent pushes" banner and reach no review. ` +
    `Move the work to a FRESH branch cut from the current base and open a NEW PR for it. ` +
    `Do not re-push ${v.branch}, and do not reopen #${v.prNumber}.`
  );
}
