/**
 * Provider capacity/auth failures, normalized into typed durable waits.
 *
 * The Claude SDK and remote executors report the same outage through several surfaces: assistant
 * error codes, rate_limit_event metadata, result.errors[], or a thrown error.
 * This collector makes those transport details non-authoritative. Workstream
 * state stores only the closed classification and recovery action — never a
 * credential, account identity, or raw provider response.
 */

import type {
  SDKAssistantMessageError,
  SDKMessage,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Assignment,
  CapacityBackoff,
  CapacityCategory,
  InfrastructureRecovery,
  InfrastructureWait,
  ProviderCapacityObservation,
  WorkstreamDoc,
} from './types.js';
import { isPendingSteering } from './steering.js';
import {
  coordinatorCapacityTarget,
  coordinatorFallbackCapacityTarget,
  targetOfWait,
  type CapacityTarget,
} from './modelConfig.js';
import { runnerExecutorCapabilities, workerTargetsForAssignment } from './modelRouting.js';

const DEFAULT_RETRY_MS = 15 * 60_000;
// A plan-usage cap ('usage_limit'/'sdk_credit_exhausted') does not clear in the
// 15-minute default — it resets on a billing schedule that can be hours or days
// out. When the provider gives no explicit reset time, probing the exhausted
// pool every 15 minutes just burns a pass and re-parks each cycle (observed: a
// Fable primary dead for days re-thrashed the coordinator every 15 min while the
// fallback carried the work). A longer default backoff cuts that churn; an
// explicit `weaver capacity retry` remains the fast path once the operator knows
// usage is back, and a provider-supplied resetAt still wins over this guess.
const USAGE_LIMIT_RETRY_MS = 60 * 60_000;

