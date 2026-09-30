/**
 * `weaver ui` — a private, live browser adapter over durable Workstream state.
 *
 * This process owns no agent loop and no organizational truth. It stores team
 * intake deterministically, records follow-up messages as untrusted
 * Observations, and server-renders the same typed projections as the static
 * inspector. A resident `weaver run` process remains responsible for moving
 * work forward.
 *
 * The UI intentionally has no steering, approval, adoption, merge, deploy, or
 * send route. A teammate can ask Weaver to own work and can supply evidence;
 * they cannot acquire the operator's authority by reaching this server.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { userInfo } from 'node:os';

import type {
  ClerkBrowserAssets,
  ClerkOperatorAuthenticator,
} from './clerkOperatorAuth.js';
import { virtualNow } from './clock.js';
import { liveRunnerIds } from './coordinatorRunner.js';
import {
  FLEET_ATTENTION_STEWARD_SOURCE_KEY,
  fleetAttentionEvidence,
  fleetIncidents,
  isFleetAttentionSteward,
  routineSchedule,
} from './fleetHealth.js';
import {
  createOrGetFleetAttentionStewardWorkstream,
  createOrGetWorkstream,
  recordObservation,
} from './ingress.js';
import { AlreadyConcludedError, closeWorkstream } from './humanActs.js';
import { ManagedWorkstreamError } from './managedWorkstreams.js';
import { NeedResponseError, needVersion, recordNeedResponse } from './needResponses.js';
import { API_PREFIX, WorkstreamIndex, createRestApi, restApiTokensFromEnv, type RestApiHandler, type RestApiTokens } from './restApi.js';
import { needNotifierFromEnv } from './notify/notifier.js';
import { deriveFallback, loadHouse } from './onboard.js';
import { computeOverview, revisionMemo, type OverviewPayload } from './overview.js';
import { loadPolicies, type PolicyRecord } from './policies.js';
import { computeStats, type StatsPayload } from './stats.js';
import { DEFAULT_TIMELINE_LIMIT, workstreamTimeline } from './timeline.js';
import { liveRunnerPid, runnerLoopHealthy, runnerSourceStale } from './runner.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import {
  arrive,
  listWorkstreams,
  listWorkstreamHeads,
  listRunnerPresence,
  load,
  readArtifact,
  RevisionConflictError,
  sha256,
  verifyArtifact,
  type RunnerPresence,
  type WorkstreamHead,
} from './store.js';
import type { WorkstreamDoc } from './types.js';
import { assertRunnerId } from './runnerIdentity.js';
import {
  fleetBoard,
  fleetGlance,
  fleetNeeds,
  fleetRunnerLine,
  isFleetBucket,
  workstreamPage,
  type FleetBoardView,
  type FleetGlanceView,
  type ManagedWorkstreamLink,
  type WorkstreamCardView,
} from './ui/inspect/model.js';
import {
  renderOperatorBoardHtml,
  renderOperatorClerkAuthHtml,
  renderOperatorClerkKeepAliveHtml,
  OPERATOR_KEEPALIVE_FRAME,
  renderOperatorFleetHtml,
  renderOperatorOverviewHtml,
  renderOperatorNewHtml,
  renderOperatorPoliciesHtml,
  renderOperatorAnalyticsHtml,
  renderOperatorWorkspaceHtml,
  type OperatorFleetView,
  DEFAULT_WORKSPACE_TAB,
  type WorkspaceTab,
} from './ui/operator/render.js';

export interface OperatorUiOptions {
  host?: string;
  port?: number;
  /** Shared password for HTTP Basic auth. The username is a caller-supplied provenance label. */
  token?: string;
  /** Exclusive hosted auth mode. When present, the Basic token is ignored. */
  clerk?: ClerkOperatorAuthenticator;
  /** Bearer tokens for the `/api/v1/` JSON API (src/restApi.ts). Defaults to
   * WEAVER_READ_TOKEN / WEAVER_RESPOND_TOKEN; unset tokens are disabled. */
  apiTokens?: RestApiTokens;
  /** Run the APNs need notifier (src/notify/notifier.ts) in this process.
   * `weaver ui` turns it on; it stays disabled, with one logged reason, when
   * the WEAVER_APNS_* settings are incomplete. Off by default, so a test
   * that embeds the workspace can never reach Apple. */
  notifications?: boolean;
}

