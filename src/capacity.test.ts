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

test('provider failures back off while worker walls remain ordinary attempt failures', () => {
  const thrown = new SdkFailureTracker();
  thrown.capture(new Error('API 529 overloaded; internal request id secret-request-value'));
  const provider = thrown.classify(source)!;
  assert.equal(provider.kind, 'other');
  assert.doesNotMatch(JSON.stringify(provider), /secret-request-value/);

  const workerWall = new SdkFailureTracker();
  workerWall.capture(new Error('The operation was aborted'));
  assert.equal(workerWall.classify({ ...source, source: 'worker', wallFired: true }), null);

  const coordinatorWall = new SdkFailureTracker();
  coordinatorWall.capture(new Error('The operation was aborted'));
  const retry = coordinatorWall.classify({ ...source, source: 'coordinator', wallFired: true })!;
  assert.equal(retry.kind, 'other');
  assert.equal(retry.recovery, 'automatic_retry');
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
  // Machine-wide connectivity loss (observed 2026-08-16 overnight: DNS
  // dropout hit both Claude and Codex) is infrastructure, not work failure.
  assert.equal(classifyCapacityFailure('API Error: Unable to connect to API (ENOTFOUND)'), 'other');
  assert.equal(classifyCapacityFailure('stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)'), 'other');
  assert.equal(classifyCapacityFailure('fetch failed: getaddrinfo EAI_AGAIN api.example.com'), 'other');
  assert.equal(classifyCapacityFailure('409 run inference request limit reached'), null);
  assert.equal(classifyCapacityFailure('ordinary model error'), null);
  assert.equal(classifyCapacityFailure('', true), null);
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
    const primary = {
      ...tracker.classify(source)!,
      retryAt: new Date(source.now.getTime() + 60_000).toISOString(),
    };
    const doc = {
      assignments: [], capacity: null, workstream: { slug: 'view' },
      steering: [], managerDirections: [],
      wakes: [{ status: 'pending', infrastructure: primary, condition: { type: 'time', dueAtVirtual: primary.retryAt } }],
    } as unknown as WorkstreamDoc;
    recordCapacityBackoff(doc, primary);
    const degraded = capacityPresentation(doc, source.now.toISOString());
    assert.equal(degraded.blocking, undefined);
    assert.match(degraded.details[0]!, /fallback claude-opus-5 available/);

    const fallbackRetryAt = new Date(source.now.getTime() + 30_000).toISOString();
    recordCapacityBackoff(doc, {
      ...primary,
      sourceId: 'pass_fallback',
      model: 'claude-opus-5',
      retryAt: fallbackRetryAt,
    });
    const blocked = capacityPresentation(doc, source.now.toISOString()).blocking!;
    assert.match(blocked.summary, /^coordinator /);
    assert.equal(blocked.retryAt, fallbackRetryAt, 'fallback recovery is the next real transition');
  } finally {
    if (previousFallback === undefined) delete process.env.WEAVER_COORDINATOR_FALLBACK_MODEL;
    else process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = previousFallback;
  }
});

