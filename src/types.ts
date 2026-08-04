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
  /** Learned policies this decision applies (attributable learning). */
  appliedPolicyIds?: Id[];
  decidedAtVirtual: Iso;
}

// ---------------------------------------------------------------------------
// Work

export type AssignmentKind =
  | 'research'
  | 'work_product'
  | 'communication_draft'
  | 'evidence'
  /** A real-world act (open a PR, run a CLI) — gated on human approval,
   * confirmed by deterministic readback, never by the worker's prose. */
  | 'action';

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
  /** Read-only resource handles: directories the worker may Read/Grep/Glob.
   * Workers stay side-effect-free — these grant sight, never mutation. */
  readDirs?: string[];
  /** Present only on kind 'action': the one place a worker touches the real
   * world. There is no channel adapter layer — the worker uses real CLIs
   * (git, gh, txb) via Bash inside cwd; Weaver's job is the gate before and
   * the readback after. `verify` is a shell command the ENGINE runs
   * deterministically (no model) whose exit status confirms the effect. */
  exec?: {
    cwd: string;
    verify: string;
    /** Plain-language decision summary FOR THE HUMAN: what approving allows,
     * why it's wanted, and the blast radius. Rendered as the approval card —
     * the briefing is for the worker, this is for the person. */
    ask?: string;
    /** When set (human-authored acts), the ENGINE runs this exact command
     * deterministically — no model in the execution loop. Same principle as
     * executeApprovedSends: once a human has decided, code executes. */
    run?: string;
    approval?: { by: 'human'; at: Iso };
    verified?: { ok: boolean; output: string; at: Iso };
  };
  acceptanceCriteria: string[];
  dependsOn: Id[];
  /** Work state — distinct from any worker run's own status. */
  state:
    | 'gated' // action awaiting human approval; can never run in this state
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
  /** Idempotency key for at-least-once external delivery; duplicates are no-ops. */
  ingressKey?: string;
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
  /** Idempotency key for at-least-once external delivery; duplicates are no-ops. */
  ingressKey?: string;
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
  /** Who performed the act: the founder at the keyboard vs an agent session
   * operating on their behalf (WEAVER_ACTOR). Both are authoritative human
   * direction; attribution keeps the intervention metric honest. */
  by?: string;
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
  /** Scope tags — learned policies match workstreams sharing at least one. */
  tags: string[];
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
  spend: {
    coordinatorPasses: number;
    totalCostUsd: number;
    /** Human acts (steer/approve/adopt/reject/budget) — the numerator of the
     * interventions-per-successful-outcome metric the learning loop optimizes. */
    humanInterventions: number;
  };
  /** Single-flight reconciliation lease. */
  lease: { passId: Id; acquiredAt: Iso; expiresAt: Iso } | null;
}