export interface RunningOperatorUi {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export interface TeamIntakeRequest {
  message: string;
  done?: string;
  requestId: string;
  actor: string;
  /** Optional parent slug: create under an existing active Workstream. */
  under?: string;
  /** Exact physical host for the entire newly created Workstream. Omit for
   * automatic fleet placement. */
  runnerId?: string;
}

export interface TeamIntakeResult {
  slug: string;
  created: boolean;
}

interface LoadedFleet {
  docs: WorkstreamDoc[];
  unreadable: string[];
  managed: Map<string, ManagedWorkstreamLink[]>;
  view: OperatorFleetView;
  presences: RunnerPresence[];
  policies: PolicyRecord[];
}

type OverviewSource = () => Promise<{ fleet: LoadedFleet; overview: OverviewPayload; stats: StatsPayload }>;

/**
 * The overview reads every document, like the board, so it must not add a
 * second full-fleet load per view. It reuses the board's single loadFleet()
 * and keeps the result until the cheap head-only revision probe changes: any
 * number of viewers within one revision cost one fleet load. The key is the
 * revision loadFleet itself observed, so a write that lands mid-load is a miss
 * on the next view rather than a stale hit. The policies and analytics pages
 * read the same memo: `computeStats` is the one implementation behind
 * `weaver stats`, run once per revision here rather than once per view.
 */
function overviewSource(): OverviewSource {
  return revisionMemo(
    () => currentFleetRevision(),
    async () => {
      const fleet = await loadFleet();
      return {
        revision: fleet.view.revision,
        // The board's own glance, so the overview's job counts match the
        // board tiles and sidebar exactly.
        value: {
          fleet,
          overview: computeOverview(fleet.docs, fleet.policies, new Date(), fleet.view.glance),
          stats: computeStats(fleet.docs, fleet.policies, new Date()),
        },
      };
    },
  );
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGE_LENGTH = 50_000;
const LIVE_REVISION_POLL_MS = 2_000;
const LIVE_HEARTBEAT_MS = 15_000;
const LIVE_CONNECTION_MS = 5 * 60_000;
const PRESENTATION_TICK_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** Runners heartbeat roughly every 5s (runner.ts's default poll interval). A
 * fleet whose freshest non-degraded heartbeat is older than this — 60x that
 * cadence, well past any GC pause or transient network blip — has genuinely
 * stopped dispatching, not just missed one tick. Used only by the
 * unauthenticated `/healthz/fleet` external-monitor probe below. */
export const FLEET_HEALTH_STALE_SECONDS = 300;
export { FLEET_ATTENTION_STEWARD_SOURCE_KEY } from './fleetHealth.js';

class OperatorUiHttpError extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
  }
}

function safeActor(value: string): string {
  const actor = value.replace(/[\r\n\0]/g, '').trim().slice(0, 80);
  return actor || 'teammate';
}

function workspaceTab(value: string | null): WorkspaceTab {
  return value === 'overview' || value === 'work' || value === 'activity' || value === 'details' ? value : DEFAULT_WORKSPACE_TAB;
}

function sourceKeyFor(message: string, requestId: string): string {
  // A source URL names intended work across browser retries. Hash it so a URL
  // containing a private query token never becomes fleet metadata. Without a
  // URL, the form's stable request id makes an accidental resubmit idempotent.
  const sourceUrl = message.match(/https?:\/\/[^\s<>()\]"']+/i)?.[0];
  if (sourceUrl) return `ui:url:${sha256(sourceUrl).slice(0, 32)}`;
  return `ui:request:${sha256(requestId).slice(0, 32)}`;
}

/**
 * Store one team request without any model dependency. Refinement is a later
 * coordinator concern; provider exhaustion can never lose or delay intake.
 */
export async function createTeamWorkstream(req: TeamIntakeRequest): Promise<TeamIntakeResult> {
  const message = req.message.trim();
  const done = req.done?.trim();
  const requestId = req.requestId.trim();
  const runnerId = req.runnerId?.trim() || undefined;
  if (!message) throw new Error('What needs doing is required');
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`What needs doing must be at most ${MAX_MESSAGE_LENGTH} characters`);
  if (!requestId || requestId.length > 200) throw new Error('request_id is required');
  if (runnerId !== undefined) assertRunnerId(runnerId, 'runner id');

  const slugs = await listWorkstreams();
  const derived = deriveFallback(message, new Set(slugs), done);
  const house = loadHouse();
  // Browser intake cannot depend on a model pass, but a terse report still
  // needs the execution host's existing repository map to survive the wait.
  // Keep the reporter's words intact and append the operator-owned machine
  // context deterministically; the coordinator may then name only directories
  // that durable intended work actually contains.
  const objective = house.repoMap.trim()
    ? `${derived.objective}\n\nRepository context for this execution host:\n${house.repoMap.trim()}`
    : derived.objective;
  const sourceKey = sourceKeyFor(message, requestId);
  const under = req.under?.trim() || undefined;
  const result = await createOrGetWorkstream({
    sourceKey,
    slug: derived.slug,
    title: derived.title,
    objective,
    tags: house.tags,
    successCriteria: derived.successCriteria,
    constraints: house.constraints,
    ...(under ? { under } : {}),
    ...(runnerId ? { runnerId } : {}),
  }, 'human');

  // The Workstream owns the requested outcome. This separately preserves who
  // supplied the input as an Observation, not Steering, so it cannot silently
  // widen authority. The content hash makes a retry an exact no-op.
  await recordObservation(result.slug, {
    source: `operator-ui:${safeActor(req.actor)}`,
    summary: message,
    ingressKey: `${sourceKey}:request:${sha256(`${message}\n${done ?? ''}`).slice(0, 24)}`,
  });
  return { slug: result.slug, created: result.created };
}

/**
 * Install the operator delegate's useful doctrine as ordinary durable work —
 * root-cause shared incidents, repair reversible causes, and interrupt only for
 * genuine judgment. The routine receives no approval authority: every external
 * effect still follows its original Workstream's action lifecycle.
 */
export async function createFleetAttentionSteward(actor: string, runnerId?: string): Promise<TeamIntakeResult> {
  const house = loadHouse();
  const evidenceObjective = 'Own a recurring fleet-wide operational triage loop. Each cycle, inspect the harness-provided typed fleet-health evidence — never transcripts — for open human asks, approval-service incidents, active capacity backoff, overdue wakes, dormant routines, and results awaiting review.';
  const cadenceObjective = 'The fleet is quiet only when no actionable operational cause is unowned and no stale ask remains untriaged. Unchanged counts are not evidence of health. When genuinely quiet, schedule the next check about two hours out; while actionable operational work remains, re-check in about fifteen minutes. Report deltas only.';
  const repositoryContext = house.repoMap.trim()
    ? [`Repository context for this execution host:\n${house.repoMap.trim()}`]
    : [];
  const priorBuiltInObjective = [
    evidenceObjective,
    'Group symptoms by root cause. For every actionable group, identify an existing live owner or create one source-keyed bounded managed repair Workstream; verify apparently stale asks so their owning Workstreams can reconcile them. Surface one concise request only when a specific judgment, credential, spend, or external-effect authority genuinely requires a person.',
    cadenceObjective,
    ...repositoryContext,
  ].join('\n\n');
  const definition = {
    title: 'Fleet attention steward',
    objective: [
      evidenceObjective,
      'Group symptoms by root cause. For every actionable group, identify an existing live owner or create one source-keyed bounded managed repair Workstream; verify apparently stale asks so their owning Workstreams can reconcile them. An open card never proves an externally changeable premise is still true: verify current provider/system state before repeating a credential, spend, service-availability, or repository-state ask. Surface one concise request only when fresh readback proves that a specific judgment, credential, spend, or external-effect authority genuinely requires a person.',
      cadenceObjective,
      ...repositoryContext,
    ].join('\n\n'),
    tags: [...new Set([...house.tags, 'routine', 'fleet-operations'])],
    successCriteria: [
      'Each cycle produces one adopted attention report that groups shared causes and cites affected Workstream revisions and entity ids.',
      'Every actionable operational cause has a verified live owner or one source-keyed bounded managed repair Workstream.',
      'Apparently stale asks are verified against current typed state and handed back to their owning Workstreams for reconciliation.',
      'Externally changeable human asks are never repeated from an old open card: a managed read-only verification proves recovery or the still-current human dependency first.',
      'Paused Workstreams remain explicitly deferred: their items are covered without creating active repair work or fleet-wide attention.',
      'Only irreducible human judgment, credentials, spend, or external-effect authority is surfaced, once per root cause; routine dependency noise never becomes one request per affected action.',
      'A future wake is scheduled after every completed cycle.',
    ],
    constraints: [...house.constraints,
      'Never approve or resolve a human-only action, send, merge, deploy, push, spend, or other external effect; preserve the originating Workstream authority gate.',
      'Worker output is a proposal, never permission. Read provider state back after an unknown result and never retry an external mutation blindly.',
      'Use typed fleet state as truth. A generated report may group evidence but cannot change another Workstream\'s decision, completion, attention, or authority.',
      'Never call the fleet quiet merely because unresolved asks are unchanged. A paused Workstream is an explicit operator deferral: record it as deferred without creating active repair work or fleet-wide attention. Every non-deferred operational item requires a recorded disposition and live owner.',
      'An open attention record and a newer source revision prove only missing reconciliation, not that its external premise remains true. Create or reuse bounded managed verification before surfacing spend, credential, provider/service availability, or repository-state asks.',
    ],
    ...(runnerId ? { runnerId } : {}),
  };
  const result = await createOrGetFleetAttentionStewardWorkstream(definition);
  if (!result.created) {
    const current = await load(result.slug);
    const knownBuiltInObjective = current.workstream.objective === priorBuiltInObjective || [
      'Own a recurring fleet-wide attention triage loop. Each cycle, inspect the harness-provided typed attention evidence',
      'Own a recurring fleet-wide operational triage loop. Each cycle, inspect the shared fleet\'s typed Workstream state',
    ].some((prefix) => current.workstream.objective.startsWith(prefix));
    if (knownBuiltInObjective) {
      await arrive(result.slug, (doc, event) => {
        doc.workstream.objective = definition.objective;
        doc.workstream.tags = definition.tags;
        doc.workstream.successCriteria = definition.successCriteria;
        doc.workstream.constraints = definition.constraints;
        event('workstream.updated', 'refreshed the built-in fleet steward contract to the current harness version');
      });
    }
  }
  if (result.created) {
    await recordObservation(result.slug, {
      source: `operator-ui:${safeActor(actor)}`,
      summary: 'Start the standing fleet attention steward using its recorded safety constraints.',
      ingressKey: `${FLEET_ATTENTION_STEWARD_SOURCE_KEY}:enabled`,
    });
  }
  return { slug: result.slug, created: result.created };
}

function managedIndex(docs: WorkstreamDoc[]): Map<string, ManagedWorkstreamLink[]> {
  const index = new Map<string, ManagedWorkstreamLink[]>();
  for (const doc of docs) {
    const manager = doc.workstream.managedBy?.slug;
    if (!manager) continue;
    const children = index.get(manager) ?? [];
    children.push({ slug: doc.workstream.slug, status: doc.workstream.status });
    index.set(manager, children);
  }
  for (const children of index.values()) children.sort((a, b) => a.slug.localeCompare(b.slug));
  return index;
}

function fleetGroups(board: FleetBoardView): OperatorFleetView['groups'] {
  const definitions: Array<[string, WorkstreamCardView[]]> = [
    ['Needs you', board.lanes['needs-you']],
    ['Working', board.lanes.moving],
    ['Waiting', board.lanes.waiting],
    ['Ready', board.lanes.ready],
  ];
  return definitions.map(([label, cards]) => ({ label, cards }));
}

interface RunnerObservation {
  pid: number | null;
  stale: boolean;
  healthy: boolean;
  sharedLiveRunnerIds: string[];
  sharedCoordinatorSeats?: Array<{ runnerId: string; seats?: RunnerPresence['coordinatorSeats']; degraded?: string }>;
}

function observeRunner(sharedLiveRunnerIds: string[], presences: readonly RunnerPresence[] = []): RunnerObservation {
  const pid = liveRunnerPid();
  const stale = pid !== null && runnerSourceStale();
  return {
    pid, stale, healthy: pid !== null && runnerLoopHealthy() && !stale, sharedLiveRunnerIds,
    sharedCoordinatorSeats: sharedLiveRunnerIds.map((runnerId) => {
      const latest = presences.filter((presence) => presence.runnerId === runnerId)
        .sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt))[0];
      // A runner going degraded (or recovering) changes what the fleet status
      // says, so it must change the revision the browser refreshes on.
      return { runnerId, seats: latest?.coordinatorSeats, ...(latest?.degraded ? { degraded: latest.degraded } : {}) };
    }),
  };
}

