/**
 * PgStore — the hosted StateStore backend: the same typed state in plain
 * Postgres (Supabase/Neon/RDS/self-hosted — no provider-specific APIs), so the
 * knowledge layer can live centrally and several machines can share one fleet.
 * Selected via WEAVER_STORE=postgres://… (src/store.ts getStore()).
 *
 * What this backend owns is EXACTLY what the contract in ./types.ts assigns a
 * backend: persistence and the revision CAS. Secrets refusal, artifact
 * redaction + hashing, and arrive's bounded retry stay in src/store.ts and run
 * before anything reaches here.
 *
 * The CAS is genuinely atomic, not load-then-hope: `mutate` loads the doc
 * INSIDE a transaction, runs the synchronous mutator between that read and the
 * write, and persists with `UPDATE … SET revision = revision + 1 WHERE slug =
 * $ AND revision = $expected`. Under READ COMMITTED a concurrent committed
 * write makes the UPDATE re-check its WHERE against the new row → zero rows →
 * RevisionConflictError. There is no window in which two writers can both pass
 * the check and both land (the fs backend gets the same guarantee from being
 * synchronous in-process; here it must hold across machines).
 *
 * Known fs-only conveniences this backend does not carry: the live views that
 * read the state DIR directly (tail's jsonl feed, watch/TUI file polling, the
 * simulated world's outbox) and per-workstream secrets files remain local to
 * each machine — the durable truth (docs, artifacts, policies) is what moves
 * into Postgres.
 */

import pg from 'pg';
import { virtualNow } from '../clock.js';
import { changedById, printoutChanges, writeJournalReceipt } from '../printoutJournal.js';
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import { creationReceipt, emptyPolicyStore, eventHelperFor, initialDoc } from './doc.js';
import { policyJournalDir, printoutJournalDir } from './fs.js';
import { RevisionConflictError, type Mutator, type StateStore } from './types.js';

/**
 * Idempotent, run on first use of every process. The `revision` COLUMN is the
 * CAS guard; the same number inside the doc/store jsonb is kept in sync so a
 * loaded doc carries its own revision (the shape callers already rely on).
 * The policies singleton row is seeded here so mutatePolicies can always
 * UPDATE (a first-writer INSERT race would need ON CONFLICT gymnastics).
 * A multi-statement simple query runs as one implicit transaction, so the
 * leading advisory xact lock serializes concurrent first connects (two fresh
 * processes racing CREATE TABLE IF NOT EXISTS can otherwise hit spurious
 * duplicate-key errors on the catalog) and releases itself at commit.
 */
const SCHEMA = `
  SELECT pg_advisory_xact_lock(hashtext('weaver-schema'));
  CREATE TABLE IF NOT EXISTS workstreams (
    slug     text    PRIMARY KEY,
    revision integer NOT NULL,
    doc      jsonb   NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    slug     text NOT NULL,
    rel_path text NOT NULL,
    content  text NOT NULL,
    PRIMARY KEY (slug, rel_path)
  );
  CREATE TABLE IF NOT EXISTS policies (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision  integer NOT NULL,
    store     jsonb   NOT NULL
  );
  INSERT INTO policies (singleton, revision, store)
    VALUES (true, 0, '{"schemaVersion":1,"revision":0,"policies":[]}'::jsonb)
    ON CONFLICT DO NOTHING;
`;

