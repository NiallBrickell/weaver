/**
 * SqliteStore — the single-file local StateStore backend: the same typed state
 * in one SQLite database via Node's built-in `node:sqlite` (zero dependencies).
 * Selected via WEAVER_STORE=sqlite:<path> (src/store.ts getStore()). The
 * lineup: fs (default, zero setup) · sqlite (single local file, real
 * transactions) · postgres (shared fleet).
 *
 * What this backend owns is EXACTLY what the contract in ./types.ts assigns a
 * backend: persistence, the revision CAS, and the serialized arrival region.
 * Secrets refusal and artifact redaction + hashing stay in src/store.ts and
 * run before anything reaches here.
 *
 * The CAS leans on node:sqlite being fully SYNCHRONOUS: the whole
 * read→check→mutate→write region runs inside one `BEGIN IMMEDIATE … COMMIT`
 * with zero awaits inside — the same no-yield guarantee FsStore pins (no
 * in-process writer can interleave), PLUS cross-process safety from the
 * database write lock: BEGIN IMMEDIATE takes the write lock up front, so a
 * second process's region blocks (busy_timeout retries inside SQLite) until
 * ours commits, then reads the new revision and conflicts — or, for an
 * arrival (undefined expectedRevision), simply lands next. There is no window
 * in which two writers can both pass the check and both land.
 *
 * node:sqlite emits an ExperimentalWarning on module LOAD (observed on both
 * Node 22.22 and 25.4, where it is unflagged and works), so it is loaded
 * lazily in the constructor — a process on the fs or pg backend never touches
 * it and keeps a clean stderr.
 *
 * Machine-local things stay on fs exactly as they do for pg: printout
 * receipts are fs sidecars written before COMMIT, secrets env files, the
 * runner pid lock, the tail's jsonl feed, watch/TUI polling, and the
 * simulated world's outbox all read the machine-local state directory. A
 * SQLite file is inherently single-machine, so unlike pg nothing is lost —
 * which is also why pid-probe liveness (below) is sound here.
 *
 * Artifact strings use BLOB rather than TEXT. Node 22's SQLite binding binds
 * a JavaScript TEXT value containing U+0000 as a C string and truncates it;
 * UTF-8 Buffers preserve the same exact bytes as the filesystem backend.
 */

import type { CapacityTarget } from '../modelConfig.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { virtualNow } from '../clock.js';
import { changedById, printoutChanges, writeJournalReceipt } from '../printoutJournal.js';
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import { creationReceipt, emptyPolicyStore, eventHelperFor, initialDoc } from './doc.js';
import { moveLocalSidecars, policyJournalDir, printoutJournalDir } from './fs.js';
import { RevisionConflictError, SourceKeyConflictError, type Mutator, type RunnerPresence, type StateStore, type WorkstreamHead } from './types.js';

/**
 * Idempotent, run once per process at construction. TEXT for doc JSON (SQLite
 * has no jsonb; the doc is parsed/serialized at the boundary), the `revision`
 * COLUMN is the CAS guard with the same number kept in sync inside the doc.
 * The policies singleton row is seeded so mutatePolicies can always UPDATE.
 * tick_locks backs cross-process tick exclusion (see tryTickLock).
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workstreams (
    slug     TEXT    PRIMARY KEY,
    revision INTEGER NOT NULL,
    doc      TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    slug     TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    content  BLOB NOT NULL,
    PRIMARY KEY (slug, rel_path)
  );
  CREATE TABLE IF NOT EXISTS policies (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision  INTEGER NOT NULL,
    store     TEXT    NOT NULL
  );
  INSERT OR IGNORE INTO policies (singleton, revision, store)
    VALUES (1, 0, '{"schemaVersion":1,"revision":0,"policies":[]}');
  CREATE TABLE IF NOT EXISTS tick_locks (
    slug        TEXT    PRIMARY KEY,
    pid         INTEGER NOT NULL,
    acquired_at TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runner_presence (
    runner_id         TEXT PRIMARY KEY,
    heartbeat_at      TEXT NOT NULL,
    coordinator_seats TEXT
  );
`;

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6): another process holds the write lock
 * longer than busy_timeout — contention, not corruption, so retry. */
