/**
 * `weaver link` rails, deterministic (no model calls): URL validation fails
 * closed, a password never survives into anything link echoes, the probe goes
 * through the real store layer and performs NO writes, and the `.env`
 * persistence is surgical in both directions (link and --unlink).
 */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  probeFleet,
  redactStoreUrl,
  removeEnvKey,
  scrubStoreSecrets,
  storeDisplayLabel,
  validateStoreUrl,
} from './link.js';
import { updateEnvContent } from './login.js';
import { closeStore, createWorkstream, load } from './store.js';

beforeEach(async () => {
  await closeStore();
  delete process.env.WEAVER_STORE;
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-link-'));
});

// ── URL validation ───────────────────────────────────────────────────────────

test('validateStoreUrl accepts exactly the three store forms', () => {
  assert.equal(validateStoreUrl('postgres://user:pass@host:5432/weaver'), null);
  assert.equal(validateStoreUrl('postgresql://host/db'), null);
  assert.equal(validateStoreUrl('sqlite:/tmp/fleet.db'), null);
  assert.equal(validateStoreUrl('sqlite:~/fleet.db'), null);
});

test('validateStoreUrl rejects everything else with the accepted forms named', () => {
  for (const bad of [
    'mysql://host/db',
    'http://host/db',
    'postgres:/missing-slashes',
    'host:5432/weaver',
    '/tmp/fleet.db',
    '',
  ]) {
    const err = validateStoreUrl(bad);
    assert.ok(err, `expected '${bad}' to be rejected`);
    assert.match(err!, /postgres:\/\//);
    assert.match(err!, /sqlite:/);
  }
});

test('store display labels distinguish shared and local fleets without credentials', () => {
  const shared = storeDisplayLabel('postgresql://private-user:private-pass@db.example.test:5432/weaver?sslmode=require');
  assert.equal(shared, 'Shared fleet · db.example.test/weaver');
  assert.doesNotMatch(shared, /private|5432|sslmode/);
  assert.equal(storeDisplayLabel('sqlite:/tmp/my-fleet.db'), 'Local SQLite · my-fleet.db');
  assert.equal(storeDisplayLabel(undefined), 'Local files');
});

// ── redaction ────────────────────────────────────────────────────────────────

test('redactStoreUrl removes the password and only the password', () => {
  assert.equal(
    redactStoreUrl('postgres://weaver:s3cret-pw@db.example.com:5432/fleet'),
    'postgres://weaver:***@db.example.com:5432/fleet',
  );
  assert.equal(
    redactStoreUrl('postgresql://weaver:s3cret-pw@db.example.com/fleet'),
    'postgresql://weaver:***@db.example.com/fleet',
  );
  assert.ok(!redactStoreUrl('postgres://weaver:s3cret-pw@h/db').includes('s3cret-pw'));
});

test('redactStoreUrl passes through URLs without secrets unchanged', () => {
  assert.equal(redactStoreUrl('postgres://host:5432/fleet'), 'postgres://host:5432/fleet');
  assert.equal(redactStoreUrl('postgres://weaver@host/fleet'), 'postgres://weaver@host/fleet');
  assert.equal(redactStoreUrl('sqlite:/tmp/fleet.db'), 'sqlite:/tmp/fleet.db');
  assert.equal(redactStoreUrl('sqlite:~/state/fleet.db'), 'sqlite:~/state/fleet.db');
});

test('scrubStoreSecrets strips both the full URL and the bare password from error text', () => {
  const url = 'postgres://weaver:s3cret-pw@db.example.com:5432/fleet';
  const scrubbed = scrubStoreSecrets(
    `connection to ${url} failed: password authentication failed for "s3cret-pw"`,
    url,
  );
  assert.ok(!scrubbed.includes('s3cret-pw'), scrubbed);
  assert.ok(scrubbed.includes('postgres://weaver:***@db.example.com:5432/fleet'));

  // No userinfo / sqlite: scrubbing must be a no-op, never a corruption.
  assert.equal(scrubStoreSecrets('boom', 'postgres://host/db'), 'boom');
  assert.equal(scrubStoreSecrets('boom', 'sqlite:/tmp/fleet.db'), 'boom');
});

// ── the probe, against a real temp store ─────────────────────────────────────

test('probeFleet reads a real sqlite fleet through the store layer and writes nothing', async () => {
  const url = `sqlite:${path.join(process.env.WEAVER_HOME!, 'fleet.db')}`;
  process.env.WEAVER_STORE = url;
  await createWorkstream({
    slug: 'shared-ws',
    title: 'Shared fleet workstream',
    objective: 'prove link sees real data',
    tags: ['test'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  const before = await load('shared-ws');
  await closeStore();
  delete process.env.WEAVER_STORE; // link starts from an unlinked machine

  const summary = await probeFleet(url);
  assert.equal(summary.backend, 'sqlite');
  assert.equal(summary.workstreamCount, 1);
  assert.equal(summary.recent?.slug, 'shared-ws');
  assert.equal(summary.recent?.title, 'Shared fleet workstream');
  assert.equal(summary.recent?.status, 'active');

  // Read-only: the doc is byte-identical and the revision did not move.
  assert.equal(process.env.WEAVER_STORE, undefined, 'probe must restore the prior store target');
  process.env.WEAVER_STORE = url;
  const after = await load('shared-ws');
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after, before);
  await closeStore();
  delete process.env.WEAVER_STORE;
});

test('probeFleet reports an empty fleet without inventing data', async () => {
  const dbPath = path.join(process.env.WEAVER_HOME!, 'empty.db');
  // Materialize an empty-but-real fleet database first (link never creates one).
  process.env.WEAVER_STORE = `sqlite:${dbPath}`;
  const { listWorkstreams } = await import('./store.js');
  assert.deepEqual(await listWorkstreams(), []);
  await closeStore();
  delete process.env.WEAVER_STORE;

  const summary = await probeFleet(`sqlite:${dbPath}`);
  assert.equal(summary.workstreamCount, 0);
  assert.equal(summary.recent, undefined);
});

test('probeFleet refuses a missing sqlite file instead of minting an empty fleet', async () => {
  await assert.rejects(
    () => probeFleet(`sqlite:${path.join(process.env.WEAVER_HOME!, 'nope', 'missing.db')}`),
    /no database file/,
  );
});

// ── .env persistence ─────────────────────────────────────────────────────────

const ENV_BEFORE =
  [
    '# machine-local config',
    'WEAVER_COORDINATOR_MODEL=claude-fable-5',
    '',
    'export WEAVER_WORKER_MODEL=sonnet',
    'UNRELATED=stays',
  ].join('\n') + '\n';

test('linking adds WEAVER_STORE and updates it in place, preserving everything else', () => {
  const linked = updateEnvContent(ENV_BEFORE, { WEAVER_STORE: 'postgres://u:p@h/db' });
  assert.equal(linked, ENV_BEFORE + 'WEAVER_STORE=postgres://u:p@h/db\n');

  const relinked = updateEnvContent(linked, { WEAVER_STORE: 'sqlite:/tmp/other.db' });
  assert.equal(relinked, ENV_BEFORE + 'WEAVER_STORE=sqlite:/tmp/other.db\n');
});

test('--unlink removes every WEAVER_STORE assignment and nothing else', () => {
  const content =
    [
      '# fleet target — see docs-public/hosting.md',
      'WEAVER_STORE=postgres://u:p@h/db',
      'UNRELATED=stays',
      'export WEAVER_STORE=sqlite:/tmp/dup.db',
      '# WEAVER_STORE=postgres://commented-out-stays',
    ].join('\n') + '\n';
  const { content: next, removed } = removeEnvKey(content, 'WEAVER_STORE');
  assert.equal(removed, true);
  assert.equal(
    next,
    [
      '# fleet target — see docs-public/hosting.md',
      'UNRELATED=stays',
      '# WEAVER_STORE=postgres://commented-out-stays',
    ].join('\n') + '\n',
  );
});

test('--unlink on content without the key is a clean no-op', () => {
  const { content, removed } = removeEnvKey(ENV_BEFORE, 'WEAVER_STORE');
  assert.equal(removed, false);
  assert.equal(content, ENV_BEFORE);
  assert.deepEqual(removeEnvKey('', 'WEAVER_STORE'), { content: '', removed: false });
});
