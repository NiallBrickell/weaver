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

/** Where a standing course is within its cycle. Position, never authority: cites typed facts; cannot adopt, complete, or conclude anything. */
export interface CourseProgress {
  cycle: number;
  step: number;
  label: string;
  /** Live assignments, active interactions, or open attention items the
   * course is waiting on — validated live when recorded. */
  awaitingIds: Id[];
  /** Adopted deliverables, readback-confirmed actions, or evaluated
   * observations/replies the position rests on — validated when recorded. */
  basisIds: Id[];
  next?: string;
  passId: Id;
  atVirtual: Iso;
  cycleStartedAtVirtual: Iso;
}

export interface Decision {
  id: Id;
  title: string;
  rationale: string;
  madeBy: 'coordinator' | 'human';
  passId?: Id;
  /** 'standing' = a live commitment. 'superseded' = replaced by a specific
   * successor decision (supersededBy) because the commitment itself changed.
   * 'closed' = retired without a successor — the honest state for a course
   * whose work is finished and nothing replaces it. A step or cycle advance
   * is neither: it is `progress` on the same standing course, updated in
   * place, so a routine's decision log does not grow by one commitment per
   * step. Only 'standing' decisions are authoritative; superseded/closed
   * survive as inspectable lineage. */
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
  /** Latest recorded position of this standing course (record_progress).
   * Overwritten in place; each update is journaled in printouts and the
   * `course.progress` event. Absent on courses that never recorded one. */
  progress?: CourseProgress;
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
    /** Physical-time retry boundary for the unavailable approval service.
     * Keeps recovery automatic without polling every gated action each tick. */
    pilotRetryAt?: Iso;
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
  /** Present when an engine-run probe produced this observation (src/probe.ts).
   * Provenance for the untrusted output, never authority: the full redacted
   * stdout is the artifact, the summary is a bounded line diff of it. */
  probe?: {
    /** The probe wake whose check changed and which this observation satisfied. */
    wakeId: Id;
    /** sha256 of the redacted stdout — also the artifact's content hash. */
    fingerprint: string;
    /** The baseline fingerprint the output changed from; absent on a first check. */
    previous?: string;
    /** Artifact path (under the workstream) holding the full redacted stdout. */
    artifactPath: string;
    /** Size of the redacted stdout in bytes. */
    bytes: number;
  };
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
  /** Present only on a wait this workstream BORROWED from the fleet: the slug
   * of the workstream whose own pass/attempt (`source`/`sourceId`) hit the
   * limit. A seat parked for one workstream is parked for every workstream,
   * so a stream about to launch on that exact target copies the active wait
   * instead of spending a doomed launch to rediscover it. The copy keeps the
   * source's detectedAt/retryAt, never counts as this stream's backoff, raises
   * no attention, and is released when the fleet no longer holds the wait. */
  observedIn?: string;
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

/** The exact shell a probe runs. Every field is part of the approved spec:
 * changing any of them is a different probe that needs a new approval. */
export interface ProbeSpec {
  /** Literal bash command the ENGINE runs verbatim, with no model in the loop.
   * It must print only stable facts: any byte difference wakes the stream. */
  command: string;
  /** Absolute working directory the command runs in. */
  cwd: string;
  /** Cadence in wall-clock seconds (minimum 300), on the grid anchored at
   * `firstCheckAt`. */
  everySeconds: number;
  /** Exact named credentials injected as environment variables, resolved
   * immediately before each run and limited to WEAVER_PROBE_CREDENTIALS. */
  credentialNames?: string[];
  /** When true, the run also receives a GitHub App READ token for the repo
   * resolved from `cwd` — never a write token. */
  githubRead?: boolean;
}

export type WakeCondition =
  | { type: 'time'; dueAtVirtual: Iso }
  | { type: 'wall_time'; dueAt: Iso }
  | { type: 'immediate' }
  /** An engine-run check of external state that wakes the workstream only
   * when its output changes (src/probe.ts). An unsatisfied probe is never due;
   * a check that finds new output records one untrusted Observation, sets
   * `satisfiedBy` (which makes this wake due for one coalesced pass), and
   * re-arms a successor probe carrying the new baseline. Checks that find
   * nothing new write only the probe cursor, never this document. */
  | {
      type: 'probe';
      /** What the engine runs; immutable for the life of this wake. */
      spec: ProbeSpec;
      /** sha256 of the canonical spec (probeSpecHash). Approval pins this
       * value, and eligibility recomputes it from `spec` before every run. */
      specHash: string;
      /** Wall-clock anchor of the cadence grid and the first check time, so a
       * daily probe can land at a chosen hour. */
      firstCheckAt: Iso;
      /** Fingerprint of the output the previous probe fired on. Absent on the
       * first probe of a watch: its first successful check fires once. */
      baseline?: string;
      /** Which authority cleared this exact spec. Absent = inert: the engine
       * never runs a probe whose approval does not pin the current specHash. */
      approval?: { by: 'pilot' | 'human'; at: Iso; specHash: string; actor?: string };
      /** One-shot Pilot verdict, so a deny/ask is not re-asked every tick; a
       * non-approve verdict leaves the probe inert for the human card. */
      pilotVerdict?: { decision: string; reason: string; at: Iso };
      /** Physical-time retry boundary while Pilot is unreachable. */
      pilotRetryAt?: Iso;
      /** Human rejection of this probe's approval card — the mirror of
       * approval, kept durable (status 'cancelled' alone attributes nothing). */
      rejection?: { actor: string; at: Iso; reason: string };
      /** The Observation that recorded changed output. Set once; it makes
       * this wake due and retires it from checking. */
      satisfiedBy?: Id;
      /** Set once when checks keep failing (third consecutive failure) or
       * cannot start (missing/unallowed credential, bad cwd), together with
       * one immediate wake so the coordinator can repair the probe. Later
       * failures write nothing; the next successful check clears it. */
      error?: { since: Iso; failures: number; excerpt: string };
    };

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

/**
 * An outside-world fact whose truth makes a needs-you card moot. Typed state
 * the COORDINATOR declared at raise time (or the harness declared on its own
 * capacity cards) — never parsed from the card's prose. The runner reads each
 * fact back from its provider; only an exact typed answer closes a card, and
 * an error or an unknown answer leaves it open.
 *
 * - `github_pr_state` — the PR `repo#number` (repo is `owner/name`) reached one
 *   of `states`, read back with the host's GitHub App READ token.
 * - `sentry_issue_status` — Sentry issue `shortId` in organization `org` reached
 *   one of `statuses`, read back with the executor-only
 *   `WEAVER_SENTRY_READ_TOKEN`.
 * - `capacity_target_unblocked` — harness-owned: the exact provider target the
 *   card was raised for works again for that role. Read from typed state (the
 *   fleet recovery ledger and recorded passes/attempts), never probed.
 */
export type ExternalFact =
  | { kind: 'github_pr_state'; repo: string /* owner/name */; number: number; states: Array<'MERGED' | 'CLOSED'> }
  | { kind: 'sentry_issue_status'; org: string; shortId: string; statuses: Array<'resolved' | 'ignored'> }
  | { kind: 'capacity_target_unblocked'; role: 'coordinator' | 'worker'; target: { executor: string; provider: string; model: string } };

/** One read-back observation that proved a declared fact true. */
export interface ExternalFactEvidence {
  fact: ExternalFact;
  /** What the provider (or typed state) reported, e.g. `MERGED at 2026-09-18T12:26:00Z`. */
  observed: string;
  url?: string;
  at: Iso;
}

export interface AttentionItem {
  id: Id;
  kind: 'approval' | 'review' | 'blocker' | 'budget' | 'capacity';
  summary: string;
  /** Reference to the interaction/assignment/etc. this concerns. Internal
   * only — an external thing the card waits on is a typed `resolvesWhen` fact. */
  refId?: Id;
  status: 'open' | 'resolved';
  createdAt: Iso;
  resolvedAt?: Iso;
  /** WHO resolved it (WEAVER_ACTOR) — durable, unlike the event summary.
   * System actors (pilot, coordinator, worker, fleet-capacity, capacity-probe,
   * and every `engine:*`) are never human interventions — see stats.ts. */
  resolvedBy?: string;
  /** The card is moot as soon as ANY of these external facts holds. Declared
   * as typed state when the card is raised; the runner's readback sweep
   * (attentionReadback.ts) checks them and closes the card with evidence.
   * Absent means only a human, the coordinator, or the act the card asks for
   * can close it. Prose that merely mentions a PR never binds a card. */
  resolvesWhen?: { any: ExternalFact[] };
  /** How the harness closed the card from facts, with the exact facts observed
   * true: `engine:readback` read a declared external fact back from its
   * provider; `engine:capacity-recovered` found typed proof that a capacity
   * card's ask is moot (its target works again, or the role's work flows). */
  resolution?: { by: 'engine:readback' | 'engine:capacity-recovered'; evidence: ExternalFactEvidence[] };
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
  /** Exact execution host that claimed this coordinator pass. */
  runnerId?: string;
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
  /** Exact execution host for every Assignment this Workstream creates.
   * This is a durable resource constraint, not a model choice or authority
   * grant. The human placement act also reconciles safe pending work to it. */
  assignmentRunnerId?: string;
  /** Human-owned physical execution preference for coordinator passes. The
   * first runner with a fresh shared heartbeat owns reconciliation; later
   * runners are warm standbys. Omitted preserves ordinary fleet-wide claims.
   * Worker placement remains Assignment.runnerId and is independent. */
  executionPolicy?: {
    coordinatorRunnerOrder: string[];
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

export type WorkstreamLease = { passId: Id; runnerId?: string; acquiredAt: Iso; expiresAt: Iso } | null;
