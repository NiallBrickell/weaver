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
  loadAllSecrets,
  loadSecrets,
  redactSecrets,
  removeSecret,
  sdkEnv,
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

async function makeWs(slug: string): Promise<void> {
  await createWorkstream({
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

async function addAction(slug: string, action: Partial<Assignment>): Promise<void> {
  await arrive(slug, (d) => {
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

test('fleet redaction retains different local values stored under the same name', () => {
  makeWs('alpha');
  makeWs('beta');
  setSecret('TOKEN', 'alpha-value-123', 'alpha');
  setSecret('TOKEN', 'beta-value-456', 'beta');
  const all = loadAllSecrets();
  assert.ok(Object.values(all).includes('alpha-value-123'));
  assert.ok(Object.values(all).includes('beta-value-456'));
  const redacted = redactSecrets('alpha-value-123 / beta-value-456', all);
  assert.doesNotMatch(redacted, /alpha-value-123|beta-value-456/);
});

test('invalid names and empty values are refused', () => {
  assert.throws(() => setSecret('lower_case', 'x-value'));
  assert.throws(() => setSecret('GH TOKEN', 'x-value'));
  assert.throws(() => setSecret('OK_NAME', ''));
});

test('sdkEnv strips ambient API and OAuth credentials but preserves the operator-selected login', () => {
  const keys = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.ANTHROPIC_API_KEY = 'ambient-api-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-auth-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-oauth-token';
    process.env.CLAUDE_CONFIG_DIR = '/operator/selected/claude-config';

    const env = sdkEnv();
    assert.ok(!('ANTHROPIC_API_KEY' in env));
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env));
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
    assert.equal(env.CLAUDE_CONFIG_DIR, '/operator/selected/claude-config');
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('sdkEnv extras cannot reintroduce API or OAuth credentials', () => {
  const env = sdkEnv({
    ANTHROPIC_API_KEY: 'extra-api-key',
    ANTHROPIC_AUTH_TOKEN: 'extra-auth-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'extra-oauth-token',
    SAFE_EXTRA: 'kept',
  });
  assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env));
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
  assert.equal(env.SAFE_EXTRA, 'kept');
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

test('verify runs with secrets in env and its captured output is redacted', async () => {
  await makeWs('sec-verify-ws');
  setSecret('MY_TOKEN', 'tok-supersecret-999', 'sec-verify-ws');
  // The expected value lives OUTSIDE typed state — the store guard (rightly)
  // refuses any stored command that embeds the literal.
  fs.writeFileSync(path.join(process.env.WEAVER_HOME!, 'expected.txt'), 'tok-supersecret-999');
  await addAction('sec-verify-ws', {
    exec: {
      cwd: process.env.WEAVER_HOME!,
      verify: 'test "$MY_TOKEN" = "$(cat expected.txt)" && echo "got $MY_TOKEN"',
      approval: { by: 'human', at: new Date().toISOString() },
    },
    state: 'awaiting_review',
    attempts: [{ runId: 'r1', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }],
  });
  assert.equal(await verifyAction('sec-verify-ws', 'asg_act'), true);
  const out = (await load('sec-verify-ws')).assignments[0]!.exec!.verified!.output;
  assert.ok(out.includes('«secret:MY_TOKEN»'));
  assert.ok(!out.includes('tok-supersecret-999'));
});

test('EVERY doc write refuses embedded secret values at the store layer (steer, reply, any path)', async () => {
  await makeWs('sec-store-ws');
  setSecret('TOKEN', 'value-1234-secret', 'sec-store-ws');
  await assert.rejects(
    arrive('sec-store-ws', (d) => {
      d.steering.push({ id: 'steer_x', body: 'use value-1234-secret to auth', at: new Date().toISOString() });
    }),
    /reference it as \$TOKEN/,
  );
  // The refused write mutated nothing.
  assert.equal((await load('sec-store-ws')).steering.length, 0);
});

test('writeArtifact redacts values before hashing, so the pin matches disk and no artifact carries a value', async () => {
  await makeWs('sec-artifact-ws');
  setSecret('KEY', 'artifact-secret-99', 'sec-artifact-ws');
  const { readArtifact: readA, writeArtifact, sha256 } = await import('./store.js');
  const { relPath, hash } = await writeArtifact('sec-artifact-ws', 'out.md', 'header artifact-secret-99 footer');
  const onDisk = await readA('sec-artifact-ws', relPath);
  assert.ok(!onDisk.includes('artifact-secret-99'));
  assert.ok(onDisk.includes('«secret:KEY»'));
  assert.equal(sha256(onDisk), hash);
});

test('engine-executed exec.run gets secrets in env; the execution record never contains the value', async () => {
  await makeWs('sec-run-ws');
  setSecret('API_KEY', 'key-abcd-1234-efgh', 'sec-run-ws');
  await addAction('sec-run-ws', {
    state: 'queued',
    exec: {
      cwd: process.env.WEAVER_HOME!,
      run: 'echo "using $API_KEY" && echo "$API_KEY" > used.txt && echo done',
      verify: 'grep -q "$API_KEY" used.txt && [ -s used.txt ]',
      approval: { by: 'human', at: new Date().toISOString() },
    },
  });
  await tick('sec-run-ws', { maxPasses: 0 });
  const doc = await load('sec-run-ws');
  const asg = doc.assignments[0]!;
  assert.equal(asg.exec!.verified!.ok, true);
  const record = doc.deliverables.find((d) => d.kind === 'execution_record')!;
  const content = await readArtifact('sec-run-ws', record.path);
  assert.ok(!content.includes('key-abcd-1234-efgh'), 'execution record leaked the secret value');
  assert.ok(content.includes('«secret:API_KEY»'));
  const raw = JSON.stringify(doc);
  assert.ok(!raw.includes('key-abcd-1234-efgh'), 'typed state leaked the secret value');
});
