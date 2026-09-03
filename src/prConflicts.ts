/**
 * Open-PR conflict watch: tell a workstream when a PR it egressed has turned
 * CONFLICTING against its base.
 *
 * The deconfliction gate (deconflict.ts) looks at file overlaps at EGRESS
 * time; nothing watched the PR afterwards, so when main moved under an open
 * PR the conflict sat invisible until a human noticed and relayed it by hand
 * (twice in one weekend). The stream that owns the PR
 * has everything needed to rebase — it just never learns the fact.
 *
 * Ownership is derived from the WORLD, not from parsing model text: an egress
 * action's cwd is a git checkout whose HEAD branch is the PR's head ref, so
 * `gh pr list --head <branch>` in that cwd names the PR without scraping the
 * action's command strings for numbers. Fail-open everywhere, like the
 * deconflict gate: a missing cwd, a dead gh, or GitHub's lazily-computed
 * mergeability answering UNKNOWN all mean "no signal", never a wedged fleet.
 *
 * Dedupe follows guardRepoEgress's pattern — a token in the event summary,
 * keyed on (PR, head oid): one wake per conflicted head. A rebase moves the
 * oid; if the new head still conflicts that is new information and earns one
 * new wake. Wake reasons are presentation and are never parsed (Wake contract).
 */

import { execFileSync } from 'node:child_process';

import { arrive, listWorkstreams, load, newId } from './store.js';
import { isRepoEgressAction } from './deconflict.js';
import { githubAppEnvironment } from './githubApp.js';

/** Between provider probes per workstream. PR mergeability changes at merge
 * cadence (minutes to hours), and each probe is one gh call per egressed
 * branch — half-hourly is fresh enough to act the same afternoon. */
export const PR_CONFLICT_PROBE_INTERVAL_MS = 30 * 60_000;

export function prConflictToken(prNumber: number, headOid: string): string {
  return `[pr-conflict #${prNumber} @${headOid}]`;
}

/** One open PR for a probed branch, reduced to the conflict decision. */
export interface ProbedPr {
  number: number;
  headRefOid: string;
  /** GitHub's computed mergeability: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
}

/** Injectable IO seam so the sweep is unit-testable without git/gh. */
export interface PrConflictIO {
  /** Current branch of the checkout at cwd, or null when unreadable. */
  branchOf(cwd: string, environment?: Record<string, string>): string | null;
  /** The open PR whose head is `branch`, from the repo cwd belongs to. */
  openPrForBranch(cwd: string, branch: string, environment?: Record<string, string>): ProbedPr | null;
}

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

const liveIO: PrConflictIO = {
  branchOf(cwd, environment = {}) {
    const branch = tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, environment);
    return branch && branch !== 'HEAD' ? branch : null;
  },
  openPrForBranch(cwd, branch, environment = {}) {
    const json = tryRun(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,headRefOid,mergeable'],
      cwd,
      environment,
    );
    if (json === null) return null;
    try {
      const raw = JSON.parse(json) as { number: number; headRefOid: string; mergeable: string }[];
      return raw[0] ?? null;
    } catch {
      return null;
    }
  },
};

/**
 * Probe one workstream's egressed branches and wake it for each newly
 * conflicted PR head. Returns the number of wakes added.
 */
export async function probeWorkstreamPrConflicts(slug: string, io: PrConflictIO = liveIO): Promise<number> {
  const doc = await load(slug);
  if (doc.workstream.status !== 'active') return 0;
  // The durable trace of "this stream put a PR into the world": an egress
  // action that actually ran. Its cwd names the checkout; the checkout names
  // the branch. Deleted worktrees fail open in branchOf.
  const cwds = new Set<string>();
  for (const asg of doc.assignments) {
    if (!isRepoEgressAction(asg)) continue;
    if (asg.attempts.length === 0 && !asg.exec?.verified) continue;
    if (asg.exec?.cwd) cwds.add(asg.exec.cwd);
  }
  if (cwds.size === 0) return 0;

  let woken = 0;
  const probedBranches = new Set<string>();
  for (const cwd of cwds) {
    const githubEnvironment = await githubAppEnvironment(cwd, 'read');
    const branch = io.branchOf(cwd, githubEnvironment);
    // The trunk is never a PR head this watch should chase.
    if (!branch || branch === 'main' || branch === 'master' || probedBranches.has(branch)) continue;
    probedBranches.add(branch);
    const pr = io.openPrForBranch(cwd, branch, githubEnvironment);
    if (!pr || pr.mergeable !== 'CONFLICTING') continue;
    const token = prConflictToken(pr.number, pr.headRefOid);
    let added = false;
    await arrive(slug, (d, event) => {
      if (d.events.some((e) => e.type === 'pr.conflict_detected' && e.summary.includes(token))) return;
      event(
        'pr.conflict_detected',
        `open PR #${pr.number} (head ${branch}) is CONFLICTING with its base at ${pr.headRefOid.slice(0, 9)} — the base moved under it ${token}`,
        [],
      );
      d.wakes.push({
        id: newId('wake'),
        reason: `PR #${pr.number} (head branch ${branch}) reports CONFLICTING with its base at head ${pr.headRefOid.slice(0, 9)}. Dispatch a bounded rebase: work-step to rebase the branch onto the current base and resolve conflicts reading both sides, then a gated action to force-with-lease push the same branch. Keep the existing PR as the vehicle; review must be re-earned at the new head.`,
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      added = true;
    });
    if (added) woken += 1;
  }
  return woken;
}

/**
 * Runner-level sweep: probe every active workstream at most once per
 * PR_CONFLICT_PROBE_INTERVAL_MS. `lastProbedAt` is runner memory — a restart
 * probing once more is harmless, and no schema rides on the throttle.
 */
export async function sweepPrConflicts(
  lastProbedAt: Map<string, number>,
  log: (line: string) => void,
  io: PrConflictIO = liveIO,
  intervalMs: number = PR_CONFLICT_PROBE_INTERVAL_MS,
): Promise<void> {
  const now = Date.now();
  for (const slug of await listWorkstreams()) {
    if ((lastProbedAt.get(slug) ?? 0) > now - intervalMs) continue;
    lastProbedAt.set(slug, now);
    try {
      const woken = await probeWorkstreamPrConflicts(slug, io);
      if (woken > 0) log(`[run] ${slug}: ${woken} open PR(s) turned CONFLICTING — stream woken to rebase`);
    } catch {
      /* fail open: an unreadable stream reports through its own tick */
    }
  }
}
