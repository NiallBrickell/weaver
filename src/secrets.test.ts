/**
 * Secrets: values are usable by exec shells but can never surface in typed
 * state, artifacts, or captured output — only NAMES are ever visible.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { tick, verifyAction } from './engine.js';
import {
  globalSecretsPath,
  loadSecrets,
  redactSecrets,
  removeSecret,
  secretNames,
  setSecret,
} from './secrets.js';
import { createWorkstream, load, readArtifact } from './store.js';
import { virtualNow } from './clock.js';
import type { Assignment } from './types.js';
import { arrive } from './store.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-sec-'));
});

function makeWs(slug: string): void {
  createWorkstream({
    slug,
    title: 'Secrets test',
    objective: 'test secrets',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

function addAction(slug: string, action: Partial<Assignment>): void {
  arrive(slug, (d) => {
    d.assignments.push({
      id: 'asg_act',
      objective: 'perform the act',
      briefing: 'n/a',
      kind: 'action',
      exec: { cwd: process.env.WEAVER_HOME!, verify: 'true' },
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'gated',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
      ...action,
    } as Assignment);
  });
}

test('set/list/rm roundtrip; workstream overlay wins over global; file is 0600', () => {
  makeWs('sec-ws');
  setSecret('GH_TOKEN', 'global-value-123');
  setSecret('DB_URL', 'postgres://u:p@h/db');
  setSecret('GH_TOKEN', 'ws-value-456', 'sec-ws');

  assert.deepEqual(secretNames(), ['DB_URL', 'GH_TOKEN']);
  assert.equal(loadSecrets('sec-ws').GH_TOKEN, 'ws-value-456');
  assert.equal(loadSecrets().GH_TOKEN, 'global-value-123');

  const mode = fs.statSync(globalSecretsPath()).mode & 0o777;
  assert.equal(mode, 0o600);

  assert.equal(removeSecret('DB_URL'), true);
  assert.deepEqual(secretNames(), ['GH_TOKEN']);
  assert.equal(removeSecret('DB_URL'), false);
});

test('invalid names and empty values are refused', () => {
  assert.throws(() => setSecret('lower_case', 'x-value'));
  assert.throws(() => setSecret('GH TOKEN', 'x-value'));
  assert.throws(() => setSecret('OK_NAME', ''));
});

test('redactSecrets scrubs every value, longest first, and skips tiny values', () => {
  const secrets = { LONG: 'abcdef-secret', SHORT: 'abcdef', TINY: 'ab' };
  const out = redactSecrets('x abcdef-secret y abcdef z ab', secrets);
  assert.equal(out, 'x «secret:LONG» y «secret:SHORT» z ab');
});

test('human-authored text embedding a secret VALUE is refused; $NAME references pass', async () => {
  const { assertNoSecretValues } = await import('./secrets.js');
  const secrets = { API_KEY: 'key-abcd-1234-efgh' };
  assert.throws(
    () => assertNoSecretValues('curl -H "Auth: key-abcd-1234-efgh" x', secrets),
    /reference it as \$API_KEY/,
  );
  assertNoSecretValues('curl -H "Auth: $API_KEY" x', secrets);
});

test('verify runs with secrets in env and its captured output is redacted', () => {
  makeWs('sec-verify-ws');
  setSecret('MY_TOKEN', 'tok-supersecret-999', 'sec-verify-ws');
  addAction('sec-verify-ws', {
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'test "$MY_TOKEN" = tok-supersecret-999 && echo "got $MY_TOKEN"',
    },
  });
  assert.equal(verifyAction('sec-verify-ws', 'asg_act'), true);
  const out = load('sec-verify-ws').assignments[0]!.exec!.verified!.output;
  assert.ok(out.includes('«secret:MY_TOKEN»'));
  assert.ok(!out.includes('tok-supersecret-999'));
});

test('engine-executed exec.run gets secrets in env; the execution record never contains the value', async () => {
  makeWs('sec-run-ws');
  setSecret('API_KEY', 'key-abcd-1234-efgh', 'sec-run-ws');
  addAction('sec-run-ws', {
    state: 'queued',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'echo "using $API_KEY" && echo "$API_KEY" > used.txt && echo done',
      verify: 'grep -q "$API_KEY" used.txt && [ -s used.txt ]',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });
  await tick('sec-run-ws', { maxPasses: 0 });
  const doc = load('sec-run-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.exec!.verified!.ok, true);
  const record = doc.deliverables.find((d) => d.kind === 'execution_record')!;
  const content = readArtifact('sec-run-ws', record.path);
  assert.ok(!content.includes('key-abcd-1234-efgh'), 'execution record leaked the secret value');
  assert.ok(content.includes('«secret:API_KEY»'));
  const raw = JSON.stringify(doc);
  assert.ok(!raw.includes('key-abcd-1234-efgh'), 'typed state leaked the secret value');
});
