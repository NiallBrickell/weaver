import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const repo = fileURLToPath(new URL('../', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(dotenv: string, disabled?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-up-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['weaver-up.sh', 'weaver.mjs']) {
    fs.copyFileSync(path.join(repo, 'bin', name), path.join(bin, name));
  }
  fs.symlinkSync(path.join(repo, 'src'), path.join(root, 'src'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(root, '.env'), dotenv);
  // Inert process probes keep --print deterministic even if a real runner is
  // active on the test machine. Disabled mode must not reach these at all.
  fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, WEAVER_HOME: path.join(root, 'state') };
  delete env.WEAVER_STORE;
  delete env.WEAVER_RUNNER_DISABLED;
  if (disabled !== undefined) env.WEAVER_RUNNER_DISABLED = disabled;
  return { root, env, script: path.join(bin, 'weaver-up.sh'), cli: path.join(bin, 'weaver.mjs') };
}

test('weaver-up reads disabled from its checkout .env and skips local start and restart', () => {
  const f = fixture('WEAVER_RUNNER_DISABLED=1\nWEAVER_TEST_LITERAL="$(touch should-not-run)"\n');
  // Include a live lock owner so --restart would advertise killing it if the
  // wrapper accidentally entered the enabled path. --print makes it inert.
  fs.mkdirSync(path.join(f.env.WEAVER_HOME!, '.runner.lock'), { recursive: true });
  fs.writeFileSync(path.join(f.env.WEAVER_HOME!, '.runner.lock', `${process.pid}-test.owner.json`), '{}');
  for (const args of [['--no-watch'], ['--no-watch', '--restart', '--print']]) {
    const result = spawnSync('bash', [f.script, ...args], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /operator mode.*local execution disabled/);
    assert.doesNotMatch(result.stdout, /nohup|stopping runner|starting headless|fleet up/);
    assert.equal(fs.existsSync(path.join(f.root, 'should-not-run')), false, '.env must not execute shell substitutions');
  }
});

test('weaver-up preserves environment precedence and the enabled/unset startup path', () => {
  for (const [dotenv, disabled] of [
    ['WEAVER_RUNNER_DISABLED=1\n', '0'],
    ['WEAVER_RUNNER_DISABLED=0\n', '1'],
    ['', undefined],
  ] as const) {
    const f = fixture(dotenv, disabled);
    const result = spawnSync('bash', [f.script, '--no-watch', '--print'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    if (disabled === '1') assert.doesNotMatch(result.stdout, /nohup/);
    else assert.match(result.stdout, /nohup weaver run/);
  }
});

test('a new Terminal viewer receives an invocation-only disabled posture', () => {
  const f = fixture('WEAVER_RUNNER_DISABLED=0\n', '1');
  const result = spawnSync('bash', [f.script, '--print'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WEAVER_RUNNER_DISABLED=1 weaver watch/);
  assert.doesNotMatch(result.stdout, /nohup/);
});

test('invalid configuration fails the wrapper before any startup and CLI run before its lock', () => {
  for (const disabled of ['invalid', '1']) {
    const f = fixture(`WEAVER_RUNNER_DISABLED=${disabled}\n`);
    const command = disabled === 'invalid' ? 'bash' : process.execPath;
    const args = disabled === 'invalid' ? [f.script, '--no-watch', '--print'] : [f.cli, 'run'];
    const result = spawnSync(command, args, { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WEAVER_RUNNER_DISABLED/);
    assert.doesNotMatch(result.stdout, /nohup|ticking active workstreams/);
    assert.equal(fs.existsSync(f.env.WEAVER_HOME!), false, 'config refusal creates no runner lock or store');
  }
});

test('CLI configuration check works without a reachable store and starts nothing', () => {
  const f = fixture('WEAVER_RUNNER_DISABLED=1\nWEAVER_STORE=postgres://unreachable.invalid/weaver\n');
  const result = spawnSync(process.execPath, [f.cli, 'run', '--check'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'disabled\n');
  assert.equal(fs.existsSync(f.env.WEAVER_HOME!), false);
});
