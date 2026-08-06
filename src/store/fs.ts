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
import type { PolicyStore } from '../policies.js';
import type { EventRecord, WorkstreamCore, WorkstreamDoc } from '../types.js';
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

function policiesPath(): string {
  return path.join(weaverHome(), 'policies.json');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Atomic tmp+rename write. Secrets enforcement happens in src/store.ts BEFORE
 * this is reached — the backend persists exactly what the shared layer vetted. */
function writeAtomic(slug: string, doc: WorkstreamDoc): void {
  const p = docPath(slug);
  const json = JSON.stringify(doc, null, 2) + '\n';
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
      events: [
        {
          at: new Date().toISOString(),
          atVirtual: virtualNow().toISOString(),
          type: 'workstream.created',
          summary: `Workstream '${core.title}' created`,
        },
      ],
      spend: { coordinatorPasses: 0, totalCostUsd: 0, humanInterventions: 0 },
      lease: null,
    };
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(core.slug, doc);
    return doc;
  }

  async mutate(slug: string, expectedRevision: number, fn: Mutator): Promise<WorkstreamDoc> {
    // NO await between the load, the revision check, and the write: the whole
    // check-and-set runs synchronously, so a concurrent in-process writer can
    // never interleave inside it — it conflicts on ITS check instead. (An
    // awaited load here once opened exactly that window; the store contract
    // test on concurrent arrivals catches it.)
    const doc = this.loadSync(slug);
    if (doc.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, doc.revision);
    }
    const event = (type: string, summary: string, refs?: string[]) => {
      const rec: EventRecord = {
        at: new Date().toISOString(),
        atVirtual: virtualNow().toISOString(),
        type,
        summary,
        ...(refs ? { refs } : {}),
      };
      doc.events.push(rec);
      if (doc.events.length > EVENT_TAIL_LIMIT) {
        doc.events.splice(0, doc.events.length - EVENT_TAIL_LIMIT);
      }
    };
    fn(doc, event);
    doc.revision += 1;
    writeAtomic(slug, doc);
    return doc;
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
    } catch {
      return { schemaVersion: 1, revision: 0, policies: [] };
    }
  }

  async savePolicies(store: PolicyStore): Promise<void> {
    fs.mkdirSync(path.dirname(policiesPath()), { recursive: true });
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
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        process.kill(pid, 0); // throws if the holder is dead
        return null; // a live process holds the lock
      } catch {
        fs.rmSync(dir, { recursive: true, force: true });
        return this.tryTickLock(slug);
      }
    }
  }
}
