/**
 * PgStore — the hosted StateStore backend: the same typed state in plain
 * Postgres (Supabase/Neon/RDS/self-hosted — no provider-specific APIs), so the
 * knowledge layer can live centrally and several machines can share one fleet.
 * Selected via WEAVER_STORE=postgres://… (src/store.ts getStore()).
 *
 * What this backend owns is EXACTLY what the contract in ./types.ts assigns a
 * backend: persistence, the revision CAS, and the serialized arrival region
 * (FOR UPDATE row lock). Secrets refusal and artifact redaction + hashing stay
 * in src/store.ts and run before anything reaches here.
 *
 * Documents use Postgres `json`, deliberately not `jsonb`. `jsonb` decodes
 * JSON Unicode escapes and therefore rejects the otherwise-valid JSON string
 * `"\u0000"` because Postgres text cannot contain a zero byte. `json` keeps
 * the validated JSON representation, so every JavaScript string survives an
 * exact round trip. Source-key uniqueness lives in a separate TEXT column
 * containing JSON.stringify(sourceKey): that encoding is injective for JS
 * strings and contains no zero byte, even when the source key does.
 * Artifact strings use `bytea`: PostgreSQL `text` cannot contain U+0000 at
 * all, while Buffer's UTF-8 encoding is the same boundary used by the
 * filesystem backend and round-trips every valid artifact string it stores.
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

import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { virtualNow } from '../clock.js';
import { changedById, printoutChanges, writeJournalReceipt } from '../printoutJournal.js';
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import { creationReceipt, emptyPolicyStore, eventHelperFor, initialDoc } from './doc.js';
import { moveLocalSidecars, policyJournalDir, printoutJournalDir } from './fs.js';
import { RevisionConflictError, SourceKeyConflictError, type Mutator, type RunnerPresence, type StateStore } from './types.js';

/**
 * Idempotent, run on first use of every process. The `revision` COLUMN is the
 * CAS guard; the same number inside the doc/store JSON is kept in sync so a
 * loaded doc carries its own revision (the shape callers already rely on).
 * The policies singleton row is seeded here so mutatePolicies can always
 * UPDATE (a first-writer INSERT race would need ON CONFLICT gymnastics).
 * initializeSchema() runs this DDL and the source-key backfill in one explicit
 * transaction behind an advisory xact lock. Source keys are decoded in JS,
 * never with Postgres JSON operators: those operators parse the whole `json`
 * document and reject an unrelated valid `\\u0000` elsewhere in it.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workstreams (
    slug            text    PRIMARY KEY,
    revision        integer NOT NULL,
    doc             json    NOT NULL,
    source_key_json text,
    source_key_initialized boolean NOT NULL DEFAULT false
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    slug     text NOT NULL,
    rel_path text NOT NULL,
    content  bytea NOT NULL,
    PRIMARY KEY (slug, rel_path)
  );
  CREATE TABLE IF NOT EXISTS policies (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision  integer NOT NULL,
    store     json    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runner_presence (
    runner_id    text        PRIMARY KEY,
    heartbeat_at timestamptz NOT NULL
  );

  -- Existing fleets used jsonb. Convert once, without decoding and rewriting
  -- the logical document in application code. The old expression index must
  -- be removed before its doc column can change type. A pre-column database
  -- also needs that index replaced even if a prior manual repair changed doc.
  DO $migration$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'workstreams'::regclass
        AND attname = 'doc' AND NOT attisdropped
        AND (
          atttypid = 'jsonb'::regtype
          OR NOT EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = 'workstreams'::regclass
              AND attname = 'source_key_json' AND NOT attisdropped
          )
        )
    ) THEN
      DROP INDEX IF EXISTS workstreams_source_key;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'workstreams'::regclass
        AND attname = 'doc' AND NOT attisdropped
        AND atttypid = 'jsonb'::regtype
    ) THEN
      ALTER TABLE workstreams ALTER COLUMN doc TYPE json USING doc::json;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'policies'::regclass
        AND attname = 'store' AND NOT attisdropped
        AND atttypid = 'jsonb'::regtype
    ) THEN
      ALTER TABLE policies ALTER COLUMN store TYPE json USING store::json;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'artifacts'::regclass
        AND attname = 'content' AND NOT attisdropped
        AND atttypid = 'text'::regtype
    ) THEN
      -- Existing TEXT artifacts are already valid database-encoded strings.
      -- Preserve their exact UTF-8 bytes while widening the column so future
      -- artifacts may also contain U+0000.
      ALTER TABLE artifacts ALTER COLUMN content TYPE bytea
        USING convert_to(content, 'UTF8');
    END IF;
  END
  $migration$;

  ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS source_key_json text;
  ALTER TABLE workstreams ADD COLUMN IF NOT EXISTS source_key_initialized boolean NOT NULL DEFAULT false;
  INSERT INTO policies (singleton, revision, store)
    VALUES (true, 0, '{"schemaVersion":1,"revision":0,"policies":[]}'::json)
    ON CONFLICT DO NOTHING;
`;

function sourceKeyJson(doc: WorkstreamDoc): string | null {
  return doc.workstream.sourceKey === undefined ? null : JSON.stringify(doc.workstream.sourceKey);
}

/**
 * The deliberately narrow seam used by the one-time filesystem → Postgres
 * fleet copy. Ordinary writes must continue through StateStore's revisioned
 * methods; importing an already-authoritative durable snapshot is different:
 * it must preserve every revision and id rather than minting a new history.
 */
