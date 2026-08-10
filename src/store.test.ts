/**
 * Deterministic store-contract tests: no model, no network to any provider,
 * no SDK run. (Testing discipline ported from the relay experiment: model
 * quality must never be able to make a durability test pass or fail.)
 *
 * The suite is PARAMETERIZED over backends: the fs reference backend and the
 * sqlite backend (a temp-file database — no service, no env var) always run;
 * the Postgres backend runs when WEAVER_TEST_PG_URL points at a database (a
 * throwaway `docker run postgres:16` is enough) and is skipped with a message
 * otherwise. Same tests, same assertions — the contract is the contract on
 * every backend.
 */

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

import {
  RevisionConflictError,
  SourceKeyConflictError,
  arrive,
  artifactsDir,
  closeStore,
  createWorkstream,
  findBySourceKey,
  listWorkstreams,
  load,
  mutate,
  mutatePolicies,
  newId,
  tryTickLock,
  verifyArtifact,
  workstreamDir,
  writeArtifact,
} from './store.js';
import { loadPolicies, type PolicyRecord } from './policies.js';
import { virtualNow } from './clock.js';

const PG_URL = process.env.WEAVER_TEST_PG_URL;

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

function makeWorkstream(slug = 'test-ws') {
  return createWorkstream({
    slug,
    title: 'Test',
    objective: 'test objective',
    tags: ['test'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

function fakePolicy(tag: string): PolicyRecord {
  return {
    id: newId('pol'),
    statement: `test policy ${tag}`,
    scope: { tags: ['test'] },
    effect: { kind: 'advisory', description: 'test effect' },
    widensAuthority: false,
    status: 'shadow',
    provenance: { source: 'seed', ref: 'test', interventionSummary: 'test' },
    evidence: [],
    createdAt: new Date().toISOString(),
  };
}

/** One short-lived client for test plumbing (truncation, tampering, barriers). */
async function pgAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Backend {
  /** Point getStore() at this backend on top of a clean slate. */
  reset(): Promise<void>;
  /** Corrupt a stored artifact behind the store's back (integrity test). */
  tamper(slug: string, relPath: string, content: string): Promise<void>;
}

const fsBackend: Backend = {
  async reset() {
    await closeStore();
    delete process.env.WEAVER_STORE;
    freshHome();
  },
  async tamper(slug, relPath, content) {
    fs.writeFileSync(path.join(artifactsDir(slug), relPath), content);
  },
};

/** Set by sqliteBackend.reset() so tamper() can open the same database file. */
let sqliteDbPath = '';

const sqliteBackend: Backend = {
  async reset() {
    await closeStore();
    const home = freshHome(); // secrets and machine-local sidecars still live under WEAVER_HOME
    sqliteDbPath = path.join(home, 'weaver.db');
    process.env.WEAVER_STORE = `sqlite:${sqliteDbPath}`;
  },
  async tamper(slug, relPath, content) {
    // A second connection to the same file — genuinely behind the store's back.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(sqliteDbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('UPDATE artifacts SET content = ? WHERE slug = ? AND rel_path = ?')
        .run(content, slug, relPath);
    } finally {
      db.close();
    }
  },
};

const pgBackend: Backend = {
  async reset() {
    await closeStore();
    process.env.WEAVER_STORE = PG_URL;
    freshHome(); // secrets and machine-local locks still live under WEAVER_HOME
    try {
      await pgAdmin((c) => c.query('TRUNCATE workstreams, artifacts, policies'));
    } catch (e) {
      // 42P01 undefined_table: first-ever run, migration hasn't created them.
      if ((e as { code?: string }).code !== '42P01') throw e;
    }
  },
  async tamper(slug, relPath, content) {
    await pgAdmin((c) =>
      c.query('UPDATE artifacts SET content = $1 WHERE slug = $2 AND rel_path = $3', [
        content,
        slug,
        relPath,
      ]),
    );
  },
};

/** The whole contract, identical for every backend. */
function contractSuite(backend: Backend): void {
  beforeEach(() => backend.reset());

  test('a stale write is rejected with RevisionConflictError and mutates nothing', async () => {
    await makeWorkstream();
    const doc = await load('test-ws');
    await assert.rejects(
      mutate('test-ws', doc.revision - 1, (d) => (d.workstream.title = 'clobbered')),
      RevisionConflictError,
    );
    await assert.rejects(mutate('test-ws', doc.revision + 1, () => {}), RevisionConflictError);
    assert.equal((await load('test-ws')).workstream.title, 'Test');
    assert.equal((await load('test-ws')).revision, doc.revision);
  });

  test('a checked write bumps the revision by exactly one and appends an event', async () => {
    await makeWorkstream();
    const before = await load('test-ws');
    await mutate('test-ws', before.revision, (d, event) => {
      event('test.event', 'hello');
    });
    const after = await load('test-ws');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.events[after.events.length - 1]!.summary, 'hello');
  });

  test('an external arrival between read and write conflicts an in-flight coordinator write', async () => {
    await makeWorkstream();
    const coordinatorRead = (await load('test-ws')).revision;
    // External arrival (steer/reply/completion) lands after the coordinator read.
    await arrive('test-ws', (d, event) => event('external.arrival', 'reply landed'));
    await assert.rejects(
      mutate('test-ws', coordinatorRead, (d) => (d.workstream.title = 'stale winner')),
      RevisionConflictError,
    );
  });

  test('adoption pins the exact content hash and integrity verification catches tampering', async () => {
    await makeWorkstream();
    const { relPath, hash } = await writeArtifact('test-ws', 'draft.md', 'the exact adopted content');
    await arrive('test-ws', (d) => {
      d.deliverables.push({
        id: newId('del'),
        title: 'Draft',
        kind: 'document',
        path: relPath,
        contentHash: hash,
        createdAtVirtual: virtualNow().toISOString(),
        adopted: { contentHash: hash, passId: 'test', atVirtual: virtualNow().toISOString() },
      });
    });
    assert.ok(await verifyArtifact('test-ws', relPath, hash));

    // Tamper with the stored artifact behind the store: the pin must catch it.
    await backend.tamper('test-ws', relPath, 'silently drifted content');
    assert.equal(await verifyArtifact('test-ws', relPath, hash), false);
  });

  test('concurrent arrivals both land: arrive retries a revision conflict against fresh state', async () => {
    await makeWorkstream();
    const before = (await load('test-ws')).revision;
    // Interleaved on the event loop: both read the same revision before either
    // writes, so the loser hits the CAS and must retry from the newer state.
    await Promise.all([
      arrive('test-ws', (d, event) => event('arrival.one', 'first')),
      arrive('test-ws', (d, event) => event('arrival.two', 'second')),
    ]);
    const after = await load('test-ws');
    assert.equal(after.revision, before + 2); // no lost update, no double-apply
    const types = after.events.map((e) => e.type);
    assert.ok(types.includes('arrival.one'));
    assert.ok(types.includes('arrival.two'));
  });

  test('simultaneous cross-process arrivals serialize without losing a revision', async () => {
    await makeWorkstream();
    const home = process.env.WEAVER_HOME!;
    const gate = path.join(home, 'arrival-gate');
    const storeUrl = pathToFileURL(path.resolve('src/store.ts')).href;
    const count = 8;
    const children = Array.from({ length: count }, (_, index) => {
      const ready = path.join(home, `ready-${index}`);
      const code = `
        import fs from 'node:fs';
        const { arrive, closeStore } = await import(${JSON.stringify(storeUrl)});
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
        await arrive('test-ws', (doc) => doc.workstream.constraints.push(${JSON.stringify(`arrival-${index}`)}));
        await closeStore();
      `;
      return new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
          cwd: process.cwd(),
          env: { ...process.env, WEAVER_HOME: home },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('close', (exitCode) => resolve({ code: exitCode, stderr }));
      });
    });
    const deadline = Date.now() + 10_000;
    while (fs.readdirSync(home).filter((name) => name.startsWith('ready-')).length < count) {
      if (Date.now() > deadline) throw new Error('child arrival barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(gate, 'go');
    const results = await Promise.all(children);
    // node:sqlite prints an ExperimentalWarning on load (Node 22–25), so a
    // child on the sqlite backend has known-benign stderr noise; anything
    // else on stderr is still a failure.
    const cleaned = results.map(({ code, stderr }) => ({
      code,
      stderr: stderr
        .split('\n')
        .filter((line) => line && !/ExperimentalWarning: SQLite|Use `node --trace-warnings/.test(line))
        .join('\n'),
    }));
    assert.deepEqual(cleaned, Array.from({ length: count }, () => ({ code: 0, stderr: '' })));
    const doc = await load('test-ws');
    assert.equal(doc.revision, count);
    assert.deepEqual([...doc.workstream.constraints].sort(), Array.from({ length: count }, (_, index) => `arrival-${index}`));
    // Every backend journals a receipt per committed revision on this machine.
    assert.equal(fs.readdirSync(path.join(home, 'test-ws', 'printout', 'revisions')).length, count + 1);
  });

  test('arrive never retries a non-conflict failure', async () => {
    await makeWorkstream();
    let calls = 0;
    await assert.rejects(
      arrive('test-ws', () => {
        calls++;
        throw new Error('mutator refused');
      }),
      /mutator refused/,
    );
    assert.equal(calls, 1); // the retry is for CAS conflicts only
  });

  test('artifact content is content-addressed: identical content yields the identical hash', async () => {
    await makeWorkstream();
    const a = await writeArtifact('test-ws', 'a.md', 'same content');
    const b = await writeArtifact('test-ws', 'b.md', 'same content');
    assert.equal(a.hash, b.hash);
    const c = await writeArtifact('test-ws', 'c.md', 'different content');
    assert.notEqual(a.hash, c.hash);
  });

  test('an async mutator is refused: late writes must not land after the CAS write', async () => {
    await makeWorkstream();
    const before = (await load('test-ws')).revision;
    await assert.rejects(
      // Deliberately violates the sync Mutator contract; TS void-leniency
      // permits it at the type level, so the guard must be structural.
      mutate('test-ws', before, (async () => {}) as unknown as Parameters<typeof mutate>[2]),
      /mutator must be synchronous/,
    );
    assert.equal((await load('test-ws')).revision, before); // nothing persisted
  });

  test('concurrent policy mutations both land: the global store is a guarded read-modify-write', async () => {
    // The policy store is global and unkeyed by caller revision, so two
    // concurrent runners are the lost-update hazard mutatePolicies exists for.
    const [pa, pb] = [fakePolicy('a'), fakePolicy('b')];
    await Promise.all([
      mutatePolicies((s) => s.policies.push(pa)),
      mutatePolicies((s) => s.policies.push(pb)),
    ]);
    const store = await loadPolicies();
    assert.equal(store.policies.length, 2);
    assert.equal(store.revision, 2);
    const ids = store.policies.map((p) => p.id);
    assert.ok(ids.includes(pa.id));
    assert.ok(ids.includes(pb.id));
  });

  test('an async policy mutator is refused and nothing persists', async () => {
    await assert.rejects(
      mutatePolicies((async () => {}) as unknown as Parameters<typeof mutatePolicies>[0]),
      /mutator must be synchronous/,
    );
    assert.equal((await loadPolicies()).revision, 0);
  });

  test('tick lock: held blocks a second acquire; release restores it', async () => {
    // On pg each acquire uses its own pooled connection (its own session), so
    // this genuinely exercises the advisory lock, not session re-entrancy.
    await makeWorkstream();
    const release = await tryTickLock('test-ws');
    assert.ok(release, 'first acquire must succeed');
    assert.equal(await tryTickLock('test-ws'), null);
    await release!();
    const again = await tryTickLock('test-ws');
    assert.ok(again, 'reacquire after release must succeed');
    await again!();
  });

  test('a second workstream for the same source key is refused, naming the holder', async () => {
    await createWorkstream({
      slug: 'first-holder', title: 'First', objective: 'o', tags: [], successCriteria: [], constraints: [],
      sourceKey: 'tracker:9', autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
    });
    await assert.rejects(
      createWorkstream({
        slug: 'would-duplicate', title: 'Dup', objective: 'o', tags: [], successCriteria: [], constraints: [],
        sourceKey: 'tracker:9', autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
      }),
      (e) =>
        e instanceof SourceKeyConflictError &&
        /first-holder/.test(e.message) &&
        /already stands for tracker:9/.test(e.message),
    );
    assert.equal((await listWorkstreams()).includes('would-duplicate'), false);
    assert.equal(await findBySourceKey('tracker:9'), 'first-holder');
  });

  test('two creates racing the same source key across processes: exactly one lands', async () => {
    // Two DIFFERENT slugs, the SAME sourceKey, from separate OS processes gated
    // to fire together. Uniqueness is enforced ATOMICALLY inside the backend's
    // create (fs: a home-scoped create lock around a fail-loud scan; sqlite:
    // BEGIN IMMEDIATE + json_extract; pg: a partial UNIQUE index), so exactly
    // one workstream may ever stand for the key — the loser must fail, never a
    // silent second identity.
    const home = process.env.WEAVER_HOME!;
    const storeUrl = pathToFileURL(path.resolve('src/store.ts')).href;
    const gate = path.join(home, 'create-gate');
    const key = 'tracker:shared-425';
    const slugs = ['stream-a', 'stream-b'];
    // Initialize the backend in the parent first (sqlite: persist WAL mode +
    // schema to the file; pg: run migrations) so the two children race the
    // create itself, not first-touch database setup.
    await listWorkstreams();
    const children = slugs.map((slug, index) => {
      const ready = path.join(home, `create-ready-${index}`);
      const code = `
        import fs from 'node:fs';
        const { createWorkstream, closeStore, SourceKeyConflictError } = await import(${JSON.stringify(storeUrl)});
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
        try {
          await createWorkstream({
            slug: ${JSON.stringify(slug)}, title: 't', objective: 'o', tags: [],
            successCriteria: [], constraints: [], sourceKey: ${JSON.stringify(key)},
            autonomy: { sendsRequireApproval: true },
            budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
          });
          console.log('won');
        } catch (error) {
          console.log(error instanceof SourceKeyConflictError ? 'conflict' : 'error: ' + (error?.stack ?? error));
        }
        await closeStore();
      `;
      return new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
          cwd: process.cwd(),
          env: { ...process.env, WEAVER_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('close', (exitCode) =>
          exitCode === 0
            ? resolve(stdout.trim())
            : reject(new Error(`child ${slug} exited ${exitCode}: ${stdout}${stderr}`)));
      });
    });
    const deadline = Date.now() + 10_000;
    while (fs.readdirSync(home).filter((name) => name.startsWith('create-ready-')).length < slugs.length) {
      if (Date.now() > deadline) throw new Error('child create barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(gate, 'go');
    const outcomes = (await Promise.all(children)).sort();
    assert.deepEqual(outcomes, ['conflict', 'won']); // exactly one created, the other refused
    const created = (await listWorkstreams()).filter((s) => slugs.includes(s));
    assert.equal(created.length, 1); // never a silent second identity
    assert.equal(await findBySourceKey(key), created[0]);
  });
}

describe('store contract — fs backend', () => {
  contractSuite(fsBackend);

  test('a sourced create fails LOUD when an existing workstream is unreadable', async () => {
    // The source-key uniqueness scan must never silently skip a corrupt doc:
    // corruption cannot make an existing identity disappear and let a duplicate
    // slip in. (The best-effort findBySourceKey skips corruption; create must
    // not.) fs only — sqlite/pg detect existing keys through the store engine.
    await fsBackend.reset();
    await createWorkstream({
      slug: 'broken-holder', title: 'Broken', objective: 'o', tags: [], successCriteria: [], constraints: [],
      sourceKey: 'tracker:corrupt', autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
    });
    fs.writeFileSync(path.join(workstreamDir('broken-holder'), 'workstream.json'), '{ not json');
    await assert.rejects(
      createWorkstream({
        slug: 'new-sourced', title: 'New', objective: 'o', tags: [], successCriteria: [], constraints: [],
        sourceKey: 'tracker:unrelated', autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
      }),
      /unreadable|refusing to create/,
    );
    assert.equal((await listWorkstreams()).includes('new-sourced'), false);
  });
});

describe('store contract — sqlite backend', () => {
  contractSuite(sqliteBackend);

  test('a cross-process mutate race on one expected revision: exactly one wins the CAS', async () => {
    // Both writers target the same expectedRevision from separate OS
    // processes on the same database file. BEGIN IMMEDIATE serializes the
    // whole read→check→write region across processes: whichever transaction
    // runs second reads the bumped revision and must conflict — never a lost
    // update, never both landing. (Any interleaving satisfies the assertion,
    // and the gate makes genuine contention overwhelmingly likely.)
    await makeWorkstream();
    const rev = (await load('test-ws')).revision;
    const home = process.env.WEAVER_HOME!;
    const gate = path.join(home, 'mutate-gate');
    const ready = path.join(home, 'mutate-ready');
    const storeUrl = pathToFileURL(path.resolve('src/store.ts')).href;
    const code = `
      import fs from 'node:fs';
      const { mutate, closeStore } = await import(${JSON.stringify(storeUrl)});
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(wait, 0, 0, 5);
      try {
        await mutate('test-ws', ${rev}, (doc, event) => event('race.child', 'child'));
        console.log('won');
      } catch (error) {
        console.log(error?.name === 'RevisionConflictError' ? 'conflict' : 'error: ' + error);
      }
      await closeStore();
    `;
    const child = new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
        cwd: process.cwd(),
        env: { ...process.env, WEAVER_HOME: home },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
      proc.on('close', (exitCode) =>
        exitCode === 0 ? resolve(stdout.trim()) : reject(new Error(`child exited ${exitCode}: ${stdout}`)));
    });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw new Error('child mutate barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(gate, 'go');
    const parent = mutate('test-ws', rev, (doc, event) => event('race.parent', 'parent'))
      .then(() => 'won')
      .catch((error) => {
        if (error instanceof RevisionConflictError) return 'conflict';
        throw error;
      });
    const outcomes = (await Promise.all([parent, child])).sort();
    assert.deepEqual(outcomes, ['conflict', 'won']);
    const doc = await load('test-ws');
    assert.equal(doc.revision, rev + 1); // exactly one write landed
    const raceEvents = doc.events.filter((e) => e.type === 'race.parent' || e.type === 'race.child');
    assert.equal(raceEvents.length, 1); // the loser's mutation left no trace
  });
});

describe(
  'store contract — postgres backend',
  { skip: PG_URL ? false : 'WEAVER_TEST_PG_URL not set — export it (any plain Postgres) to run the store contract against the pg backend' },
  () => {
    contractSuite(pgBackend);

    test('two mutates racing on the same expected revision: exactly one wins the CAS', async () => {
      // A REAL race, not an interleaving accident: a barrier transaction holds
      // the row lock so both mutates read the same revision inside their own
      // transactions and both reach their UPDATE before either can commit.
      // When the barrier releases, Postgres serializes them: the first UPDATE
      // re-checks its WHERE and lands; the second re-checks against the
      // now-bumped revision, matches zero rows, and must conflict.
      await makeWorkstream();
      const rev = (await load('test-ws')).revision;
      const barrier = new pg.Client({ connectionString: PG_URL });
      await barrier.connect();
      try {
        await barrier.query('BEGIN');
        await barrier.query('SELECT 1 FROM workstreams WHERE slug = $1 FOR UPDATE', ['test-ws']);
        const results = Promise.allSettled([
          mutate('test-ws', rev, (d, event) => event('race.a', 'a')),
          mutate('test-ws', rev, (d, event) => event('race.b', 'b')),
        ]);
        // Wait until BOTH writers are provably blocked on the barrier's lock.
        await pgAdmin(async (observer) => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const r = await observer.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query ILIKE 'UPDATE workstreams%'`,
            );
            if (r.rows[0]!.n >= 2) return;
            if (Date.now() > deadline) throw new Error('writers never blocked on the barrier');
            await new Promise((res) => setTimeout(res, 25));
          }
        });
        await barrier.query('COMMIT');
        const settled = await results;
        const winners = settled.filter((s) => s.status === 'fulfilled');
        const losers = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
        assert.equal(winners.length, 1);
        assert.equal(losers.length, 1);
        assert.ok(losers[0]!.reason instanceof RevisionConflictError);
        const doc = await load('test-ws');
        assert.equal(doc.revision, rev + 1); // exactly one write landed
        const raceEvents = doc.events.filter((e) => e.type === 'race.a' || e.type === 'race.b');
        assert.equal(raceEvents.length, 1); // the loser's mutation left no trace
      } finally {
        await barrier.end();
      }
    });
  },
);

after(() => closeStore());
