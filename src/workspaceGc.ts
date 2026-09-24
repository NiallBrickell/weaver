/**
 * `weaver gc-workspaces` — reclaim the workspace root.
 *
 * Every workstream gets a persistent neutral workspace under
 * WEAVER_WORKSPACE_ROOT, and coordinators name further checkouts, clones and
 * worktrees under it. Nothing ever removed them: on 2026-09-24 the hosted
 * runner's disk reached 100% with 71 GB of workspaces for streams resolved
 * days earlier, and the runner went DEGRADED (below its free-space floor) and
 * dispatched nothing. This command is the missing half of the lifecycle.
 *
 * The rule is conservative in the one direction that matters — never lose
 * work the fleet has not shipped:
 *
 * - A top-level child of the root whose name is a live workstream's slug
 *   (status other than 'done'), or that any assignment still ahead of its
 *   terminal state (gated, queued, running, awaiting review) names in
 *   `readDirs` or an action cwd, is in use and untouched. Finished
 *   assignments do not pin their directories forever: a routine that runs
 *   daily for months would otherwise keep every dated clone it ever named.
 * - A child touched within the idle window (newest file outside .git and
 *   build output; default a week) is left alone even if nothing references
 *   it: a stream may have just resolved, a follow-up may still want the
 *   checkout warm, and a coordinator that re-names a recent clone finds it.
 * - Otherwise every git repository inside it is inspected. Uncommitted
 *   changes or commits on no remote keep the child; only its rebuildable
 *   build output (node_modules, .next, .turbo, .cache, Go caches) is removed
 *   and the reason is reported so the operator can rescue or discard it by
 *   hand. A repository git cannot read counts as unshipped work.
 * - A child with nothing unshipped is removed whole.
 *
 * It runs once a day from its own systemd timer on the hosted VM (see
 * bin/weaver-gcp-update.sh) — a daily `load()` of the fleet, like the digest,
 * not a hot-path loop — and refuses to collect anything if a single stored
 * workstream cannot be read, since an unreadable document might be the one
 * naming a workspace.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workerWorkspaceRoot } from './executor/workspaceMounts.js';
import { closeStore, listWorkstreams, load } from './store.js';
import type { WorkstreamDoc } from './types.js';

export const WORKSPACE_GC_IDLE_DAYS_DEFAULT = 7;
/** Assignment states that still hold, or are about to hold, a process on disk. */
const PENDING_ASSIGNMENT_STATES = new Set(['gated', 'queued', 'running', 'awaiting_review']);
const DAY_MS = 24 * 60 * 60_000;
/** How long one git query may take before the repository counts as unreadable. */
const GIT_TIMEOUT_MS = 60_000;
/** How deep inside a child git repositories are looked for (checkout → worktree → nested). */
const GIT_SEARCH_DEPTH = 4;
/** Upper bound on files examined per child for the idle check; a child this
 * large is treated as recently touched rather than walked forever. */
const WALK_FILE_LIMIT = 500_000;

/** Directory names whose contents a build regenerates: safe to drop from a
 * child that must otherwise be kept. `dist` is deliberately absent — some
 * repositories commit it. */
export function isRebuildableDirName(name: string): boolean {
  return name === 'node_modules' || name === '.next' || name === '.turbo' || name === '.cache' || /gocache/i.test(name);
}

/** The root's immediate child a directory belongs to, or null when it lies outside the root. */
export function workspaceChildOf(root: string, directory: string): string | null {
  const rel = relative(resolve(root), resolve(directory));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep)[0] ?? null;
}

/**
 * The children live work still names. A stream that is not 'done' keeps its
 * neutral workspace (named by its slug); every assignment still ahead of its
 * terminal state keeps the directories it declares, whatever its stream's
 * status says, since a process is (or is about to be) on disk there. A
 * finished assignment pins nothing: the idle window covers a clone the
 * coordinator may name again soon.
 */
export function referencedWorkspaceChildren(root: string, docs: Iterable<WorkstreamDoc>): Set<string> {
  const referenced = new Set<string>();
  for (const doc of docs) {
    if (doc.workstream.status !== 'done') referenced.add(doc.workstream.slug);
    for (const assignment of doc.assignments) {
      if (!PENDING_ASSIGNMENT_STATES.has(assignment.state)) continue;
      const directories = [...(assignment.readDirs ?? []), ...(assignment.exec ? [assignment.exec.cwd] : [])];
      for (const directory of directories) {
        const child = workspaceChildOf(root, directory);
        if (child !== null) referenced.add(child);
      }
    }
  }
  return referenced;
}