/** Non-sensitive per-runner facts for the external-monitor probe: the id as
 * published, how stale its freshest heartbeat is, and its degraded reason (if
 * any) — never a host mapping, address, or anything beyond the id itself. */
export interface FleetHealthRunner {
  id: string;
  heartbeat_age_seconds: number;
  degraded: string | null;
}

export interface FleetHealthSnapshot {
  ok: boolean;
  checked_at: string;
  runners: FleetHealthRunner[];
  freshest_heartbeat_age_seconds: number | null;
  healthy_runners: number;
  last_completed_pass_age_seconds: number | null;
  oldest_unserved_due_seconds: number | null;
  capacity_blocked_workstreams: number;
  /** Free MiB on the freshest healthy runner's state filesystem, or null when
   * no healthy runner has published it. */
  state_free_mib: number | null;
  problems: string[];
  unhealthy: 0 | 1;
}

// The runner stops dispatching at its 512 MiB floor (runner.ts). Warning at
// 2 GiB gives the operator (or the nightly workspace collection) a day or two
// of ordinary fleet churn to act before the fleet silently goes quiet — the
// 2026-09-24 disk-full outage had no signal until the floor was crossed.
export const FLEET_STATE_FREE_WARN_BYTES = 2 * 1024 * 1024 * 1024;

// A runner can heartbeat while dispatching nothing (2026-09-21: a fleet
// recorded 0 completed coordinator passes and 236 capacity backoffs in a day
// with a heartbeat that never went stale). An hour past a wake's own due time
// is well beyond ordinary dispatch latency (see fleetHealth.ts's
// ROUTINE_WAKE_GRACE_MS), so it means dispatch itself has stalled.
export const FLEET_UNSERVED_DUE_LIMIT_SECONDS = 3600;
// A coordinator pass can legitimately take hours when providers are in
// backoff; twelve hours of zero completions is only paired with a capacity
// condition below so a fleet that is simply quiet (nothing due) never trips.
export const FLEET_STALLED_OUTPUT_SECONDS = 12 * 60 * 60;

/**
 * Reduce shared runner presence to what an external monitor (Alertee polling
 * `unhealthy`) needs to page on a dead OR stalled fleet — derived from
 * `listRunnerPresence()` alone, never a `load()` loop over every Workstream
 * (see AGENTS.md's "never loop load() over the fleet on a hot path").
 * A degraded presence (state directory can't commit — see runner.ts) publishes
 * no seats and dispatches nothing, so it counts as unhealthy exactly like a
 * stale heartbeat regardless of how fresh its last publish was. Liveness alone
 * is not enough either (AGENTS.md's "a fresh heartbeat is not health"): a
 * runner can tick every 5 seconds while every pass fails before completing, so
 * this also reads the latest healthy runner's own observed OUTPUT — when due
 * work has gone unserved, or nothing has completed while work waits on
 * provider capacity.
 */
