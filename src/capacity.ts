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

function isoFromEpoch(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function latestReset(info: SDKRateLimitInfo | undefined): string | undefined {
  const values = [info?.resetsAt, info?.overageResetsAt]
    .map(isoFromEpoch)
    .filter((v): v is string => Boolean(v));
  return values.sort().at(-1);
}

const CREDIT_TEXT =
  /out of (?:usage credits|extra usage)|credits?_required|\bcredits?\b|billing|usage allocation (?:has been )?disabled|usage limit is set to \$?0|requires usage credits|run \/usage-credits/i;
const AUTH_TEXT =
  /401|unauthoriz|authentication|not logged in|log ?in|oauth_org_not_allowed|token (?:revoked|expired)|process aborted/i;
const SESSION_TEXT = /session limit|hit your session limit/i;
// Limit wording varies by plan window ("hit your weekly limit · resets Aug 8",
// "reached your usage limit") and Anthropic renames these freely — so match
// the shape (hit/reached + any named limit + optional reset time), not one
// remembered phrasing. A miss here burns three strikes and pages the human
// with a fleet of false blockers, as the weekly limit did on 2026-08-06.
const RATE_TEXT =
  /rate.?limit|usage limit|quota|exceeded your|you(?:'|’)ve (?:reached|hit) your [\w -]*limit|(?:weekly|monthly|daily|5-?hour) limit|limit ·? ?resets/i;
const PROVIDER_TEXT = /overloaded|529|server error|service unavailable/i;

/** Compatibility classifier for thrown errors and older SDK result text.
 * Structured SDK fields take precedence in SdkFailureTracker, but this pure
 * function remains a strict superset of Weaver's original infra regex. */
export function classifyCapacityFailure(
  errorText: string,
  wallFired = false,
): CapacityCategory | null {
  if (wallFired) return 'other';
  if (CREDIT_TEXT.test(errorText)) return 'sdk_credit_exhausted';
  if (SESSION_TEXT.test(errorText)) return 'session_limit';
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
    const creditsRequired =
      this.rateLimit?.errorCode === 'credits_required' ||
      disabled === 'out_of_credits' ||
      disabled === 'seat_tier_level_disabled' ||
      disabled === 'member_level_disabled' ||
      disabled === 'seat_tier_zero_credit_limit' ||
      disabled === 'group_zero_credit_limit' ||
      disabled === 'member_zero_credit_limit' ||
      this.errors.has('billing_error') ||
      classifyCapacityFailure(text) === 'sdk_credit_exhausted';

    if (creditsRequired) {
      return this.make(
        'sdk_credit_exhausted',
        'claim_sdk_credit_or_enable_usage_credits',
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
    const resetAt = latestReset(this.rateLimit);
    const wallNow = source.wallNow ?? new Date();
    const resetDelay = resetAt ? Date.parse(resetAt) - wallNow.getTime() : -1;
    // Provider resets are wall-clock facts; Weaver wakes use virtual time.
    // Preserve the delay between them instead of comparing unlike clocks.
    const retryDelay = resetDelay > 0 ? resetDelay : DEFAULT_RETRY_MS;
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

export function infrastructureWaitSummary(wait: InfrastructureWait): string {
  switch (wait.kind) {
    case 'sdk_credit_exhausted':
      return 'Claude Agent SDK capacity is exhausted; work is safely parked. Claim the included SDK credit in Claude Settings > Usage, or run `/usage-credits` in Claude Code for paid overflow with a provider spend cap. Weaver will probe and resume automatically.';
    case 'auth':
      return 'Claude authentication needs attention; work is safely parked. Run `claude auth login` in a terminal and complete the intended operator login. Weaver never accepts credentials or tokens and will detect recovery.';
    case 'session_limit':
      return `Claude's session limit is active; work is safely parked until ${wait.retryAt.slice(0, 16)}. Weaver will retry and probe automatically.`;
    case 'rate_limit':
      return `Claude usage is limited; work is safely parked until ${wait.retryAt.slice(0, 16)}. Weaver will retry and probe automatically.`;
    case 'other':
      return `Claude is temporarily unavailable or stopped responding; work is safely parked until ${wait.retryAt.slice(0, 16)} and will retry automatically.`;
  }
}

export function recordCapacityBackoff(
  doc: WorkstreamDoc,
  wait: InfrastructureWait,
): CapacityBackoff {
  const previous = doc.capacity?.byModel[wait.model];
  const sameCategory = previous?.wait.kind === wait.kind;
  const entry: CapacityBackoff = {
    wait,
    consecutiveBackoffs: sameCategory ? previous.consecutiveBackoffs + 1 : 1,
    firstBackoffAtVirtual: sameCategory
      ? previous.firstBackoffAtVirtual
      : wait.detectedAt,
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
  return category === 'sdk_credit_exhausted' || category === 'auth' ? 3 : 12;
}

export function capacityAttentionSummary(entry: CapacityBackoff): string {
  const { wait, consecutiveBackoffs } = entry;
  const prefix = `Claude capacity (${wait.model}/${wait.kind}) has blocked work ${consecutiveBackoffs} times.`;
  if (wait.kind === 'auth') {
    return `${prefix} Run \`claude auth login\` and complete the intended operator login; Weaver reads no credential values. Agent SDK plan guidance: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`;
  }
  if (wait.kind === 'sdk_credit_exhausted') {
    return `${prefix} Claim the included Agent SDK credit, or enable paid overflow with a provider spend cap via \`/usage-credits\`. Guidance: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan and https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans`;
  }
  return `${prefix} The limit should self-clear; check Claude plan status if it persists. Guidance: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`;
}

export function ensureCapacityAttention(
  doc: WorkstreamDoc,
  entry: CapacityBackoff,
  refId: string,
  makeId: () => string,
): void {
  if (entry.consecutiveBackoffs < capacityAttentionThreshold(entry.wait.kind)) return;
  const key = `Claude capacity (${entry.wait.model}/${entry.wait.kind})`;
  const existing = doc.attention.find(
    (item) => item.status === 'open' && item.kind === 'capacity' && item.summary.startsWith(key),
  );
  if (existing) {
    existing.summary = capacityAttentionSummary(entry);
    existing.refId = refId;
    return;
  }
  doc.attention.push({
    id: makeId(),
    kind: 'capacity',
    summary: capacityAttentionSummary(entry),
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
