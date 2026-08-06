import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  capacityAttentionThreshold,
  classifyCapacityFailure,
  infrastructureWaitSummary,
  recordCapacityBackoff,
  SdkFailureTracker,
} from './capacity.js';
import type { WorkstreamDoc } from './types.js';

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
  assert.equal(wait.kind, 'sdk_credit_exhausted');
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
  assert.equal(tracker.classify(source)?.kind, 'sdk_credit_exhausted');
});

test('typed assistant errors distinguish auth, rate limits, and provider outages', () => {
  const cases = [
    ['authentication_failed', 'auth', 'reauthenticate'],
    ['rate_limit', 'rate_limit', 'automatic_retry'],
    ['overloaded', 'other', 'automatic_retry'],
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
  assert.equal(provider.kind, 'other');
  assert.doesNotMatch(JSON.stringify(provider), /secret-request-value/);

  const timedOut = new SdkFailureTracker();
  const timeout = timedOut.classify({ ...source, wallFired: true })!;
  assert.equal(timeout.kind, 'other');
  assert.equal(timeout.recovery, 'automatic_retry');
});

test('the pure compatibility classifier is a categorized superset of the old regex', () => {
  assert.equal(classifyCapacityFailure("You've hit your session limit"), 'session_limit');
  assert.equal(classifyCapacityFailure("You're out of usage credits. Run /usage-credits"), 'sdk_credit_exhausted');
  assert.equal(classifyCapacityFailure('429 rate limit'), 'rate_limit');
  assert.equal(classifyCapacityFailure('401 unauthorized'), 'auth');
  assert.equal(classifyCapacityFailure('529 overloaded'), 'other');
  assert.equal(classifyCapacityFailure('quota exceeded'), 'rate_limit');
  assert.equal(classifyCapacityFailure('ordinary model error'), null);
  assert.equal(classifyCapacityFailure('', true), 'other');
});

test('typed capacity state preserves independent models and category thresholds', () => {
  const doc = { capacity: null } as WorkstreamDoc;
  const credit = new SdkFailureTracker();
  observe(credit, { type: 'assistant', error: 'billing_error' });
  const fable = credit.classify(source)!;
  const first = recordCapacityBackoff(doc, fable);
  const second = recordCapacityBackoff(doc, fable);
  const sonnet = { ...fable, source: 'worker' as const, sourceId: 'run_sonnet', model: 'sonnet' };
  recordCapacityBackoff(doc, sonnet);

  assert.equal(first.consecutiveBackoffs, 1);
  assert.equal(second.consecutiveBackoffs, 2);
  assert.deepEqual(Object.keys(doc.capacity!.byModel).sort(), ['claude-fable-5', 'sonnet']);
  assert.equal(capacityAttentionThreshold('sdk_credit_exhausted'), 3);
  assert.equal(capacityAttentionThreshold('auth'), 3);
  assert.equal(capacityAttentionThreshold('session_limit'), 12);
  assert.equal(capacityAttentionThreshold('rate_limit'), 12);
});

test('operator summaries expose supported recovery without account cycling', () => {
  const tracker = new SdkFailureTracker();
  observe(tracker, { type: 'assistant', error: 'billing_error' });
  const summary = infrastructureWaitSummary(tracker.classify(source)!);
  assert.match(summary, /included SDK credit/);
  assert.match(summary, /`\/usage-credits`/);
  assert.doesNotMatch(summary, /switch|rotate|pool|mint/i);
});
