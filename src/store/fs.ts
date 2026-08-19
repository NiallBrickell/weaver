/**
 * FsStore — the reference StateStore backend: typed state on disk.
 *
 * Layout (under WEAVER_HOME, default ./state):
 *   <slug>/workstream.json   — the WorkstreamDoc (single source of truth)
 *   <slug>/artifacts/<file>  — deliverable content, content-addressed by hash
 *   <slug>/.tick.lock/       — ownership-marked cross-process tick exclusion
 *   policies.json            — the global learned-policy store
 *
 * Semantics this backend pins for every future backend: atomic tmp+rename
 * writes, revision CAS throwing RevisionConflictError, event-tail cap of 200.
 * Everything backend-agnostic (secrets assertion, artifact redaction/hashing,
 * arrive's retry) lives in src/store.ts — this file persists bytes only.
 *
 * Methods are async to satisfy the StateStore contract but use SYNCHRONOUS
 * node:fs inside: each store operation runs without yielding to the event
 * loop, so a mutate's load→check→write can never interleave with another
 * in-process write mid-operation — the same intra-process atomicity the
 * pre-adapter store had.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { virtualNow } from '../clock.js';
import { changedById, printoutChanges, writeJournalReceipt } from '../printoutJournal.js';
import { acquireProcessLock } from '../processLock.js';
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import { creationReceipt, emptyPolicyStore, eventHelperFor, initialDoc, newId, sha256 } from './doc.js';
import { RevisionConflictError, SourceKeyConflictError, type Mutator, type StateStore } from './types.js';

export { newId, sha256 };

export function weaverHome(): string {
  return process.env.WEAVER_HOME ?? path.resolve(process.cwd(), 'state');
}

export function workstreamDir(slug: string): string {
  return path.join(weaverHome(), slug);
}

function docPath(slug: string): string {
  return path.join(workstreamDir(slug), 'workstream.json');
}

export function artifactsDir(slug: string): string {
  return path.join(workstreamDir(slug), 'artifacts');
}

function writeLockDir(slug: string): string {
  return path.join(workstreamDir(slug), '.write.lock');
}

export function printoutJournalDir(slug: string): string {
  return path.join(workstreamDir(slug), 'printout');
}

/** Printout receipts for the GLOBAL policy store (fs sidecar on this machine). */
export function policyJournalDir(): string {
  return path.join(weaverHome(), '.printout', 'policies');
}

function policiesPath(): string {
  return path.join(weaverHome(), 'policies.json');
}

/** Serialize the actual read/check/write region across local processes. */
function withWriteLock<T>(slug: string, fn: () => T): T {
  const release = acquireProcessLock(writeLockDir(slug), { timeoutMs: 10_000 });
  if (!release) throw new Error(`workstream '${slug}' write lock timeout`);
  try { return fn(); }
  finally { release(); }
}

/** Atomic tmp+rename write. Secrets enforcement happens in src/store.ts BEFORE
 * this is reached — the backend persists exactly what the shared layer vetted. */
function writeAtomic(slug: string, doc: WorkstreamDoc, receipt?: PrintoutMutationReceipt): void {
  const p = docPath(slug);
  const json = JSON.stringify(doc, null, 2) + '\n';
  // Receipt first: an interrupted commit may leave an ignored future receipt,
  // but can never expose a committed head whose exact transition is missing.
  if (receipt) writeJournalReceipt(printoutJournalDir(slug), receipt);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, p);
}

export class FsStore implements StateStore {
  async listWorkstreams(): Promise<string[]> {
    const home = weaverHome();
    if (!fs.existsSync(home)) return [];
    return fs
      .readdirSync(home)
      .filter((d) => fs.existsSync(docPath(d)))
      .sort();
  }

