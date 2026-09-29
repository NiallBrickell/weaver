/**
 * Host-side git in a worker-writable checkout (safeGit.ts). Every test uses a
 * real git in a temporary directory: the claim is about what git actually
 * executes, so nothing here is mocked. A poisoned checkout writes a marker
 * file when git obeys it; the assertions are that the marker never appears.
 */

import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  actionGitHardenedEnv,
  appendGitConfigEnv,
  checkoutRefusal,
  execCapableGitConfig,
  harnessGitEnv,
  inspectCheckout,
  PoisonedCheckoutError,
  runHarnessGit,
} from './safeGit.js';
import { liveStrandedPushIO } from './deconflict.js';
import { gcWorkspaces, unshippedWork } from './workspaceGc.js';
import { runActionCommand } from './engine.js';
import { engineCommandEnv, sdkEnv } from './secrets.js';

const roots: string[] = [];
// Hermetic executor-secret store: sdkEnv/engineCommandEnv read it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-safegit-home-'));
process.env.WEAVER_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  // realpath: macOS tmpdir is a symlink, and git reports canonical paths.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

/** The test's own git, deliberately NOT the hardened runner: it plays the
 * worker writing its checkout. */
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
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();
}

/** A bare remote plus a clone with one pushed commit on main. */
function checkout(root: string, name = 'repo'): { repo: string; remote: string } {
  const remote = path.join(root, `${name}-remote.git`);
  fs.mkdirSync(remote);
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { repo, remote };
}

function markerCommand(marker: string): string {
  return `touch ${JSON.stringify(marker)}`;
}

test('core.fsmonitor in the checkout: host git never runs it and the checkout is refused by name', () => {
  const root = tmp('weaver-safegit-fsmonitor-');
  const { repo } = checkout(root);
  const marker = path.join(root, 'fsmonitor-ran');
  git(repo, 'config', 'core.fsmonitor', markerCommand(marker));
  // Control: an ordinary git obeys it — the attack is real.
  git(repo, 'status', '--porcelain');
  assert.equal(fs.existsSync(marker), true, 'control: plain git executes core.fsmonitor');
  fs.rmSync(marker);

  const refusal = checkoutRefusal(repo);
  assert.ok(refusal, 'the checkout is refused');
  assert.equal(refusal.checkout, repo);
  assert.ok(refusal.findings.some((f) => f.startsWith('core.fsmonitor in ')), refusal.findings.join('; '));
  assert.throws(() => runHarnessGit(['status', '--porcelain'], { cwd: repo }), PoisonedCheckoutError);
  // Even with the refusal bypassed, the overrides alone neutralise it.
  execFileSync('git', ['status', '--porcelain'], { cwd: repo, env: harnessGitEnv(), stdio: 'ignore' });
  assert.equal(fs.existsSync(marker), false, 'neither the refusal nor the hardened env ran the fsmonitor');
  // From a subdirectory too: discovery walks up the way git does.
  fs.mkdirSync(path.join(repo, 'src'));
  assert.ok(checkoutRefusal(path.join(repo, 'src')));
});

test('a husky-style checkout is not refused, and host git and an engine push never run its hooks', async () => {
  const root = tmp('weaver-safegit-husky-');
  const { repo, remote } = checkout(root);
  // What `yarn install` leaves behind in a husky repository: core.hooksPath in
  // repository config and executable hooks under it — plus one in .git/hooks
  // for the pre-husky layout.
  const marker = path.join(root, 'hook-ran');
  fs.mkdirSync(path.join(repo, '.husky'));
  for (const hook of [path.join(repo, '.husky', 'pre-push'), path.join(repo, '.husky', 'post-commit'), path.join(repo, '.git', 'hooks', 'pre-push')]) {
    fs.writeFileSync(hook, `#!/bin/sh\n${markerCommand(marker)}\n`, { mode: 0o755 });
  }
  git(repo, 'add', '.husky');
  git(repo, 'commit', '-q', '-m', 'husky');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'config', 'core.hooksPath', '.husky');
  fs.rmSync(marker, { force: true });
  // Control: plain git obeys the husky hooks — they are real.
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'control');
  assert.equal(fs.existsSync(marker), true, 'control: plain git runs the husky post-commit hook');
  fs.rmSync(marker);
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');

  assert.equal(inspectCheckout(repo).verdict, 'clean', 'hooks are not a refusal: the override neutralises them');
  assert.equal(runHarnessGit(['status', '--porcelain'], { cwd: repo }).trim(), '');
  fs.writeFileSync(path.join(repo, 'README.md'), 'pushed\n');
  const env = engineCommandEnv({
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  const pushed = await runActionCommand(
    'git commit -q -am pushed && git push -q origin HEAD:main && git rev-parse HEAD',
    repo,
    env,
    30_000,
  );
  assert.equal(pushed.ok, true, pushed.output);
  assert.equal(git(remote, 'rev-parse', 'main'), pushed.output.trim());
  assert.equal(fs.existsSync(marker), false, 'neither pre-push nor post-commit ran on the host');
});

