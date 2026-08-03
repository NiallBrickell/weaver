/**
 * The Weaver domain schema — the typed state that IS the durable Workstream.
 *
 * Everything a fresh coordinator needs must be representable here; if a fact
 * only exists in a transcript, the state model is broken (kernel rule 2).
 */

export type Id = string;

/** ISO timestamps. `virtual` timestamps come from the demo clock (src/clock.ts). */
export type Iso = string;

// ---------------------------------------------------------------------------
// Direction

export interface Decision {
  id: Id;
  title: string;
  rationale: string;
  madeBy: 'coordinator' | 'human';
  passId?: Id;
  status: 'standing' | 'superseded';
  /** Lineage: which decision this one replaced, and which replaced it. */
  supersedes?: Id;
  supersededBy?: Id;
  /** Optional review boundary, e.g. "review if reply rate < 10% after 20 sends". */
  reviewWhen?: string;
  decidedAtVirtual: Iso;
}

// ---------------------------------------------------------------------------
// Work

export type AssignmentKind =
  | 'research'
  | 'work_product'
  | 'communication_draft'
  | 'evidence';

export interface Attempt {
  runId: Id;
  /** Agent SDK session id — provenance only, never read back for state. */
  sessionId?: string;
  model?: string;
  startedAt: Iso;
  endedAt?: Iso;
  costUsd?: number;
  terminalReason?: string;
}

export interface Assignment {
  id: Id;
  objective: string;
  /** Full brief handed to the worker — declared inputs, never a parent transcript. */
  briefing: string;
  kind: AssignmentKind;
  acceptanceCriteria: string[];
  dependsOn: Id[];
  /** Work state — distinct from any worker run's own status. */
  state:
    | 'queued'
    | 'running'
    | 'awaiting_review'
    | 'completed'
    | 'failed'
    | 'cancelled';
  attempts: Attempt[];
  submission?: {
    summary: string;
    deliverableId?: Id;
  };
  /** Adoption is a coordinator act, distinct from the worker finishing. */
  adoption: {
    state: 'none' | 'proposed' | 'accepted' | 'rejected' | 'superseded';
    passId?: Id;
    reason?: string;
  };
  createdInPass?: Id;
  createdAtVirtual: Iso;
}

// ---------------------------------------------------------------------------
// Deliverables

export interface Deliverable {
  id: Id;
  title: string;
  kind: string;
  /** Relative path under the workstream artifacts dir. */
  path: string;
  /** sha256 of content at creation. */
  contentHash: string;
  producedByAssignment?: Id;
  createdAtVirtual: Iso;
  /** Set at adoption: the pinned immutable revision. Absent = candidate only. */
  adopted?: {
    contentHash: string;
    passId: Id;
    atVirtual: Iso;
  };
}

// ---------------------------------------------------------------------------
// Interactions — draft, send, receipt, reply are separate facts.

export interface Reply {
  id: Id;
  from: string;
  body: string;
  receivedAtVirtual: Iso;
  /** A reply is untrusted input until a coordinator evaluates it. */
  evaluation?: {
    countsTowardObjective: boolean;
    note: string;
    passId: Id;
  };
}

export interface Interaction {
  id: Id;
  kind: 'email_send';
  to: string;
  subject: string;
  /** The draft being sent. */
  deliverableId: Id;
  /** Pinned at approval so the sent content cannot drift afterwards. */
  pinnedHash?: string;
  status:
    | 'awaiting_approval'
    | 'approved'
    | 'sent'
    | 'unknown' // crash after egress: readback required, never a re-send
    | 'confirmed' // provider readback confirmed the send
    | 'rejected';
  approvedBy?: 'human';
  approvedAt?: Iso;
  /** Provider-side reference discovered on send or readback. */
  externalRef?: string;
  sentAtVirtual?: Iso;
  requestedInPass?: Id;
  replies: Reply[];
}

// ---------------------------------------------------------------------------
// Results

export interface Observation {
  id: Id;
  source: string;
  summary: string;
  atVirtual: Iso;
  evaluation?: {
    countsTowardObjective: boolean;
    note: string;
    passId: Id;
  };
}

// ---------------------------------------------------------------------------
// Waits & inputs

export type WakeCondition =
  | { type: 'time'; dueAtVirtual: Iso }
  | { type: 'immediate' };

export interface Wake {
  id: Id;
  reason: string;
  condition: WakeCondition;
  status: 'pending' | 'fired' | 'cancelled';
  createdAt: Iso;
  firedInPass?: Id;
}

export interface Steering {
  id: Id;
  body: string;
  at: Iso;
  consumedByPass?: Id;
}

export interface AttentionItem {
  id: Id;
  kind: 'approval' | 'review' | 'blocker' | 'budget';
  summary: string;
  /** Reference to the interaction/assignment/etc. this concerns. */
  refId?: Id;
  status: 'open' | 'resolved';
  createdAt: Iso;
  resolvedAt?: Iso;
}

// ---------------------------------------------------------------------------
// Provenance

export interface PassRecord {
  id: Id;
  startedAt: Iso;
  endedAt?: Iso;
  baseRevision: number;
  wakeReasons: string[];
  model?: string;
  sessionId?: string;
  costUsd?: number;
  /** What the coordinator says it did — informational; typed state is truth. */
  summary?: string;
  changes: string[];
  outcome: 'completed' | 'error' | 'no_finish' | 'running';
}

export interface EventRecord {
  at: Iso;
  atVirtual: Iso;
  type: string;
  summary: string;
  refs?: Id[];
}

// ---------------------------------------------------------------------------
// The document

export interface WorkstreamCore {
  id: Id;
  slug: string;
  title: string;
  objective: string;
  successCriteria: string[];
  constraints: string[];
  autonomy: {
    /** Outbound sends always need human approval when true. */
    sendsRequireApproval: boolean;
  };
  budget: {
    maxCoordinatorPasses: number;
    maxCostUsd: number;
  };
  status: 'active' | 'paused' | 'done';
  createdAt: Iso;
}

export interface WorkstreamDoc {
  schemaVersion: 1;
  /** Bumped on every write; all writes are revision-checked (kernel rule 8). */
  revision: number;
  workstream: WorkstreamCore;
  decisions: Decision[];
  assignments: Assignment[];
  deliverables: Deliverable[];
  interactions: Interaction[];
  observations: Observation[];
  wakes: Wake[];
  steering: Steering[];
  attention: AttentionItem[];
  passes: PassRecord[];
  /** Bounded narrative tail — projection section 8. Never authoritative. */
  events: EventRecord[];
  spend: { coordinatorPasses: number; totalCostUsd: number };
  /** Single-flight reconciliation lease. */
  lease: { passId: Id; acquiredAt: Iso; expiresAt: Iso } | null;
}
