/**
 * The workstream store: typed state with revision-checked writes, now behind
 * the async StateStore interface (src/store/types.ts). The fs implementation
 * (src/store/fs.ts) is the reference backend; PR 2 adds selection of a second
 * backend via WEAVER_STORE.
 *
 * This module is the BACKEND-AGNOSTIC layer — policy every backend inherits:
 *  - `assertNoSecretValues` runs on the serialized state BEFORE any backend
 *    write. THE structural enforcement point for secrets-in-state: every doc
 *    write funnels through `mutate`/`createWorkstream` here, so no ingress
 *    path (steer, reply, observe, constraint, coordinator tool, TUI) can
 *    persist a secret VALUE — the write is refused with the $NAME advice
 *    regardless of which caller forgot, on every backend.
 *  - `writeArtifact` redacts against known secrets and hashes BEFORE handing
 *    raw bytes to the backend, so an artifact can never carry a value and its
 *    pin always matches what is stored.
 *  - `arrive` is an UNCHECKED mutation (expectedRevision undefined): the
 *    backend serializes the whole read-modify-write region, so simultaneous
 *    arrivals all land without a spurious conflict — and still each bump the
 *    revision, so an in-flight coordinator pass conflicts on ITS check.
 *
 * Every mutation goes through `mutate()`, which verifies the caller's expected
 * revision against the stored one and fails the write on a conflicting arrival
 * between read and write, forcing the caller to reconcile from newer state.
 */

// Circular at module level (secrets.ts uses this file's path helpers), but
// both sides only call functions at runtime, so ESM resolves it fine.
import { assertNoSecretValues, loadSecrets, redactSecrets } from './secrets.js';
import { FsStore, artifactsDir, newId, printoutJournalDir, sha256, weaverHome, workstreamDir } from './store/fs.js';
import { RevisionConflictError, type Mutator, type StateStore } from './store/types.js';
import type { WorkstreamCore, WorkstreamDoc } from './types.js';

export { artifactsDir, newId, printoutJournalDir, sha256, weaverHome, workstreamDir };
export { RevisionConflictError };
export type { StateStore };

let activeStore: StateStore | undefined;

/** The active backend. PR 2 adds selection via WEAVER_STORE; fs is the reference. */
export function getStore(): StateStore {
  return (activeStore ??= new FsStore());
}

export async function listWorkstreams(): Promise<string[]> {
  return getStore().listWorkstreams();
}

export async function load(slug: string): Promise<WorkstreamDoc> {
  return getStore().load(slug);
}

/**
 * Apply a revision-checked mutation. `expectedRevision` must equal the stored
 * revision or the write fails with RevisionConflictError. Returns the new doc.
 *
 * The mutator receives a fresh copy; it may push an event describing the
 * change via the provided `event` helper (bounded narrative tail).
 */
/** The shared-policy wrapper both mutate() and arrive() apply around a caller's mutator. */
function checkedMutator(slug: string, fn: Mutator): Mutator {
  return (doc, event) => {
    // TS's void-leniency lets an ASYNC mutator satisfy the sync Mutator type;
    // its late writes would land after the CAS write persisted — the same
    // lost-update class the backend guards against, at the API boundary.
    const r = fn(doc, event) as unknown;
    if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function') {
      throw new Error('mutator must be synchronous: an async mutator would apply changes after the revision-checked write');
    }
    // Backend-agnostic secrets enforcement: the mutator has fully applied its
    // change (events included); serialize and refuse BEFORE the backend
    // persists anything. Only the revision bump happens after this point, and
    // a bare integer cannot embed a secret value.
    assertNoSecretValues(JSON.stringify(doc, null, 2), loadSecrets(slug));
  };
}

export async function mutate(
  slug: string,
  expectedRevision: number,
  fn: Mutator,
): Promise<WorkstreamDoc> {
  return getStore().mutate(slug, expectedRevision, checkedMutator(slug, fn));
}

/**
 * Convenience for "external arrival" writes (steer, reply, clock-driven) that
 * don't care about a previously-read revision: read-modify-write on current.
 * Still bumps the revision, so an in-flight coordinator pass will conflict —
 * which is exactly the contract.
 *
 * expectedRevision is undefined: the backend serializes the whole
 * read-modify-write region (fs: the per-workstream write lock; a network
 * backend: its own transaction), so simultaneous arrivals from separate
 * processes all land without a spurious conflict.
 */
export async function arrive(slug: string, fn: Mutator): Promise<WorkstreamDoc> {
  return getStore().mutate(slug, undefined, checkedMutator(slug, fn));
}

export async function createWorkstream(
  core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>,
): Promise<WorkstreamDoc> {
  // Everything human-supplied in the initial doc (title, objective, tags,
  // constraints, criteria) comes from `core`; generated ids/timestamps cannot
  // carry a value — so asserting on the serialized core preserves the "no doc
  // write can persist a secret" guarantee for creation on every backend.
  assertNoSecretValues(JSON.stringify(core, null, 2), loadSecrets(core.slug));
  return getStore().create(core);
}

/**
 * Write deliverable content to artifact storage; returns {path, hash}.
 * Content is redacted against known secrets BEFORE hashing, so an artifact
 * can never carry a value and its pin always matches what is stored. Both
 * happen here, in the shared layer, so every backend inherits them.
 */
export async function writeArtifact(
  slug: string,
  fileName: string,
  rawContent: string,
): Promise<{ relPath: string; hash: string }> {
  const content = redactSecrets(rawContent, loadSecrets(slug));
  const hash = sha256(content);
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const relPath = `${hash.slice(0, 8)}-${safe}`;
  await getStore().writeArtifactRaw(slug, relPath, content);
  return { relPath, hash };
}

export async function readArtifact(slug: string, relPath: string): Promise<string> {
  return getStore().readArtifact(slug, relPath);
}

/** Verify a deliverable's stored content still matches a pinned hash. */
export async function verifyArtifact(slug: string, relPath: string, hash: string): Promise<boolean> {
  try {
    return sha256(await readArtifact(slug, relPath)) === hash;
  } catch {
    return false;
  }
}

/**
 * Cross-process tick exclusion for one workstream, delegated to the backend.
 * Null when another live process is ticking; otherwise an async release.
 */
export async function tryTickLock(slug: string): Promise<(() => Promise<void>) | null> {
  return getStore().tryTickLock(slug);
}