test('a filter driver plus .gitattributes is refused and never executes', () => {
  const root = tmp('weaver-safegit-filter-');
  const { repo } = checkout(root);
  const marker = path.join(root, 'filter-ran');
  git(repo, 'config', 'filter.x.clean', `sh -c '${markerCommand(marker)}; cat'`);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=x\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
  const refusal = checkoutRefusal(repo);
  assert.ok(refusal?.findings.some((f) => f.startsWith('filter.x.clean in ')));
  assert.equal(unshippedWork(repo)?.startsWith('git refused'), true);
  assert.equal(fs.existsSync(marker), false);
});

test('the refusal list covers the exec-capable keys and leaves ordinary configuration alone', () => {
  for (const [key, value] of [
    ['include.path', '/tmp/x'],
    ['includeIf.gitdir:/x/.path', '/tmp/x'],
    ['credential.helper', '!sh -c evil'],
    ['credential.https://github.com.helper', 'store'],
    ['diff.x.textconv', 'evil'],
    ['diff.external', 'evil'],
    ['merge.x.driver', 'evil'],
    ['core.sshCommand', 'evil'],
    ['core.pager', 'evil'],
    ['core.fsmonitor', 'evil'],
    ['alias.co', '!evil'],
    ['gpg.program', 'evil'],
    ['remote.origin.uploadpack', 'evil'],
    ['remote.origin.url', 'ext::sh -c evil'],
    ['url.ext::sh.insteadOf', 'https://github.com/'],
    ['submodule.x.update', '!evil'],
    ['protocol.ext.allow', 'always'],
  ] as const) {
    assert.equal(execCapableGitConfig(key, value), true, key);
  }
  for (const [key, value] of [
    ['core.fsmonitor', 'false'],
    // Neutralised by the core.hooksPath=/dev/null override instead.
    ['core.hooksPath', '.husky/_'],
    ['core.bare', 'false'],
    ['credential.helper', ''],
    ['remote.origin.url', 'https://github.com/octo/repo.git'],
    ['branch.main.merge', 'refs/heads/main'],
    ['submodule.x.update', 'checkout'],
    ['protocol.ext.allow', 'never'],
    ['user.name', 'x'],
  ] as const) {
    assert.equal(execCapableGitConfig(key, value), false, key);
  }
});

test('include.path is refused without being followed, and an implicit bare repository is refused', () => {
  const root = tmp('weaver-safegit-include-');
  const { repo } = checkout(root);
  const marker = path.join(root, 'include-ran');
  const included = path.join(root, 'included');
  fs.writeFileSync(included, `[core]\n\tfsmonitor = ${markerCommand(marker)}\n`);
  git(repo, 'config', 'include.path', included);
  const refusal = checkoutRefusal(repo);
  assert.ok(refusal?.findings.some((f) => f.startsWith('include.path in ')));
  assert.equal(fs.existsSync(marker), false);

  // A worker that deletes .git and turns the checkout itself into a bare
  // repository must not have its config read by discovery.
  const bareish = path.join(root, 'bareish');
  fs.mkdirSync(bareish);
  git(bareish, 'init', '-q', '--bare');
  const inspection = inspectCheckout(bareish);
  assert.equal(inspection.verdict, 'refused');
});

