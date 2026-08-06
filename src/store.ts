/**
 * The workstream store: typed state on disk with revision-checked writes.
 *
 * Layout (under WEAVER_HOME, default ./state):
 *   <slug>/workstream.json   — the WorkstreamDoc (single source of truth)
 *   <slug>/artifacts/<file>  — deliverable content, content-addressed by hash
 *
 * Every mutation goes through `mutate()`, which loads the doc, verifies the
 * caller's expected revision, applies the change, bumps the revision, and
 * writes atomically (tmp + rename). A conflicting arrival between read and
 * write fails the write and forces the caller to reconcile from newer state.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventRecord, WorkstreamCore, WorkstreamDoc } from './types.js';
import { virtualNow } from './clock.js';
// Circular at module level (secrets.ts uses this file's path helpers), but
// both sides only call functions at runtime, so ESM resolves it fine.
import { assertNoSecretValues, loadSecrets, redactSecrets } from './secrets.js';

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

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class RevisionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `revision conflict: expected ${expected}, store is at ${actual} — ` +
        `state changed since it was read; reconcile from the newer state`,
    );
    this.name = 'RevisionConflictError';
  }
}

export function listWorkstreams(): string[] {
  const home = weaverHome();
  if (!fs.existsSync(home)) return [];
  return fs
    .readdirSync(home)
    .filter((d) => fs.existsSync(docPath(d)))
    .sort();
}

export function load(slug: string): WorkstreamDoc {
  const p = docPath(slug);
  if (!fs.existsSync(p)) {
    throw new Error(`no workstream '${slug}' under ${weaverHome()}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as WorkstreamDoc;
}

function writeAtomic(slug: string, doc: WorkstreamDoc): void {
  const p = docPath(slug);
  const json = JSON.stringify(doc, null, 2) + '\n';
  // THE structural enforcement point for secrets-in-state: every doc write in
  // the codebase funnels here, so no ingress path (steer, reply, observe,
  // constraint, coordinator tool, TUI) can persist a secret VALUE — the write
  // is refused with the $NAME advice regardless of which caller forgot.
  assertNoSecretValues(json, loadSecrets(slug));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, p);
}

/**
 * Apply a revision-checked mutation. `expectedRevision` must equal the stored
 * revision or the write fails with RevisionConflictError. Returns the new doc.
 *
 * The mutator receives a fresh copy; it may push an event describing the
 * change via the provided `event` helper (bounded narrative tail).
 */
export function mutate(
  slug: string,
  expectedRevision: number,
  fn: (doc: WorkstreamDoc, event: (type: string, summary: string, refs?: string[]) => void) => void,
): WorkstreamDoc {
  const doc = load(slug);
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

/**
 * Convenience for "external arrival" writes (steer, reply, clock-driven) that
 * don't care about a previously-read revision: read-modify-write on current.
 * Still bumps the revision, so an in-flight coordinator pass will conflict —
 * which is exactly the contract.
 */
export function arrive(
  slug: string,
  fn: (doc: WorkstreamDoc, event: (type: string, summary: string, refs?: string[]) => void) => void,
): WorkstreamDoc {
  const current = load(slug).revision;
  return mutate(slug, current, fn);
}

export function createWorkstream(core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>): WorkstreamDoc {
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
    capacity: null,
    lease: null,
  };
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(core.slug, doc);
  return doc;
}

/**
 * Write deliverable content to the artifacts dir; returns {path, hash}.
 * Content is redacted against known secrets BEFORE hashing, so an artifact
 * can never carry a value and its pin always matches what is on disk.
 */
export function writeArtifact(
  slug: string,
  fileName: string,
  rawContent: string,
): { relPath: string; hash: string } {
  const content = redactSecrets(rawContent, loadSecrets(slug));
  const hash = sha256(content);
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const relPath = `${hash.slice(0, 8)}-${safe}`;
  fs.writeFileSync(path.join(artifactsDir(slug), relPath), content);
  return { relPath, hash };
}

export function readArtifact(slug: string, relPath: string): string {
  return fs.readFileSync(path.join(artifactsDir(slug), relPath), 'utf8');
}

/** Verify a deliverable's on-disk content still matches a pinned hash. */
export function verifyArtifact(slug: string, relPath: string, hash: string): boolean {
  try {
    return sha256(readArtifact(slug, relPath)) === hash;
  } catch {
    return false;
  }
}
