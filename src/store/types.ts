/**
 * The StateStore contract — the durable layer behind an async interface, so
 * every backend (fs, sqlite, postgres) implements the same semantics the fs
 * store proves. Everything backend-AGNOSTIC (secrets assertion, artifact
 * redaction + hashing, arrive's bounded retry) lives in src/store.ts, NOT in a
 * backend: a backend persists bytes and enforces the revision CAS; it never
 * owns policy.
 *
 * Contract every backend must honor:
 *  - `mutate` is the revision-checked write path: load the doc, compare the
 *    stored revision to `expectedRevision` and throw RevisionConflictError on
 *    mismatch, run the SYNCHRONOUS mutator on a fresh copy, bump the revision
 *    by exactly one, persist atomically. The `event` helper appends to the
 *    bounded narrative tail (cap 200). `expectedRevision: undefined` is an
 *    ARRIVAL: no revision check, but the backend must serialize the whole
 *    read-modify-write region (fs: per-workstream write lock; sqlite: the
 *    BEGIN IMMEDIATE database write lock; pg: a row lock inside the writing
 *    transaction), so simultaneous arrivals all land.
 *  - Every committed head carries its exact transition: the backend persists
 *    a printout mutation receipt (revision, changed fields, emitted events)
 *    to this machine's printout journal BEFORE the head write, so an
 *    interruption can leave an ignored future receipt but never a committed
 *    head whose transition is missing.
 *  - `tryTickLock` is cross-PROCESS tick exclusion for one workstream: null
 *    when a live holder exists, otherwise a release function. A dead holder's
 *    lock is stale and reclaimed.
 *  - `writeArtifactRaw` persists exactly the bytes given (redaction and
 *    hashing already happened in the shared layer — the relPath embeds the
 *    content hash, so the backend must not transform content).
 *  - `mutatePolicies` is the ONLY write path for the global policy store, and
 *    the backend must make its read-modify-write safe against concurrent
 *    writers (the store is global, so two remote runners can race it): run the
 *    SYNCHRONOUS mutator on current state, bump `store.revision` by exactly
 *    one, persist atomically, and on a concurrent write re-run the mutator
 *    against fresh state (bounded retry, same semantics as the shared layer's
 *    arrive()) rather than clobbering. There is no savePolicies — an
 *    unguarded whole-store write is exactly the lost-update hazard this
 *    method exists to close.
 */

// Type-only import: erased at compile time, so the runtime chain
// policies → store → store/fs → store/types stays acyclic.
import type { PolicyStore } from '../policies.js';
import type { EventRecord, WorkstreamCore, WorkstreamDoc } from '../types.js';

export type EventHelper = (type: string, summary: string, refs?: string[]) => void;

export type Mutator = (doc: WorkstreamDoc, event: EventHelper) => void;

/**
 * Two workstreams may never stand for the same external thing. Uniqueness on
 * `WorkstreamCore.sourceKey` is enforced ATOMICALLY inside each backend's
 * `create` (fs: a home-scoped create lock around a fail-loud scan; sqlite: the
 * BEGIN IMMEDIATE write lock around a json_extract lookup; pg: a partial UNIQUE
 * index) — never as a scan-then-create in a caller, which would race. The
 * shared layer translates this into a friendly message that names the existing
 * slug; a raw throw from a backend already names the key.
 */
export class SourceKeyConflictError extends Error {
  constructor(
    public readonly sourceKey: string,
    /** Set by the shared layer once it resolves which slug already holds it. */
    public readonly existingSlug?: string,
  ) {
    super(
      existingSlug
        ? `'${existingSlug}' already stands for ${sourceKey}`
        : `another workstream already stands for ${sourceKey}`,
    );
    this.name = 'SourceKeyConflictError';
  }
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

export interface StateStore {
  listWorkstreams(): Promise<string[]>;
  load(slug: string): Promise<WorkstreamDoc>;
  create(core: Omit<WorkstreamCore, 'id' | 'createdAt' | 'status'>): Promise<WorkstreamDoc>;
  /** undefined expectedRevision = serialized arrival (see contract above). */
  mutate(slug: string, expectedRevision: number | undefined, fn: Mutator): Promise<WorkstreamDoc>;
  /** Persist pre-redacted artifact bytes at relPath. Content must be stored verbatim. */
  writeArtifactRaw(slug: string, relPath: string, content: string): Promise<void>;
  readArtifact(slug: string, relPath: string): Promise<string>;
  loadPolicies(): Promise<PolicyStore>;
  /** Concurrency-safe read-modify-write of the global policy store; the
   * mutator may be re-run against fresh state after a conflicting write. */
  mutatePolicies(fn: (store: PolicyStore) => void): Promise<PolicyStore>;
  /** Cross-process tick exclusion; null when another live process holds it. */
  tryTickLock(slug: string): Promise<(() => Promise<void>) | null>;
  /** Move one workstream's whole stored identity to a new slug: the doc's
   * `workstream.slug`, its artifacts, and (fs) its state directory move
   * together, with a `workstream.renamed` event, a bumped revision, and a
   * printout receipt — the old name survives as lineage, never as state. The
   * backend must refuse an occupied target and a workstream whose tick lock a
   * live process holds (the tick lock covers the whole tick, workers included,
   * so everything in flight still references the old slug). Slug VALIDATION is
   * the shared layer's job (src/store.ts rename), not the backend's. */
  rename(oldSlug: string, newSlug: string): Promise<WorkstreamDoc>;
  /** Release held resources (connection pools). Optional: the fs backend has none. */
  close?(): Promise<void>;
}

export type { EventRecord, WorkstreamCore, WorkstreamDoc };