test('capacity presentation chooses the earliest transition across roles and does not hide runnable coordination', () => {
  const names = [
    'WEAVER_EXECUTOR',
    'WEAVER_WORKER_MODEL',
    'WEAVER_COORDINATOR_EXECUTOR',
    'WEAVER_COORDINATOR_MODEL',
    'WEAVER_COORDINATOR_FALLBACK_EXECUTOR',
    'WEAVER_COORDINATOR_FALLBACK_MODEL',
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.WEAVER_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
  process.env.WEAVER_COORDINATOR_EXECUTOR = 'local-sdk';
  process.env.WEAVER_COORDINATOR_MODEL = 'claude-fable-5';
  process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR = 'local-sdk';
  process.env.WEAVER_COORDINATOR_FALLBACK_MODEL = 'claude-opus-5';
  try {
    const now = source.now.toISOString();
    const assignment = {
      id: 'asg_remote', objective: 'bounded repair', briefing: 'n/a', kind: 'work' as const,
      executionRequirements: { profile: 'bounded-code-repair' as const, modalities: ['text' as const] },
      acceptanceCriteria: ['done'], dependsOn: [] as string[], state: 'queued' as const,
      attempts: [], adoption: { state: 'none' as const }, createdAtVirtual: now,
    };
    const runnableCoordinatorDoc = {
      workstream: { slug: 'mixed-progress' }, assignments: [assignment], capacity: null,
      steering: [], managerDirections: [],
      wakes: [{ status: 'pending', condition: { type: 'immediate' } }],
    } as unknown as WorkstreamDoc;
    assert.equal(
      capacityPresentation(runnableCoordinatorDoc, now, new Set(['local-sdk'])).executorUnavailable,
      undefined,
      'a due local coordinator transition keeps the workstream progressing on this host',
    );

    const workerRetryAt = new Date(source.now.getTime() + 60_000).toISOString();
    const primaryRetryAt = new Date(source.now.getTime() + 45_000).toISOString();
    const fallbackRetryAt = new Date(source.now.getTime() + 30_000).toISOString();
    recordCapacityBackoff(runnableCoordinatorDoc, {
      kind: 'rate_limit', recovery: 'automatic_retry', source: 'worker', sourceId: 'run_worker',
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
      detectedAt: now, retryAt: workerRetryAt,
    });
    recordCapacityBackoff(runnableCoordinatorDoc, {
      kind: 'rate_limit', recovery: 'automatic_retry', source: 'worker', sourceId: 'run_worker_fallback',
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5',
      detectedAt: now, retryAt: new Date(source.now.getTime() + 50_000).toISOString(),
    });
    assert.equal(
      capacityPresentation(
        runnableCoordinatorDoc,
        now,
        new Set(['local-sdk', 'codex-sdk']),
      ).blocking,
      undefined,
      'blocked workers do not make a due, runnable coordinator transition WAITING',
    );
    recordCapacityBackoff(runnableCoordinatorDoc, {
      kind: 'rate_limit', recovery: 'automatic_retry', source: 'coordinator', sourceId: 'pass_primary',
      executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
      detectedAt: now, retryAt: primaryRetryAt,
    });
    recordCapacityBackoff(runnableCoordinatorDoc, {
      kind: 'rate_limit', recovery: 'automatic_retry', source: 'coordinator', sourceId: 'pass_fallback',
      executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5',
      detectedAt: now, retryAt: fallbackRetryAt,
    });
    const blocked = capacityPresentation(
      runnableCoordinatorDoc,
      now,
      new Set(['local-sdk', 'codex-sdk']),
    ).blocking!;
    assert.match(blocked.summary, /^coordinator /);
    assert.equal(blocked.retryAt, fallbackRetryAt);

    clearCapacityBackoff(runnableCoordinatorDoc, {
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
    });
    clearCapacityBackoff(runnableCoordinatorDoc, {
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5',
    });
    assert.equal(
      capacityPresentation(
        runnableCoordinatorDoc,
        now,
        new Set(['local-sdk', 'codex-sdk']),
      ).blocking,
      undefined,
      'blocked coordination does not make a runnable worker transition WAITING',
    );
    assignment.dependsOn = ['missing_dependency'];
    assert.match(
      capacityPresentation(
        runnableCoordinatorDoc,
        now,
        new Set(['local-sdk', 'codex-sdk']),
      ).blocking!.summary,
      /^coordinator /,
      'a dependency-blocked assignment cannot masquerade as runnable worker progress',
    );
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('capacity presentation ignores withdrawn targets, shows preferred-route degradation, and blocks only with no fallback', () => {
  const previousExecutor = process.env.WEAVER_EXECUTOR;
  const previousModel = process.env.WEAVER_WORKER_MODEL;
  process.env.WEAVER_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
  try {
  const now = source.now.toISOString();
  const retryAt = new Date(source.now.getTime() + 60_000).toISOString();
  const fallbackRetryAt = new Date(source.now.getTime() + 30_000).toISOString();
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
  recordCapacityBackoff(doc, {
    ...wait,
    sourceId: 'run_withdrawn',
    executor: 'openhands',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k3',
  });
  assert.doesNotMatch(capacityPresentation(doc, now).details.join('\n'), /kimi-k3/);

  const reservedDoc = {
    ...doc,
    assignments: [doc.assignments.find((candidate) => candidate.id === 'asg_codex')!],
  } as WorkstreamDoc;
  const reserved = capacityPresentation(reservedDoc, now, new Set(['local-sdk']));
  assert.equal(reserved.blocking, undefined);
  assert.match(reserved.executorUnavailable!.summary, /gpt-5\.6-sol.*codex-sdk/);
  assert.equal(
    capacityPresentation(reservedDoc, now, new Set(['codex-sdk', 'local-sdk'])).executorUnavailable,
    undefined,
  );

  recordCapacityBackoff(doc, wait);

  const degraded = capacityPresentation(doc, now, new Set(['codex-sdk']));
  assert.equal(degraded.blocking, undefined);
  assert.equal(degraded.executorUnavailable, undefined);
  assert.match(degraded.details.join('\n'), /gpt-5\.6-sol/);

  recordCapacityBackoff(doc, {
    ...wait, sourceId: 'run_general', executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.5',
    retryAt: fallbackRetryAt,
  });
  const blocked = capacityPresentation(doc, now, new Set(['codex-sdk'])).blocking!;
  assert.match(blocked.summary, /^worker OpenAI gpt-5\.5 /);
  assert.equal(blocked.retryAt, fallbackRetryAt, 'the earliest target retry is the next real transition');
  } finally {
    if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
    else process.env.WEAVER_EXECUTOR = previousExecutor;
    if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
    else process.env.WEAVER_WORKER_MODEL = previousModel;
  }
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
