import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { infrastructureWaitSummary, SdkFailureTracker } from './capacity.js';

function observe(tracker: SdkFailureTracker, message: unknown): void {
  tracker.observe(message as SDKMessage);
}

const source = {
  source: 'coordinator' as const,
  sourceId: 'pass_test',
  model: 'claude-fable-5',
  now: new Date('2026-08-06T10:00:00.000Z'),
  wallNow: new Date('2026-08-06T10:00:00.000Z'),
};

test('structured credits_required becomes a closed, non-poolable Agent SDK wait', () => {
  const tracker = new SdkFailureTracker();
  observe(tracker, {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      errorCode: 'credits_required',
      overageDisabledReason: 'out_of_credits',
      resetsAt: Date.parse('2026-08-07T09:00:00.000Z') / 1000,
      rateLimitType: 'overage',
    },
  });

  const wait = tracker.classify(source)!;
  assert.equal(wait.kind, 'agent_sdk_credits_exhausted');
  assert.equal(wait.recovery, 'claim_sdk_credit_or_enable_usage_credits');
  assert.equal(wait.retryAt, '2026-08-07T09:00:00.000Z');
  assert.equal(wait.rateLimitType, 'overage');
  assert.doesNotMatch(JSON.stringify(wait), /account|token|credential|rotate|pool/i);
});

test('SDKResultError.errors is inspected instead of becoming a generic model error', () => {
  const tracker = new SdkFailureTracker();
  observe(tracker, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ["You're out of usage credits. Run /usage-credits to continue."],
    terminal_reason: 'blocking_limit',
  });
  assert.equal(tracker.classify(source)?.kind, 'agent_sdk_credits_exhausted');
});

test('typed assistant errors distinguish auth, rate limits, and provider outages', () => {
  const cases = [
    ['authentication_failed', 'authentication', 'reauthenticate'],
    ['rate_limit', 'usage_limit', 'automatic_retry'],
    ['overloaded', 'provider_unavailable', 'automatic_retry'],
  ] as const;
  for (const [error, kind, recovery] of cases) {
    const tracker = new SdkFailureTracker();
    observe(tracker, { type: 'assistant', error });
    const wait = tracker.classify(source)!;
    assert.equal(wait.kind, kind);
    assert.equal(wait.recovery, recovery);
  }
});

test('allowed warnings and ordinary model failures are not infrastructure', () => {
  const warning = new SdkFailureTracker();
  observe(warning, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
  assert.equal(warning.classify(source), null);

  const ordinary = new SdkFailureTracker();
  observe(ordinary, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['tool schema was invalid'],
  });
  assert.equal(ordinary.classify(source), null);
});

test('thrown compatibility errors and the hard wall classify without persisting raw text', () => {
  const thrown = new SdkFailureTracker();
  thrown.capture(new Error('API 529 overloaded; internal request id secret-request-value'));
  const provider = thrown.classify(source)!;
  assert.equal(provider.kind, 'provider_unavailable');
  assert.doesNotMatch(JSON.stringify(provider), /secret-request-value/);

  const timedOut = new SdkFailureTracker();
  const timeout = timedOut.classify({ ...source, wallFired: true })!;
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.recovery, 'automatic_retry');
});

test('operator summaries expose supported recovery without account cycling', () => {
  const tracker = new SdkFailureTracker();
  observe(tracker, { type: 'assistant', error: 'billing_error' });
  const summary = infrastructureWaitSummary(tracker.classify(source)!);
  assert.match(summary, /included SDK credit/);
  assert.match(summary, /`\/usage-credits`/);
  assert.doesNotMatch(summary, /switch|rotate|pool|mint/i);
});
