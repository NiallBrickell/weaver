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
function tryRun(bin: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(bin, args, {
      cwd,
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
export async function repoEgressCollisions(cwd: string): Promise<Collision[]> {
  const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  // Detached HEAD (or unreadable) → nothing to deconflict.
  if (!branch || branch === 'HEAD') return [];

  // Base to diff against: the merge-base with the repo's default remote head,
  // falling back to origin/main. Either may be absent in a given checkout.
  let base: string | null = null;
  for (const ref of ['origin/HEAD', 'origin/main']) {
    base = tryRun('git', ['merge-base', ref, 'HEAD'], cwd);
    if (base) break;
  }
  if (!base) return [];

  const diff = tryRun('git', ['diff', '--name-only', `${base}...HEAD`], cwd);
  // No commits ahead of base (empty diff) → nothing of ours to collide.
  if (diff === null) return [];
  const ourFiles = diff.split('\n').map((l) => l.trim()).filter(Boolean);
  if (ourFiles.length === 0) return [];

  const prsJson = tryRun(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,author,files'],
    cwd,
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

