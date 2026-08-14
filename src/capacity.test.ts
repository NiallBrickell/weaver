import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  capacityAttentionThreshold,
  capacityBackoffFor,
  capacityPresentation,
  classifyCapacityFailure,
  clearCapacityBackoff,
  infrastructureWaitSummary,
  providerCapacityHeadline,
  recordCapacityBackoff,
  retryCapacityNow,
  SdkFailureTracker,
} from './capacity.js';
import { coordinatorCapacityTarget, workerCapacityTarget } from './modelConfig.js';
import type { WorkstreamDoc } from './types.js';

function observe(tracker: SdkFailureTracker, message: unknown): void {
  tracker.observe(message as SDKMessage);
}

const source = {
  source: 'coordinator' as const,
  sourceId: 'pass_test',
  model: 'claude-fable-5',
  executor: 'local-sdk',
  provider: 'anthropic',
  now: new Date('2026-08-06T10:00:00.000Z'),
  wallNow: new Date('2026-08-06T10:00:00.000Z'),
};

test('structured credits_required becomes a closed, non-poolable plan usage wait', () => {
  const tracker = new SdkFailureTracker();
  observe(tracker, {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      errorCode: 'credits_required',
      overageDisabledReason: 'out_of_credits',
      resetsAt: Date.parse('2026-08-07T09:00:00.000Z') / 1000,
      overageResetsAt: Date.parse('2026-08-08T09:00:00.000Z') / 1000,
      rateLimitType: 'overage',
    },
  });

  const wait = tracker.classify(source)!;
  assert.equal(wait.kind, 'usage_limit');
  assert.equal(wait.recovery, 'wait_or_enable_usage_credits');
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
  assert.equal(tracker.classify(source)?.kind, 'usage_limit');
});

test('a usage limit with no provider reset backs off an hour, not the 15-minute default', () => {
  // No resetsAt in the signal, so Weaver must guess the backoff. A plan-usage
  // cap does not clear in 15 minutes — probing that often just re-parks the
  // exhausted pool every cycle (the Fable-dead-for-days thrash).
  const usage = new SdkFailureTracker();
  observe(usage, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ["You're out of usage credits. Run /usage-credits to continue."],
    terminal_reason: 'blocking_limit',
  });
  const usageWait = usage.classify(source)!;
  assert.equal(usageWait.kind, 'usage_limit');
  assert.equal(
    usageWait.retryAt,
    '2026-08-06T11:00:00.000Z',
    'usage limit waits an hour when the provider supplies no reset time',
  );

  // A transient outage is NOT a usage cap: it keeps the short 15-minute default
  // so genuinely brief blips recover fast.
  const transient = new SdkFailureTracker();
  observe(transient, { type: 'assistant', error: 'overloaded' });
  const transientWait = transient.classify(source)!;
  assert.equal(transientWait.kind, 'other');
  assert.equal(
    transientWait.retryAt,
    '2026-08-06T10:15:00.000Z',
    'a transient outage keeps the 15-minute default',
  );
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

test('structured plan windows distinguish session and weekly usage limits', () => {
  const cases = [
    ['five_hour', 'session_limit', 'automatic_retry'],
    ['seven_day_sonnet', 'usage_limit', 'wait_or_enable_usage_credits'],
  ] as const;
  for (const [rateLimitType, kind, recovery] of cases) {
    const tracker = new SdkFailureTracker();
    observe(tracker, {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType },
    });
    const wait = tracker.classify(source)!;
    assert.equal(wait.kind, kind);
    assert.equal(wait.recovery, recovery);
  }
});

test('allowed warnings and ordinary model failures are not infrastructure', () => {
  const warning = new SdkFailureTracker();
  observe(warning, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
  assert.equal(warning.classify(source), null);
  assert.deepEqual(warning.capacityObservations(source), [{
    executor: 'local-sdk',
    provider: 'anthropic',
    model: 'claude-fable-5',
    window: 'unspecified',
    status: 'allowed_warning',
    observedAt: source.wallNow.toISOString(),
  }]);

  const wrongScale = new SdkFailureTracker();
  observe(wrongScale, {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 82 },
  });
  assert.deepEqual(wrongScale.capacityObservations(source), []);

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
  assert.equal(classifyCapacityFailure("You're out of usage credits. Run /usage-credits"), 'usage_limit');
  assert.equal(classifyCapacityFailure("You've reached your weekly limit"), 'usage_limit');
  assert.equal(classifyCapacityFailure("You've hit your weekly limit · resets Aug 8"), 'usage_limit');
  assert.equal(classifyCapacityFailure('429 rate limit'), 'rate_limit');
  assert.equal(classifyCapacityFailure('401 unauthorized'), 'auth');
  assert.equal(classifyCapacityFailure('529 overloaded'), 'other');
  assert.equal(classifyCapacityFailure('quota exceeded'), 'rate_limit');
  assert.equal(classifyCapacityFailure('ordinary model error'), null);
  assert.equal(classifyCapacityFailure('', true), 'other');
});