export interface ExactPgFleetSnapshot {
  workstreams: { slug: string; revision: number; doc: WorkstreamDoc }[];
  artifacts: { slug: string; relPath: string; content: string }[];
  policies: PolicyStore;
}

export class PgStoreNotEmptyError extends Error {
  constructor() {
    super('destination Postgres store is not empty — refusing to merge or overwrite durable fleet state');
    this.name = 'PgStoreNotEmptyError';
  }
}

export class PgStore implements StateStore {
  private readonly pool: pg.Pool;
  private readonly connectionString: string;
  private ready: Promise<void> | undefined;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    // allowExitOnIdle: idle pooled connections must not pin a finished CLI
    // process open — closeStore() is the deliberate shutdown, this is the net.
    this.pool = new pg.Pool({ connectionString, max: 10, allowExitOnIdle: true });
  }

  private ensureReady(): Promise<void> {
    return (this.ready ??= this.initializeSchema());
  }

  /**
   * One serialized schema transaction, including the only source-key backfill.
   * `source_key_initialized` distinguishes "backfilled and genuinely absent"
   * from "legacy row not inspected yet". Reading a json column returns its raw
   * representation to node-postgres, whose JSON.parse preserves U+0000; no SQL
   * JSON operator is allowed here because it would decode the whole document
   * through PostgreSQL text before reaching the requested field.
   */
  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('weaver-schema'))");
      await client.query(SCHEMA);

      const pending = await client.query(
        `SELECT slug, doc FROM workstreams
         WHERE NOT source_key_initialized
         ORDER BY slug
         FOR UPDATE`,
      );
      for (const row of pending.rows as { slug: string; doc: WorkstreamDoc }[]) {
        const sourceKey = row.doc?.workstream?.sourceKey;
        if (sourceKey !== undefined && typeof sourceKey !== 'string') {
          throw new Error(`workstream '${row.slug}' has an invalid non-string sourceKey`);
        }
        await client.query(
          `UPDATE workstreams
           SET source_key_json = $1, source_key_initialized = true
           WHERE slug = $2`,
          [sourceKey === undefined ? null : JSON.stringify(sourceKey), row.slug],
        );
      }

      // Two workstreams may never stand for the same external thing. Exact
      // JSON string bytes under C collation enforce uniqueness atomically,
      // including source keys containing U+0000. Create only after every
      // legacy row is initialized so duplicates fail the whole transaction.
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workstreams_source_key
         ON workstreams (source_key_json COLLATE "C")
         WHERE source_key_json IS NOT NULL`,
      );
      await client.query(
        'ALTER TABLE workstreams ALTER COLUMN source_key_initialized SET DEFAULT true',
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Install one exact fleet snapshot into an empty Postgres store.
   *
   * ACCESS EXCLUSIVE table locks make the emptiness check and every insert a
   * single indivisible database operation even if a mistakenly-started remote
   * process connects during the copy. The seeded revision-zero policy row is
   * the sole allowed pre-existing row; any durable Weaver truth refuses the
   * import instead of being merged or overwritten.
   */
  async importExactFleet(snapshot: ExactPgFleetSnapshot): Promise<void> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('LOCK TABLE workstreams, artifacts, policies IN ACCESS EXCLUSIVE MODE');

      const counts = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM workstreams) AS workstreams,
           (SELECT count(*)::integer FROM artifacts) AS artifacts,
           (SELECT count(*)::integer FROM policies) AS policies`,
      );
      const row = counts.rows[0] as { workstreams: number; artifacts: number; policies: number };
      const existingPolicy = await client.query('SELECT revision, store FROM policies WHERE singleton');
      const policyIsEmpty =
        row.policies === 1 &&
        existingPolicy.rowCount === 1 &&
        (existingPolicy.rows[0]!.revision as number) === 0 &&
        isDeepStrictEqual(existingPolicy.rows[0]!.store, emptyPolicyStore());
      if (row.workstreams !== 0 || row.artifacts !== 0 || !policyIsEmpty) {
        throw new PgStoreNotEmptyError();
      }

      for (const entry of snapshot.workstreams) {
        await client.query(
          `INSERT INTO workstreams
             (slug, revision, doc, source_key_json, source_key_initialized)
           VALUES ($1, $2, $3::json, $4, true)`,
          [entry.slug, entry.revision, JSON.stringify(entry.doc), sourceKeyJson(entry.doc)],
        );
      }
      for (const artifact of snapshot.artifacts) {
        await client.query(
          'INSERT INTO artifacts (slug, rel_path, content) VALUES ($1, $2, $3)',
          [artifact.slug, artifact.relPath, Buffer.from(artifact.content, 'utf8')],
        );
      }
      await client.query(
        'UPDATE policies SET revision = $1, store = $2::json WHERE singleton',
        [snapshot.policies.revision, JSON.stringify(snapshot.policies)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** One transactionally consistent readback for post-import verification. */
  async readExactFleet(): Promise<ExactPgFleetSnapshot> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // A pg Client is one ordered connection. Keep these reads sequential:
      // Promise.all on one client is only queued today and is rejected by pg 9.
      const workstreams = await client.query('SELECT slug, revision, doc FROM workstreams ORDER BY slug');
      const artifacts = await client.query('SELECT slug, rel_path, content FROM artifacts ORDER BY slug, rel_path');
      const policies = await client.query('SELECT revision, store FROM policies WHERE singleton');
      const policyStore = policies.rows[0]?.store as PolicyStore | undefined;
      if (!policyStore || (policies.rows[0]!.revision as number) !== policyStore.revision) {
        throw new Error('Postgres policy row revision does not match its stored PolicyStore revision');
      }
      await client.query('COMMIT');
      const workstreamSnapshot = workstreams.rows.map((row) => ({
        slug: row.slug as string,
        revision: row.revision as number,
        doc: row.doc as WorkstreamDoc,
      }));
      const artifactSnapshot = artifacts.rows.map((row) => ({
        slug: row.slug as string,
        relPath: row.rel_path as string,
        content: (row.content as Buffer).toString('utf8'),
      }));
      // Database collation is deployment-specific. Canonicalize with the same
      // comparator used by the filesystem snapshot before byte-exact readback
      // comparison (for example, `go-vb` and `google` order differently under
      // common Postgres and JavaScript locales).
      workstreamSnapshot.sort((a, b) => a.slug.localeCompare(b.slug));
      artifactSnapshot.sort(
        (a, b) => a.slug.localeCompare(b.slug) || a.relPath.localeCompare(b.relPath),
      );
      return {
        workstreams: workstreamSnapshot,
        artifacts: artifactSnapshot,
        policies: policyStore,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
        `INSERT INTO workstreams
           (slug, revision, doc, source_key_json, source_key_initialized)
         VALUES ($1, $2, $3::json, $4, true)`,
        [core.slug, doc.revision, JSON.stringify(doc), sourceKeyJson(doc)],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        // Two unique constraints can raise 23505: the slug PK and the
        // sourceKey partial index. Distinguish by the reported constraint so
        // the caller gets the right message.
        if ((e as { constraint?: string }).constraint === 'workstreams_source_key' && core.sourceKey !== undefined) {
          throw new SourceKeyConflictError(core.sourceKey);
        }
        throw new Error(`workstream '${core.slug}' already exists`);
      }
      throw e;
    }
    return doc;
  }

  async mutate(slug: string, expectedRevision: number | undefined, fn: Mutator): Promise<WorkstreamDoc> {
    await this.ensureReady();
    const client = await this.pool.connect();
    let attemptedSourceKey: string | undefined;
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
      attemptedSourceKey = doc.workstream.sourceKey;
      const upd = await client.query(
        `UPDATE workstreams
         SET doc = $1::json,
             source_key_json = $2,
             source_key_initialized = true,
             revision = revision + 1
         WHERE slug = $3 AND revision = $4`,
        [JSON.stringify(doc), sourceKeyJson(doc), slug, stored],
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
      if (
        (e as { code?: string; constraint?: string }).code === '23505' &&
        (e as { constraint?: string }).constraint === 'workstreams_source_key' &&
        attemptedSourceKey !== undefined
      ) {
        throw new SourceKeyConflictError(attemptedSourceKey);
      }
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
      [slug, relPath, Buffer.from(content, 'utf8')],
    );
  }

  async readArtifact(slug: string, relPath: string): Promise<string> {
    await this.ensureReady();
    const r = await this.pool.query(
      'SELECT content FROM artifacts WHERE slug = $1 AND rel_path = $2',
      [slug, relPath],
    );
    if (r.rowCount === 0) throw new Error(`no artifact '${relPath}' for workstream '${slug}'`);
    return (r.rows[0].content as Buffer).toString('utf8');
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
          `INSERT INTO policies AS p (singleton, revision, store) VALUES (true, $2 + 1, $1::json)
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

  async heartbeatRunner(presence: RunnerPresence): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      `INSERT INTO runner_presence (runner_id, heartbeat_at) VALUES ($1, $2::timestamptz)
       ON CONFLICT (runner_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`,
      [presence.runnerId, presence.heartbeatAt],
    );
  }

  async listRunnerPresence(): Promise<RunnerPresence[]> {
    await this.ensureReady();
    const result = await this.pool.query(
      `SELECT runner_id, to_char(heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS heartbeat_at
       FROM runner_presence ORDER BY runner_id`,
    );
    return result.rows.map((row) => ({
      runnerId: row.runner_id as string,
      heartbeatAt: row.heartbeat_at as string,
    }));
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
    // A DEDICATED connection, never a pool client: the lock is held for the
    // whole tick (minutes–hours), and the runner's default concurrency equals
    // the pool's max — pool-held locks would drain every client, every mutate
    // inside those ticks would queue on the pool forever, and no tick could
    // finish to release one. Lock connections are bounded by runner
    // concurrency; session death still auto-releases (why no pid file here).
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    let locked = false;
    try {
      const r = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
      locked = r.rows[0]?.ok === true;
    } finally {
      if (!locked) await client.end().catch(() => {});
    }
    if (!locked) return null;
    return async () => {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } finally {
        await client.end().catch(() => {});
      }
    };
  }

  async rename(oldSlug: string, newSlug: string): Promise<WorkstreamDoc> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The tick lock covers the whole tick, workers included: an xact-scoped
      // try on the same advisory key conflicts with a held session lock, so a
      // mid-tick rename is refused — and ours self-releases at COMMIT/ROLLBACK,
      // never outliving the transaction.
      const l = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [
        `weaver-tick:${oldSlug}`,
      ]);
      if (l.rows[0]?.ok !== true) {
        throw new Error(`workstream '${oldSlug}' is mid-tick — retry when the tick finishes`);
      }
      // FOR UPDATE pins the row: no concurrent write can land between this
      // read and the UPDATE, so the rename needs no CAS of its own.
      const r = await client.query('SELECT doc, revision FROM workstreams WHERE slug = $1 FOR UPDATE', [oldSlug]);
      if (r.rowCount === 0) throw new Error(`no workstream '${oldSlug}' in the Postgres store`);
      const clash = await client.query('SELECT 1 FROM workstreams WHERE slug = $1', [newSlug]);
      if (clash.rowCount !== 0) throw new Error(`workstream '${newSlug}' already exists`);
      const doc = r.rows[0].doc as WorkstreamDoc;
      const stored = r.rows[0].revision as number;
      const before = structuredClone(doc);
      const emitted: EventRecord[] = [];
      eventHelperFor(doc, emitted)('workstream.renamed', `renamed from '${oldSlug}' to '${newSlug}'`);
      doc.workstream.slug = newSlug;
      doc.revision = stored + 1;
      await client.query(
        `UPDATE workstreams
         SET slug = $1,
             doc = $2::json,
             source_key_json = $3,
             source_key_initialized = true,
             revision = revision + 1
         WHERE slug = $4`,
        [newSlug, JSON.stringify(doc), sourceKeyJson(doc), oldSlug],
      );
      await client.query('UPDATE artifacts SET slug = $1 WHERE slug = $2', [newSlug, oldSlug]);
      // Receipt before COMMIT, into the OLD slug's machine-local journal — the
      // sidecar directory moves to the new name after commit.
      writeJournalReceipt(printoutJournalDir(oldSlug), {
        revision: doc.revision,
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        changes: printoutChanges(before, doc),
        events: emitted,
      } satisfies PrintoutMutationReceipt);
      await client.query('COMMIT');
      moveLocalSidecars(oldSlug, newSlug);
      return doc;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