export function fleetHealthSnapshot(presences: readonly RunnerPresence[], nowMs = Date.now()): FleetHealthSnapshot {
  const latestByRunner = new Map<string, RunnerPresence>();
  for (const presence of presences) {
    const current = latestByRunner.get(presence.runnerId);
    if (!current || Date.parse(presence.heartbeatAt) > Date.parse(current.heartbeatAt)) {
      latestByRunner.set(presence.runnerId, presence);
    }
  }
  const runners = [...latestByRunner.values()]
    .map((presence) => ({
      id: presence.runnerId,
      ageMs: Math.max(0, nowMs - Date.parse(presence.heartbeatAt)),
      degraded: presence.degraded ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const freshAges = runners.filter((runner) => runner.degraded === null).map((runner) => runner.ageMs);
  const healthyRunners = runners.filter((runner) =>
    runner.degraded === null && runner.ageMs <= FLEET_HEALTH_STALE_SECONDS * 1000,
  ).length;

  // A stale or degraded runner's cached output is not evidence of current
  // fleet state — only the freshest HEALTHY presence's own last scan counts.
  const freshestOutput = [...latestByRunner.values()]
    .filter((presence) =>
      !presence.degraded &&
      Math.max(0, nowMs - Date.parse(presence.heartbeatAt)) <= FLEET_HEALTH_STALE_SECONDS * 1000 &&
      presence.output,
    )
    .sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))[0]?.output;

  const lastCompletedPassAgeSeconds = freshestOutput?.lastCompletedPassAt
    ? Math.max(0, Math.round((nowMs - Date.parse(freshestOutput.lastCompletedPassAt)) / 1000))
    : null;
  const oldestUnservedDueSeconds = freshestOutput?.oldestUnservedDueAt
    ? Math.max(0, Math.round((nowMs - Date.parse(freshestOutput.oldestUnservedDueAt)) / 1000))
    : null;
  const capacityBlockedWorkstreams = freshestOutput?.capacityBlocked ?? 0;

  const problems: string[] = [];
  if (healthyRunners === 0) problems.push('no runner has a healthy heartbeat');
  if (oldestUnservedDueSeconds !== null && oldestUnservedDueSeconds > FLEET_UNSERVED_DUE_LIMIT_SECONDS) {
    problems.push('due work has not been served for over an hour');
  }
  if (
    lastCompletedPassAgeSeconds !== null &&
    lastCompletedPassAgeSeconds > FLEET_STALLED_OUTPUT_SECONDS &&
    capacityBlockedWorkstreams > 0
  ) {
    problems.push('no coordinator pass has completed in 12h while work is waiting on provider capacity');
  }
  const stateFreeBytes = freshestOutput?.stateFreeBytes;
  const stateFreeMib = typeof stateFreeBytes === 'number' && Number.isFinite(stateFreeBytes)
    ? Math.round(stateFreeBytes / (1024 * 1024))
    : null;
  if (stateFreeMib !== null && stateFreeBytes! < FLEET_STATE_FREE_WARN_BYTES) {
    problems.push(`the runner's state filesystem has ${stateFreeMib} MiB free, under the 2 GiB warning line; below 512 MiB it stops dispatching`);
  }

  return {
    ok: problems.length === 0,
    checked_at: new Date(nowMs).toISOString(),
    runners: runners.map((runner) => ({
      id: runner.id,
      heartbeat_age_seconds: Math.round(runner.ageMs / 1000),
      degraded: runner.degraded,
    })),
    freshest_heartbeat_age_seconds: freshAges.length ? Math.round(Math.min(...freshAges) / 1000) : null,
    healthy_runners: healthyRunners,
    last_completed_pass_age_seconds: lastCompletedPassAgeSeconds,
    oldest_unserved_due_seconds: oldestUnservedDueSeconds,
    capacity_blocked_workstreams: capacityBlockedWorkstreams,
    state_free_mib: stateFreeMib,
    problems,
    unhealthy: problems.length ? 1 : 0,
  };
}

function fleetRevision(
  heads: WorkstreamHead[],
  runner: RunnerObservation,
  wallNow = new Date(),
  organizationalNow = virtualNow(),
): string {
  return sha256(JSON.stringify({
    docs: heads.map((head) => [head.slug, head.revision]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    runner,
    // Lane readiness, expiring leases/capacity, due labels, and routine health
    // are projections of time as well as durable revisions. A minute tick is
    // the bounded semantic clock for those human-facing claims.
    presentation: [
      Math.floor(wallNow.getTime() / PRESENTATION_TICK_MS),
      Math.floor(organizationalNow.getTime() / PRESENTATION_TICK_MS),
    ],
  })).slice(0, 20);
}

/** Cheap frequent-poll path: the board asks every few seconds whether a full
 * render is stale, so this must never load document bodies. The returned hash
 * intentionally has the identical `{ docs: [[slug, revision]], runner }`
 * shape used by loadFleet(). */
export async function currentFleetRevision(
  heads: () => Promise<WorkstreamHead[]> = listWorkstreamHeads,
  presences: () => Promise<RunnerPresence[]> = listRunnerPresence,
  wallNow = new Date(),
  organizationalNow = virtualNow(),
): Promise<string> {
  const [currentHeads, currentPresences] = await Promise.all([heads(), presences()]);
  return fleetRevision(currentHeads, observeRunner(liveRunnerIds(currentPresences, wallNow.getTime()), currentPresences), wallNow, organizationalNow);
}

/**
 * One shared store poll fans revision changes out to every connected browser.
 * The durable store remains the source of truth — this resident helper only
 * removes one poll per tab and never carries organizational state.
 */
class FleetRevisionEvents {
  private readonly clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private revision: string | undefined;
  private heartbeatAt = 0;
  private observation: Promise<string | undefined> = Promise.resolve(undefined);

  /** `onChange` hears every observed fleet-revision change (the push
   * notifier's cheap early wake-up; its own interval covers the rest). */
  constructor(private readonly onChange?: () => void) {}

  async subscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const revision = await this.observe();
    res.writeHead(200, {
      ...secureHeaders('text/event-stream; charset=utf-8', res),
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    this.clients.add(res);
    this.writeRevision(res, revision);
    this.heartbeatAt = Date.now();
    const expiry = setTimeout(() => res.end(), LIVE_CONNECTION_MS);
    expiry.unref();
    const remove = () => {
      clearTimeout(expiry);
      this.remove(res);
    };
    req.once('close', remove);
    res.once('close', remove);
    this.schedule();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private remove(res: ServerResponse): void {
    this.clients.delete(res);
    if (!this.clients.size && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.clients.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, LIVE_REVISION_POLL_MS);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.clients.size) return this.schedule();
    this.polling = true;
    try {
      const before = this.revision;
      const revision = await this.observe();
      const now = Date.now();
      if (revision !== before) {
        this.heartbeatAt = now;
      } else if (now - this.heartbeatAt >= LIVE_HEARTBEAT_MS) {
        for (const client of this.clients) client.write(': keep-alive\n\n');
        this.heartbeatAt = now;
      }
    } catch {
      // Durable state is unchanged by a failed observation. The next bounded
      // poll repairs the missed notification without inventing a revision.
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  private observe(): Promise<string> {
    const next = this.observation.then(async () => {
      const revision = await currentFleetRevision();
      if (this.revision && revision !== this.revision) {
        for (const client of this.clients) this.writeRevision(client, revision);
        this.onChange?.();
      }
      this.revision = revision;
      return revision;
    });
    this.observation = next.catch(() => this.revision);
    return next;
  }

  private writeRevision(res: ServerResponse, revision: string): void {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`id: ${revision}\ndata: ${JSON.stringify({ revision })}\n\n`);
    }
  }
}

function fleetScope(): OperatorFleetView['scope'] {
  if (/^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '')) {
    return {
      label: 'Shared fleet',
      detail: 'This workspace reads the shared team database. Fleet details report only the execution state this web service can actually observe.',
    };
  }
  return {
    label: 'Local fleet',
    detail: 'This workspace reads this machine\'s local Weaver store and can measure its local runner.',
  };
}

/** The fleet notice. Its job counts come from the fleet-status model
 * (`fleetGlance`) so the notice, the board strip, and the sidebar can never
 * show different numbers; it adds only fleet-level facts the buckets do not
 * carry (unreadable state, a stalled local runner, the approval-service
 * incident, routine health). */
function fleetHealth(docs: WorkstreamDoc[], unreadable: string[], runner: RunnerObservation, glance: FleetGlanceView): OperatorFleetView['health'] {
  const { pid, healthy: healthyRunner } = runner;
  const sharedRunnerHealthy = /^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '') &&
    runner.sharedLiveRunnerIds.length > 0;
  const stalledRunner = pid !== null && !healthyRunner;
  const incidents = fleetIncidents(docs);
  const pilotIncident = incidents.find((incident) => incident.key === 'approval-service-unavailable');
  const bucketCount = (key: string) => glance.buckets.find((bucket) => bucket.key === key)?.count ?? 0;
  const blocked = bucketCount('blocked');
  const degraded = bucketCount('degraded');
  const unhealthyRoutines = fleetAttentionEvidence(docs, unreadable).workstreams.filter(({ routineHealth }) =>
    !!routineHealth && (
      routineHealth.dormant ||
      routineHealth.overdueWakes.length > 0 ||
      routineHealth.awaitingReviewAssignmentIds.length > 0
    ),
  );

  const jobs = (count: number) => `${count} job${count === 1 ? '' : 's'}`;
  const are = (count: number) => (count === 1 ? 'is' : 'are');
  // Plain sentences a teammate reads at a glance: what is wrong, in jobs.
  // Runner problems are spelled out on the runner line right below this.
  const details: string[] = [];
  if (unreadable.length) details.push(`${jobs(unreadable.length)} can't be read from storage.`);
  if (pilotIncident) {
    details.push(`The approval service isn't responding, so ${jobs(pilotIncident.affectedWorkstreams.length)} can't get approvals.`);
  }
  if (blocked) details.push(`${jobs(blocked)} ${are(blocked)} blocked and can't continue right now.`);
  if (degraded) details.push(`${jobs(degraded)} ${are(degraded)} running on a backup model because the main model is limited.`);
  if (unhealthyRoutines.length) {
    details.push(`${unhealthyRoutines.length} routine${unhealthyRoutines.length === 1 ? ' is' : 's are'} behind schedule.`);
  }
  const say = (...extra: string[]) => [...details, ...extra].join(' ');

  if (unreadable.length || stalledRunner) {
    return {
      tone: 'critical',
      headline: unreadable.length ? 'Some jobs can\'t be read' : 'The runner is stuck',
      detail: say('Nothing is lost; jobs resume once this is fixed.'),
    };
  }
  if (glance.runners.degraded.length) {
    return { tone: 'critical', headline: 'A runner has stopped taking jobs', detail: say() };
  }
  if (pilotIncident || blocked || degraded || unhealthyRoutines.length) {
    return {
      tone: 'warning',
      headline: pilotIncident || blocked
        ? 'Some jobs are blocked'
        : unhealthyRoutines.length
          ? 'Some routines are behind schedule'
          : 'Some jobs are on a backup model',
      detail: pilotIncident || blocked ? say('Nothing is lost; jobs resume when this clears.') : say(),
    };
  }
  if (sharedRunnerHealthy || healthyRunner) {
    return { tone: 'healthy', headline: 'Weaver is running', detail: say() };
  }
  return {
    tone: 'warning',
    headline: 'No runner is running',
    detail: say('Nothing is lost; jobs resume when a runner starts.'),
  };
}

function fleetStatus(docs: WorkstreamDoc[], board: FleetBoardView, runner: RunnerObservation): OperatorFleetView['status'] {
  const shared = /^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '');
  const { pid, stale, healthy } = runner;
  const incidents = fleetIncidents(docs);
  const affected = incidents.reduce((sum, incident) => sum + incident.affectedActions, 0);
  const needJobs = new Set(board.needs.map((need) => need.slug)).size;
  return {
    storage: {
      label: 'Shared data',
      value: shared ? 'Shared team database · Connected' : 'Local store · Connected',
      detail: shared ? 'Jobs, decisions, results, and shared knowledge come from one team database.' : 'This browser and the runner use this machine\'s local state.',
      tone: 'healthy',
    },
    execution: shared && pid === null ? {
      label: 'Agent execution',
      value: runner.sharedLiveRunnerIds.length
        ? `Running · ${runner.sharedLiveRunnerIds.join(', ')}`
        : 'Offline · no runner online',
      detail: runner.sharedLiveRunnerIds.length
        ? 'Runners check in every few seconds; these are the ones online now.'
        : 'No runner is online. Nothing is lost; jobs resume when one starts.',
      tone: runner.sharedLiveRunnerIds.length ? 'healthy' : 'warning',
    } : {
      label: 'Agent execution',
      value: healthy ? 'Running' : pid === null ? 'Offline' : 'Stuck',
      detail: healthy
        ? 'The runner on this machine is checking in.'
        : pid === null
          ? 'No runner is running. Nothing is lost; jobs resume when one starts.'
          : 'A runner process exists but has stopped checking in.',
      tone: healthy ? 'healthy' : stale || pid !== null ? 'critical' : 'warning',
    },
    attention: {
      label: 'Attention',
      value: board.needs.length
        ? `${board.needs.length} question${board.needs.length === 1 ? '' : 's'} for you across ${needJobs} job${needJobs === 1 ? '' : 's'}`
        : 'Nothing needs you',
      detail: affected
        ? `${affected} approval${affected === 1 ? ' is' : 's are'} waiting on the approval service; see below.`
        : 'Problems shared by many jobs show here once, not on every job.',
      tone: board.needs.length ? 'warning' : 'healthy',
    },
  };
}

