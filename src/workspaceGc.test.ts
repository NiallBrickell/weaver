/**
 * Workspace garbage collection must never lose work the fleet has not
 * shipped, and must actually reclaim what it safely can. Real git
 * repositories in a temporary root pin both halves.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  gcWorkspaces,
  isRebuildableDirName,
  referencedWorkspaceChildren,
  renderWorkspaceGcReport,
  unshippedWork,
  workspaceChildOf,
} from './workspaceGc.js';
import type { WorkstreamDoc } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-24T04:30:00Z');

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gc-'));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();
}

/** A bare "remote" and a clone of it with one pushed commit. */
function clonedRepo(root: string, name: string): string {
  const remote = path.join(root, `.remotes`, `${name}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'shipped\n');
  // Like a real repository: build output is ignored, so its presence is not
  // uncommitted work. An untracked file outside these IS (the model may have
  // written it and never committed).
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.next/\n*gocache*/\n');
  git(repo, 'add', 'README.md', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'shipped');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return repo;
}

/** Make every file under `dir` look `days` old, ignoring .git. */
function age(dir: string, days: number): void {
  const when = new Date(NOW - days * DAY_MS);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      fs.utimesSync(p, when, when);
    }
    fs.utimesSync(current, when, when);
  }
}

function doc(slug: string, status: WorkstreamDoc['workstream']['status'], assignments: Array<Partial<WorkstreamDoc['assignments'][number]>>): WorkstreamDoc {
  return {
    workstream: { slug, status },
    assignments: assignments.map((assignment, i) => ({ id: `asg_${i}`, state: 'completed', ...assignment })),
  } as unknown as WorkstreamDoc;
}

test('a directory maps to the root child it lives under; outside paths map to nothing', () => {
  assert.equal(workspaceChildOf('/w', '/w/erdo/frontend/src'), 'erdo');
  assert.equal(workspaceChildOf('/w', '/w/erdo'), 'erdo');
  assert.equal(workspaceChildOf('/w', '/w'), null);
  assert.equal(workspaceChildOf('/w', '/tmp/scratch'), null);
  assert.equal(workspaceChildOf('/w', '/wider/erdo'), null);
  assert.ok(isRebuildableDirName('node_modules') && isRebuildableDirName('.next') && isRebuildableDirName('resource-gocache'));
  assert.ok(!isRebuildableDirName('dist') && !isRebuildableDirName('src'));
});

test('a live stream keeps its slug workspace; only assignments ahead of their terminal state keep the directories they name', () => {
  const docs = [
    doc('active-stream', 'active', [
      { state: 'queued', readDirs: ['/w/shared-erdo/frontend', '/tmp/elsewhere'] },
      // Finished months ago: a daily routine must not pin every dated clone it ever named.
      { state: 'completed', readDirs: ['/w/active-clone-20260601'] },
      { state: 'failed', readDirs: ['/w/active-clone-failed'] },
    ]),
    doc('paused-stream', 'paused', [{ state: 'gated', exec: { cwd: '/w/paused-clone', verify: 'true' } } as never]),
    doc('done-stream', 'done', [{ state: 'completed', readDirs: ['/w/old-clone'] }]),
    doc('done-but-running', 'done', [{ state: 'running', readDirs: ['/w/still-busy'] }]),
    doc('reviewing', 'done', [{ state: 'awaiting_review', readDirs: ['/w/under-review'] }]),
  ];
  assert.deepEqual(
    [...referencedWorkspaceChildren('/w', docs)].sort(),
    ['active-stream', 'paused-clone', 'paused-stream', 'shared-erdo', 'still-busy', 'under-review'],
  );
});

test('unshipped work is uncommitted changes, commits on no remote, or a repository git cannot read', () => {
  const root = tmpRoot();
  const clean = clonedRepo(root, 'clean');
  assert.equal(unshippedWork(clean), null);

  const dirty = clonedRepo(root, 'dirty');
  fs.writeFileSync(path.join(dirty, 'wip.txt'), 'not committed\n');
  assert.equal(unshippedWork(dirty), 'uncommitted changes');

  const ahead = clonedRepo(root, 'ahead');
  fs.writeFileSync(path.join(ahead, 'README.md'), 'local only\n');
  git(ahead, 'commit', '-q', '-am', 'never pushed');
  assert.equal(unshippedWork(ahead), 'commits on no remote');

  const branch = clonedRepo(root, 'branch');
  git(branch, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(branch, 'f.txt'), 'x\n');
  git(branch, 'add', 'f.txt');
  git(branch, 'commit', '-q', '-m', 'on an unpushed branch');
  assert.equal(unshippedWork(branch), 'commits on no remote');

  const broken = path.join(root, 'broken');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.git', 'HEAD'), 'garbage\n');
  assert.match(unshippedWork(broken) ?? '', /^git could not read it/);
});

test('collection removes idle unreferenced children with nothing unshipped, prunes only build output from the rest, and leaves live and recent work alone', () => {
  const root = tmpRoot();
  // Shipped and idle: goes.
  const shipped = clonedRepo(root, 'resolved-stream');
  fs.mkdirSync(path.join(shipped, 'frontend', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(shipped, 'frontend', 'node_modules', 'pkg', 'index.js'), '');
  age(shipped, 5);
  // Idle but with an unpushed commit: kept, build output pruned.
  const ahead = clonedRepo(root, 'unpushed-stream');
  fs.writeFileSync(path.join(ahead, 'README.md'), 'local only\n');
  fs.mkdirSync(path.join(ahead, 'dist'));
  fs.writeFileSync(path.join(ahead, 'dist', 'kept.js'), '');
  git(ahead, 'add', '-A');
  git(ahead, 'commit', '-q', '-m', 'never pushed');
  fs.mkdirSync(path.join(ahead, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ahead, 'node_modules', 'pkg', 'index.js'), '');
  fs.mkdirSync(path.join(ahead, 'backend', 'resource-gocache'), { recursive: true });
  fs.writeFileSync(path.join(ahead, 'backend', 'resource-gocache', 'blob'), '');
  age(ahead, 5);
  // Idle, shipped, but a live workstream names it: untouched.
  const shared = clonedRepo(root, 'erdo');
  fs.mkdirSync(path.join(shared, 'node_modules'));
  age(shared, 20);
  // Shipped but touched yesterday: untouched.
  const recent = clonedRepo(root, 'just-resolved');
  age(recent, 1);
  // A nested worktree-style layout: the repo two levels down still counts.
  const nestedParent = path.join(root, 'nested-stream');
  fs.mkdirSync(nestedParent);
  const nested = clonedRepo(nestedParent, 'erdo-fix');
  fs.writeFileSync(path.join(nested, 'wip.txt'), 'uncommitted\n');
  age(nestedParent, 9);
  // A plain file and a symlink at the root are never candidates.
  fs.writeFileSync(path.join(root, 'notes.txt'), '');
  fs.symlinkSync(shared, path.join(root, 'erdo-link'));
  // The bare remotes live under a dot directory the fixture just wrote, so
  // it is "recently touched" and left alone like any other fresh child.

  const referenced = referencedWorkspaceChildren(root, [doc('live', 'active', [{ state: 'queued', readDirs: [path.join(root, 'erdo', 'frontend')] }])]);

  const dry = gcWorkspaces({ root, referenced, idleMs: 3 * DAY_MS, nowMs: NOW, dryRun: true });
  assert.deepEqual(dry.removed, ['resolved-stream']);
  assert.ok(fs.existsSync(shipped), 'a dry run removes nothing');
  assert.ok(fs.existsSync(path.join(ahead, 'node_modules')), 'a dry run prunes nothing');

  const report = gcWorkspaces({ root, referenced, idleMs: 3 * DAY_MS, nowMs: NOW });
  assert.deepEqual(report.removed, ['resolved-stream']);
  assert.ok(!fs.existsSync(shipped));
  assert.deepEqual(report.referenced, ['erdo']);
  assert.ok(fs.existsSync(path.join(shared, 'node_modules')), 'a referenced child is not even pruned');
  assert.deepEqual(report.recent, ['.remotes', 'just-resolved']);
  assert.deepEqual(
    report.kept.map(({ child, reason }) => [child, reason]),
    [
      ['nested-stream', 'nested-stream/erdo-fix: uncommitted changes'],
      ['unpushed-stream', 'unpushed-stream: commits on no remote'],
    ],
  );
  assert.deepEqual(report.pruned.sort(), ['unpushed-stream/backend/resource-gocache', 'unpushed-stream/node_modules']);
  assert.ok(!fs.existsSync(path.join(ahead, 'node_modules')));
  assert.ok(fs.existsSync(path.join(ahead, 'dist', 'kept.js')), 'dist may be committed source and is never pruned');
  assert.ok(fs.existsSync(path.join(ahead, 'README.md')) && fs.existsSync(nested), 'kept children keep their trees');
  assert.ok(fs.existsSync(path.join(root, 'notes.txt')) && fs.existsSync(path.join(root, 'erdo-link')));

  const text = renderWorkspaceGcReport(report);
  assert.match(text, /removed 1 workspace\(s\), pruned build output in 2, 1 in use by live work, 2 recently touched/);
  assert.match(text, /kept unpushed-stream — unpushed-stream: commits on no remote/);
  assert.match(text, /pruned unpushed-stream\/node_modules/);
});

test('the filesystem root and the home directory are refused as a root; a missing root is an empty report', () => {
  assert.throws(() => gcWorkspaces({ root: '/', referenced: new Set(), idleMs: 0 }), /refusing to collect/);
  assert.throws(() => gcWorkspaces({ root: os.homedir(), referenced: new Set(), idleMs: 0 }), /refusing to collect/);
  assert.throws(() => gcWorkspaces({ root: 'relative/workspaces', referenced: new Set(), idleMs: 0 }), /must be absolute/);
  const report = gcWorkspaces({ root: path.join(tmpRoot(), 'never-created'), referenced: new Set(), idleMs: 0 });
  assert.deepEqual([report.removed, report.kept, report.pruned], [[], [], []]);
});
