/**
 * The hosted updater is what turns a merged runner fix into a deployed one.
 * These tests run it against a real local git origin and inert PATH stubs for
 * yarn and systemctl, as the service user itself (the script runs commands
 * directly when it is not root), so the fast-forward, the no-op, the refusal
 * to move a diverged checkout, and the timer install are all exercised.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const updater = fileURLToPath(new URL('../bin/weaver-gcp-update.sh', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, message: string): string {
  fs.writeFileSync(path.join(cwd, 'file.txt'), `${message}\n`);
  git(cwd, 'add', 'file.txt');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function fixture(): { root: string; origin: string; checkout: string; calls: string; units: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-update-'));
  roots.push(root);
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'opt-weaver');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  const units = path.join(root, 'units');
  for (const dir of [bin, calls, units, seed]) fs.mkdirSync(dir);
  git(root, 'init', '-q', '--bare', '--initial-branch=main', bare);
  git(seed, 'init', '-q', '--initial-branch=main');
  commit(seed, 'initial');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', bare, checkout);
  for (const tool of ['yarn', 'systemctl']) {
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/bash\nprintf '%s %s\\n' "${tool}" "$*" >> "$WEAVER_GCP_UPDATE_TEST_CALLS/log"\n`,
      { mode: 0o755 },
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    WEAVER_GCP_UPDATE_REPO: checkout,
    WEAVER_GCP_UPDATE_SERVICE_USER: os.userInfo().username,
    WEAVER_GCP_UPDATE_UNIT_DIR: units,
    WEAVER_GCP_UPDATE_SELF: '/usr/local/sbin/weaver-gcp-update',
    WEAVER_GCP_UPDATE_TEST_CALLS: calls,
    WEAVER_GCP_UPDATE_LOCK: path.join(root, 'lock'),
    WEAVER_GCP_UPDATE_LOCK_WAIT: '2',
  };
  return { root, origin: seed, checkout, calls, units, env };
}

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('bash', [updater, ...args], { env, encoding: 'utf8' });
}

function calls(dir: string): string {
  const file = path.join(dir, 'log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('an unchanged origin is a silent no-op that touches nothing', () => {
  const f = fixture();
  const quiet = run(f.env, '--quiet');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  assert.equal(calls(f.calls), '');
  const loud = run(f.env);
  assert.equal(loud.status, 0, loud.stderr);
  assert.match(loud.stdout, /^up to date at [0-9a-f]{12}\n$/);
  assert.equal(calls(f.calls), '');
});

test('a moved origin fast-forwards the checkout, reinstalls immutably, and restarts only serve', () => {
  const f = fixture();
  const before = git(f.checkout, 'rev-parse', 'HEAD');
  const target = commit(f.origin, 'a merged runner fix');
  git(f.origin, 'push', '-q', 'origin', 'main');
  const result = run(f.env, '--quiet');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), target);
  assert.match(result.stdout, new RegExp(`^updated ${before.slice(0, 12)} → ${target.slice(0, 12)} \\(origin/main\\)`));
  assert.equal(calls(f.calls), 'yarn install --immutable\nsystemctl restart weaver-serve\n');
  assert.ok(!calls(f.calls).includes('weaver-run'), 'the runner relaunches itself; the updater must never restart it');
});

test('a checkout that cannot fast-forward is left exactly where it is', () => {
  const f = fixture();
  const local = commit(f.checkout, 'a hand edit on the host');
  commit(f.origin, 'something merged meanwhile');
  git(f.origin, 'push', '-q', 'origin', 'main');
  const result = run(f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot fast-forward to origin\/main/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), local);
  assert.equal(calls(f.calls), '', 'nothing is installed or restarted on a checkout that did not move');
});

test('a failed dependency install is reported after the checkout moved, and serve is not restarted', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'bin', 'yarn'), '#!/bin/bash\nexit 7\n', { mode: 0o755 });
  const target = commit(f.origin, 'a fix whose lockfile drifted');
  git(f.origin, 'push', '-q', 'origin', 'main');
  const result = run(f.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /yarn install failed after fast-forwarding/);
  assert.equal(git(f.checkout, 'rev-parse', 'HEAD'), target);
  assert.equal(calls(f.calls), '');
});

test('install writes a oneshot service and a five-minute persistent timer and enables it', () => {
  const f = fixture();
  const result = run(f.env, 'install');
  assert.equal(result.status, 0, result.stderr);
  const service = fs.readFileSync(path.join(f.units, 'weaver-update.service'), 'utf8');
  const timer = fs.readFileSync(path.join(f.units, 'weaver-update.timer'), 'utf8');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/local\/sbin\/weaver-gcp-update --quiet$/m);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.equal(calls(f.calls), 'systemctl daemon-reload\nsystemctl enable --now weaver-update.timer\n');
});

test('an unknown subcommand and a non-checkout are refused before anything runs', () => {
  const f = fixture();
  const usage = run(f.env, 'reset');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: weaver-gcp-update \[install\|--quiet\]/);
  const missing = run({ ...f.env, WEAVER_GCP_UPDATE_REPO: path.join(f.root, 'nowhere') });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /is not a git checkout/);
  assert.equal(calls(f.calls), '');
});

test('two updaters serialize on the lock; a dead holder is taken over, a live one is waited for', () => {
  const f = fixture();
  const lock = f.env.WEAVER_GCP_UPDATE_LOCK!;
  // A holder that died mid-run (its pid is gone) must not block updates forever.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '999999999\n');
  const stale = run(f.env);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /^up to date/);
  assert.ok(!fs.existsSync(lock), 'the lock is released on exit');

  // A live holder is waited for up to the configured window, then refused —
  // never raced. This process is alive, so its pid holds the lock.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  const started = Date.now();
  const blocked = run(f.env);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, new RegExp(`another update \\(pid ${process.pid}\\) still holds .* after 2s`));
  assert.ok(Date.now() - started >= 2_000, 'the updater waited for the window before giving up');
  assert.equal(calls(f.calls), '', 'a blocked updater touches nothing');
  assert.ok(fs.existsSync(lock), 'a live holder\'s lock is left alone');
});
