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
  /** 'standing' = a live commitment. 'superseded' = replaced by a specific
   * successor decision (supersededBy). 'closed' = retired without a successor
   * — the honest state for a routine's per-cycle course once the cycle ends,
   * so cycle history does not pile up forever as fake standing commitments.
   * Only 'standing' decisions are authoritative or count as conclusion
   * evidence; superseded/closed survive as inspectable lineage. */
  status: 'standing' | 'superseded' | 'closed';
  /** Lineage: which decision this one replaced, and which replaced it. */
  supersedes?: Id;
  supersededBy?: Id;
  /** Why a decision was closed (retired without a successor). */
  closedReason?: string;
  /** Optional review boundary, e.g. "review if reply rate < 10% after 20 sends". */
  reviewWhen?: string;
  /** Learned policies this decision applies (attributable learning). */
  appliedPolicyIds?: Id[];
  decidedAtVirtual: Iso;
}

// ---------------------------------------------------------------------------
// Work

/**
 * A worker does one of two things, and only this distinction has runtime teeth
 * (everything branches on `=== 'action'`):
 *
 * - `work` — bounded, reversible work that PROPOSES a result. Full ordinary
 *   toolset, including every configured MCP server used freely READ and WRITE:
 *   keeping the systems the brief names in sync (a tracker's status, a comment,
 *   a label) is work, not a privileged effect. No gate, no allow-list.
 * - `action` — one specific, human-approved, Pilot-supervised, readback-verified
 *   irreversible egress to the outside world: a message to a person, a spend, a
 *   merge/deploy/push. Confirmed by deterministic readback, never by prose.
 *
 * Earlier revisions split the reversible side into research/work_product/
 * evidence/communication_draft; nothing ever branched on those labels, so they
 * were needless surface. Legacy stored docs may still carry them — code treats
 * any non-`action` kind as `work`, so no migration is required.
 */
export type AssignmentKind = 'work' | 'action';

/** Closed, durable requirements the coordinator may declare without choosing
 * a provider. Routing reads these typed facts; it never guesses capability
 * needs from briefing prose. A value with no reviewed route today (see
 * docs/execution-profiles.md) is forward-declared route scope: routes bind to
 * exactly this declaration when an eval cohort earns one, so history carries
 * the scope. No route binds to `general` — a registry convention the
 * registry auditor test enforces (routing code itself would accept it). */
export type AssignmentExecutionProfile =
  | 'general'
  | 'bounded-code-repair'
  | 'evidence-synthesis'
  | 'ui-build';

export type AssignmentInputModality = 'text' | 'image';

/** How demanding the work is, as a typed requirement — never a model name.
 * `high` marks work whose acceptance depends on deep multi-file reasoning,
 * design judgment, or hard debugging; routing may seat it on the operator's
 * configured complex-tier model. Absent means standard. */
export type AssignmentExecutionComplexity = 'standard' | 'high';

/** Whether an approved action's verifier is also a pre-execution idempotency
 * check. Most actions use the default `postcondition` mode: an already-true
 * verifier proves the intended external effect exists, so execution is
 * skipped. `always-execute` is only for deterministic engine commands whose
 * current observation/output is itself the result; approval and the ordinary
 * one-shot execution + readback lifecycle still apply unchanged. */
export type ActionPreflightMode = 'postcondition' | 'always-execute';

export interface AssignmentExecutionRequirements {
  profile: AssignmentExecutionProfile;
  modalities: AssignmentInputModality[];
  complexity?: AssignmentExecutionComplexity;
}

