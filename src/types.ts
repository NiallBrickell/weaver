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
  /** OS pid of the harness process driving this attempt: a dead pid means the
   * attempt is orphaned NOW — recovery need not wait out the stale horizon. */
  runnerPid?: number;
  model?: string;
  startedAt: Iso;
  endedAt?: Iso;
  costUsd?: number;
  terminalReason?: string;
  /** Provider-side outage/limit that ended this disposable attempt. The
   * assignment remains intended work and is retried after the typed wait. */
  infrastructure?: InfrastructureWait;
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
    /** 'human' = explicit keypress; 'pilot' = auto-approved by the operator's
     * pilot daemon (their standing approval policy engine) — same authority
     * source, since the human owns pilot's rules. */
    /** `actor` names WHO (WEAVER_ACTOR: the founder's username, an agent
     * session steering on their behalf, …) — 'by' says which authority path.
     * Durable so per-actor intervention load survives the event tail. */
    approval?: { by: 'human' | 'pilot'; at: Iso; note?: string; actor?: string };
    /** Human rejection of a gated action — the mirror of approval, kept
     * durable (state 'cancelled' alone dates and attributes nothing). */
    rejection?: { actor: string; at: Iso; reason: string };
    /** One-shot pilot verdict (approve or not) so a denial isn't re-asked
     * every tick; a denied action simply stays gated for the human. */
    pilotVerdict?: { decision: string; reason: string; at: Iso };
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
    /** Set on human adoption overrides only: when, and by which actor. */
    at?: Iso;
    actor?: string;
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
  /** Named actor behind the approval/rejection (WEAVER_ACTOR) — durable. */
  approvedByActor?: string;
  rejectedBy?: string;
  rejectedAt?: Iso;
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

export type CapacityCategory =
  | 'usage_limit'
  /** Persisted by Weaver versions that assumed a separate Agent SDK credit.
   * New writes use `usage_limit`; readers retain this value for continuity. */
  | 'sdk_credit_exhausted'
  | 'session_limit'
  | 'rate_limit'
  | 'auth'
  | 'other';

/** Closed on purpose: recovering capacity can never mean selecting, pooling,
 * or rotating accounts. Credentials stay in Claude Code, outside Weaver. */
export type InfrastructureRecovery =
  | 'wait_or_enable_usage_credits'
  /** Legacy persisted value; presentation must not repeat the stale claim flow. */
  | 'claim_sdk_credit_or_enable_usage_credits'
  | 'reauthenticate'
  | 'automatic_retry';

export interface InfrastructureWait {
  kind: CapacityCategory;
  recovery: InfrastructureRecovery;
  source: 'coordinator' | 'worker';
  sourceId: Id;
  model: string;
  detectedAt: Iso;
  retryAt: Iso;
  resetAt?: Iso;
  rateLimitType?: string;
}

export interface CapacityBackoff {
  wait: InfrastructureWait;
  consecutiveBackoffs: number;
  firstBackoffAtVirtual: Iso;
  lastBackoffAtVirtual: Iso;
}

/** Current provider capacity is a typed, model-indexed organizational fact.
 * The index matters because coordinator and worker models can recover at
 * different times; one scalar category would silently collapse that state. */
export interface CapacityState {
  state: 'backoff';
  byModel: Record<string, CapacityBackoff>;
}

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
  /** Typed provider wait. Human-readable `reason` is presentation only and
   * must never be parsed to decide recovery behavior. */
  infrastructure?: InfrastructureWait;
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
  kind: 'approval' | 'review' | 'blocker' | 'budget' | 'capacity';
  summary: string;
  /** Reference to the interaction/assignment/etc. this concerns. */
  refId?: Id;
  status: 'open' | 'resolved';
  createdAt: Iso;
  resolvedAt?: Iso;
  /** WHO resolved it (WEAVER_ACTOR) — durable, unlike the event summary. */
  resolvedBy?: string;
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
  infrastructure?: InfrastructureWait;
}

export interface EventRecord {
  at: Iso;
  atVirtual: Iso;
  type: string;
  summary: string;
  refs?: Id[];
}

/**
 * Exact before/after values written beside each organizational revision.
 * This journal is operator history, never coordinator input or authority.
 * Keeping the values (rather than only entity ids) preserves intermediate
 * facts such as a failed readback that is later replaced by a successful one.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PrintoutFieldDelta {
  /** JSON Pointer within the typed entity; '/' means the whole entity. */
  path: string;
  before?: JsonValue;
  after?: JsonValue;
}

export interface PrintoutChange {
  kind: 'workstream' | 'decision' | 'assignment' | 'deliverable' | 'interaction' |
    'observation' | 'wake' | 'steering' | 'attention' | 'pass' | 'spend' | 'capacity' | 'lease';
  /** Absent only for singleton workstream/spend/capacity/lease values. */
  id?: Id;
  /** Exact leaf deltas; growing arrays append one indexed value, not a full copy. */
  fields: PrintoutFieldDelta[];
}

export interface PrintoutMutationReceipt {
  revision: number;
  at: Iso;
  atVirtual: Iso;
  changes: PrintoutChange[];
  /** Supporting chronology only; the typed values above remain truth. */
  events: EventRecord[];
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
  /** Durable outcome claim and its cited typed evidence. The referenced facts
   * remain the authority; this prose cannot make an unverified act real. */
  conclusion?: {
    passId: Id;
    atVirtual: Iso;
    /** Coordinator account, informational; cited typed facts remain authority. */
    summary: string;
    /** Resolved at conclusion time to adopted/verified/standing typed facts. */
    evidenceIds: Id[];
  };
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
  spend: WorkstreamSpend;
  /** Typed source of truth for current Agent SDK capacity constraints. Old
   * documents may omit this additive field and are treated as recovered. */
  capacity?: CapacityState | null;
  /** Single-flight reconciliation lease. */
  lease: WorkstreamLease;
}

export interface WorkstreamSpend {
    coordinatorPasses: number;
    totalCostUsd: number;
    /** Human acts (steer/approve/adopt/reject/budget) — the numerator of the
     * interventions-per-successful-outcome metric the learning loop optimizes. */
    humanInterventions: number;
}

export type WorkstreamLease = { passId: Id; acquiredAt: Iso; expiresAt: Iso } | null;
