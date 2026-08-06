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

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { virtualNow } from '../clock.js';
import { diffPrintoutFields, printoutChanges, writeJournalReceipt } from '../printoutJournal.js';
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, PrintoutMutationReceipt, WorkstreamCore, WorkstreamDoc } from '../types.js';
import { RevisionConflictError, type Mutator, type StateStore } from './types.js';

const EVENT_TAIL_LIMIT = 200;

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

function policiesPath(): string {
  return path.join(weaverHome(), 'policies.json');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
      const doc: WorkstreamDoc = {
        schemaVersion: 1,
        revision: 0,
        workstream: {
          ...core,
          id: newId('ws'),
          status: 'active',
          createdAt: new Date().toISOString(),
        },
        decisions: [],
        assignments: [],
        deliverables: [],
        interactions: [],
        observations: [],
        wakes: [],
        steering: [],
        attention: [],
        passes: [],
        events: [],
        spend: { coordinatorPasses: 0, totalCostUsd: 0, humanInterventions: 0 },
        capacity: null,
        lease: null,
      };
      const created: EventRecord = {
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        type: 'workstream.created',
        summary: `Workstream '${core.title}' created`,
      };
      doc.events.push(created);
      const receipt: PrintoutMutationReceipt = {
        revision: 0,
        at: created.at,
        atVirtual: created.atVirtual,
        changes: [
          { kind: 'workstream', fields: diffPrintoutFields(undefined, doc.workstream) },
          { kind: 'spend', fields: diffPrintoutFields(undefined, doc.spend) },
          { kind: 'capacity', fields: diffPrintoutFields(undefined, doc.capacity) },
          { kind: 'lease', fields: diffPrintoutFields(undefined, doc.lease) },
        ],
        events: [created],
      };
      writeAtomic(core.slug, doc, receipt);
      return doc;
    });
  }

  async mutate(slug: string, expectedRevision: number | undefined, fn: Mutator): Promise<WorkstreamDoc> {
    // The write lock serializes the whole read-check-write region across
    // processes (the arrival contract); WITHIN it there is also NO await
    // between the load, the revision check, and the write, so a concurrent
    // in-process writer can never interleave inside it either. (An awaited
    // load here once opened exactly that window; the store contract test on
    // concurrent arrivals catches it.)
    return withWriteLock(slug, () => {
      const doc = this.loadSync(slug);
      if (expectedRevision !== undefined && doc.revision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, doc.revision);
      }
      const before = structuredClone(doc);
      const emitted: EventRecord[] = [];
      const event = (type: string, summary: string, refs?: string[]) => {
        const rec: EventRecord = {
          at: new Date().toISOString(),
          atVirtual: virtualNow().toISOString(),
          type,
          summary,
          ...(refs ? { refs } : {}),
        };
        emitted.push(rec);
        doc.events.push(rec);
        if (doc.events.length > EVENT_TAIL_LIMIT) {
          doc.events.splice(0, doc.events.length - EVENT_TAIL_LIMIT);
        }
      };
      fn(doc, event);
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
      return { schemaVersion: 1, revision: 0, policies: [] };
    }
  }

  async savePolicies(store: PolicyStore, receipt: PolicyMutationReceipt): Promise<void> {
    fs.mkdirSync(path.dirname(policiesPath()), { recursive: true });
    // Receipt first, same as workstream heads (see writeAtomic).
    writeJournalReceipt(path.join(weaverHome(), '.printout', 'policies'), receipt);
    const tmp = `${policiesPath()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, policiesPath());
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