async function loadFleet(): Promise<LoadedFleet> {
  const docs: WorkstreamDoc[] = [];
  const unreadable: string[] = [];
  for (const slug of await listWorkstreams()) {
    try {
      docs.push(await load(slug));
    } catch {
      unreadable.push(slug);
    }
  }
  const managed = managedIndex(docs);
  const policies = (await loadPolicies()).policies;
  const presences = await listRunnerPresence();
  const board = fleetBoard(docs, policies, managed, unreadable, new Date(), virtualNow(), presences);
  const incidents = fleetIncidents(docs);
  const stewardDoc = docs.find(isFleetAttentionSteward);
  const stewardCard = stewardDoc
    ? Object.values(board.lanes).flat().find((card) => card.slug === stewardDoc.workstream.slug)
    : undefined;
  const runner = observeRunner(liveRunnerIds(presences), presences);
  const glance = fleetGlance(board, fleetRunnerLine(presences, {
    state: runner.healthy ? 'running' : runner.pid !== null ? 'stalled' : 'offline',
  }));
  const health = fleetHealth(docs, unreadable, runner, glance);
  // "All clear" must never sit beside a fleet notice that says otherwise
  // (a stalled routine, unreadable state): the notice's headline wins then.
  const reconciledGlance: FleetGlanceView = glance.headline === 'All clear' && health.tone !== 'healthy'
    ? { ...glance, tone: health.tone, headline: health.headline }
    : glance;
  const revision = fleetRevision(
    docs.map((doc) => ({ slug: doc.workstream.slug, revision: doc.revision })),
    runner,
  );
  return {
    docs,
    unreadable,
    managed,
    presences,
    policies,
    view: {
      board,
      groups: fleetGroups(board),
      scope: fleetScope(),
      glance: reconciledGlance,
      health,
      status: fleetStatus(docs, board, runner),
      incidents,
      steward: stewardDoc ? {
        state: stewardDoc.workstream.status,
        title: 'Attention steward',
        detail: stewardCard?.next ?? stewardDoc.workstream.conclusion?.summary ?? 'Open the steward job to see what it is doing.',
        slug: stewardDoc.workstream.slug,
      } : {
        state: 'not-configured',
        title: 'Attention steward',
        detail: 'A recurring job that looks into these problems, fixes what it safely can, and asks you only when it needs a decision.',
      },
      intakeParents: docs
        .filter((doc) => doc.workstream.status === 'active')
        .map((doc) => ({ slug: doc.workstream.slug, title: doc.workstream.title }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      intakeRunnerIds: runner.sharedLiveRunnerIds,
      revision,
    },
  };
}

const clerkBrowserByResponse = new WeakMap<ServerResponse, ClerkBrowserAssets>();
/** Signed-in Clerk responses: their operator pages carry the keep-alive frame. */
const clerkSessionPages = new WeakSet<ServerResponse>();
/** The keep-alive page, the one response a same-origin frame may embed. */
const framedBySameOrigin = new WeakSet<ServerResponse>();

function secureHeaders(contentType: string, res?: ServerResponse): Record<string, string> {
  const clerk = res ? clerkBrowserByResponse.get(res) : undefined;
  // Only the content-free keep-alive page may be framed, and only by this
  // origin; a signed-in page may frame only this origin (that page).
  const framed = res ? framedBySameOrigin.has(res) : false;
  const frameAncestors = framed ? "frame-ancestors 'self'" : "frame-ancestors 'none'";
  const contentSecurityPolicy = clerk
    ? [
      "default-src 'none'",
      `connect-src 'self' ${clerk.frontendOrigin} https://*.protect.clerk.com:*`,
      "style-src 'unsafe-inline'",
      `script-src 'unsafe-inline' ${clerk.frontendOrigin} https://challenges.cloudflare.com https://*.protect.clerk.com`,
      "img-src 'self' https://img.clerk.com",
      "worker-src 'self' blob:",
      "frame-src https://challenges.cloudflare.com https://*.protect.clerk.com",
      "form-action 'self'",
      "base-uri 'none'",
      frameAncestors,
    ].join('; ')
    : `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; ${frameAncestors}`;
  return {
    'content-type': contentType,
    'content-security-policy': contentSecurityPolicy,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': framed ? 'SAMEORIGIN' : 'DENY',
    'strict-transport-security': 'max-age=31536000',
    'cache-control': 'no-store',
  };
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  // A signed-in operator page (Clerk mode) embeds the hidden keep-alive frame
  // that renews the session cookie; see renderOperatorClerkKeepAliveHtml.
  const page = clerkSessionPages.has(res) && html.includes('data-operator-root') && html.includes('</body>')
    ? html.replace('</body>', `${OPERATOR_KEEPALIVE_FRAME}</body>`)
    : html;
  const body = redactSecrets(page, loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('text/html; charset=utf-8', res), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendClerkHtml(res: ServerResponse, status: number, html: string, browser: ClerkBrowserAssets): void {
  clerkBrowserByResponse.set(res, browser);
  sendHtml(res, status, html);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = redactSecrets(JSON.stringify(value), loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('application/json; charset=utf-8', res), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, value: string): void {
  const body = redactSecrets(value, loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('text/plain; charset=utf-8', res), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/**
 * Railway and similar supervisors need a probe that cannot become a fleet
 * read API. Reaching this response means the configured StateStore completed
 * a real operation; the empty body deliberately reveals no fleet facts.
 */
function sendHealth(res: ServerResponse, status: 200 | 503): void {
  res.writeHead(status, {
    ...secureHeaders('text/plain; charset=utf-8', res),
    'content-length': '0',
  });
  res.end();
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...secureHeaders('text/plain; charset=utf-8', res), location });
  res.end('See Other');
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    ...secureHeaders('text/plain; charset=utf-8', res),
    'www-authenticate': 'Basic realm="Weaver", charset="UTF-8"',
  });
  res.end('Authentication required');
}

function forbidden(res: ServerResponse): void {
  res.writeHead(403, secureHeaders('text/plain; charset=utf-8', res));
  res.end('Same-origin request required');
}

function copyClerkHeaders(res: ServerResponse, headers: Headers): void {
  const blocked = new Set([
    'connection',
    'content-length',
    'content-security-policy',
    'content-type',
    'location',
    'strict-transport-security',
    'transfer-encoding',
    'x-content-type-options',
    'x-frame-options',
  ]);
  headers.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
}

function clerkRedirect(res: ServerResponse, location: string, headers: Headers): void {
  copyClerkHeaders(res, headers);
  res.writeHead(307, { ...secureHeaders('text/plain; charset=utf-8', res), location });
  res.end('Temporary Redirect');
}

function authenticationUnavailable(res: ServerResponse): void {
  sendText(res, 503, 'Authentication is temporarily unavailable. Please try again.');
}

function localReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/board';
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '/board';
  }
  if (decoded.startsWith('//') || /[\\\r\n\0]/.test(decoded)) return '/board';
  const target = new URL(value, 'https://weaver.invalid');
  if (target.origin !== 'https://weaver.invalid'
    || target.pathname.startsWith('//')
    || /[\\\r\n\0]/.test(target.pathname)
    || ['/sign-in', '/access-denied', '/sign-out'].includes(target.pathname)) return '/board';
  return `${target.pathname}${target.search}${target.hash}`;
}

function requestAuthority(req: IncomingMessage): string | null {
  const value = req.headers.host;
  if (typeof value !== 'string' || !value || /[\s\\/@?#]/.test(value)) return null;
  try {
    return new URL(`http://${value}/`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Browser credentials are replayed automatically, including on cross-site
 * form submissions. Clerk mode compares the complete canonical HTTPS origin;
 * legacy Basic mode compares Origin to the request host because a private
 * reverse proxy may terminate HTTPS in front of this HTTP server.
 * The page's no-referrer policy makes Chromium serialize Origin as `null` on
 * an ordinary same-origin HTML form navigation. That path is accepted only
 * with browser-controlled Fetch Metadata proving a same-origin document
 * navigation. A non-browser request with neither signal still fails closed.
 */
function isSameOriginPost(req: IncomingMessage, exactOrigin?: string): boolean {
  const value = req.headers.origin;
  const authority = requestAuthority(req);
  if (!authority) return false;
  if (value === undefined || value === 'null') {
    return req.headers['sec-fetch-site'] === 'same-origin'
      && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document';
  }
  if (typeof value !== 'string') return false;
  try {
    const origin = new URL(value);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    if (exactOrigin) return origin.origin === exactOrigin;
    return origin.host.toLowerCase() === authority;
  } catch {
    return false;
  }
}

function actorFor(req: IncomingMessage, token?: string): string | null {
  if (!token) return safeActor(userInfo().username);
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  const username = decoded.slice(0, separator);
  const presented = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return safeActor(username);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = req.headers['content-type']?.split(';')[0]?.trim();
  if (type !== 'application/x-www-form-urlencoded') throw new Error('form content type required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function noticeFrom(url: URL): string | undefined {
  if (url.searchParams.get('steward') === 'created') return 'Attention steward started. It will audit grouped incidents without acquiring approval authority.';
  if (url.searchParams.get('steward') === 'existing') return 'The fleet already has an attention steward.';
  if (url.searchParams.get('created') === '1') return 'Request stored. Weaver can pick it up as soon as execution is available.';
  if (url.searchParams.get('existing') === '1') return 'This source already has a Workstream. Your request was added there.';
  if (url.searchParams.get('added') === '1') return 'Information added. Weaver will reconcile it on the next pass.';
  if (url.searchParams.get('responded') === '1') return 'Response added. Weaver has been woken.';
  if (url.searchParams.get('closed') === '1') return 'Job closed as not worth doing. Resume it from the CLI if that was wrong.';
  return undefined;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token?: string,
  clerk?: ClerkOperatorAuthenticator,
  revisionEvents?: FleetRevisionEvents,
  overview?: OverviewSource,
  restApi?: RestApiHandler,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? 'GET';

  // Health is the one unauthenticated route. It exposes no status or counts,
  // and succeeds only after the selected backend answers a real read.
  if (method === 'GET' && url.pathname === '/healthz') {
    try {
      await listWorkstreams();
      return sendHealth(res, 200);
    } catch {
      return sendHealth(res, 503);
    }
  }

  // A second unauthenticated probe, deliberately exempted from the operator
  // auth gate below like /healthz: an external monitor (e.g. Alertee) needs a
  // fleet-liveness signal it can poll without a Basic/Clerk credential, and
  // this exposes no workstream content — only runner ids and heartbeat
  // freshness derived from shared presence. See docs-public for the contract.
  if (method === 'GET' && url.pathname === '/healthz/fleet') {
    try {
      const snapshot = fleetHealthSnapshot(await listRunnerPresence());
      return sendJson(res, 200, snapshot);
    } catch {
      return sendJson(res, 503, { ok: false, unhealthy: 1, error: 'store unreachable' });
    }
  }

  // The machine API authenticates with its own bearer tokens and never falls
  // through to the browser's Clerk/Basic session below (no cookie, so no
  // same-origin check either). See src/restApi.ts.
  if (url.pathname.startsWith(API_PREFIX)) {
    if (!restApi) return sendJson(res, 404, { error: 'Not found' });
    return restApi(req, res);
  }

  let actor: string;
  if (clerk) {
    let result;
    try {
      result = await clerk.authenticate(req);
    } catch {
      return authenticationUnavailable(res);
    }
    if (result.kind === 'redirect') return clerkRedirect(res, result.location, result.headers);
    copyClerkHeaders(res, result.headers);
    if (result.kind === 'unavailable') return authenticationUnavailable(res);
    if (result.kind === 'signed-out') {
      if (url.pathname.startsWith('/api/')) return sendText(res, 401, 'Authentication required');
      if (method === 'GET' && url.pathname === '/sign-in') {
        const returnTo = localReturnTo(url.searchParams.get('return_to'));
        return sendClerkHtml(res, 200, renderOperatorClerkAuthHtml(clerk.browser, 'sign-in', returnTo), clerk.browser);
      }
      const returnTo = localReturnTo(`${url.pathname}${url.search}`);
      return redirect(res, `/sign-in?return_to=${encodeURIComponent(returnTo)}`);
    }
    if (result.kind === 'forbidden') {
      if (method === 'GET' && url.pathname === '/access-denied') {
        return sendClerkHtml(res, 403, renderOperatorClerkAuthHtml(clerk.browser, 'access-denied'), clerk.browser);
      }
      return redirect(res, '/access-denied');
    }
    actor = safeActor(result.actor);
    if (method === 'GET' && url.pathname === '/session-keepalive') {
      framedBySameOrigin.add(res);
      return sendClerkHtml(res, 200, renderOperatorClerkKeepAliveHtml(clerk.browser), clerk.browser);
    }
    clerkSessionPages.add(res);
    if (method === 'GET' && url.pathname === '/sign-in') {
      return redirect(res, localReturnTo(url.searchParams.get('return_to')));
    }
    if (method === 'GET' && url.pathname === '/access-denied') return redirect(res, '/board');
  } else {
    const basicActor = actorFor(req, token);
    if (!basicActor) return unauthorized(res);
    actor = basicActor;
  }
  if (method === 'POST' && !isSameOriginPost(req, clerk?.publicOrigin)) return forbidden(res);

  if (clerk && method === 'POST' && url.pathname === '/sign-out') {
    return sendClerkHtml(res, 200, renderOperatorClerkAuthHtml(clerk.browser, 'sign-out'), clerk.browser);
  }

  if (method === 'GET' && url.pathname === '/') return redirect(res, '/board');

  if (method === 'GET' && url.pathname === '/api/fleet-revision') {
    return sendJson(res, 200, { revision: await currentFleetRevision() });
  }

  if (method === 'GET' && url.pathname === '/api/fleet-events') {
    if (!revisionEvents) return sendText(res, 503, 'Live updates are temporarily unavailable');
    return revisionEvents.subscribe(req, res);
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'workstreams' && parts[3] === 'revision') {
    try {
      const doc = await load(parts[2]!);
      return sendJson(res, 200, { revision: String(doc.revision) });
    } catch {
      return sendJson(res, 404, { error: 'Workstream not found' });
    }
  }

  if (method === 'GET' && url.pathname === '/board') {
    const fleet = await loadFleet();
    // An unknown or absent ?state= shows every job rather than an error.
    const state = url.searchParams.get('state');
    return sendHtml(res, 200, renderOperatorBoardHtml({
      fleet: fleet.view,
      ...(isFleetBucket(state) ? { filter: state } : {}),
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'GET' && url.pathname === '/fleet') {
    const fleet = await loadFleet();
    return sendHtml(res, 200, renderOperatorFleetHtml({
      fleet: fleet.view,
      routines: routineSchedule(fleet.docs, new Date(), virtualNow()),
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'GET' && url.pathname === '/overview') {
    const { fleet, overview: payload } = await (overview ?? overviewSource())();
    return sendHtml(res, 200, renderOperatorOverviewHtml({
      fleet: fleet.view,
      overview: payload,
      ...(url.searchParams.get('now') ? { nowTab: url.searchParams.get('now')! } : {}),
      ...(url.searchParams.get('example') ? { exampleTab: url.searchParams.get('example')! } : {}),
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'GET' && url.pathname === '/policies') {
    // The fleet revision covers workstream heads, not the policy store, so a
    // memoized copy would miss a CLI supersede or backfill until some job
    // moved. The store is one document; read it fresh.
    const [{ fleet }, { policies }] = await Promise.all([(overview ?? overviewSource())(), loadPolicies()]);
    return sendHtml(res, 200, renderOperatorPoliciesHtml({
      fleet: fleet.view,
      policies,
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'GET' && url.pathname === '/analytics') {
    const { fleet, stats, overview: payload } = await (overview ?? overviewSource())();
    return sendHtml(res, 200, renderOperatorAnalyticsHtml({
      fleet: fleet.view,
      stats,
      overview: payload,
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'POST' && url.pathname === '/fleet/attention-steward') {
    const result = await createFleetAttentionSteward(actor);
    return redirect(res, `/fleet?steward=${result.created ? 'created' : 'existing'}`);
  }

  if (method === 'GET' && url.pathname === '/new') {
    const fleet = await loadFleet();
    return sendHtml(res, 200, renderOperatorNewHtml({
      fleet: fleet.view,
      actor,
      requestId: randomUUID(),
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'POST' && url.pathname === '/workstreams') {
    const form = await readForm(req);
    const result = await createTeamWorkstream({
      message: form.get('message') ?? '',
      done: form.get('done') ?? undefined,
      requestId: form.get('request_id') ?? '',
      actor,
      under: form.get('under') ?? undefined,
      runnerId: form.get('runner_id') ?? undefined,
    });
    return redirect(res, `/workstreams/${encodeURIComponent(result.slug)}?${result.created ? 'created' : 'existing'}=1`);
  }

  if (method === 'POST' && parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'observations') {
    const slug = parts[1]!;
    await load(slug);
    const form = await readForm(req);
    const message = (form.get('message') ?? '').trim();
    if (!message) throw new Error('Information is required');
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`Information must be at most ${MAX_MESSAGE_LENGTH} characters`);
    await recordObservation(slug, { source: `operator-ui:${actor}`, summary: message });
    return redirect(res, `/workstreams/${encodeURIComponent(slug)}?tab=activity&added=1`);
  }

  if (method === 'POST' && parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'close') {
    // The human kill switch: the signed-in operator closes the job as not
    // worth doing, against the revision the page showed them. Delivery is
    // never asserted from here — only the coordinator concludes that, on
    // adopted evidence.
    const slug = parts[1]!;
    await load(slug);
    const form = await readForm(req);
    const reason = (form.get('reason') ?? '').trim();
    if (!reason) throw new OperatorUiHttpError(400, 'A reason is required to close a job');
    if (reason.length > MAX_MESSAGE_LENGTH) throw new OperatorUiHttpError(400, `A reason must be at most ${MAX_MESSAGE_LENGTH} characters`);
    const revision = Number(form.get('revision') ?? '');
    if (!Number.isInteger(revision) || revision < 1) throw new OperatorUiHttpError(400, 'The close request is malformed');
    try {
      await closeWorkstream(slug, 'not_worth_doing', reason, { expectedRevision: revision, actor });
    } catch (error) {
      if (error instanceof RevisionConflictError) throw new OperatorUiHttpError(409, 'This job changed since you loaded it. Reload it before closing.');
      if (error instanceof AlreadyConcludedError) throw new OperatorUiHttpError(409, 'This job is already concluded.');
      throw error;
    }
    return redirect(res, `/workstreams/${encodeURIComponent(slug)}?tab=overview&closed=1`);
  }

  if (method === 'POST' && parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'responses') {
    const slug = parts[1]!;
    await load(slug);
    const form = await readForm(req);
    await recordNeedResponse(slug, {
      sourceType: form.get('need_source_type') ?? '',
      sourceId: form.get('need_id') ?? '',
      version: form.get('need_version') ?? '',
      responseId: form.get('response_id') ?? '',
      choice: form.get('choice') ?? '',
      custom: form.get('custom') ?? '',
      note: form.get('note') ?? '',
    }, actor);
    return redirect(res, `/workstreams/${encodeURIComponent(slug)}?tab=overview&responded=1`);
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'workstreams' && parts[2] === 'artifacts') {
    const slug = parts[1]!;
    const doc = await load(slug);
    const deliverable = doc.deliverables.find((candidate) => candidate.id === parts[3]);
    if (!deliverable) return sendHtml(res, 404, '<h1>Artifact not found</h1>');
    if (deliverable.adopted && deliverable.adopted.contentHash !== deliverable.contentHash) {
      return sendHtml(res, 409, '<h1>Artifact pin does not match its recorded revision</h1>');
    }
    if (!(await verifyArtifact(slug, deliverable.path, deliverable.contentHash))) {
      return sendHtml(res, 409, '<h1>Artifact integrity check failed</h1>');
    }
    const content = redactSecrets(await readArtifact(slug, deliverable.path), loadAllSecrets());
    const fileName = deliverable.path.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.writeHead(200, {
      ...secureHeaders('text/plain; charset=utf-8', res),
      'content-disposition': `attachment; filename="${fileName}"`,
      'content-length': String(Buffer.byteLength(content)),
    });
    res.end(content);
    return;
  }

  if (method === 'GET' && parts.length === 2 && parts[0] === 'workstreams') {
    const slug = parts[1]!;
    const fleet = await loadFleet();
    const doc = fleet.docs.find((candidate) => candidate.workstream.slug === slug);
    if (!doc) return sendHtml(res, 404, '<h1>Workstream not found</h1>');
    const policies = (await loadPolicies()).policies;
    const view = workstreamPage(doc, policies, fleet.managed.get(slug) ?? [], fleet.presences);
    const primaryNeed = view.needs[0];
    const tab = workspaceTab(url.searchParams.get('tab'));
    return sendHtml(res, 200, renderOperatorWorkspaceHtml({
      fleet: fleet.view,
      actor,
      notice: noticeFrom(url),
      view,
      tab,
      ...(tab === 'timeline' ? {
        timeline: workstreamTimeline(doc, { now: virtualNow(), limit: url.searchParams.get('all') === '1' ? 'all' : DEFAULT_TIMELINE_LIMIT }),
      } : {}),
      responseId: randomUUID(),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
      ...(primaryNeed ? { needVersion: needVersion(primaryNeed) } : {}),
    }));
  }

  return sendHtml(res, 404, '<h1>Not found</h1>');
}

export async function startOperatorUi(opts: OperatorUiOptions = {}): Promise<RunningOperatorUi> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && !opts.token && !opts.clerk) {
    throw new Error('Clerk authentication or WEAVER_UI_TOKEN is required when weaver ui binds beyond loopback');
  }
  // One fleet index for the REST API and the push notifier, so pushing
  // costs no reads beyond what serving /api/v1/needs already costs.
  const index = new WorkstreamIndex();
  const notifier = opts.notifications ? needNotifierFromEnv(index) : null;
  const revisionEvents = new FleetRevisionEvents(notifier ? () => notifier.kick() : undefined);
  const overview = overviewSource();
  const restApi = createRestApi({ tokens: opts.apiTokens ?? restApiTokensFromEnv(), index });
  const server = createServer((req, res) => {
    handle(req, res, opts.token, opts.clerk, revisionEvents, overview, restApi).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof OperatorUiHttpError || error instanceof NeedResponseError) {
        sendText(res, error.status, `Request could not be stored\n\n${message}\n`);
        return;
      }
      const userError = error instanceof ManagedWorkstreamError || /required|too large|at most|content type/i.test(message);
      const status = userError ? 400 : 500;
      sendText(res, status, `${status === 400 ? 'Request could not be stored' : 'Weaver UI failed'}\n\n${message}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('unexpected server address'));
      notifier?.start();
      resolve({
        server,
        port: address.port,
        close: () => {
          notifier?.stop();
          revisionEvents.close();
          return new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
        },
      });
    });
  });
}