/** Newest mtime (ms) of any file under `dir`, ignoring .git and rebuildable
 * output; the directory's own mtime when it holds no such file. */
export function newestContentMtimeMs(dir: string): number {
  let newest = statSync(dir).mtimeMs;
  let examined = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // `.git` is a directory in a checkout and a FILE in a worktree (a
      // pointer git rewrites on its own schedule); neither is the worker's
      // content, so neither says when the tree was last touched.
      if (entry.isSymbolicLink() || entry.name === '.git') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (isRebuildableDirName(entry.name)) continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      examined += 1;
      if (examined > WALK_FILE_LIMIT) return Number.POSITIVE_INFINITY;
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // Removed under us; its age no longer matters.
      }
    }
  }
  return newest;
}

/** Every git repository (checkout or worktree — `.git` dir or file) under `dir`, to a bounded depth. */
export function gitRepositoriesUnder(dir: string, depth = GIT_SEARCH_DEPTH): string[] {
  const repos: string[] = [];
  const visit = (current: string, remaining: number) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '.git')) repos.push(current);
    if (remaining === 0) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || isRebuildableDirName(entry.name)) continue;
      visit(join(current, entry.name), remaining - 1);
    }
  };
  visit(dir, depth);
  return repos;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

/** Why a repository still holds work the fleet has not shipped, or null when
 * everything in it is committed and on a remote. Errors count as unshipped:
 * a repository git cannot read is not one to delete. */
export function unshippedWork(repo: string): string | null {
  try {
    if (git(repo, ['status', '--porcelain', '--untracked-files=normal']).trim() !== '') return 'uncommitted changes';
    if (git(repo, ['log', '--branches', '--not', '--remotes', '--oneline', '-1']).trim() !== '') return 'commits on no remote';
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return `git could not read it (${detail})`;
  }
}

/** Rebuildable directories under `dir` (not descending into them or .git). */
export function rebuildableDirectoriesUnder(dir: string, depth = GIT_SEARCH_DEPTH + 2): string[] {
  const found: string[] = [];
  const visit = (current: string, remaining: number) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git') continue;
      const path = join(current, entry.name);
      if (isRebuildableDirName(entry.name)) {
        found.push(path);
        continue;
      }
      if (remaining > 0) visit(path, remaining - 1);
    }
  };
  visit(dir, depth);
  return found;
}

export interface WorkspaceGcOptions {
  root: string;
  /** Top-level children live work names (referencedWorkspaceChildren). */
  referenced: ReadonlySet<string>;
  idleMs: number;
  nowMs?: number;
  dryRun?: boolean;
}

export interface WorkspaceGcReport {
  root: string;
  dryRun: boolean;
  /** Children removed whole (would be, on a dry run). */
  removed: string[];
  /** Rebuildable directories removed from children that were kept. */
  pruned: string[];
  /** Children kept despite being idle and unreferenced, with why. */
  kept: Array<{ child: string; reason: string }>;
  /** Children live work names. */
  referenced: string[];
  /** Children touched inside the idle window. */
  recent: string[];
  freeBytesBefore: number | null;
  freeBytesAfter: number | null;
}