function isBusy(error: unknown): boolean {
  const e = error as { errcode?: number; message?: string };
  return e?.errcode === 5 || e?.errcode === 6 || /database is locked/i.test(e?.message ?? '');
}

export function expandTilde(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export class SqliteStore implements StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const resolved = path.resolve(expandTilde(dbPath));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    // Lazy built-in load: node:sqlite warns on LOAD (ExperimentalWarning on
    // Node 22/25), so only a process that actually selected this backend
    // pays it — a static import would put the warning on every backend.
    const { DatabaseSync: Db } = process.getBuiltinModule('node:sqlite');
    this.db = new Db(resolved);
    // busy_timeout FIRST: it makes every subsequent lock acquisition (the WAL
    // switch and schema creation included) block-and-retry inside SQLite
    // instead of throwing SQLITE_BUSY at a concurrent first connect.
    this.db.exec('PRAGMA busy_timeout = 10000');
    // WAL for multi-process access: readers never block the writer and the
    // writer never blocks readers, so watch/status polling from a second
    // process doesn't contend with a tick's writes. Must run outside a txn.
    this.db.exec('PRAGMA journal_mode = WAL');
    // One transaction so two processes racing first-connect serialize on the
    // write lock instead of interleaving CREATE TABLE statements. Old stores
    // declared artifact content as TEXT; SQLite cannot ALTER a column type, so
    // rebuild that one table once and cast its already-valid text to UTF-8
    // bytes. DDL is transactional here: interruption restores the old table.
    this.txn(() => {
      this.db.exec(SCHEMA);
      // Additive presence column for files created before seat publication.
      // SQLite has no ADD COLUMN IF NOT EXISTS, so ask the catalog first.
      const seatsColumn = this.db.prepare(
        `SELECT 1 FROM pragma_table_info('runner_presence') WHERE name = 'coordinator_seats'`,
      ).get();
      if (!seatsColumn) this.db.exec('ALTER TABLE runner_presence ADD COLUMN coordinator_seats TEXT');
      const artifactColumn = this.db.prepare(
        `SELECT type FROM pragma_table_info('artifacts') WHERE name = 'content'`,
      ).get() as { type: string } | undefined;
      if (artifactColumn?.type.toUpperCase() === 'TEXT') {
        this.db.exec(`
          CREATE TABLE artifacts_blob_migration (
            slug     TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            content  BLOB NOT NULL,
            PRIMARY KEY (slug, rel_path)
          );
          INSERT INTO artifacts_blob_migration (slug, rel_path, content)
            SELECT slug, rel_path, CAST(content AS BLOB) FROM artifacts;
          DROP TABLE artifacts;
          ALTER TABLE artifacts_blob_migration RENAME TO artifacts;
        `);
      }
    });
  }

  /**
   * One synchronous BEGIN IMMEDIATE region — the backend's whole atomicity
   * story (see file header). `fn` must not yield (it cannot: everything in
   * this file is synchronous node:sqlite). BEGIN retries on busy beyond
   * SQLite's own busy_timeout with a bounded synchronous spin, mirroring
   * FsStore's write-lock spin: two contending processes queue, they don't
   * throw spuriously. Errors inside the region ROLLBACK and rethrow —
   * a RevisionConflictError is never retried here (the shared layer's
   * arrive() owns conflict retries).
   */
  private txn<T>(fn: () => T): T {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        if (isBusy(error) && Date.now() < deadline) {
          const until = Date.now() + 5;
          while (Date.now() < until) { /* writers are synchronous and normally sub-ms */ }
          continue;
        }
        throw error;
      }
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* txn already gone */ }
        throw error;
      }
    }
  }

  async listWorkstreams(): Promise<string[]> {
    return this.db.prepare('SELECT slug FROM workstreams ORDER BY slug').all()
      .map((row) => (row as { slug: string }).slug);
  }

  async listWorkstreamHeads(): Promise<WorkstreamHead[]> {
    return this.db.prepare(
      'SELECT slug, revision FROM workstreams WHERE json_valid(doc) ORDER BY slug',
    ).all().map((row) => {
      const typed = row as { slug: string; revision: number };
      return { slug: typed.slug, revision: typed.revision };
    });
  }

  async load(slug: string): Promise<WorkstreamDoc> {
    const row = this.db.prepare('SELECT doc FROM workstreams WHERE slug = ?').get(slug) as
      | { doc: string }
      | undefined;
    if (!row) throw new Error(`no workstream '${slug}' in the SQLite store`);
    return JSON.parse(row.doc) as WorkstreamDoc;
  }

  async create(core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>): Promise<WorkstreamDoc> {
    const doc = initialDoc(core);
    return this.txn(() => {
      if (this.db.prepare('SELECT 1 FROM workstreams WHERE slug = ?').get(core.slug)) {
        throw new Error(`workstream '${core.slug}' already exists`);
      }
      // Source-key uniqueness is atomic here: BEGIN IMMEDIATE holds the write
      // lock, so no concurrent create — same key, different slug — can commit
      // between this lookup and the INSERT. json_extract reads sourceKey out of
      // the stored doc; malformed JSON (external tampering) makes it THROW,
      // which is the intended fail-loud: corruption may not hide an identity.
      if (core.sourceKey !== undefined) {
        const clash = this.db
          .prepare(`SELECT slug FROM workstreams WHERE json_extract(doc, '$.workstream.sourceKey') = ? LIMIT 1`)
          .get(core.sourceKey);
        if (clash) throw new SourceKeyConflictError(core.sourceKey);
      }
      // Receipt before COMMIT (fs sidecar, same as pg): a failure here rolls
      // the INSERT back, so a committed head always has its transition; an
      // interruption after the receipt orphans a future receipt readers ignore.
      writeJournalReceipt(printoutJournalDir(core.slug), creationReceipt(doc));
      this.db.prepare('INSERT INTO workstreams (slug, revision, doc) VALUES (?, ?, ?)')
        .run(core.slug, doc.revision, JSON.stringify(doc));
      return doc;
    });
  }

  async mutate(slug: string, expectedRevision: number | undefined, fn: Mutator): Promise<WorkstreamDoc> {
    // The whole read→check→mutate→write runs inside one IMMEDIATE transaction
    // with zero awaits: in-process atomicity from being synchronous (FsStore's
    // guarantee), cross-process atomicity from the database write lock. An
    // ARRIVAL (undefined expectedRevision) serializes on the same lock, so
    // simultaneous arrivals queue and all land instead of racing the CAS.
    return this.txn(() => {
      const row = this.db.prepare('SELECT doc, revision FROM workstreams WHERE slug = ?').get(slug) as
        | { doc: string; revision: number }
        | undefined;
      if (!row) throw new Error(`no workstream '${slug}' in the SQLite store`);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, row.revision);
      }
      const doc = JSON.parse(row.doc) as WorkstreamDoc;
      const before = structuredClone(doc);
      const emitted: EventRecord[] = [];
      // The mutator contract is SYNCHRONOUS (enforced structurally in
      // src/store.ts), so nothing yields between this read and the UPDATE.
      fn(doc, eventHelperFor(doc, emitted));
      doc.revision = row.revision + 1;
      this.db.prepare('UPDATE workstreams SET doc = ?, revision = ? WHERE slug = ?')
        .run(JSON.stringify(doc), doc.revision, slug);
      // Receipt before COMMIT, same discipline as pg: an interruption here
      // orphans a future receipt (ignored by readers) and rolls back the
      // UPDATE; a committed head always has its exact transition.
      writeJournalReceipt(printoutJournalDir(slug), {
        revision: doc.revision,
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        changes: printoutChanges(before, doc),
        events: emitted,
      } satisfies PrintoutMutationReceipt);
      return doc;
    });
  }

  async writeArtifactRaw(slug: string, relPath: string, content: string): Promise<void> {
    // relPath embeds the content hash (shared layer), so an upsert can only
    // ever rewrite the same bytes — matching the fs backend's overwrite.
    this.db.prepare(
      `INSERT INTO artifacts (slug, rel_path, content) VALUES (?, ?, ?)
       ON CONFLICT (slug, rel_path) DO UPDATE SET content = excluded.content`,
    ).run(slug, relPath, Buffer.from(content, 'utf8'));
  }

  async readArtifact(slug: string, relPath: string): Promise<string> {
    const row = this.db.prepare('SELECT content FROM artifacts WHERE slug = ? AND rel_path = ?')
      .get(slug, relPath) as { content: Uint8Array } | undefined;
    if (!row) throw new Error(`no artifact '${relPath}' for workstream '${slug}'`);
    return Buffer.from(row.content).toString('utf8');
  }

  async loadPolicies(): Promise<PolicyStore> {
    const row = this.db.prepare('SELECT store FROM policies WHERE singleton = 1').get() as
      | { store: string }
      | undefined;
    return row ? (JSON.parse(row.store) as PolicyStore) : emptyPolicyStore();
  }

  /**
   * The global store's read-modify-write inside one IMMEDIATE transaction:
   * the write lock serializes concurrent runners across processes and the
   * region is synchronous in-process, so — like the fs backend's lock — there
   * is no window for a lost update and no need for pg's CAS-and-retry.
   */
  async mutatePolicies(fn: (store: PolicyStore) => void): Promise<PolicyStore> {
    return this.txn(() => {
      const row = this.db.prepare('SELECT store, revision FROM policies WHERE singleton = 1').get() as
        | { store: string; revision: number }
        | undefined;
      const stored = row?.revision ?? 0;
      const store = row ? (JSON.parse(row.store) as PolicyStore) : emptyPolicyStore();
      const before = new Map(store.policies.map((policy) => [policy.id, structuredClone(policy)]));
      fn(store);
      store.revision = stored + 1;
      // Upsert rather than plain UPDATE: the singleton row is seeded at
      // construction, but a wiped table (tests clear between cases) must not
      // strand future writes.
      this.db.prepare(
        `INSERT INTO policies (singleton, revision, store) VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET store = excluded.store, revision = excluded.revision`,
      ).run(store.revision, JSON.stringify(store));
      // Receipt before COMMIT, same discipline as doc mutations.
      writeJournalReceipt(policyJournalDir(), {
        revision: store.revision,
        at: new Date().toISOString(),
        changes: changedById([...before.values()], store.policies),
      } satisfies PolicyMutationReceipt);
      return store;
    });
  }

  async heartbeatRunner(presence: RunnerPresence): Promise<void> {
    this.db.prepare(
      `INSERT INTO runner_presence (runner_id, heartbeat_at, coordinator_seats) VALUES (?, ?, ?)
       ON CONFLICT (runner_id) DO UPDATE
         SET heartbeat_at = excluded.heartbeat_at, coordinator_seats = excluded.coordinator_seats`,
    ).run(
      presence.runnerId,
      presence.heartbeatAt,
      presence.coordinatorSeats === undefined ? null : JSON.stringify(presence.coordinatorSeats),
    );
  }

  async listRunnerPresence(): Promise<RunnerPresence[]> {
    return this.db.prepare(
      'SELECT runner_id, heartbeat_at, coordinator_seats FROM runner_presence ORDER BY runner_id',
    ).all()
      .map((row) => {
        const { runner_id, heartbeat_at, coordinator_seats } = row as {
          runner_id: string; heartbeat_at: string; coordinator_seats: string | null;
        };
        return {
          runnerId: runner_id,
          heartbeatAt: heartbeat_at,
          ...(coordinator_seats ? { coordinatorSeats: JSON.parse(coordinator_seats) as CapacityTarget[] } : {}),
        };
      });
  }

  /**
   * Cross-process tick exclusion via a tick_locks row. Liveness is a pid
   * probe (`process.kill(pid, 0)`), which is only meaningful for processes on
   * THIS machine — a sound assumption here because a SQLite file is
   * inherently single-machine (the pg backend, which does span machines,
   * uses session-scoped advisory locks instead).
   *
   * The whole probe→reclaim→insert runs inside one IMMEDIATE transaction, so
   * the TOCTOU race fs.ts must guard against by hand (holder releases and a
   * third process acquires between our probe and our reclaim) is structurally
   * excluded: no other process can touch the row while we hold the write
   * lock. The pid-matched DELETE mirrors fs.ts's "reclaim only what we
   * probed" discipline anyway, so the invariant survives even a future
   * refactor that shrinks the transaction.
   */
  async tryTickLock(slug: string): Promise<(() => Promise<void>) | null> {
    const acquired = this.txn(() => {
      const row = this.db.prepare('SELECT pid FROM tick_locks WHERE slug = ?').get(slug) as
        | { pid: number }
        | undefined;
      if (row) {
        try {
          process.kill(row.pid, 0); // throws if the holder is dead
          return false; // a live process holds the lock
        } catch {
          // Dead holder: stale lock, reclaim exactly the row we probed.
          this.db.prepare('DELETE FROM tick_locks WHERE slug = ? AND pid = ?').run(slug, row.pid);
        }
      }
      this.db.prepare('INSERT INTO tick_locks (slug, pid, acquired_at) VALUES (?, ?, ?)')
        .run(slug, process.pid, new Date().toISOString());
      return true;
    });
    if (!acquired) return null;
    return async () => {
      // Release only OUR lock: a crashed-then-reclaimed pid must not delete a
      // successor's row.
      this.db.prepare('DELETE FROM tick_locks WHERE slug = ? AND pid = ?').run(slug, process.pid);
    };
  }

  async rename(oldSlug: string, newSlug: string): Promise<WorkstreamDoc> {
    const doc = this.txn(() => {
      const row = this.db.prepare('SELECT doc, revision FROM workstreams WHERE slug = ?').get(oldSlug) as
        | { doc: string; revision: number }
        | undefined;
      if (!row) throw new Error(`no workstream '${oldSlug}' in the SQLite store`);
      if (this.db.prepare('SELECT 1 FROM workstreams WHERE slug = ?').get(newSlug)) {
        throw new Error(`workstream '${newSlug}' already exists`);
      }
      // The tick lock covers the whole tick, workers included: a live holder
      // still references the old slug, so a mid-tick rename is refused. Same
      // probe-and-reclaim discipline as tryTickLock, inside the same write lock.
      const lock = this.db.prepare('SELECT pid FROM tick_locks WHERE slug = ?').get(oldSlug) as
        | { pid: number }
        | undefined;
      if (lock) {
        let holderLive = false;
        try { process.kill(lock.pid, 0); holderLive = true; } catch { /* dead holder */ }
        if (holderLive) throw new Error(`workstream '${oldSlug}' is mid-tick — retry when the tick finishes`);
        this.db.prepare('DELETE FROM tick_locks WHERE slug = ? AND pid = ?').run(oldSlug, lock.pid);
      }
      const d = JSON.parse(row.doc) as WorkstreamDoc;
      const before = structuredClone(d);
      const emitted: EventRecord[] = [];
      eventHelperFor(d, emitted)('workstream.renamed', `renamed from '${oldSlug}' to '${newSlug}'`);
      d.workstream.slug = newSlug;
      d.revision = row.revision + 1;
      this.db.prepare('UPDATE workstreams SET slug = ?, doc = ?, revision = ? WHERE slug = ?')
        .run(newSlug, JSON.stringify(d), d.revision, oldSlug);
      this.db.prepare('UPDATE artifacts SET slug = ? WHERE slug = ?').run(newSlug, oldSlug);
      // Receipt before COMMIT, into the OLD slug's machine-local journal — the
      // whole sidecar directory moves to the new name after commit.
      writeJournalReceipt(printoutJournalDir(oldSlug), {
        revision: d.revision,
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        changes: printoutChanges(before, d),
        events: emitted,
      } satisfies PrintoutMutationReceipt);
      return d;
    });
    moveLocalSidecars(oldSlug, newSlug);
    return doc;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
