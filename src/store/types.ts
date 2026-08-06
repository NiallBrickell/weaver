/**
 * The StateStore contract — the durable layer behind an async interface, so a
 * second backend (Postgres, PR 2) can implement the same semantics the fs
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
 *    read-modify-write region (fs: per-workstream write lock; a network
 *    backend: its transaction), so simultaneous arrivals all land.
 *  - Every committed head carries its exact transition: the backend persists
 *    a printout mutation receipt (revision, changed fields, emitted events)
 *    BEFORE the head write, so an interruption can leave an ignored future
 *    receipt but never a committed head whose transition is missing.
 *  - `tryTickLock` is cross-PROCESS tick exclusion for one workstream: null
 *    when a live holder exists, otherwise a release function. A dead holder's
 *    lock is stale and reclaimed.
 *  - `writeArtifactRaw` persists exactly the bytes given (redaction and
 *    hashing already happened in the shared layer — the relPath embeds the
 *    content hash, so the backend must not transform content).
 */

// Type-only import: erased at compile time, so the runtime chain
// policies → store → store/fs → store/types stays acyclic.
import type { PolicyMutationReceipt, PolicyStore } from '../policies.js';
import type { EventRecord, WorkstreamCore, WorkstreamDoc } from '../types.js';

export type EventHelper = (type: string, summary: string, refs?: string[]) => void;

export type Mutator = (doc: WorkstreamDoc, event: EventHelper) => void;

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
  /** Persist the policy head with its mutation receipt (receipt first). */
  savePolicies(store: PolicyStore, receipt: PolicyMutationReceipt): Promise<void>;
  /** Cross-process tick exclusion; null when another live process holds it. */
  tryTickLock(slug: string): Promise<(() => Promise<void>) | null>;
}

export type { EventRecord, WorkstreamCore, WorkstreamDoc };