test('legacy SDK-credit state continues the same usage-limit backoff lineage', () => {
  const current = new SdkFailureTracker();
  observe(current, { type: 'assistant', error: 'billing_error' });
  const wait = current.classify(source)!;
  const doc = {
    capacity: {
      state: 'backoff' as const,
      byModel: {
        'claude-fable-5': {
          wait: {
            ...wait,
            kind: 'sdk_credit_exhausted' as const,
            recovery: 'claim_sdk_credit_or_enable_usage_credits' as const,
          },
          consecutiveBackoffs: 4,
          firstBackoffAtVirtual: wait.detectedAt,
          lastBackoffAtVirtual: wait.detectedAt,
        },
      },
    },
  } as unknown as WorkstreamDoc;

  assert.equal(recordCapacityBackoff(doc, wait).consecutiveBackoffs, 5);
  assert.equal(capacityBackoffFor(doc, coordinatorCapacityTarget('claude-fable-5'))!.wait.kind, 'usage_limit');
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
  assert.deepEqual(
    Object.values(doc.capacity!.byModel).map((entry) => entry.wait.model).sort(),
    ['claude-fable-5', 'sonnet'],
  );
  assert.equal(capacityAttentionThreshold('usage_limit'), 12);
  assert.equal(capacityAttentionThreshold('sdk_credit_exhausted'), 12);
  assert.equal(capacityAttentionThreshold('auth'), 1);
  assert.equal(capacityAttentionThreshold('session_limit'), 12);
  assert.equal(capacityAttentionThreshold('rate_limit'), 12);
});

test('equal model labels on different executors remain independent pools', () => {
  const doc = { capacity: null } as WorkstreamDoc;
  const tracker = new SdkFailureTracker();
  observe(tracker, { type: 'assistant', error: 'rate_limit' });
  const local = tracker.classify({ ...source, source: 'worker', model: 'sonnet' })!;
  const remote = {
    ...local,
    sourceId: 'run_remote',
    executor: 'openhands',
    provider: 'openrouter',
  };
  recordCapacityBackoff(doc, local);
  recordCapacityBackoff(doc, remote);
  assert.equal(Object.keys(doc.capacity!.byModel).length, 2);

  clearCapacityBackoff(doc, workerCapacityTarget('sonnet', 'local-sdk'));
  assert.equal(Object.keys(doc.capacity!.byModel).length, 1);
  assert.equal(Object.values(doc.capacity!.byModel)[0]!.wait.provider, 'openrouter');
  assert.match(infrastructureWaitSummary(remote), /^OpenRouter is rate limited/);
  assert.doesNotMatch(infrastructureWaitSummary(remote), /Claude/);
});

test('operator summaries expose supported recovery without account cycling', () => {
  const tracker = new SdkFailureTracker();
  observe(tracker, { type: 'assistant', error: 'billing_error' });
  const summary = infrastructureWaitSummary(tracker.classify(source)!);
  assert.match(summary, /Check `\/usage`/);
  assert.match(summary, /Claude Settings > Usage/);
  assert.match(summary, /weaver capacity retry <slug>/);
  assert.match(summary, /never changes billing/);
  assert.doesNotMatch(summary, /switch|rotate|pool|mint/i);
});

test('fresh provider utilization becomes honest remaining headroom and then expires', () => {
  const now = new Date('2026-08-06T10:00:00.000Z');
  const observation = {
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
    window: 'five_hour', status: 'allowed_warning' as const, utilization: 0.82,
    observedAt: now.toISOString(), resetAt: '2026-08-06T12:00:00.000Z',
  };
  assert.equal(providerCapacityHeadline([observation], now), '⚠ Claude 5h 18% left · resets in 2h');
  assert.equal(providerCapacityHeadline([
    observation,
    { ...observation, status: 'allowed', utilization: 0.2, observedAt: '2026-08-06T10:01:00.000Z' },
  ], new Date('2026-08-06T10:02:00.000Z')), 'Claude 5h 80% left · resets in 2h');
  assert.equal(providerCapacityHeadline([observation], new Date('2026-08-06T10:31:00.000Z')), undefined);
});

test('capacity presentation distinguishes fallback degradation from a real block', () => {
  const previousFallback = process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = 'claude-opus-5';
  try {
    const tracker = new SdkFailureTracker();
    observe(tracker, { type: 'assistant', error: 'rate_limit' });
    const primary = tracker.classify(source)!;
    const doc = {
      assignments: [], capacity: null, workstream: { slug: 'view' },
      steering: [], managerDirections: [],
      wakes: [{ status: 'pending', infrastructure: primary, condition: { type: 'time', dueAtVirtual: primary.retryAt } }],
    } as unknown as WorkstreamDoc;
    recordCapacityBackoff(doc, primary);
    const degraded = capacityPresentation(doc, source.now.toISOString());
    assert.equal(degraded.blocking, undefined);
    assert.match(degraded.details[0]!, /fallback claude-opus-5 available/);

    recordCapacityBackoff(doc, { ...primary, sourceId: 'pass_fallback', model: 'claude-opus-5' });
    assert.match(capacityPresentation(doc, source.now.toISOString()).blocking!.summary, /^coordinator /);
  } finally {
    if (previousFallback === undefined) delete process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
    else process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = previousFallback;
  }
});

