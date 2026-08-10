/**
 * The workstream store: typed state with revision-checked writes, behind the
 * async StateStore interface (src/store/types.ts). Three backends, selected
 * via WEAVER_STORE (see getStore()): fs (the reference, zero setup), sqlite
 * (single local file), postgres (shared fleet).
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
import type { PolicyStore } from './policies.js';
import { assertNoSecretValues, loadSecrets, redactSecrets } from './secrets.js';
import { FsStore, artifactsDir, newId, printoutJournalDir, sha256, weaverHome, workstreamDir } from './store/fs.js';
import { PgStore } from './store/pg.js';
import { SqliteStore } from './store/sqlite.js';
import { RevisionConflictError, SourceKeyConflictError, type Mutator, type StateStore } from './store/types.js';
import type { WorkstreamCore, WorkstreamDoc } from './types.js';

export { artifactsDir, newId, printoutJournalDir, sha256, weaverHome, workstreamDir };
export { RevisionConflictError, SourceKeyConflictError };
export type { StateStore };

let activeStore: StateStore | undefined;

/**
 * The active backend, selected once per process by WEAVER_STORE:
 *   unset            → fs reference backend under WEAVER_HOME (zero setup)
 *   sqlite:<path>    → single-file local SQLite (real transactions, `~` ok)
 *   postgres(ql)://… → hosted Postgres (shared fleet)
 * Anything else falls back to fs.
 */
export function getStore(): StateStore {
  if (!activeStore) {
    const url = process.env.WEAVER_STORE;
    activeStore =
      url && /^postgres(ql)?:\/\//.test(url) ? new PgStore(url)
      : url?.startsWith('sqlite:') ? new SqliteStore(url.slice('sqlite:'.length))
      : new FsStore();
  }
  return activeStore;
}

/**
 * Release the active backend (close the Postgres pool / SQLite handle so a
 * finished process doesn't hang) and forget it, so the next getStore()
 * re-reads WEAVER_STORE — which is also what lets tests run the same contract
 * suite over every backend in one process.
 */
export async function closeStore(): Promise<void> {
  const s = activeStore;
  activeStore = undefined;
  await s?.close?.();
}

export async function listWorkstreams(): Promise<string[]> {
  return getStore().listWorkstreams();
}

export async function load(slug: string): Promise<WorkstreamDoc> {
  return getStore().load(slug);
}

/**
 * Direct children of one manager slug — a single-level scan, never resolved
 * transitively (kernel rule 1: flat identities, no trees). O(fleet) on the fs
 * backend; flagged as a fast-follow for the in-flight Postgres adapter to
 * index instead. Unreadable sibling docs are skipped, never thrown: one
 * corrupt workstream must not blind a manager to the rest of its fleet.
 */
export async function listManagedBy(managerSlug: string): Promise<{ slug: string; status: WorkstreamDoc['workstream']['status'] }[]> {
  const out: { slug: string; status: WorkstreamDoc['workstream']['status'] }[] = [];
  for (const slug of await listWorkstreams()) {
    let doc: WorkstreamDoc;
    try {
      doc = await load(slug);
    } catch {
      continue;
    }
    if (doc.workstream.managedBy?.slug === managerSlug) {
      out.push({ slug, status: doc.workstream.status });
    }
  }
  return out;
}

/**
 * The slug of the workstream already standing for an external thing, if one
 * exists. Intake is at-least-once — a repeated pass, a redelivered webhook, a
 * coordinator that simply looks again — so spawning is keyed on this rather
 * than on anyone remembering what they already created.
 */
export async function findBySourceKey(sourceKey: string): Promise<string | null> {
  for (const slug of await listWorkstreams()) {
    try {
      if ((await load(slug)).workstream.sourceKey === sourceKey) return slug;
    } catch {
      // A single unreadable document must not make an existing workstream
      // invisible to the dedupe — but it must not wedge intake either.
      continue;
    }
  }
  return null;}

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
    refuseAsyncMutator(fn(doc, event) as unknown);
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

/** TS's void-leniency lets an ASYNC mutator satisfy a sync mutator type; its
 * late writes would land after the CAS write persisted — the same lost-update
 * class the backends guard against, at the API boundary. Structural, so no
 * backend can inherit the hazard. */
function refuseAsyncMutator(r: unknown): void {
  if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function') {
    throw new Error('mutator must be synchronous: an async mutator would apply changes after the revision-checked write');
  }
}

/**
 * Convenience for "external arrival" writes (steer, reply, clock-driven) that
 * don't care about a previously-read revision: read-modify-write on current.
 * Still bumps the revision, so an in-flight coordinator pass will conflict —
 * which is exactly the contract.
 *
 * expectedRevision is undefined: the backend serializes the whole
 * read-modify-write region (fs: the per-workstream write lock; pg: a row
 * lock inside the writing transaction), so simultaneous arrivals from
 * separate processes — or machines — all land without a spurious conflict.
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
  try {
    return await getStore().create(core);
  } catch (e) {
    // The backend enforces source-key uniqueness atomically at the write (fs
    // create lock, sqlite BEGIN IMMEDIATE, pg partial unique index) — this is
    // NOT a pre-scan, so no race can slip a duplicate past it. Enrich the
    // conflict with the slug that already holds the key (best-effort lookup,
    // purely for the message) before re-throwing.
    if (e instanceof SourceKeyConflictError && core.sourceKey !== undefined) {
      const existing = await findBySourceKey(core.sourceKey);
      throw new SourceKeyConflictError(core.sourceKey, existing ?? undefined);
    }
    throw e;
  }
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

/**
 * The ONLY write path for the global policy store — a concurrency-safe
 * read-modify-write the backend serializes (fs: process lock; pg: revision
 * CAS with bounded retry, so the mutator may re-run against fresh state).
 * The same two backend-agnostic guards as doc writes apply here: an async
 * mutator is refused structurally, and the serialized store is refused if it
 * embeds a known secret VALUE (policy statements quote human interventions —
 * exactly where a pasted credential would otherwise fossilize; global secrets
 * only, since the policy store is not scoped to a workstream).
 */
export async function mutatePolicies(fn: (store: PolicyStore) => void): Promise<PolicyStore> {
  return getStore().mutatePolicies((store) => {
    refuseAsyncMutator(fn(store) as unknown);
    // Only the backend's revision bump happens after this point, and a bare
    // integer cannot embed a secret value.
    assertNoSecretValues(JSON.stringify(store, null, 2), loadSecrets());
  });
}