export interface Attempt {
  runId: Id;
  /** Agent SDK session id — provenance only, never read back for state. */
  sessionId?: string;
  /** OS pid of the harness process driving this attempt: a dead pid means the
   * attempt is orphaned NOW — recovery need not wait out the stale horizon. */
  runnerPid?: number;
  /** Exact execution host that claimed this attempt. Optional on legacy
   * records; unlike runnerPid it is meaningful across a shared fleet. */
  runnerId?: string;
  /** Exact disposable target for this attempt. Optional on legacy records. */
  executor?: string;
  provider?: string;
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
  /** Capability requirements survive replacement; the selected model does
   * not. Legacy/omitted requirements mean general text work. */
  executionRequirements?: AssignmentExecutionRequirements;
  /** Optional exact execution-host placement. Intended work stays queued on
   * every other runner; absence preserves the fleet-wide scheduling default. */
  runnerId?: string;
  /** Credential names explicitly selected for an ordinary work attempt.
   * Values never enter typed state; the worker resolves this exact subset
   * from the applicable global/workstream secret store immediately before
   * launch. Actions retain their existing all-applicable-secrets lifecycle. */
  credentialNames?: string[];
  /** Project/source directories supplied as worker context. The first is the
   * cwd; the legacy field name is retained for stored-state compatibility. */
  readDirs?: string[];
  /** Present only on kind 'action': the durable lifecycle for an intentional
   * external effect. The worker uses normal CLIs and MCPs; Weaver supplies the
   * gate before and readback after. `verify` is a shell command the ENGINE
   * runs deterministically (no model) whose exit status confirms the effect. */
  exec?: {
    cwd: string;
    verify: string;
    /** Absent/`postcondition` runs verify before execution and skips when it
     * already succeeds. `always-execute` suppresses only that preflight read;
     * it is valid solely with an exact deterministic `run` command. */
    preflightMode?: ActionPreflightMode;
    /** Which durable authority may clear this action's gate. Legacy records
     * omit the field and retain the original pilot-or-human behavior. */
    approvalMode?: 'pilot-or-human' | 'human-only';
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
    /** `actor` names WHO (WEAVER_ACTOR: the human's username, an agent
     * session steering on their behalf, …) — 'by' says which authority path.
     * Durable so per-actor intervention load survives the event tail. */
    approval?: { by: 'human' | 'pilot'; at: Iso; note?: string; actor?: string };
    /** Human rejection of a gated action — the mirror of approval, kept
     * durable (state 'cancelled' alone dates and attributes nothing). */
    rejection?: { actor: string; at: Iso; reason: string };
    /** One-shot pilot verdict (approve or not) so a denial isn't re-asked
     * every tick; a denied action simply stays gated for the human. */
    pilotVerdict?: { decision: string; reason: string; at: Iso };
    /** First failed Pilot contact for this gate. A sustained outage eventually
     * opens a human card; a transient outage remains internal retry state. */
    pilotUnavailableSince?: Iso;
    verified?: { ok: boolean; output: string; at: Iso };
  };
  acceptanceCriteria: string[];
  dependsOn: Id[];
  /** Work state — distinct from any worker run's own status. */
  state:
    | 'gated' // action awaiting Pilot or human approval; can never run in this state
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
    /** A hard-wall checkpoint is inspectable recovery evidence, never a
     * complete result. Legacy/absent means a normal complete submission. */
    completeness?: 'complete' | 'checkpoint';
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
    | 'sending' // egress claimed: linearized against rejection; a stale one is resolved by readback, never re-sent
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
  /** The disposable execution substrate and upstream provider that produced
   * this wait. Absent on documents written before provider-scoped capacity;
   * legacy coordinator waits are known to be local Anthropic SDK waits, while
   * legacy worker waits deliberately remain ambiguous. */
  executor?: string;
  provider?: string;
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

/** Current provider capacity is a typed execution-target organizational fact.
 * Executor + provider + model matter because equal model labels can refer to
 * different pools; one scalar category would silently collapse that state. */
export interface CapacityState {
  state: 'backoff';
  /** Historical field name. New entries are keyed by executor/provider/model;
   * readers inspect the typed wait rather than interpreting this key. */
  byModel: Record<string, CapacityBackoff>;
}

/** A provider-reported plan window observed inside a disposable run. This is
 * glanceable telemetry, never an execution gate: not every executor/provider
 * reports it, and an observation can become stale between runs. */
export interface ProviderCapacityObservation {
  executor: string;
  provider: string;
  model: string;
  window: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Fraction used, 0..1. Absent when the provider did not report it. */
  utilization?: number;
  observedAt: Iso;
  resetAt?: Iso;
}

export type WakeCondition =
  | { type: 'time'; dueAtVirtual: Iso }
  | { type: 'wall_time'; dueAt: Iso }
  | { type: 'immediate' };

export interface Wake {
  id: Id;
  reason: string;
  condition: WakeCondition;
  status: 'pending' | 'fired' | 'cancelled';
  createdAt: Iso;
  firedInPass?: Id;
  /** Exact organizational commitment this ordinary scheduled check serves.
   * Harness-owned and legacy wakes omit it and cannot be individually retired
   * by a coordinator. Never infer it from `reason`. */
  organizationalCourseId?: Id;
  /** Typed coordinator-authored cancellation proof. Harness-owned
   * cancellations do not manufacture this field. */
  coordinatorCancellation?:
    | { kind: 'course-retired'; passId: Id; reason: string; basisIds: Id[] }
    | { kind: 'workstream-concluded'; passId: Id };
  /** Typed provider wait. Human-readable `reason` is presentation only and
   * must never be parsed to decide recovery behavior. */
  infrastructure?: InfrastructureWait;
  /** Harness-owned rolling runaway guard. Unlike the legacy lifetime dollar
   * cap, this is a typed temporary wait: no billing claim, no human top-up,
   * and the stored wake resumes the workstream when the window reopens. */
  executionSafety?: {
    blockedUntil: Iso;
    observedStarts: number;
    limit: number;
    windowSeconds: number;
  };
}

export interface Steering {
  id: Id;
  body: string;
  /** Who performed the act: the human at the keyboard vs an agent session
   * operating on their behalf (WEAVER_ACTOR). Both are authoritative human
   * direction; attribution keeps the intervention metric honest. */
  by?: string;
  at: Iso;
  consumedByPass?: Id;
  /**
   * Withdrawn before any pass read it. Typing a steer is the fastest way to
   * change a stream's course and therefore the fastest way to send it the
   * wrong one — a message written against a stale picture, or one that says
   * something a single workstream cannot act on (it can see only itself, never
   * the fleet). A withdrawn steer stops reaching the coordinator but stays on
   * the record: what a human tried to say is history, not a mistake to erase.
   * Only unconsumed steering can be withdrawn; once a pass has acted on it,
   * the way back is another steer.
   */
  revokedAt?: Iso;
  revokedBy?: string;
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
  /** Exact disposable coordinator target. Optional on legacy records. */
  executor?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  costUsd?: number;
  /** What the coordinator says it did — informational; typed state is truth. */
  summary?: string;
  changes: string[];
  /** 'conflicted' = finish_pass lost its revision-checked write to a concurrent
   * arrival. It is NOT a completion (no summary landed, steering stayed
   * unconsumed) and NOT a logical failure (the revision check working as
   * designed) — a fresh pass reconciles from the newer state. */
  outcome: 'completed' | 'error' | 'no_finish' | 'running' | 'conflicted';
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
    'observation' | 'wake' | 'steering' | 'attention' | 'pass' | 'manager_direction' |
    'manager_notice' | 'spend' | 'capacity' | 'lease';
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

/**
 * Set once at creation, immutable thereafter. The single source of truth for
 * a managed-workstream link — the manager's OWN doc stores no mirrored
 * "manages" array; `listManagedBy` (store.ts) derives that by scanning. Flat
 * by design: each doc renders only its own single pointer and its own
 * single-level `listManagedBy` scan, never a resolved chain (kernel rule 1).
 */
export interface ManagedBy {
  slug: Id;
  sinceVirtual: Iso;
}

/**
 * Durable input from a managing workstream to one it manages — NOT Steering
 * (kernel rule 9): must never touch spend.humanInterventions, and must
 * render distinctly (projection §6) so a coordinator can't mistake it for
 * human authority. Advisory text only; it grants no authority over the
 * receiving workstream's assignments, execution safety, constraints, or approvals.
 */
export interface ManagerDirection {
  id: Id;
  fromWorkstreamSlug: Id;
  body: string;
  atVirtual: Iso;
  consumedByPass?: Id;
}

/**
 * Idempotent cross-workstream notice, lives on the RECEIVING (manager) doc.
 * `dedupKey` makes a duplicate insert a no-op — the same shape as
 * `Reply.ingressKey`/`Observation.ingressKey` — so re-derivation from durable
 * facts (conclusion, open attention) on every delivery attempt is safe to
 * repeat after a crash.
 */
export interface ManagerNotice {
  id: Id;
  dedupKey: string;
  kind: 'finished' | 'needs_attention';
  fromWorkstreamSlug: Id;
  summary: string;
  /** Conclusion passId, or the source attention item's id. */
  refId?: Id;
  receivedAtVirtual: Iso;
}

export interface WorkstreamCore {
  id: Id;
  slug: string;
  title: string;
  objective: string;
  /** Scope tags — learned policies match workstreams sharing at least one. */
  tags: string[];
  /** Stable identity of the external thing this workstream exists for, e.g.
   * `linear:<issue-uuid>`. It is the idempotency key for spawning: intake is
   * at-least-once by nature, so "has this already become a workstream?" must
   * be answerable from typed state rather than from a model's recollection. */
  sourceKey?: string;
  successCriteria: string[];
  constraints: string[];
  autonomy: {
    /** Outbound sends always need human approval when true. */
    sendsRequireApproval: boolean;
  };
  /** Harness-owned model-start rate limit. Fresh workstreams persist it;
   * legacy documents without it use the fixed safe defaults. */
  executionSafety?: {
    windowSeconds: number;
    maxModelStarts: number;
  };
  /** @deprecated Historical lifetime caps remain readable for state and
   * printout lineage, but are never consulted for execution eligibility. */
  budget?: {
    maxCoordinatorPasses: number;
    maxCostUsd: number;
  };
  status: 'active' | 'paused' | 'done';
  /**
   * Which streams get the runner's slots when there are more due streams than
   * slots. The runner is otherwise strictly fair — least-recently-ticked
   * first — which is right when everything matters equally and wrong on the
   * evening one client's amendments matter more than sixteen background
   * sweeps. Fairness then means the urgent stream waits its turn behind them.
   *
   * Set by a human (`weaver priority`), never by a coordinator: a workstream
   * can see only itself, so nothing inside one is in a position to judge what
   * it should outrank. Absent means 'normal'. Ordering is by priority first,
   * then the same least-recently-ticked fairness WITHIN a priority — so a
   * high-priority stream never starves its peers, and 'low' still runs
   * whenever the fleet is not saturated.
   *
   * Ordering alone only decided who went first, which left the ranked stream
   * doing its work on a machine every other due stream was ticking on, so a
   * due 'high' band now also reserves most of the runner's slot budget
   * (`allocateSlots`). The rest of the fleet keeps a floor of slots, never
   * zero: 'low' still progresses while high work is in flight, just slowly.
   */
  priority?: 'high' | 'normal' | 'low';
  /** Set only by create_workstream; absent means unmanaged. */
  managedBy?: ManagedBy;
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
  /** Typed source of truth for current provider capacity constraints. Old
   * documents may omit this additive field and are treated as recovered. */
  capacity?: CapacityState | null;
  /** Latest provider-reported plan-window observations. Missing means unknown,
   * never unlimited; unsupported executors do not manufacture a percentage. */
  providerCapacity?: ProviderCapacityObservation[];
  /** Single-flight reconciliation lease. */
  lease: WorkstreamLease;
  /** Directions received FROM this workstream's manager (if any). Additive:
   * old documents may omit it and are treated as having none. */
  managerDirections?: ManagerDirection[];
  /** Notices received from workstreams THIS workstream manages. Additive:
   * old documents may omit it and are treated as having none. */
  managerNotices?: ManagerNotice[];
}

export interface WorkstreamSpend {
    coordinatorPasses: number;
    totalCostUsd: number;
    /** Human acts (steer/approve/adopt/reject/config) — the numerator of the
     * interventions-per-successful-outcome metric the learning loop optimizes. */
    humanInterventions: number;
}

export type WorkstreamLease = { passId: Id; acquiredAt: Iso; expiresAt: Iso } | null;
