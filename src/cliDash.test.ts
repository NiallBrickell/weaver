/**
 * A bare word to the CLI is an intake message by design; a word starting with
 * a dash never is. On 2026-09-14 `weaver version` and `weaver --version`
 * became two live workstreams and burned coordinator passes.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-cli-dash-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, WEAVER_HOME: home, WEAVER_STORE: '' },
    encoding: 'utf8',
  });
}

test('a dash-led first word is refused as an option, never onboarded as a workstream', () => {
  const result = cli('--version');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option '--version'/);
  assert.equal(fs.existsSync(path.join(home, 'version')), false);
  assert.equal(fs.existsSync(path.join(home, '--version')), false);
});

test('-h and --help print usage and exit cleanly', () => {
  for (const flag of ['-h', '--help']) {
    const result = cli(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^weaver — manages outcomes/);
  }
});