test('capacity presentation ignores a stale wait for a withdrawn route and blocks on the configured fallback', () => {
  const now = source.now.toISOString();
  const retryAt = new Date(source.now.getTime() + 60_000).toISOString();
  const assignment = (id: string, profile: 'general' | 'bounded-code-repair') => ({
    id, objective: id, briefing: 'n/a', kind: 'work' as const,
    executionRequirements: { profile, modalities: ['text' as const] },
    acceptanceCriteria: ['done'], dependsOn: [], state: 'queued' as const,
    attempts: [], adoption: { state: 'none' as const }, createdAtVirtual: now,
  });
  const doc = {
    workstream: { slug: 'routed-view' },
    assignments: [assignment('asg_codex', 'bounded-code-repair'), assignment('asg_general', 'general')],
    capacity: null, steering: [], managerDirections: [], wakes: [],
  } as unknown as WorkstreamDoc;
  const wait = {
    kind: 'rate_limit' as const, recovery: 'automatic_retry' as const,
    source: 'worker' as const, sourceId: 'run_codex',
    executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
    detectedAt: now, retryAt,
  };
  recordCapacityBackoff(doc, wait);

  const degraded = capacityPresentation(doc, now);
  assert.equal(degraded.blocking, undefined);
  assert.doesNotMatch(degraded.details.join('\n'), /gpt-5\.6-sol/);

  recordCapacityBackoff(doc, {
    ...wait, sourceId: 'run_general', executor: 'local-sdk', provider: 'anthropic', model: 'sonnet',
  });
  assert.match(capacityPresentation(doc, now).blocking!.summary, /^worker /);
});

test('a block says whether recovery is a persons move or a timers', () => {
  const previousFallback = process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = process.env.WEAVER_COORDINATOR_MODEL ?? 'claude-fable-5';
  try {
    const build = (wait: ReturnType<SdkFailureTracker['classify']>) => {
      const doc = {
        assignments: [], capacity: null, workstream: { slug: 'view' },
        steering: [], managerDirections: [],
        wakes: [{ status: 'pending', infrastructure: wait, condition: { type: 'time', dueAtVirtual: wait!.retryAt } }],
      } as unknown as WorkstreamDoc;
      recordCapacityBackoff(doc, wait!);
      return capacityPresentation(doc, source.now.toISOString());
    };

    // A session limit clears on its own reset — nobody has anything to do.
    const rateLimited = new SdkFailureTracker();
    observe(rateLimited, { type: 'assistant', error: 'rate_limit' });
    const auto = build(rateLimited.classify(source));
    assert.equal(auto.blocking!.needsHuman, false);

    // A usage limit sits there until a person enables credits or waits it out.
    const outOfCredits = new SdkFailureTracker();
    observe(outOfCredits, {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected', errorCode: 'credits_required',
        overageDisabledReason: 'out_of_credits',
        resetsAt: Date.parse('2026-08-07T09:00:00.000Z') / 1000,
        rateLimitType: 'overage',
      },
    });
    const human = build(outOfCredits.classify(source));
    assert.equal(human.blocking!.needsHuman, true);
  } finally {
    if (previousFallback === undefined) delete process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
    else process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = previousFallback;
  }
});

test('an explicit retry makes typed waits due without claiming recovery', () => {
  const retryAt = '2026-08-07T09:00:00.000Z';
  const infrastructure = {
    kind: 'usage_limit' as const,
    recovery: 'wait_or_enable_usage_credits' as const,
    source: 'worker' as const,
    sourceId: 'run_wait',
    model: 'sonnet',
    detectedAt: source.now.toISOString(),
    retryAt,
  };
  const doc = {
    wakes: [{
      id: 'wake_wait', reason: 'typed wait', condition: { type: 'time', dueAtVirtual: retryAt } as const,
      status: 'pending' as const, createdAt: source.now.toISOString(), infrastructure,
    }],
    assignments: [{ attempts: [{ infrastructure }] }],
    capacity: {
      state: 'backoff' as const,
      byModel: { sonnet: {
        wait: infrastructure, consecutiveBackoffs: 1,
        firstBackoffAtVirtual: source.now.toISOString(), lastBackoffAtVirtual: source.now.toISOString(),
      } },
    },
  } as unknown as WorkstreamDoc;

  assert.deepEqual(retryCapacityNow(doc, source.now.toISOString()), ['sonnet']);
  assert.equal(doc.wakes[0]!.condition.type === 'time' && doc.wakes[0]!.condition.dueAtVirtual, source.now.toISOString());
  assert.equal(doc.assignments[0]!.attempts[0]!.infrastructure!.retryAt, source.now.toISOString());
  assert.equal(doc.capacity!.byModel.sonnet!.wait.retryAt, source.now.toISOString());
  assert.equal(doc.capacity!.state, 'backoff');
});