export class PgStore implements StateStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | undefined;

  constructor(connectionString: string) {
    // allowExitOnIdle: idle pooled connections must not pin a finished CLI
    // process open — closeStore() is the deliberate shutdown, this is the net.
    this.pool = new pg.Pool({ connectionString, max: 10, allowExitOnIdle: true });
  }

  private ensureReady(): Promise<void> {
    return (this.ready ??= this.pool.query(SCHEMA).then(() => {}));
  }

  async listWorkstreams(): Promise<string[]> {
    await this.ensureReady();
    const r = await this.pool.query('SELECT slug FROM workstreams ORDER BY slug');
    return r.rows.map((row) => row.slug as string);
  }

  async load(slug: string): Promise<WorkstreamDoc> {
    await this.ensureReady();
    const r = await this.pool.query('SELECT doc FROM workstreams WHERE slug = $1', [slug]);
    if (r.rowCount === 0) throw new Error(`no workstream '${slug}' in the Postgres store`);
    return r.rows[0].doc as WorkstreamDoc;
  }

  async create(core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>): Promise<WorkstreamDoc> {
    await this.ensureReady();
    const doc = initialDoc(core);
    // Receipt first (to this machine's printout journal): a failed INSERT can
    // leave an orphan future receipt, which printout readers ignore, but never
    // a committed head whose transition is missing.
    writeJournalReceipt(printoutJournalDir(core.slug), creationReceipt(doc));
    try {
      await this.pool.query(
        'INSERT INTO workstreams (slug, revision, doc) VALUES ($1, $2, $3::jsonb)',
        [core.slug, doc.revision, JSON.stringify(doc)],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new Error(`workstream '${core.slug}' already exists`);
      }
      throw e;
    }
    return doc;
  }

  async mutate(slug: string, expectedRevision: number | undefined, fn: Mutator): Promise<WorkstreamDoc> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The read happens in the SAME transaction as the write — never load
      // outside it: a doc read on a previous connection could be arbitrarily
      // stale and the mutator would apply to state the CAS no longer covers.
      // An ARRIVAL (undefined expectedRevision) reads FOR UPDATE: the row lock
      // serializes the whole read-modify-write region, so simultaneous
      // arrivals queue and all land instead of racing the CAS.
      const r = await client.query(
        expectedRevision === undefined
          ? 'SELECT doc, revision FROM workstreams WHERE slug = $1 FOR UPDATE'
          : 'SELECT doc, revision FROM workstreams WHERE slug = $1',
        [slug],
      );
      if (r.rowCount === 0) throw new Error(`no workstream '${slug}' in the Postgres store`);
      const stored = r.rows[0].revision as number;
      if (expectedRevision !== undefined && stored !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, stored);
      }
      const doc = r.rows[0].doc as WorkstreamDoc;
      const before = structuredClone(doc);
      const emitted: EventRecord[] = [];
      // The mutator contract is SYNCHRONOUS (enforced structurally in
      // src/store.ts), so nothing yields between this read and the UPDATE.
      fn(doc, eventHelperFor(doc, emitted));
      doc.revision = stored + 1;
      const upd = await client.query(
        'UPDATE workstreams SET doc = $1::jsonb, revision = revision + 1 WHERE slug = $2 AND revision = $3',
        [JSON.stringify(doc), slug, stored],
      );
      if (upd.rowCount === 0) {
        // A concurrent transaction committed between our snapshot read and the
        // UPDATE's re-check: the CAS lost. Report the revision that beat us.
        // (Unreachable for arrivals — FOR UPDATE pinned the row.)
        await client.query('ROLLBACK');
        const actual = await client.query('SELECT revision FROM workstreams WHERE slug = $1', [slug]);
        throw new RevisionConflictError(expectedRevision ?? stored, (actual.rows[0]?.revision as number) ?? -1);
      }
      // Receipt before COMMIT: an interruption here orphans a future receipt
      // (ignored by readers); a committed head always has its transition.
      writeJournalReceipt(printoutJournalDir(slug), {
        revision: doc.revision,
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        changes: printoutChanges(before, doc),
        events: emitted,
      } satisfies PrintoutMutationReceipt);
      await client.query('COMMIT');
      return doc;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async writeArtifactRaw(slug: string, relPath: string, content: string): Promise<void> {
    await this.ensureReady();
    // relPath embeds the content hash (shared layer), so an upsert can only
    // ever rewrite the same bytes — matching the fs backend's overwrite.
    await this.pool.query(
      `INSERT INTO artifacts (slug, rel_path, content) VALUES ($1, $2, $3)
       ON CONFLICT (slug, rel_path) DO UPDATE SET content = EXCLUDED.content`,
      [slug, relPath, content],
    );
  }

  async readArtifact(slug: string, relPath: string): Promise<string> {
    await this.ensureReady();
    const r = await this.pool.query(
      'SELECT content FROM artifacts WHERE slug = $1 AND rel_path = $2',
      [slug, relPath],
    );
    if (r.rowCount === 0) throw new Error(`no artifact '${relPath}' for workstream '${slug}'`);
    return r.rows[0].content as string;
  }

  async loadPolicies(): Promise<PolicyStore> {
    await this.ensureReady();
    const r = await this.pool.query('SELECT store FROM policies WHERE singleton');
    return (r.rows[0]?.store as PolicyStore) ?? emptyPolicyStore();
  }

  /**
   * Same CAS + bounded-retry shape as the shared layer's arrive(): the global
   * store has no caller-held revision, so read current, mutate, and CAS on the
   * revision column; a lost race re-runs the mutator against fresh state (at
   * most 3 attempts) instead of clobbering a concurrent runner's write.
   */
  async mutatePolicies(fn: (store: PolicyStore) => void): Promise<PolicyStore> {
    await this.ensureReady();
    const ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query('SELECT store, revision FROM policies WHERE singleton');
        const stored = (r.rows[0]?.revision as number) ?? 0;
        const store = (r.rows[0]?.store as PolicyStore) ?? emptyPolicyStore();
        const before = new Map(store.policies.map((policy) => [policy.id, structuredClone(policy)]));
        fn(store);
        store.revision = stored + 1;
        // Upsert-with-CAS rather than plain UPDATE: the singleton row is
        // seeded at migration, but a wiped table (tests TRUNCATE between
        // cases) must not strand every future write in the conflict path.
        const upd = await client.query(
          `INSERT INTO policies AS p (singleton, revision, store) VALUES (true, $2 + 1, $1::jsonb)
           ON CONFLICT (singleton) DO UPDATE SET store = EXCLUDED.store, revision = p.revision + 1
           WHERE p.revision = $2`,
          [JSON.stringify(store), stored],
        );
        if (upd.rowCount === 0) {
          await client.query('ROLLBACK');
          const actual = await client.query('SELECT revision FROM policies WHERE singleton');
          throw new RevisionConflictError(stored, (actual.rows[0]?.revision as number) ?? -1);
        }
        // Receipt before COMMIT, same discipline as doc mutations.
        writeJournalReceipt(policyJournalDir(), {
          revision: store.revision,
          at: new Date().toISOString(),
          changes: changedById([...before.values()], store.policies),
        } satisfies PolicyMutationReceipt);
        await client.query('COMMIT');
        return store;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e instanceof RevisionConflictError && attempt < ATTEMPTS) continue;
        throw e;
      } finally {
        client.release();
      }
    }
  }

  /**
   * Cross-process (here: cross-MACHINE) tick exclusion via a session-scoped
   * advisory lock on a dedicated pooled connection, held until release. There
   * is deliberately no pid file and no stale-holder reclaim: Postgres releases
   * a session's advisory locks the moment the session dies, so a crashed
   * holder frees the lock automatically — the liveness check the fs backend
   * does with `kill(pid, 0)` is built into the lock itself.
   */
  async tryTickLock(slug: string): Promise<(() => Promise<void>) | null> {
    await this.ensureReady();
    const key = `weaver-tick:${slug}`;
    const client = await this.pool.connect();
    let locked = false;
    try {
      const r = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
      locked = r.rows[0]?.ok === true;
    } finally {
      if (!locked) client.release();
    }
    if (!locked) return null;
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