function freeBytesAt(path: string): number | null {
  try {
    const stat = statfsSync(path);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function assertCollectableRoot(root: string): void {
  if (!isAbsolute(root)) throw new Error(`workspace root must be absolute, got '${root}'`);
  const canonical = resolve(root);
  const refused = new Set([resolve('/'), resolve(homedir())]);
  if (refused.has(canonical)) throw new Error(`refusing to collect '${root}': it is the filesystem root or the home directory`);
}

/** Collect the workspace root by the rules in the module comment. Pure
 * filesystem work: the caller supplies which children are referenced. */
export function gcWorkspaces(options: WorkspaceGcOptions): WorkspaceGcReport {
  const { root, referenced, idleMs } = options;
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? false;
  assertCollectableRoot(root);
  const report: WorkspaceGcReport = {
    root,
    dryRun,
    removed: [],
    pruned: [],
    kept: [],
    referenced: [],
    recent: [],
    freeBytesBefore: freeBytesAt(root),
    freeBytesAfter: null,
  };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      report.freeBytesAfter = report.freeBytesBefore;
      return report;
    }
    throw error;
  }
  // Judge every child BEFORE removing any. A git worktree in one child keeps
  // its metadata inside a sibling child's .git (the checkout it was made
  // from); removing that sibling first makes the worktree unreadable, and an
  // unreadable repository is kept — so a one-pass loop turned six removable
  // worktrees into permanent clutter on the first live run. Two phases also
  // make the dry run's report exactly what the real run does.
  const toRemove: string[] = [];
  const toPrune: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = entry.name;
    const path = join(root, child);
    if (referenced.has(child)) {
      report.referenced.push(child);
      continue;
    }
    if (nowMs - newestContentMtimeMs(path) < idleMs) {
      report.recent.push(child);
      continue;
    }
    const reasons = gitRepositoriesUnder(path)
      .map((repo) => ({ repo, reason: unshippedWork(repo) }))
      .filter((entry): entry is { repo: string; reason: string } => entry.reason !== null);
    if (reasons.length === 0) {
      toRemove.push(path);
      report.removed.push(child);
      continue;
    }
    report.kept.push({
      child,
      reason: reasons.map(({ repo, reason }) => `${relative(root, repo) || child}: ${reason}`).join('; '),
    });
    for (const rebuildable of rebuildableDirectoriesUnder(path)) {
      toPrune.push(rebuildable);
      report.pruned.push(relative(root, rebuildable));
    }
  }
  if (!dryRun) {
    for (const path of [...toRemove, ...toPrune]) rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  }
  report.freeBytesAfter = dryRun ? report.freeBytesBefore : freeBytesAt(root);
  return report;
}

function gib(bytes: number | null): string {
  return bytes === null ? '?' : `${(bytes / (1024 ** 3)).toFixed(1)} GiB`;
}

export function renderWorkspaceGcReport(report: WorkspaceGcReport): string {
  const verb = report.dryRun ? 'would remove' : 'removed';
  const lines = [
    `workspace root ${report.root}${report.dryRun ? ' (dry run)' : ''}: ${verb} ${report.removed.length} workspace(s), pruned build output in ${report.kept.length}, ${report.referenced.length} in use by live work, ${report.recent.length} recently touched`,
    ...report.removed.map((child) => `  ${verb} ${child}`),
    ...report.kept.map(({ child, reason }) => `  kept ${child} — ${reason}`),
    ...report.pruned.map((path) => `  ${report.dryRun ? 'would prune' : 'pruned'} ${path}`),
    `free: ${gib(report.freeBytesBefore)} → ${gib(report.freeBytesAfter)}`,
  ];
  return lines.join('\n');
}

export interface WorkspaceGcCommandOptions {
  dryRun: boolean;
  idleDays: number;
}

/** The CLI entry: read the fleet once, refuse if any part of it is unreadable, collect. */
export async function gcWorkspacesCommand(options: WorkspaceGcCommandOptions): Promise<{ ok: boolean; message: string }> {
  if (!Number.isFinite(options.idleDays) || options.idleDays < 0) {
    return { ok: false, message: `--idle-days must be a non-negative number, got '${options.idleDays}'` };
  }
  const root = workerWorkspaceRoot();
  const docs: WorkstreamDoc[] = [];
  const unreadable: string[] = [];
  try {
    for (const slug of await listWorkstreams()) {
      try {
        docs.push(await load(slug));
      } catch {
        unreadable.push(slug);
      }
    }
  } finally {
    await closeStore();
  }
  if (unreadable.length) {
    return {
      ok: false,
      message: `refusing to collect ${root}: ${unreadable.length} workstream(s) could not be read (${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', …' : ''}) and any of them may still name a workspace`,
    };
  }
  const report = gcWorkspaces({
    root,
    referenced: referencedWorkspaceChildren(root, docs),
    idleMs: options.idleDays * DAY_MS,
    dryRun: options.dryRun,
  });
  return { ok: true, message: renderWorkspaceGcReport(report) };
}