  /** Synchronous read shared by load() and mutate() — mutate must not yield
   * between its revision check and its write (see mutate). */
  private loadSync(slug: string): WorkstreamDoc {
    const p = docPath(slug);
    if (!fs.existsSync(p)) {
      throw new Error(`no workstream '${slug}' under ${weaverHome()}`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8')) as WorkstreamDoc;
  }

  async load(slug: string): Promise<WorkstreamDoc> {
    return this.loadSync(slug);
  }

  async create(core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>): Promise<WorkstreamDoc> {
    // The slug write lock is per-slug, so it cannot make source-key uniqueness
    // atomic: two DIFFERENT slugs carrying the same sourceKey take different
    // locks and would both pass a scan-then-create. A home-scoped create lock
    // serializes ALL creations (they are rare), so the sourceKey scan below and
    // the write happen with no other create interleaving.
    const home = weaverHome();
    fs.mkdirSync(home, { recursive: true });
    const releaseCreate = acquireProcessLock(path.join(home, '.create.lock'), { timeoutMs: 10_000 });
    if (!releaseCreate) throw new Error('create lock timeout');
    try {
      if (core.sourceKey !== undefined) {
        const existing = this.slugForSourceKey(core.sourceKey);
        if (existing) throw new SourceKeyConflictError(core.sourceKey);
      }
      return withWriteLock(core.slug, () => {
        if (fs.existsSync(docPath(core.slug))) {
          throw new Error(`workstream '${core.slug}' already exists`);
        }
        fs.mkdirSync(artifactsDir(core.slug), { recursive: true });
        const doc = initialDoc(core);
        writeAtomic(core.slug, doc, creationReceipt(doc));
        return doc;
      });
    } finally {
      releaseCreate();
    }
  }

  /**
   * The slug already standing for a sourceKey, or null. Unlike the shared
   * layer's best-effort findBySourceKey, this FAILS LOUD on an unreadable doc:
   * corruption must never make an existing identity disappear and let a
   * duplicate be created. Called only inside the create lock.
   */
  private slugForSourceKey(sourceKey: string): string | null {
    const home = weaverHome();
    if (!fs.existsSync(home)) return null;
    for (const slug of fs.readdirSync(home).filter((d) => fs.existsSync(docPath(d))).sort()) {
      let doc: WorkstreamDoc;
      try {
        doc = this.loadSync(slug);
      } catch (error) {
        throw new Error(
          `cannot verify source-key uniqueness: workstream '${slug}' is unreadable ` +
            `(${error instanceof Error ? error.message : error}) — refusing to create so a duplicate identity cannot slip in`,
        );
      }
      if (doc.workstream.sourceKey === sourceKey) return slug;
    }
    return null;
  }

  async mutate(slug: string, expectedRevision: number | undefined, fn: Mutator): Promise<WorkstreamDoc> {
    // The write lock serializes the whole read-check-write region across
    // processes (the arrival contract: expectedRevision undefined must land
    // without a spurious conflict); WITHIN it there is also NO await between
    // the load, the revision check, and the write, so a concurrent in-process
    // writer can never interleave inside it either. (An awaited load here once
    // opened exactly that window; the store contract test on concurrent
    // arrivals catches it.)
    return withWriteLock(slug, () => {
      const doc = this.loadSync(slug);
      if (expectedRevision !== undefined && doc.revision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, doc.revision);
      }
      const before = structuredClone(doc);
      const emitted: EventRecord[] = [];
      fn(doc, eventHelperFor(doc, emitted));
      doc.revision += 1;
      const receipt: PrintoutMutationReceipt = {
        revision: doc.revision,
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        changes: printoutChanges(before, doc),
        events: emitted,
      };
      writeAtomic(slug, doc, receipt);
      return doc;
    });
  }

  async writeArtifactRaw(slug: string, relPath: string, content: string): Promise<void> {
    fs.writeFileSync(path.join(artifactsDir(slug), relPath), content);
  }

  async readArtifact(slug: string, relPath: string): Promise<string> {
    return fs.readFileSync(path.join(artifactsDir(slug), relPath), 'utf8');
  }

  async loadPolicies(): Promise<PolicyStore> {
    try {
      return JSON.parse(fs.readFileSync(policiesPath(), 'utf8')) as PolicyStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`cannot read global policy store: ${error instanceof Error ? error.message : error}`);
      }
      return emptyPolicyStore();
    }
  }

  /**
   * The policy store is GLOBAL (shared across workstreams), so two concurrent
   * ticks can race the read-modify-write. The shared ownership-marked process
   * lock serializes same-machine writers and reclaims only a holder proven
   * dead; inside the lock the read→mutate→write runs without yielding, so
   * in-process writers cannot interleave either. A network backend serializes
   * with its own CAS instead.
   */
  async mutatePolicies(fn: (store: PolicyStore) => void): Promise<PolicyStore> {
    const dir = `${policiesPath()}.lock`;
    const release = acquireProcessLock(dir, { timeoutMs: 10_000, pollMs: 25 });
    if (!release) throw new Error('policy store lock timeout');
    try {
      // Synchronous from read to rename: no yield between load and write.
      let store: PolicyStore;
      try {
        store = JSON.parse(fs.readFileSync(policiesPath(), 'utf8')) as PolicyStore;
      } catch {
        store = emptyPolicyStore();
      }
      const before = new Map(store.policies.map((policy) => [policy.id, structuredClone(policy)]));
      fn(store);
      store.revision += 1;
      const receipt: PolicyMutationReceipt = {
        revision: store.revision,
        at: new Date().toISOString(),
        changes: changedById([...before.values()], store.policies),
      };
      // Receipt first, same as workstream heads (see writeAtomic).
      writeJournalReceipt(policyJournalDir(), receipt);
      const tmp = `${policiesPath()}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
      fs.renameSync(tmp, policiesPath());
      return store;
    } finally {
      release();
    }
  }

  /**
   * Cross-PROCESS tick exclusion (the doc's revision check guards logical
   * conflicts, not two OS processes dispatching the same real-world act in the
   * same instant — e.g. `weaver run` resident plus a manual `weaver tick`).
   * The shared process-lock primitive publishes complete owner metadata
   * atomically; only a holder proven dead is reclaimed, and predecessor
   * release cannot delete a successor's lock.
   */
  async tryTickLock(slug: string): Promise<(() => Promise<void>) | null> {
    const dir = path.join(workstreamDir(slug), '.tick.lock');
    const release = acquireProcessLock(dir);
    return release ? async () => release() : null;
  }

  async rename(oldSlug: string, newSlug: string): Promise<WorkstreamDoc> {
    // The home-scoped create lock: a rename brings one identity into existence
    // and retires another, so it must not race a create (or another rename)
    // targeting either name.
    const home = weaverHome();
    fs.mkdirSync(home, { recursive: true });
    const releaseCreate = acquireProcessLock(path.join(home, '.create.lock'), { timeoutMs: 10_000 });
    if (!releaseCreate) throw new Error('create lock timeout');
    try {
      if (!fs.existsSync(docPath(oldSlug))) throw new Error(`no workstream '${oldSlug}' under ${home}`);
      if (fs.existsSync(workstreamDir(newSlug))) throw new Error(`workstream '${newSlug}' already exists`);
      // The tick lock covers the whole tick, workers included: holding it here
      // proves nothing in flight still references the old slug.
      const releaseTick = acquireProcessLock(path.join(workstreamDir(oldSlug), '.tick.lock'));
      if (!releaseTick) throw new Error(`workstream '${oldSlug}' is mid-tick — retry when the tick finishes`);
      try {
        const doc = withWriteLock(oldSlug, () => {
          const d = this.loadSync(oldSlug);
          const before = structuredClone(d);
          const emitted: EventRecord[] = [];
          eventHelperFor(d, emitted)('workstream.renamed', `renamed from '${oldSlug}' to '${newSlug}'`);
          d.workstream.slug = newSlug;
          d.revision += 1;
          writeAtomic(oldSlug, d, {
            revision: d.revision,
            at: new Date().toISOString(),
            atVirtual: virtualNow().toISOString(),
            changes: printoutChanges(before, d),
            events: emitted,
          });
          return d;
        });
        // Doc first, directory second: a crash between the two leaves the
        // renamed doc inside the old directory, which re-running the rename
        // heals — the reverse order would strand a directory whose contents
        // still answer to a name that no longer loads.
        fs.renameSync(workstreamDir(oldSlug), workstreamDir(newSlug));
        return doc;
      } finally {
        // The directory rename carried our held tick lock into the new
        // location, so releasing the old path is a no-op by design (the unique
        // owner file is simply absent there) — remove the moved lock we still
        // own so the next tick isn't blocked until this process exits.
        releaseTick();
        fs.rmSync(path.join(workstreamDir(newSlug), '.tick.lock'), { recursive: true, force: true });
      }
    } finally {
      releaseCreate();
    }
  }
}

/**
 * Move the machine-local fs sidecars (printout journal, tail feed, secrets
 * overlay) that the sqlite/pg backends keep under WEAVER_HOME/<slug> alongside
 * their database-held truth. Best-effort by design: sidecars are provenance
 * and machine-local convenience, never durable state, so an absent source or
 * an occupied target leaves things where they are rather than failing the
 * rename that already committed.
 */
export function moveLocalSidecars(oldSlug: string, newSlug: string): void {
  const from = workstreamDir(oldSlug);
  const to = workstreamDir(newSlug);
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  fs.renameSync(from, to);
}
