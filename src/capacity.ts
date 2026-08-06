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
  InfrastructureKind,
  InfrastructureRecovery,
  InfrastructureWait,
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
  /out of (?:usage credits|extra usage)|credits?_required|credit balance|billing|usage allocation (?:has been )?disabled|usage limit is set to \$?0|requires usage credits/i;
const AUTH_TEXT =
  /401|unauthoriz|authentication|not logged in|log ?in|oauth_org_not_allowed|token (?:revoked|expired)/i;
const RATE_TEXT =
  /session limit|rate.?limit|usage limit|quota|exceeded your|you(?:'|’)ve (?:hit|reached) your|429/i;
const PROVIDER_TEXT = /overloaded|529|server error|service unavailable/i;

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
    if (source.wallFired) {
      return this.make('timeout', 'automatic_retry', source, now);
    }
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
      CREDIT_TEXT.test(text);

    if (creditsRequired) {
      return this.make(
        'agent_sdk_credits_exhausted',
        'claim_sdk_credit_or_enable_usage_credits',
        source,
        now,
      );
    }
    if (
      this.errors.has('authentication_failed') ||
      this.errors.has('oauth_org_not_allowed') ||
      AUTH_TEXT.test(text)
    ) {
      return this.make('authentication', 'reauthenticate', source, now);
    }
    if (
      this.errors.has('rate_limit') ||
      this.rateLimit?.status === 'rejected' ||
      this.terminalReason === 'blocking_limit' ||
      RATE_TEXT.test(text)
    ) {
      return this.make('usage_limit', 'automatic_retry', source, now);
    }
    if (
      this.errors.has('overloaded') ||
      this.errors.has('server_error') ||
      PROVIDER_TEXT.test(text)
    ) {
      return this.make('provider_unavailable', 'automatic_retry', source, now);
    }
    return null;
  }

  private make(
    kind: InfrastructureKind,
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
    case 'agent_sdk_credits_exhausted':
      return 'Claude Agent SDK capacity is exhausted; work is safely parked. Claim the included SDK credit in Claude Settings > Usage, or run `/usage-credits` in Claude Code for paid overflow with a provider spend cap. Weaver will probe and resume automatically.';
    case 'authentication':
      return 'Claude authentication needs attention; work is safely parked. Run `claude auth login` in a terminal and complete the intended operator login. Weaver never accepts credentials or tokens and will detect recovery.';
    case 'usage_limit':
      return `Claude usage is limited; work is safely parked until ${wait.retryAt.slice(0, 16)}. Weaver will retry and probe automatically.`;
    case 'provider_unavailable':
      return `Claude is temporarily unavailable; work is safely parked until ${wait.retryAt.slice(0, 16)} and will resume automatically.`;
    case 'timeout':
      return `The Claude SDK stopped responding; work is safely parked until ${wait.retryAt.slice(0, 16)} and will retry automatically.`;
  }
}