function isoFromEpoch(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function earliestFutureReset(
  info: SDKRateLimitInfo | undefined,
  wallNow: Date,
): string | undefined {
  const values = [info?.resetsAt, info?.overageResetsAt]
    .map(isoFromEpoch)
    .filter((v): v is string => v !== undefined && Date.parse(v) > wallNow.getTime());
  return values.sort().at(0);
}

const AUTH_TEXT =
  /401|unauthoriz|authentication|not logged in|log ?in|oauth_org_not_allowed|token (?:revoked|expired)|process aborted/i;
const SESSION_TEXT = /session limit|hit your session limit|5-?hour limit/i;
// Limit wording varies by plan window ("hit your weekly limit · resets Aug 8",
// "reached your usage limit") and Anthropic renames these freely — so match
// the shape, not one remembered phrasing. These are plan-usage waits; a miss
// would turn infrastructure into work failure and page the human falsely.
const USAGE_TEXT =
  /out of (?:usage credits|extra usage)|credits?_required|\bcredits?\b|billing|usage allocation (?:has been )?disabled|usage limit|requires usage credits|run \/usage-credits|exceeded your .* limit|you(?:'|’)ve (?:reached|hit) your [\w -]*limit|(?:weekly|monthly|daily) limit|limit ·? ?resets/i;
const RATE_TEXT = /rate.?limit|quota|429/i;
const PROVIDER_TEXT = /overloaded|529|server error|service unavailable/i;

function capacityFamily(category: CapacityCategory): CapacityCategory {
  return category === 'sdk_credit_exhausted' ? 'usage_limit' : category;
}

/** Compatibility classifier for thrown errors and older SDK result text.
 * Structured SDK fields take precedence in SdkFailureTracker, but this pure
 * function remains a strict superset of Weaver's original infra regex. */
export function classifyCapacityFailure(
  errorText: string,
  wallFired = false,
): CapacityCategory | null {
  if (wallFired) return 'other';
  if (SESSION_TEXT.test(errorText)) return 'session_limit';
  if (USAGE_TEXT.test(errorText)) return 'usage_limit';
  if (RATE_TEXT.test(errorText)) return 'rate_limit';
  if (AUTH_TEXT.test(errorText)) return 'auth';
  if (PROVIDER_TEXT.test(errorText)) return 'other';
  return null;
}

export interface InfrastructureSource {
  source: 'coordinator' | 'worker';
  sourceId: string;
  model: string;
  executor: string;
  provider: string;
  /** Scheduler time stored in wakes (virtual in demos). */
  now?: Date;
  /** Provider wall time used to translate an absolute reset into a delay. */
  wallNow?: Date;
  wallFired?: boolean;
}

export class SdkFailureTracker {
  private failed = false;
  private texts: string[] = [];
  private errors = new Set<SDKAssistantMessageError>();
  private rateLimit?: SDKRateLimitInfo;
  private rateLimits = new Map<string, SDKRateLimitInfo>();
  private terminalReason?: string;

  observe(message: SDKMessage): void {
    if (message.type === 'assistant' && message.error) {
      this.errors.add(message.error);
      this.failed = true;
    }
    if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info;
      this.rateLimits.set(info.rateLimitType ?? 'unspecified', info);
      if (message.rate_limit_info.status === 'rejected') {
        this.failed = true;
        this.rateLimit = info;
      }
    }
    if (message.type === 'result') {
      if (message.is_error) this.failed = true;
      if ('errors' in message) this.texts.push(...message.errors);
      if ('result' in message && message.is_error && typeof message.result === 'string') {
        this.texts.push(message.result);
      }
      if (message.terminal_reason) this.terminalReason = message.terminal_reason;
    }
  }

  capture(error: unknown): void {
    this.failed = true;
    this.texts.push(error instanceof Error ? error.message : String(error));
  }

  /** Raw text is used only as a compatibility signal; it is never persisted. */
  diagnostic(): string {
    return this.texts.filter(Boolean).join(' · ').slice(0, 500) || 'model execution failed';
  }

  /** Provider plan-window facts are observability only. An allowed warning is
   * useful headroom telemetry, but it must never become an infrastructure
   * failure or an execution gate. */
  capacityObservations(source: InfrastructureSource): ProviderCapacityObservation[] {
    const wallNow = source.wallNow ?? new Date();
    return [...this.rateLimits.entries()].flatMap(([window, info]) => {
      const resetAt = earliestFutureReset(info, wallNow);
      const utilization = typeof info.utilization === 'number' &&
        Number.isFinite(info.utilization) &&
        info.utilization >= 0 &&
        info.utilization <= 1
        ? info.utilization
        : undefined;
      if (utilization === undefined && !resetAt && info.status === 'allowed') return [];
      return [{
        executor: source.executor,
        provider: source.provider,
        model: source.model,
        window,
        status: info.status,
        ...(utilization !== undefined ? { utilization } : {}),
        observedAt: wallNow.toISOString(),
        ...(resetAt ? { resetAt } : {}),
      }];
    });
  }

  classify(source: InfrastructureSource): InfrastructureWait | null {
    const now = source.now ?? new Date();
    if (source.wallFired) return this.make('other', 'automatic_retry', source, now);
    if (!this.failed) return null;

    const text = `${this.texts.join(' ')} ${this.terminalReason ?? ''}`;
    const disabled = this.rateLimit?.overageDisabledReason;
    const usageBlocked =
      this.rateLimit?.errorCode === 'credits_required' ||
      disabled === 'out_of_credits' ||
      disabled === 'seat_tier_level_disabled' ||
      disabled === 'member_level_disabled' ||
      disabled === 'seat_tier_zero_credit_limit' ||
      disabled === 'group_zero_credit_limit' ||
      disabled === 'member_zero_credit_limit' ||
      this.errors.has('billing_error') ||
      classifyCapacityFailure(text) === 'usage_limit';

    if (usageBlocked) {
      return this.make(
        'usage_limit',
        'wait_or_enable_usage_credits',
        source,
        now,
      );
    }
    if (
      this.errors.has('authentication_failed') ||
      this.errors.has('oauth_org_not_allowed') ||
      classifyCapacityFailure(text) === 'auth'
    ) {
      return this.make('auth', 'reauthenticate', source, now);
    }
    if (classifyCapacityFailure(text) === 'session_limit') {
      return this.make('session_limit', 'automatic_retry', source, now);
    }
    if (this.rateLimit?.rateLimitType === 'five_hour') {
      return this.make('session_limit', 'automatic_retry', source, now);
    }
    if (this.rateLimit?.rateLimitType?.startsWith('seven_day')) {
      return this.make('usage_limit', 'wait_or_enable_usage_credits', source, now);
    }
    if (
      this.errors.has('rate_limit') ||
      this.rateLimit?.status === 'rejected' ||
      this.terminalReason === 'blocking_limit' ||
      classifyCapacityFailure(text) === 'rate_limit'
    ) {
      return this.make('rate_limit', 'automatic_retry', source, now);
    }
    if (
      this.errors.has('overloaded') ||
      this.errors.has('server_error') ||
      classifyCapacityFailure(text) === 'other'
    ) {
      return this.make('other', 'automatic_retry', source, now);
    }
    return null;
  }

  private make(
    kind: CapacityCategory,
    recovery: InfrastructureRecovery,
    source: InfrastructureSource,
    now: Date,
  ): InfrastructureWait {
    const wallNow = source.wallNow ?? new Date();
    const resetAt = earliestFutureReset(this.rateLimit, wallNow);
    const resetDelay = resetAt ? Date.parse(resetAt) - wallNow.getTime() : -1;
    // Provider resets are wall-clock facts; Weaver wakes use virtual time.
    // Preserve the delay between them instead of comparing unlike clocks.
    const noResetDefault =
      kind === 'usage_limit' || kind === 'sdk_credit_exhausted'
        ? USAGE_LIMIT_RETRY_MS
        : DEFAULT_RETRY_MS;
    const retryDelay = resetDelay > 0 ? resetDelay : noResetDefault;
    const retryAt = new Date(now.getTime() + retryDelay).toISOString();
    return {
      kind,
      recovery,
      source: source.source,
      sourceId: source.sourceId,
      model: source.model,
      executor: source.executor,
      provider: source.provider,
      detectedAt: now.toISOString(),
      retryAt,
      ...(resetAt ? { resetAt } : {}),
      ...(this.rateLimit?.rateLimitType ? { rateLimitType: this.rateLimit.rateLimitType } : {}),
    };
  }
}

export function capacityTargetKey(target: CapacityTarget): string {
  return `${target.executor}:${target.provider}:${target.model}`;
}

function sameTarget(a: CapacityTarget, b: CapacityTarget): boolean {
  return a.executor === b.executor && a.provider === b.provider && a.model === b.model;
}

function waitMatchesTarget(wait: InfrastructureWait, target: CapacityTarget): boolean {
  const stored = targetOfWait(wait);
  return stored ? sameTarget(stored, target) : false;
}

/** Exact current-pool lookup. Ambiguous legacy worker waits intentionally do
 * not match a configured pool: one retry can re-establish scoped state, while
 * guessing could park or clear an unrelated provider with the same model name. */
export function capacityBackoffFor(
  doc: WorkstreamDoc,
  target: CapacityTarget,
): CapacityBackoff | undefined {
  return Object.values(doc.capacity?.byModel ?? {}).find((entry) =>
    waitMatchesTarget(entry.wait, target),
  );
}

export function hasCapacityBackoffForWait(doc: WorkstreamDoc, wait: InfrastructureWait): boolean {
  const target = targetOfWait(wait);
  if (target) return capacityBackoffFor(doc, target) !== undefined;
  return Object.values(doc.capacity?.byModel ?? {}).some(
    (entry) => entry.wait.source === wait.source && entry.wait.model === wait.model,
  );
}

/** Credential-file probes are a Claude Agent SDK recovery mechanism. They
 * must never be aimed at OpenHands/OpenRouter/Kimi waits. */
export function isClaudeSdkWait(wait: InfrastructureWait): boolean {
  const target = targetOfWait(wait);
  return !!target && target.executor === 'local-sdk' && target.provider === 'anthropic';
}

function providerName(provider: string | undefined): string {
  switch (provider?.toLowerCase()) {
    case 'anthropic': return 'Claude';
    case 'openai': return 'OpenAI';
    case 'openrouter': return 'OpenRouter';
    case 'moonshot':
    case 'moonshotai': return 'Moonshot';
    default: return provider && provider !== 'unknown'
      ? provider.charAt(0).toUpperCase() + provider.slice(1)
      : 'Provider';
  }
}

function waitProviderName(wait: InfrastructureWait): string {
  return providerName(targetOfWait(wait)?.provider);
}

function capacityAttentionPrefix(wait: InfrastructureWait): string {
  return `${waitProviderName(wait)} capacity${wait.executor ? ` via ${wait.executor}` : ''} (${wait.model}/`;
}

function windowLabel(window: string): string {
  switch (window) {
    case 'five_hour': return '5h';
    case 'seven_day': return '7d';
    case 'seven_day_opus': return 'Opus 7d';
    case 'seven_day_sonnet': return 'Sonnet 7d';
    case 'seven_day_overage_included': return 'included 7d';
    case 'overage': return 'extra usage';
    case 'unspecified': return 'plan';
    default: return window.replaceAll('_', ' ');
  }
}

function relativeUntil(iso: string, now: Date): string {
  const minutes = Math.ceil((Date.parse(iso) - now.getTime()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

const CAPACITY_OBSERVATION_FRESH_MS = 30 * 60_000;

export function recordProviderCapacityObservations(
  doc: WorkstreamDoc,
  observations: ProviderCapacityObservation[],
): void {
  if (!observations.length) return;
  const byWindow = new Map<string, ProviderCapacityObservation>();
  for (const observation of [...(doc.providerCapacity ?? []), ...observations]) {
    const key = `${observation.executor}:${observation.provider}:${observation.model}:${observation.window}`;
    const previous = byWindow.get(key);
    if (!previous || previous.observedAt <= observation.observedAt) byWindow.set(key, observation);
  }
  doc.providerCapacity = [...byWindow.values()]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, 24);
}

export function freshProviderCapacity(
  observations: ProviderCapacityObservation[],
  now = new Date(),
): ProviderCapacityObservation[] {
  return observations.filter((observation) => {
    const observed = Date.parse(observation.observedAt);
    if (!Number.isFinite(observed) || now.getTime() - observed > CAPACITY_OBSERVATION_FRESH_MS) return false;
    return !observation.resetAt || Date.parse(observation.resetAt) > now.getTime();
  });
}

/** One honest fleet-level signal. It is shown only while fresh; missing means
 * unknown, not 100%. The tightest reported window wins. */
export function providerCapacityHeadline(
  observations: ProviderCapacityObservation[],
  now = new Date(),
): string | undefined {
  const latestByWindow = new Map<string, ProviderCapacityObservation>();
  for (const observation of freshProviderCapacity(observations, now)) {
    const key = `${observation.executor}:${observation.provider}:${observation.window}`;
    const previous = latestByWindow.get(key);
    if (!previous || previous.observedAt < observation.observedAt) {
      latestByWindow.set(key, observation);
    }
  }
  const fresh = [...latestByWindow.values()];
  if (!fresh.length) return undefined;
  const ranked = [...fresh].sort((a, b) => {
    const status = (x: ProviderCapacityObservation): number =>
      x.status === 'rejected' ? 2 : x.status === 'allowed_warning' ? 1 : 0;
    return status(b) - status(a) || (b.utilization ?? -1) - (a.utilization ?? -1);
  });
  const observation = ranked[0]!;
  const name = providerName(observation.provider);
  const window = windowLabel(observation.window);
  const position = observation.utilization !== undefined
    ? `${Math.max(0, Math.round((1 - observation.utilization) * 100))}% left`
    : observation.status === 'rejected' ? 'at limit' : 'near limit';
  const reset = observation.resetAt ? ` · resets in ${relativeUntil(observation.resetAt, now)}` : '';
  const warning = observation.status === 'allowed' ? '' : '⚠ ';
  return `${warning}${name} ${window} ${position}${reset}`;
}

export interface CapacityPresentation {
  /** Present only when capacity prevents the next configured model transition. */
  blocking?: { summary: string; retryAt: string; recovery: string; needsHuman: boolean };
  details: string[];
  /** Latest stored waits that belong to a configured role with intended work. */
  relevantSourceIds: string[];
  retryEligibleSourceIds: string[];
  /** Process-local launchability is not provider capacity. Keep it separate
   * so the UI can be honest without inventing a retry timestamp. */
  executorUnavailable?: { summary: string };
}

function activeWait(entry: CapacityBackoff | undefined, nowIso: string): InfrastructureWait | undefined {
  return entry?.wait.retryAt && entry.wait.retryAt > nowIso ? entry.wait : undefined;
}

/** Scheduler and five-question presentation must agree on whether a worker
 * can make a real transition. A dependency is satisfied only by completed,
 * accepted work: adoption pins the artifact the downstream worker receives.
 * Rejected/cancelled/unknown dependencies provide no input and stay blocked. */
export function assignmentDependenciesSatisfied(doc: WorkstreamDoc, assignment: Assignment): boolean {
  return assignment.dependsOn.every((dependencyId) => {
    const dependency = doc.assignments.find((candidate) => candidate.id === dependencyId);
    return dependency?.state === 'completed' && dependency.adoption.state === 'accepted';
  });
}

/** First globally available target in reviewed order. A typed wait degrades
 * to the next target; a missing capability does not. Otherwise whichever host
 * wins the tick lock could silently defeat the reviewed preference. */
export function selectWorkerCapacityTarget(
  doc: WorkstreamDoc,
  assignment: Assignment,
  nowIso: string,
  executorCapabilities?: ReadonlySet<string>,
): CapacityTarget | undefined {
  const selected = workerTargetsForAssignment(assignment).find((target) =>
    activeWait(capacityBackoffFor(doc, target), nowIso) === undefined,
  );
  if (selected && executorCapabilities && !executorCapabilities.has(selected.executor)) {
    return undefined;
  }
  return selected;
}

/** Whether clearing this wait needs a person, or clears itself on a timer.
 * The board colours on this rather than on the category, because the two read
 * identically to an operator and mean opposite things: a session limit is the
 * fleet resting until its reset, while a usage limit sits there until someone
 * enables credits. Rendering both in the same blue is how "nothing is moving
 * and nobody is coming" looks exactly like ordinary scheduled waiting. */
function waitNeedsHuman(wait: InfrastructureWait): boolean {
  return wait.recovery !== 'automatic_retry';
}

function waitPosition(wait: InfrastructureWait, role: string, now: Date): string {
  const category = wait.kind === 'usage_limit' || wait.kind === 'sdk_credit_exhausted'
    ? 'usage limited'
    : wait.kind === 'session_limit' ? 'session limited'
      : wait.kind === 'auth' ? 'login required'
        : wait.kind === 'rate_limit' ? 'rate limited'
          : 'temporarily unavailable';
  return `${role} ${waitProviderName(wait)} ${wait.model} ${category} · retry in ${relativeUntil(wait.retryAt, now)}`;
}

/** Role-aware projection shared by status and both dashboards. Historical,
 * overdue, and unconfigured model records never turn a workstream into
 * WAITING. A limited primary with a usable fallback is degradation, not a
 * block. */
export function capacityPresentation(
  doc: WorkstreamDoc,
  nowIso: string,
  executorCapabilities: ReadonlySet<string> = runnerExecutorCapabilities(),
): CapacityPresentation {
  const now = new Date(nowIso);
  const primaryTarget = coordinatorCapacityTarget();
  const fallbackTarget = coordinatorFallbackCapacityTarget();
  const primaryEntry = capacityBackoffFor(doc, primaryTarget);
  const fallbackEntry = capacityBackoffFor(doc, fallbackTarget);
  const primary = activeWait(primaryEntry, nowIso);
  const fallback = sameTarget(primaryTarget, fallbackTarget)
    ? primary
    : activeWait(fallbackEntry, nowIso);
  const details: string[] = [];
  const currentCoordinatorTargets = [primaryTarget, fallbackTarget];
  const coordinatorIntent =
    doc.steering.some(isPendingSteering) ||
    (doc.managerDirections ?? []).some((direction) => !direction.consumedByPass) ||
    doc.assignments.some((assignment) => assignment.state === 'awaiting_review') ||
    doc.wakes.some((wake) => {
      if (wake.status !== 'pending') return false;
      if (wake.infrastructure) {
        return currentCoordinatorTargets.some((target) => waitMatchesTarget(wake.infrastructure!, target));
      }
      return wake.condition.type === 'immediate' ||
        (wake.condition.type === 'time' && wake.condition.dueAtVirtual <= nowIso) ||
        (wake.condition.type === 'wall_time' && wake.condition.dueAt <= new Date().toISOString());
    });

  if (coordinatorIntent && primary && !sameTarget(primaryTarget, fallbackTarget) && !fallback) {
    details.push(`${waitPosition(primary, 'coordinator primary', now)} · fallback ${fallbackTarget.model} available`);
  }
  const coordinatorBlockingWaits: InfrastructureWait[] = sameTarget(primaryTarget, fallbackTarget)
    ? (primary ? [primary] : [])
    : (primary && fallback ? [primary, fallback] : []);
  coordinatorBlockingWaits.sort((a, b) => a.retryAt.localeCompare(b.retryAt));
  const coordinatorBlocked = coordinatorIntent ? coordinatorBlockingWaits[0] : undefined;
  if (coordinatorIntent) {
    for (const wait of coordinatorBlockingWaits) {
      details.push(waitPosition(wait, 'coordinator', now));
    }
  }
  const selectedCoordinatorTarget = !primary
    ? primaryTarget
    : (!sameTarget(primaryTarget, fallbackTarget) && !fallback ? fallbackTarget : undefined);
  const executorWaits: string[] = [];
  const coordinatorExecutorWait = (
    coordinatorIntent &&
    selectedCoordinatorTarget &&
    !coordinatorBlocked &&
    !executorCapabilities.has(selectedCoordinatorTarget.executor)
  )
    ? `coordinator ${selectedCoordinatorTarget.model} waits for a runner declaring ${selectedCoordinatorTarget.executor}`
    : undefined;

  const queuedWorkerAssignments = doc.assignments.filter((assignment) =>
    assignment.state === 'queued' &&
    !assignment.exec?.run &&
    assignmentDependenciesSatisfied(doc, assignment),
  );
  const uniqueWorkerTargets = new Map<string, CapacityTarget>();
  for (const assignment of queuedWorkerAssignments) {
    for (const target of workerTargetsForAssignment(assignment)) {
      uniqueWorkerTargets.set(capacityTargetKey(target), target);
    }
  }
  const workerEntries: Array<readonly [string, CapacityBackoff | undefined]> =
    [...uniqueWorkerTargets.values()].map((target) => [
      `worker ${target.model}`,
      capacityBackoffFor(doc, target),
    ] as const);
  const activeWorkerWaits = workerEntries
    .map(([, entry]) => activeWait(entry, nowIso))
    .filter((wait): wait is InfrastructureWait => wait !== undefined);
  for (const wait of activeWorkerWaits) details.push(waitPosition(wait, 'worker', now));
  const selectedWorkerTargets = queuedWorkerAssignments.map((assignment) =>
    selectWorkerCapacityTarget(doc, assignment, nowIso),
  );
  const everyQueuedWorkerBlocked = selectedWorkerTargets.length > 0 &&
    selectedWorkerTargets.every((target) => target === undefined);
  const workerBlocked = everyQueuedWorkerBlocked
    ? [...activeWorkerWaits].sort((a, b) => a.retryAt.localeCompare(b.retryAt))[0]
    : undefined;
  const unsupportedWorkerTargets = selectedWorkerTargets.filter(
    (target): target is CapacityTarget => !!target && !executorCapabilities.has(target.executor),
  );
  const everyQueuedWorkerHeldHere = selectedWorkerTargets.length > 0 &&
    selectedWorkerTargets.every((target) => !target || !executorCapabilities.has(target.executor));
  const someWorkerRunnableHere = selectedWorkerTargets.some(
    (target) => !!target && executorCapabilities.has(target.executor),
  );
  const coordinatorRunnableHere = !!(
    coordinatorIntent &&
    selectedCoordinatorTarget &&
    !coordinatorBlocked &&
    executorCapabilities.has(selectedCoordinatorTarget.executor)
  );
  if (coordinatorExecutorWait && !someWorkerRunnableHere) executorWaits.push(coordinatorExecutorWait);
  if (everyQueuedWorkerHeldHere && unsupportedWorkerTargets.length && !coordinatorRunnableHere) {
    const target = unsupportedWorkerTargets[0]!;
    executorWaits.push(`worker ${target.model} waits for a runner declaring ${target.executor}`);
  }
  const executorUnavailable = executorWaits.length
    ? { summary: [...new Set(executorWaits)].join('; ') }
    : undefined;
  if (executorUnavailable) details.push(executorUnavailable.summary);

  const coordinatorEntries = sameTarget(primaryTarget, fallbackTarget)
    ? [['coordinator', primaryEntry] as const]
    : [
        ['coordinator primary', primaryEntry] as const,
        ['coordinator fallback', fallbackEntry] as const,
      ];
  const relevantEntries = [
    ...(coordinatorIntent ? coordinatorEntries : []),
    ...workerEntries,
  ];
  const retryEligibleSourceIds: string[] = [];
  for (const [role, entry] of relevantEntries) {
    if (entry && entry.wait.retryAt <= nowIso) {
      const line = `${role} ${waitProviderName(entry.wait)} ${entry.wait.model} retry eligible now`;
      if (!details.includes(line)) details.push(line);
      retryEligibleSourceIds.push(entry.wait.sourceId);
    }
  }

  const blockingCandidates = [
    ...(workerBlocked && !coordinatorRunnableHere ? [{ wait: workerBlocked, role: 'worker' }] : []),
    ...(coordinatorBlocked && !someWorkerRunnableHere
      ? [{ wait: coordinatorBlocked, role: 'coordinator' }]
      : []),
  ].sort((a, b) => a.wait.retryAt.localeCompare(b.wait.retryAt));
  const blockingWait = blockingCandidates[0]?.wait;
  const blockingRole = blockingCandidates[0]?.role ?? 'worker';
  return {
    ...(blockingWait ? {
      blocking: {
        summary: waitPosition(blockingWait, blockingRole, now),
        retryAt: blockingWait.retryAt,
        recovery: infrastructureWaitSummary(blockingWait, doc.workstream.slug),
        needsHuman: waitNeedsHuman(blockingWait),
      },
    } : {}),
    details,
    relevantSourceIds: [...new Set(relevantEntries.flatMap(([, entry]) => entry ? [entry.wait.sourceId] : []))],
    retryEligibleSourceIds: [...new Set(retryEligibleSourceIds)],
    ...(executorUnavailable ? { executorUnavailable } : {}),
  };
}

export function infrastructureWaitSummary(
  wait: InfrastructureWait,
  slug?: string,
): string {
  const retry = `weaver capacity retry ${slug ?? '<slug>'}`;
  const provider = waitProviderName(wait);
  const claude = provider === 'Claude';
  switch (wait.kind) {
    case 'usage_limit':
    case 'sdk_credit_exhausted':
      return claude
        ? `Claude plan usage is limited for ${wait.model}; dependent work is parked. Check \`/usage\` in Claude Code; wait for the reset or enable usage credits in Claude Settings > Usage, then run \`${retry}\`. Weaver never changes billing.`
        : `${provider} usage is limited for ${wait.model}; dependent work is parked until its scheduled retry. Check that provider's usage page, wait for its reset, or run \`${retry}\` after restoring capacity. Weaver never changes billing.`;
    case 'auth':
      return claude
        ? `Claude authentication needs attention for ${wait.model}; dependent work is parked. Run \`claude auth login\` in a terminal and complete the intended operator login. Weaver never accepts credentials or tokens; it retries when credential metadata changes, or after \`${retry}\`.`
        : `${provider} authentication needs attention for ${wait.model}; dependent work is parked. Repair the configured ${wait.executor ?? 'executor'} credentials, then run \`${retry}\`. Weaver never accepts or rotates credentials.`;
    case 'session_limit':
      return `${provider}'s session limit is active for ${wait.model}; dependent work is parked until its scheduled retry.`;
    case 'rate_limit':
      return `${provider} is rate limited for ${wait.model}; dependent work is parked until its scheduled retry.`;
    case 'other':
      return `${provider} is temporarily unavailable for ${wait.model}; dependent work is parked until its scheduled retry.`;
  }
}

export function recordCapacityBackoff(
  doc: WorkstreamDoc,
  wait: InfrastructureWait,
): CapacityBackoff {
  const target = targetOfWait(wait);
  const key = target ? capacityTargetKey(target) : wait.model;
  const previous = target
    ? capacityBackoffFor(doc, target)
    : doc.capacity?.byModel[wait.model];
  const previousInFamily = previous &&
    capacityFamily(previous.wait.kind) === capacityFamily(wait.kind)
    ? previous
    : undefined;
  const entry: CapacityBackoff = {
    wait,
    consecutiveBackoffs: previousInFamily ? previousInFamily.consecutiveBackoffs + 1 : 1,
    firstBackoffAtVirtual: previousInFamily?.firstBackoffAtVirtual ?? wait.detectedAt,
    lastBackoffAtVirtual: wait.detectedAt,
  };
  const byModel = { ...(doc.capacity?.byModel ?? {}) };
  if (target) {
    for (const [storedKey, stored] of Object.entries(byModel)) {
      if (waitMatchesTarget(stored.wait, target)) delete byModel[storedKey];
    }
  }
  doc.capacity = {
    state: 'backoff',
    byModel: { ...byModel, [key]: entry },
  };
  return entry;
}

export function clearCapacityBackoff(doc: WorkstreamDoc, target: CapacityTarget): void {
  if (!doc.capacity) return;
  const byModel = { ...doc.capacity.byModel };
  for (const [key, entry] of Object.entries(byModel)) {
    if (waitMatchesTarget(entry.wait, target)) delete byModel[key];
  }
  doc.capacity = Object.keys(byModel).length ? { state: 'backoff', byModel } : null;
}

export function capacityAttentionThreshold(category: CapacityCategory): number {
  return category === 'auth' ? 1 : 12;
}

export function capacityAttentionSummary(entry: CapacityBackoff, slug?: string): string {
  const { wait, consecutiveBackoffs } = entry;
  const retry = `weaver capacity retry ${slug ?? '<slug>'}`;
  const provider = waitProviderName(wait);
  const prefix = `${capacityAttentionPrefix(wait)}${wait.kind}) has blocked work ${consecutiveBackoffs} times.`;
  if (wait.kind === 'auth') {
    return provider === 'Claude'
      ? `${prefix} Run \`claude auth login\` and complete the intended operator login; Weaver reads no credential values. If credential metadata is unavailable, run \`${retry}\` afterward. Agent SDK plan guidance: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`
      : `${prefix} Repair the configured ${wait.executor ?? 'executor'} credentials, then run \`${retry}\`; Weaver reads no credential values.`;
  }
  if (wait.kind === 'usage_limit' || wait.kind === 'sdk_credit_exhausted') {
    return provider === 'Claude'
      ? `${prefix} Check \`/usage\` in Claude Code. Wait for the reset, or explicitly enable usage credits with a provider spending limit in Claude Settings > Usage, then run \`${retry}\`. Weaver never changes billing. Guidance: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan and https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans`
      : `${prefix} Check the provider's usage page, wait for its reset, then run \`${retry}\`. Weaver never changes billing.`;
  }
  return `${prefix} The limit should self-clear; check the provider status if it persists.`;
}

/** Make a stored provider wait due without claiming the provider recovered.
 * The next real coordinator/worker attempt is the proof: success clears the
 * matching capacity state, while another rejection records a fresh wait. */
export function retryCapacityNow(
  doc: WorkstreamDoc,
  now: string,
  requestedModel?: string,
): string[] {
  const entries = Object.entries(doc.capacity?.byModel ?? {})
    .filter(([, entry]) => !requestedModel || entry.wait.model === requestedModel);
  if (!entries.length) return [];
  const selectedModels = new Set(entries.map(([, entry]) => entry.wait.model));

  for (const wake of doc.wakes) {
    if (
      wake.status === 'pending' &&
      wake.condition.type === 'time' &&
      wake.infrastructure &&
      selectedModels.has(wake.infrastructure.model)
    ) {
      wake.condition = { type: 'time', dueAtVirtual: now };
      wake.infrastructure.retryAt = now;
    }
  }
  for (const assignment of doc.assignments) {
    const wait = assignment.attempts.at(-1)?.infrastructure;
    if (wait && selectedModels.has(wait.model)) wait.retryAt = now;
  }
  for (const [key] of entries) {
    doc.capacity!.byModel[key]!.wait.retryAt = now;
  }
  return [...selectedModels].sort();
}

export function retryCapacityTargetNow(
  doc: WorkstreamDoc,
  now: string,
  target: CapacityTarget,
): boolean {
  const matching = Object.entries(doc.capacity?.byModel ?? {})
    .filter(([, entry]) => waitMatchesTarget(entry.wait, target));
  if (!matching.length) return false;
  for (const wake of doc.wakes) {
    if (
      wake.status === 'pending' &&
      wake.condition.type === 'time' &&
      wake.infrastructure &&
      waitMatchesTarget(wake.infrastructure, target)
    ) {
      wake.condition = { type: 'time', dueAtVirtual: now };
      wake.infrastructure.retryAt = now;
    }
  }
  for (const assignment of doc.assignments) {
    const wait = assignment.attempts.at(-1)?.infrastructure;
    if (wait && waitMatchesTarget(wait, target)) wait.retryAt = now;
  }
  for (const [key] of matching) doc.capacity!.byModel[key]!.wait.retryAt = now;
  return true;
}

export function ensureCapacityAttention(
  doc: WorkstreamDoc,
  entry: CapacityBackoff,
  refId: string,
  makeId: () => string,
): void {
  if (entry.consecutiveBackoffs < capacityAttentionThreshold(entry.wait.kind)) return;
  const key = capacityAttentionPrefix(entry.wait);
  const existing = doc.attention.find(
    (item) => item.status === 'open' && item.kind === 'capacity' && item.summary.startsWith(key),
  );
  if (existing) {
    existing.summary = capacityAttentionSummary(entry, doc.workstream.slug);
    existing.refId = refId;
    return;
  }
  doc.attention.push({
    id: makeId(),
    kind: 'capacity',
    summary: capacityAttentionSummary(entry, doc.workstream.slug),
    refId,
    status: 'open',
    createdAt: new Date().toISOString(),
  });
}

export function resolveCapacityAttention(
  doc: WorkstreamDoc,
  target: CapacityTarget,
  resolvedBy: string,
): void {
  const keys = new Set([
    `${providerName(target.provider)} capacity via ${target.executor} (${target.model}/`,
    ...(target.provider === 'anthropic' ? [`Claude capacity (${target.model}/`] : []),
  ]);
  for (const item of doc.attention) {
    if (
      item.status === 'open' &&
      item.kind === 'capacity' &&
      [...keys].some((key) => item.summary.startsWith(key))
    ) {
      item.status = 'resolved';
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = resolvedBy;
    }
  }
}