test('a clean checkout runs exactly as before: status, deconflict branch probe, and collection', () => {
  const root = tmp('weaver-safegit-clean-');
  const { repo } = checkout(root);
  assert.equal(inspectCheckout(repo).verdict, 'clean');
  assert.equal(runHarnessGit(['status', '--porcelain'], { cwd: repo }).trim(), '');
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  assert.equal(liveStrandedPushIO.branchOf(repo), 'feat/x');
  assert.equal(unshippedWork(repo), null);

  // A poisoned sibling is kept (never deleted, never executed) and named; the
  // clean one is collected.
  const gcRoot = tmp('weaver-safegit-gc-');
  const clean = checkout(gcRoot, 'clean').repo;
  const poisoned = checkout(gcRoot, 'poisoned').repo;
  const marker = path.join(root, 'gc-fsmonitor-ran');
  git(poisoned, 'config', 'core.fsmonitor', markerCommand(marker));
  const report = gcWorkspaces({ root: gcRoot, referenced: new Set(), idleMs: 0, nowMs: Date.now() + 60_000 });
  assert.ok(report.removed.includes('clean'));
  assert.equal(fs.existsSync(clean), false);
  const kept = report.kept.find((entry) => entry.child === 'poisoned');
  assert.match(kept?.reason ?? '', /git refused, its control plane can execute programs \(core\.fsmonitor in /);
  assert.equal(fs.existsSync(poisoned), true);
  assert.equal(fs.existsSync(marker), false);
  // deconflict fails open on the refused checkout without executing it.
  assert.equal(liveStrandedPushIO.branchOf(poisoned), null);
  assert.equal(fs.existsSync(marker), false);
});

test('a linked worktree is judged by its common directory configuration', () => {
  const root = tmp('weaver-safegit-worktree-');
  const { repo } = checkout(root);
  const linked = path.join(root, 'linked');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/linked', linked);
  assert.equal(inspectCheckout(linked).verdict, 'clean');
  git(repo, 'config', 'diff.x.textconv', 'evil');
  const refusal = checkoutRefusal(linked);
  assert.equal(refusal?.checkout, linked);
  assert.ok(refusal?.findings.some((f) => f.startsWith('diff.x.textconv in ')));
});

test('the action env appends the overrides after the GitHub App entries it already carries', () => {
  const env = actionGitHardenedEnv({
    PATH: '/usr/bin',
    GIT_DIR: '/elsewhere',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!f() { echo password=$GH_TOKEN; }; f',
  });
  assert.equal(env.GIT_DIR, undefined, 'a redirecting variable cannot point git elsewhere');
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
  const count = Number(env.GIT_CONFIG_COUNT);
  const pairs = Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  for (const expected of [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', '/dev/null'],
    ['diff.external', ''],
    ['protocol.ext.allow', 'never'],
    ['safe.bareRepository', 'explicit'],
  ]) {
    assert.ok(pairs.slice(2).some(([k, v]) => k === expected[0] && v === expected[1]), String(expected[0]));
  }
  // No inherited helper blanking after the App's own helper: it must survive.
  assert.equal(pairs.slice(2).some(([k]) => k === 'credential.helper'), false);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(appendGitConfigEnv({}, [['a.b', 'c']]), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' });
});

test('an engine command pushes to a real remote with the hardening on, and the App helper still answers', async () => {
  const root = tmp('weaver-safegit-push-');
  const { repo, remote } = checkout(root);
  fs.writeFileSync(path.join(repo, 'README.md'), 'second\n');
  git(repo, 'commit', '-q', '-am', 'second');
  // The exact plumbing githubApp.mintedGitHubAppEnvironment hands an action.
  const appEnvironment = {
    GH_TOKEN: 'installation-token',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!f() { test "$1" != get || printf \'%s\\n\' \'username=x-access-token\' "password=$GH_TOKEN"; }; f',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.username',
    GIT_CONFIG_VALUE_2: 'x-access-token',
    GIT_CONFIG_KEY_3: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_3: 'true',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const env = engineCommandEnv(appEnvironment);
  const pushed = await runActionCommand('git push -q origin HEAD:main && git rev-parse HEAD', repo, env, 30_000);
  assert.equal(pushed.ok, true, pushed.output);
  assert.equal(git(remote, 'rev-parse', 'main'), pushed.output.trim());
  const credential = await runActionCommand(
    'printf "protocol=https\\nhost=github.com\\npath=octo/repo.git\\n\\n" | git credential fill',
    repo,
    env,
    30_000,
  );
  assert.equal(credential.ok, true, credential.output);
  assert.match(credential.output, /^password=installation-token$/m);
  const config = await runActionCommand('git config --get core.hooksPath', repo, env, 30_000);
  assert.equal(config.output.trim(), '/dev/null');
});

test('an engine command in a poisoned checkout is refused before it spawns', async () => {
  const root = tmp('weaver-safegit-action-');
  const { repo } = checkout(root);
  const marker = path.join(root, 'action-ran');
  const filterMarker = path.join(root, 'filter-ran');
  git(repo, 'config', 'filter.x.clean', `sh -c '${markerCommand(filterMarker)}; cat'`);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=x\n');
  const result = await runActionCommand(`${markerCommand(marker)}; git add -A; git push -q origin HEAD:main`, repo, engineCommandEnv(), 30_000);
  assert.equal(result.ok, false);
  assert.match(result.output, /host git refused in .*filter\.x\.clean/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(filterMarker), false);
});

test('sdkEnv no longer hands a model process the store URL or the App identity', () => {
  const saved = {
    WEAVER_STORE: process.env.WEAVER_STORE,
    WEAVER_GITHUB_APP_ID: process.env.WEAVER_GITHUB_APP_ID,
    WEAVER_PILOT_TOKEN: process.env.WEAVER_PILOT_TOKEN,
  };
  process.env.WEAVER_STORE = 'postgres://weaver:secret@db/weaver';
  process.env.WEAVER_GITHUB_APP_ID = '12345';
  process.env.WEAVER_PILOT_TOKEN = 'pilot-bearer';
  try {
    const env = sdkEnv({ WEAVER_STORE: 'postgres://smuggled', EXTRA: 'kept' });
    assert.equal(env.WEAVER_STORE, undefined);
    assert.equal(env.WEAVER_GITHUB_APP_ID, undefined);
    assert.equal(env.WEAVER_PILOT_TOKEN, undefined);
    assert.equal(env.EXTRA, 'kept');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
