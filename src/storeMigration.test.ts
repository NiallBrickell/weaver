import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import pg from 'pg';

import type { PolicyStore } from './policies.js';
import { acquireRunnerLock } from './runner.js';
import { sha256 } from './store.js';
import { initialDoc } from './store/doc.js';
import { PgStore } from './store/pg.js';
import {
  assertSourceStable,
  runFilesystemToPostgresCopy,
  snapshotFilesystemFleet,
  validateFleetSnapshot,
  type FilesystemFleetSnapshot,
} from './storeMigration.js';
import type { WorkstreamDoc } from './types.js';

const homes: string[] = [];

function freshHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-store-copy-'));
  homes.push(home);
  process.env.WEAVER_HOME = home;
  delete process.env.WEAVER_STORE;
  return home;
}

afterEach(() => {
  delete process.env.WEAVER_STORE;
  delete process.env.WEAVER_HOME;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function writeDoc(home: string, slug: string, sourceKey?: string): WorkstreamDoc {
  const doc = initialDoc({
    slug,
    title: `Fleet ${slug}`,
    objective: 'Preserve the exact durable position',
    tags: ['migration'],
    successCriteria: ['All durable truth is shared'],
    constraints: ['Never widen authority'],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 10, maxCostUsd: 20 },
    ...(sourceKey ? { sourceKey } : {}),
  });
  doc.revision = 7;
  const dir = path.join(home, slug);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workstream.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

function activeDoctrineStore(): PolicyStore {
  return {
    schemaVersion: 1,
    revision: 4,
    policies: [{
      id: 'pol_doctrine',
      statement: 'Keep durable identities distinct',
      mechanism: 'Validate the typed store before importing it',
      scope: { tags: ['migration'] },
      effect: { kind: 'add_verification', description: 'Verify the exact imported snapshot' },
      widensAuthority: false,
      status: 'active',
      provenance: {
        source: 'backfill:rules',
        ref: 'rules § identities',
        quote: 'Keep durable identities distinct',
        interventionSummary: 'Operator-authored standing rule',
      },
      evidence: [],
      createdAt: '2026-08-01T10:00:00.000Z',
    }],
  };
}

function writePolicies(home: string, policies = activeDoctrineStore()): void {
  fs.writeFileSync(path.join(home, 'policies.json'), `${JSON.stringify(policies, null, 2)}\n`);
}

function addArtifact(home: string, doc: WorkstreamDoc, relPath: string, content: string, adopted = true): void {
  const file = path.join(home, doc.workstream.slug, 'artifacts', ...relPath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const hash = sha256(content);
  doc.deliverables.push({
    id: `del_${doc.workstream.slug}`,
    title: 'Pinned result',
    kind: 'markdown',
    path: relPath,
    contentHash: hash,
    createdAtVirtual: '2026-08-01T11:00:00.000Z',
    ...(adopted ? {
      adopted: { contentHash: hash, passId: 'pass_accept', atVirtual: '2026-08-01T12:00:00.000Z' },
    } : {}),
  });
  fs.writeFileSync(
    path.join(home, doc.workstream.slug, 'workstream.json'),
    `${JSON.stringify(doc, null, 2)}\n`,
  );
}

test('filesystem snapshot preserves exact docs, nested and unreferenced artifact bytes, and policy trust', () => {
  const home = freshHome();
  const first = writeDoc(home, 'first', 'ticket:one');
  const second = writeDoc(home, 'second', 'ticket:two');
  addArtifact(home, first, 'reports/final.md', 'first artifact\nwith unicode: £');
  addArtifact(home, second, 'result.txt', 'second artifact');
  fs.writeFileSync(path.join(home, 'second', 'artifacts', 'unreferenced.log'), 'still durable');
  writePolicies(home);

  const snapshot = snapshotFilesystemFleet(home, {});
  assert.deepEqual(snapshot.workstreams.map((entry) => [entry.slug, entry.revision]), [
    ['first', 7],
    ['second', 7],
  ]);
  assert.deepEqual(snapshot.artifacts.map((artifact) => `${artifact.slug}/${artifact.relPath}`), [
    'first/reports/final.md',
    'second/result.txt',
    'second/unreferenced.log',
  ]);
  assert.equal(snapshot.artifacts[0]!.byteLength, Buffer.byteLength('first artifact\nwith unicode: £'));
  assert.deepEqual(snapshot.policies, activeDoctrineStore());
  assert.equal(snapshot.policies.policies[0]!.status, 'active');
  assert.ok('source' in snapshot.policies.policies[0]!.provenance);
  assert.equal(snapshot.policies.policies[0]!.provenance.source, 'backfill:rules');
});

test('validation refuses duplicate source identities and mismatched document slugs or revisions', () => {
  const home = freshHome();
  writeDoc(home, 'first', 'same-source');
  writeDoc(home, 'second', 'same-source');
  writePolicies(home);
  assert.throws(() => snapshotFilesystemFleet(home, {}), /share sourceKey 'same-source'/);

  const secondFile = path.join(home, 'second', 'workstream.json');
  const second = JSON.parse(fs.readFileSync(secondFile, 'utf8')) as WorkstreamDoc;
  second.workstream.sourceKey = 'different-source';
  second.workstream.slug = 'wrong';
  fs.writeFileSync(secondFile, JSON.stringify(second));
  assert.throws(() => snapshotFilesystemFleet(home, {}), /directory 'second' contains document for 'wrong'/);

  second.workstream.slug = 'second';
  fs.writeFileSync(secondFile, JSON.stringify(second));
  const snapshot = snapshotFilesystemFleet(home, {});
  snapshot.workstreams[1]!.revision += 1;
  assert.throws(() => validateFleetSnapshot(snapshot), /invalid or mismatched revision/);
});

test('validation refuses missing or drifted deliverable bytes and an unpinned adoption', () => {
  const home = freshHome();
  const doc = writeDoc(home, 'integrity');
  addArtifact(home, doc, 'final.md', 'authoritative bytes');
  writePolicies(home);
  const source = snapshotFilesystemFleet(home, {});

  const missing = structuredClone(source);
  missing.artifacts = [];
  assert.throws(() => validateFleetSnapshot(missing), /references missing artifact 'final.md'/);

  const drifted = structuredClone(source);
  drifted.workstreams[0]!.doc.deliverables[0]!.contentHash = sha256('other bytes');
  assert.throws(() => validateFleetSnapshot(drifted), /contentHash that does not match its bytes/);

  const unpinned = structuredClone(source);
  unpinned.workstreams[0]!.doc.deliverables[0]!.adopted!.contentHash = sha256('other bytes');
  assert.throws(() => validateFleetSnapshot(unpinned), /does not pin its proposed contentHash/);
});

test('known secret values are refused in docs, every artifact, and global policies', () => {
  const home = freshHome();
  const doc = writeDoc(home, 'secret-check');
  addArtifact(home, doc, 'final.md', 'safe content');
  fs.writeFileSync(path.join(home, 'secret-check', 'artifacts', 'unreferenced.txt'), 'token secret-value');
  writePolicies(home);
  assert.throws(
    () => snapshotFilesystemFleet(home, { TEAM_TOKEN: 'secret-value' }),
    /artifact 'unreferenced.txt'.*VALUE of secret TEAM_TOKEN/,
  );

  fs.writeFileSync(path.join(home, 'secret-check', 'artifacts', 'unreferenced.txt'), 'safe again');
  doc.workstream.objective = 'Use secret-value';
  fs.writeFileSync(path.join(home, 'secret-check', 'workstream.json'), JSON.stringify(doc));
  assert.throws(
    () => snapshotFilesystemFleet(home, { TEAM_TOKEN: 'secret-value' }),
    /workstream 'secret-check'.*VALUE of secret TEAM_TOKEN/,
  );

  doc.workstream.objective = 'safe';
  fs.writeFileSync(path.join(home, 'secret-check', 'workstream.json'), JSON.stringify(doc));
  const policies = activeDoctrineStore();
  policies.policies[0]!.statement = 'Never expose secret-value';
  writePolicies(home, policies);
  assert.throws(
    () => snapshotFilesystemFleet(home, { TEAM_TOKEN: 'secret-value' }),
    /global policy store.*VALUE of secret TEAM_TOKEN/,
  );
});

test('policy trust cannot be widened or leave the closed effect vocabulary during import', () => {
  const home = freshHome();
  writeDoc(home, 'policy-check');
  writePolicies(home);
  const snapshot = snapshotFilesystemFleet(home, {});

  const widened = structuredClone(snapshot);
  (widened.policies.policies[0] as unknown as { widensAuthority: boolean }).widensAuthority = true;
  assert.throws(() => validateFleetSnapshot(widened), /invalid trust, effect, or status state/);

  const openEffect = structuredClone(snapshot);
  (openEffect.policies.policies[0]!.effect as unknown as { kind: string }).kind = 'send_without_approval';
  assert.throws(() => validateFleetSnapshot(openEffect), /invalid trust, effect, or status state/);
});

test('source stability compares exact durable filesystem bytes', () => {
  const home = freshHome();
  const doc = writeDoc(home, 'stable');
  addArtifact(home, doc, 'result.txt', 'before');
  writePolicies(home);
  const before = snapshotFilesystemFleet(home, {});
  assert.doesNotThrow(() => assertSourceStable(before, snapshotFilesystemFleet(home, {})));

  const docFile = path.join(home, 'stable', 'workstream.json');
  fs.appendFileSync(docFile, '\n');
  assert.throws(
    () => assertSourceStable(before, snapshotFilesystemFleet(home, {})),
    /changed while it was being snapshotted/,
  );
});

test('copy refuses a non-filesystem source and a non-Postgres destination before touching either', async () => {
  freshHome();
  process.env.WEAVER_STORE = 'sqlite:/tmp/fleet.db';
  await assert.rejects(runFilesystemToPostgresCopy('postgres://example.invalid/fleet'), /requires WEAVER_STORE/);
  delete process.env.WEAVER_STORE;
  await assert.rejects(runFilesystemToPostgresCopy('sqlite:/tmp/destination.db'), /destination must be/);
});

test('copy refuses while a live runner owns the filesystem fleet', async () => {
  freshHome();
  const release = acquireRunnerLock();
  assert.ok(release);
  try {
    await assert.rejects(
      runFilesystemToPostgresCopy('postgres://example.invalid/fleet'),
      new RegExp(`runner pid ${process.pid} is live`),
    );
  } finally {
    release();
  }
});

const PG_URL = process.env.WEAVER_TEST_PG_URL;

test('Postgres integration resumes an exact committed fleet without overwriting a non-empty destination', { skip: !PG_URL }, async () => {
  const home = freshHome();
  const first = writeDoc(home, 'sentry-sweep');
  first.workstream.objective = 'Preserve the valid JSON string before\u0000after without a source key';
  addArtifact(home, first, 'nested/result.md', 'exact shared bytes before\u0000after');
  const slugs = [
    first.workstream.slug,
    'go-vb-artifact-lookup-cluster',
    'google-ads-bidding-strategy-targets-dropped',
    'google-ads-campaign-schema-gaps',
    ...Array.from({ length: 57 }, (_, index) => `stream-${String(index).padStart(3, '0')}`),
  ];
  for (const [index, slug] of slugs.slice(1).entries()) {
    writeDoc(home, slug, `request:${index + 1}`);
  }
  for (let index = 0; index < 1_037; index += 1) {
    const slug = slugs[index % slugs.length]!;
    fs.writeFileSync(
      path.join(home, slug, 'artifacts', `unreferenced-${String(index).padStart(4, '0')}.txt`),
      `durable artifact ${index}`,
    );
  }
  const policies = activeDoctrineStore();
  policies.revision = 717;
  policies.policies[0]!.mechanism = 'Preserve policy strings before\u0000after too';
  writePolicies(home, policies);
  const sourceBefore = snapshotFilesystemFleet(home, {});
  assert.equal(
    sourceBefore.workstreams.find(({ slug }) => slug === 'sentry-sweep')!.doc.workstream.sourceKey,
    undefined,
  );

  const schema = `weaver_copy_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(PG_URL!);
  scoped.searchParams.set('options', `-c search_path=${schema}`);

  try {
    const result = await runFilesystemToPostgresCopy(scoped.toString());
    assert.deepEqual(result, { workstreams: 61, artifacts: 1_038, policyRevision: 717 });

    const destination = new PgStore(scoped.toString());
    try {
      const copied = await destination.readExactFleet();
      assert.deepEqual(copied.workstreams, sourceBefore.workstreams);
      assert.deepEqual(copied.artifacts, sourceBefore.artifacts.map(({ slug, relPath, content }) => ({
        slug,
        relPath,
        content,
      })));
      assert.deepEqual(copied.policies, sourceBefore.policies);
    } finally {
      await destination.close();
    }

    assertSourceStable(sourceBefore, snapshotFilesystemFleet(home, {}));

    // Reproduce the committed pre-marker schema from the failed live run. A
    // fresh pool must inspect the no-sourceKey document containing U+0000 in
    // JavaScript, then recognize the destination as the exact completed copy.
    await admin.query(`ALTER TABLE "${schema}".workstreams DROP COLUMN source_key_initialized`);
    assert.deepEqual(await runFilesystemToPostgresCopy(scoped.toString()), result);
    const initialized = await admin.query(
      `SELECT source_key_json, source_key_initialized
       FROM "${schema}".workstreams
       WHERE slug = 'sentry-sweep'`,
    );
    assert.deepEqual(initialized.rows, [{ source_key_json: null, source_key_initialized: true }]);

    // Non-empty is resumable only when every locked source value matches. A
    // mismatch fails verification and the migration never rewrites it.
    await admin.query(
      `UPDATE "${schema}".artifacts
       SET content = $1
       WHERE slug = 'sentry-sweep' AND rel_path = 'unreferenced-0000.txt'`,
      [Buffer.from('tampered destination', 'utf8')],
    );
    await assert.rejects(
      runFilesystemToPostgresCopy(scoped.toString()),
      /Postgres verification failed: artifact paths or bytes differ/,
    );
    const tampered = await admin.query(
      `SELECT content FROM "${schema}".artifacts
       WHERE slug = 'sentry-sweep' AND rel_path = 'unreferenced-0000.txt'`,
    );
    assert.ok((tampered.rows[0]!.content as Buffer).equals(Buffer.from('tampered destination')));
  } finally {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

test('Postgres upgrades legacy JSON and artifact columns idempotently and keeps source uniqueness', { skip: !PG_URL }, async () => {
  const schema = `weaver_json_upgrade_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const scoped = new URL(PG_URL!);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const legacy = initialDoc({
    slug: 'legacy',
    title: 'Legacy',
    objective: 'Existing jsonb document',
    tags: ['migration'],
    successCriteria: [],
    constraints: [],
    sourceKey: 'legacy:source',
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });

  try {
    const setup = new pg.Client({ connectionString: scoped.toString() });
    await setup.connect();
    try {
      await setup.query(`
        CREATE TABLE workstreams (
          slug text PRIMARY KEY,
          revision integer NOT NULL,
          doc jsonb NOT NULL
        );
        CREATE UNIQUE INDEX workstreams_source_key
          ON workstreams ((doc -> 'workstream' ->> 'sourceKey'))
          WHERE doc -> 'workstream' ->> 'sourceKey' IS NOT NULL;
        CREATE TABLE artifacts (
          slug text NOT NULL,
          rel_path text NOT NULL,
          content text NOT NULL,
          PRIMARY KEY (slug, rel_path)
        );
        CREATE TABLE policies (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          revision integer NOT NULL,
          store jsonb NOT NULL
        );
      `);
      await setup.query(
        'INSERT INTO workstreams (slug, revision, doc) VALUES ($1, $2, $3::jsonb)',
        [legacy.workstream.slug, legacy.revision, JSON.stringify(legacy)],
      );
      await setup.query(
        `INSERT INTO policies (singleton, revision, store)
         VALUES (true, 0, '{"schemaVersion":1,"revision":0,"policies":[]}'::jsonb)`,
      );
      await setup.query(
        'INSERT INTO artifacts (slug, rel_path, content) VALUES ($1, $2, $3)',
        ['legacy', 'legacy.txt', 'existing text artifact £'],
      );
    } finally {
      await setup.end();
    }

    const first = new PgStore(scoped.toString());
    try {
      assert.deepEqual(await first.listWorkstreams(), ['legacy']);
      assert.equal(await first.readArtifact('legacy', 'legacy.txt'), 'existing text artifact £');
      const zero = '\u0000';
      const created = await first.create({
        slug: 'exact',
        title: `Exact${zero}title`,
        objective: 'Created after upgrade',
        tags: [],
        successCriteria: [],
        constraints: [],
        sourceKey: `exact${zero}source`,
        autonomy: { sendsRequireApproval: true },
        budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
      });
      assert.equal((await first.load('exact')).workstream.title, created.workstream.title);
      await first.writeArtifactRaw('exact', 'zero.txt', `before${zero}after`);
      assert.equal(await first.readArtifact('exact', 'zero.txt'), `before${zero}after`);
      await assert.rejects(
        first.create({
          slug: 'legacy-duplicate',
          title: 'Duplicate',
          objective: 'Must be refused',
          tags: [],
          successCriteria: [],
          constraints: [],
          sourceKey: 'legacy:source',
          autonomy: { sendsRequireApproval: true },
          budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
        }),
        /another workstream already stands for legacy:source/,
      );
    } finally {
      await first.close();
    }

    // A second process initialization is a no-op migration, not another
    // rewrite; typed documents remain validated JSON and artifacts remain
    // bytea, with exact string decoding at the store boundary.
    const second = new PgStore(scoped.toString());
    try {
      assert.deepEqual(await second.listWorkstreams(), ['exact', 'legacy']);
    } finally {
      await second.close();
    }
    const types = await admin.query(
      `SELECT table_name, column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (table_name, column_name) IN (
           ('artifacts', 'content'),
           ('workstreams', 'doc'),
           ('workstreams', 'source_key_initialized'),
           ('policies', 'store')
         )
       ORDER BY table_name, column_name`,
      [schema],
    );
    assert.deepEqual(types.rows, [
      { table_name: 'artifacts', column_name: 'content', data_type: 'bytea', column_default: null },
      { table_name: 'policies', column_name: 'store', data_type: 'json', column_default: null },
      { table_name: 'workstreams', column_name: 'doc', data_type: 'json', column_default: null },
      {
        table_name: 'workstreams',
        column_name: 'source_key_initialized',
        data_type: 'boolean',
        column_default: 'true',
      },
    ]);
  } finally {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
