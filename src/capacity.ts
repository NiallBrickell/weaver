/**
 * Claude Agent SDK capacity/auth failures, normalized into typed durable waits.
 *
 * Current SDKs report the same outage through several surfaces: assistant
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
  CapacityBackoff,
  CapacityCategory,
  InfrastructureRecovery,
  InfrastructureWait,
  WorkstreamDoc,
} from './types.js';

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
  private terminalReason?: string;

  observe(message: SDKMessage): void {
    if (message.type === 'assistant' && message.error) {
      this.errors.add(message.error);
      this.failed = true;
    }
    if (message.type === 'rate_limit_event') {
      if (message.rate_limit_info.status === 'rejected') {
        this.failed = true;
        this.rateLimit = message.rate_limit_info;
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
      detectedAt: now.toISOString(),
      retryAt,
      ...(resetAt ? { resetAt } : {}),
      ...(this.rateLimit?.rateLimitType ? { rateLimitType: this.rateLimit.rateLimitType } : {}),
    };
  }
}

export function infrastructureWaitSummary(
  wait: InfrastructureWait,
  slug?: string,
): string {
  const retry = `weaver capacity retry ${slug ?? '<slug>'}`;
  switch (wait.kind) {
    case 'usage_limit':
    case 'sdk_credit_exhausted':
      return `Claude plan usage is limited; work is safely parked until its scheduled retry. Check \`/usage\` in Claude Code; wait for the reset or explicitly enable usage credits in Claude Settings > Usage, then run \`${retry}\`. Weaver never changes billing.`;
    case 'auth':
      return `Claude authentication needs attention; work is safely parked. Run \`claude auth login\` in a terminal and complete the intended operator login. Weaver never accepts credentials or tokens; it retries when credential metadata changes, or after \`${retry}\`.`;
    case 'session_limit':
      return "Claude's session limit is active; work is safely parked until its scheduled retry.";
    case 'rate_limit':
      return 'Claude is rate limited; work is safely parked until its scheduled retry.';
    case 'other':
      return 'Claude is temporarily unavailable or stopped responding; work is safely parked until its scheduled retry.';
  }
}

export function recordCapacityBackoff(
  doc: WorkstreamDoc,
  wait: InfrastructureWait,
): CapacityBackoff {
  const previous = doc.capacity?.byModel[wait.model];
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
  doc.capacity = {
    state: 'backoff',
    byModel: { ...(doc.capacity?.byModel ?? {}), [wait.model]: entry },
  };
  return entry;
}

export function clearCapacityBackoff(doc: WorkstreamDoc, model: string): void {
  if (!doc.capacity?.byModel[model]) return;
  const byModel = { ...doc.capacity.byModel };
  delete byModel[model];
  doc.capacity = Object.keys(byModel).length ? { state: 'backoff', byModel } : null;
}

export function capacityAttentionThreshold(category: CapacityCategory): number {
  return category === 'auth' ? 1 : 12;
}

export function capacityAttentionSummary(entry: CapacityBackoff, slug?: string): string {
  const { wait, consecutiveBackoffs } = entry;
  const retry = `weaver capacity retry ${slug ?? '<slug>'}`;
  const prefix = `Claude capacity (${wait.model}/${wait.kind}) has blocked work ${consecutiveBackoffs} times.`;
  if (wait.kind === 'auth') {
    return `${prefix} Run \`claude auth login\` and complete the intended operator login; Weaver reads no credential values. If credential metadata is unavailable, run \`${retry}\` afterward. Agent SDK plan guidance: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`;
  }
  if (wait.kind === 'usage_limit' || wait.kind === 'sdk_credit_exhausted') {
    return `${prefix} Check \`/usage\` in Claude Code. Wait for the reset, or explicitly enable usage credits with a provider spending limit in Claude Settings > Usage, then run \`${retry}\`. Weaver never changes billing. Guidance: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan and https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans`;
  }
  return `${prefix} The limit should self-clear; check Claude plan status if it persists. Guidance: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`;
}

/** Make a stored provider wait due without claiming the provider recovered.
 * The next real coordinator/worker attempt is the proof: success clears the
 * matching capacity state, while another rejection records a fresh wait. */
export function retryCapacityNow(
  doc: WorkstreamDoc,
  now: string,
  requestedModel?: string,
): string[] {
  const models = Object.keys(doc.capacity?.byModel ?? {})
    .filter((model) => !requestedModel || model === requestedModel);
  if (!models.length) return [];
  const selected = new Set(models);

  for (const wake of doc.wakes) {
    if (
      wake.status === 'pending' &&
      wake.condition.type === 'time' &&
      wake.infrastructure &&
      selected.has(wake.infrastructure.model)
    ) {
      wake.condition = { type: 'time', dueAtVirtual: now };
      wake.infrastructure.retryAt = now;
    }
  }
  for (const assignment of doc.assignments) {
    const wait = assignment.attempts.at(-1)?.infrastructure;
    if (wait && selected.has(wait.model)) wait.retryAt = now;
  }
  for (const model of models) {
    doc.capacity!.byModel[model]!.wait.retryAt = now;
  }
  return models.sort();
}

export function ensureCapacityAttention(
  doc: WorkstreamDoc,
  entry: CapacityBackoff,
  refId: string,
  makeId: () => string,
): void {
  if (entry.consecutiveBackoffs < capacityAttentionThreshold(entry.wait.kind)) return;
  const key = `Claude capacity (${entry.wait.model}/`;
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
  model: string,
  resolvedBy: string,
): void {
  const key = `Claude capacity (${model}/`;
  for (const item of doc.attention) {
    if (item.status === 'open' && item.kind === 'capacity' && item.summary.startsWith(key)) {
      item.status = 'resolved';
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = resolvedBy;
    }
  }
}
