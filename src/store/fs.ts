/**
 * FsStore — the reference StateStore backend: typed state on disk.
 *
 * Layout (under WEAVER_HOME, default ./state):
 *   <slug>/workstream.json   — the WorkstreamDoc (single source of truth)
 *   <slug>/artifacts/<file>  — deliverable content, content-addressed by hash
 *   <slug>/.tick.lock/       — cross-process tick exclusion (mkdir is atomic)
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
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import { creationReceipt, emptyPolicyStore, eventHelperFor, initialDoc, newId, sha256 } from './doc.js';
import { RevisionConflictError, type Mutator, type StateStore } from './types.js';

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
  const dir = writeLockDir(slug);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      let live = true;
      let observedPid: number | undefined;
      try {
        const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          observedPid = pid;
          try { process.kill(pid, 0); }
          catch { live = false; }
        } else {
          // The holder may be between mkdir and completing its pid write.
          live = fs.statSync(dir).mtimeMs >= Date.now() - 10_000;
        }
      } catch {
        try {
          live = fs.statSync(dir).mtimeMs >= Date.now() - 10_000;
        } catch { live = false; }
      }
      if (!live) {
        // Reclaim ONLY if the lock still names the dead pid we probed. The
        // probe raced the holder's release: between our pid read and here the
        // holder can finish and a THIRD process can acquire — blindly deleting
        // the dir then removes a LIVE holder's lock, two writers hold at once,
        // and one revision is silently lost (observed as 7 of 8 simultaneous
        // arrivals landing). A changed or missing pid file means the lock
        // already moved on; just contend again.
        try {
          if (observedPid === undefined ||
              Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')) === observedPid) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* released or replaced since the probe — contend again */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`workstream '${slug}' write lock timeout`);
      const until = Date.now() + 10;
      while (Date.now() < until) { /* writes are synchronous and normally sub-ms */ }
    }
  }
  try { return fn(); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    const dir = workstreamDir(core.slug);
    fs.mkdirSync(dir, { recursive: true });
    return withWriteLock(core.slug, () => {
      if (fs.existsSync(docPath(core.slug))) {
        throw new Error(`workstream '${core.slug}' already exists`);
      }
      fs.mkdirSync(artifactsDir(core.slug), { recursive: true });
      const doc = initialDoc(core);
      writeAtomic(core.slug, doc, creationReceipt(doc));
      return doc;
    });
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
   * ticks can race the read-modify-write. A short mkdir lock serializes
   * same-machine processes (10s stale-holder reclaim); inside the lock the
   * read→mutate→write runs without yielding, so in-process writers cannot
   * interleave either. A network backend serializes with its own CAS instead.
   */
  async mutatePolicies(fn: (store: PolicyStore) => void): Promise<PolicyStore> {
    const dir = `${policiesPath()}.lock`;
    // A missing home dir would make every mkdir below ENOENT — indistinguishable
    // from contention, so the spin would run out the clock on a fresh install.
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.mkdirSync(dir);
        break;
      } catch {
        try {
          if (fs.statSync(dir).mtimeMs < Date.now() - 10_000) {
            fs.rmSync(dir, { recursive: true, force: true });
            continue;
          }
        } catch { /* raced with the holder's release — retry */ }
        if (Date.now() > deadline) throw new Error('policy store lock timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
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
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Cross-PROCESS tick exclusion (the doc's revision check guards logical
   * conflicts, not two OS processes dispatching the same real-world act in the
   * same instant — e.g. `weaver run` resident plus a manual `weaver tick`).
   * mkdir is atomic on every platform; a lock whose recorded pid is dead is
   * stale and reclaimed.
   */
  async tryTickLock(slug: string): Promise<(() => Promise<void>) | null> {
    const dir = path.join(workstreamDir(slug), '.tick.lock');
    const pidFile = path.join(dir, 'pid');
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(pidFile, String(process.pid));
      return async () => fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      let observedPid: number | undefined;
      try {
        observedPid = Number(fs.readFileSync(pidFile, 'utf8'));
        process.kill(observedPid, 0); // throws if the holder is dead
        return null; // a live process holds the lock
      } catch {
        if (observedPid === undefined) {
          // No readable pid: the holder may be between mkdir and its pid
          // write. Only a stale dir is reclaimable; a fresh one counts as
          // held — the next tick simply retries.
          try {
            if (fs.statSync(dir).mtimeMs >= Date.now() - 10_000) return null;
          } catch { /* vanished — contend again */ }
        }
        // Reclaim ONLY if the lock still names the pid we probed: the probe
        // races the holder's release, and a third process may have acquired
        // in between — deleting its live lock would let two ticks run at
        // once (same TOCTOU as the write lock above).
        try {
          if (observedPid === undefined ||
              Number(fs.readFileSync(pidFile, 'utf8')) === observedPid) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch { /* released or replaced since the probe — contend again */ }
        return this.tryTickLock(slug);
      }
    }
  }
}
