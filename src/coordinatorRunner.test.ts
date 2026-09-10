import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capacityPresentation, recordCapacityBackoff } from './capacity.js';
import { coordinatorRunnerEligibility, liveRunnerIds, operatorCapacityPresentation, validateCoordinatorRunnerOrder } from './coordinatorRunner.js';
import { initialDoc } from './store/doc.js';
import type { InfrastructureWait } from './types.js';

function doc(order?: string[]) {
  return initialDoc({
    slug: 'runner-policy', title: 'Runner policy', objective: 'choose one coordinator host',
    tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    ...(order ? { executionPolicy: { coordinatorRunnerOrder: order } } : {}),
  });
}

test('durable coordinator runner order selects the first live host and fails over after TTL', () => {
  const now = Date.parse('2026-08-29T12:00:00.000Z');
  assert.equal(coordinatorRunnerEligibility(doc(), 'any-runner', [], now).eligible, true);
  assert.equal(coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'mac', [], now).eligible, true);

  const freshMac = [{ runnerId: 'mac', heartbeatAt: new Date(now - 30_000).toISOString() }];
  const blocked = coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'gcp', freshMac, now);
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.preferredLiveRunner, 'mac');

  const staleMac = [{ runnerId: 'mac', heartbeatAt: new Date(now - 120_001).toISOString() }];
  assert.equal(coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'gcp', staleMac, now).eligible, true);
  assert.equal(coordinatorRunnerEligibility(doc(['mac', 'gcp']), 'other', [], now).eligible, false);
  assert.deepEqual(liveRunnerIds([...freshMac, ...staleMac], now), ['mac']);
});

test('a live preferred runner whose every published coordinator seat is parked yields the claim', () => {
  const now = Date.parse('2026-09-03T14:00:00.000Z');
  const nowIso = new Date(now).toISOString();
  const fable = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' };
  const opus = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5' };
  const glm = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
  const codex = { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' };
  const park = (d: ReturnType<typeof doc>, seat: typeof fable, retryAt: string) =>
    recordCapacityBackoff(d, {
      kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator', sourceId: 'pass_x',
      model: seat.model, executor: seat.executor, provider: seat.provider,
      detectedAt: nowIso, retryAt,
    } satisfies InfrastructureWait);

  const fleetSeated = [{ runnerId: 'gcp', heartbeatAt: nowIso, coordinatorSeats: [fable, opus, glm] }];
  const macSeated = [{ runnerId: 'mac', heartbeatAt: nowIso, coordinatorSeats: [fable, opus, codex] }];

  // Nothing parked: the preferred host holds the claim as before.
  const open = doc(['gcp', 'mac']);
  assert.equal(coordinatorRunnerEligibility(open, 'mac', fleetSeated, now).eligible, false);

  // Every seat the preferred host publishes is parked on this Workstream: it
  // is live but cannot launch a pass, so the standby becomes eligible.
  const parked = doc(['gcp', 'mac']);
  park(parked, fable, '2026-09-30T00:00:00.000Z');
  park(parked, opus, '2026-09-03T15:10:00.000Z');
  park(parked, glm, '2026-09-03T14:20:00.000Z');
  assert.equal(coordinatorRunnerEligibility(parked, 'mac', fleetSeated, now).eligible, true);
  // The same parks do not make the standby yield to itself, and a seat the
  // preferred host does not have (Codex) does not count for it.
  assert.equal(coordinatorRunnerEligibility(parked, 'gcp', macSeated, now).eligible, true);

  // A park whose retry has passed is an open seat again: the preferred host
  // reclaims and the standby steps back. The capacity clock is the caller's
  // (virtual) clock, separate from the heartbeat clock.
  const expired = coordinatorRunnerEligibility(parked, 'mac', fleetSeated, now, undefined, '2026-09-03T14:21:00.000Z');
  assert.equal(expired.eligible, false);
  assert.equal(expired.preferredLiveRunner, 'gcp');
  // Sixty seconds on the heartbeat clock alone changes nothing: the preferred
  // host is still live and every park still stands.
  assert.equal(coordinatorRunnerEligibility(parked, 'mac', fleetSeated, now + 60_000).eligible, true);

  // A presence without published seats is liveness alone (runners that
  // predate seat publication), and a runner that publishes zero seats can
  // launch nothing and yields.
  const legacy = [{ runnerId: 'gcp', heartbeatAt: nowIso }];
  assert.equal(coordinatorRunnerEligibility(parked, 'mac', legacy, now).eligible, false);
  const seatless = [{ runnerId: 'gcp', heartbeatAt: nowIso, coordinatorSeats: [] }];
  assert.equal(coordinatorRunnerEligibility(open, 'mac', seatless, now).eligible, true);
});

test('coordinator runner order rejects malformed or ambiguous durable policy', () => {
  assert.deepEqual(validateCoordinatorRunnerOrder(['mac', 'gcp']), ['mac', 'gcp']);
  assert.throws(() => validateCoordinatorRunnerOrder([]), /at least one/);
  assert.throws(() => validateCoordinatorRunnerOrder(['mac', 'mac']), /duplicate/);
  assert.throws(() => validateCoordinatorRunnerOrder(['bad runner']), /coordinator runner id/);
});

test('operator capacity uses fresh selected host seats, not the viewer fallback, without changing execution policy', () => {
  const previous = { ...process.env };
  try {
    process.env.WEAVER_RUNNER_ID = 'mac';
    process.env.WEAVER_COORDINATOR_EXECUTOR = 'local-sdk';
    process.env.WEAVER_COORDINATOR_MODEL = 'claude-fable-5';
    process.env.WEAVER_COORDINATOR_FALLBACKS = 'codex-sdk:gpt-5.6-sol';
    const now = '2026-09-10T12:00:00.000Z';
    const fable = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' };
    const glm = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
    const d = doc(['gcp']);
    d.wakes.push({ id: 'wake_test', reason: 'reconcile', condition: { type: 'immediate' }, status: 'pending', createdAt: now });
    for (const seat of [fable, glm]) recordCapacityBackoff(d, {
      ...seat, kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator',
      sourceId: `pass_${seat.provider}`, detectedAt: now, retryAt: '2026-09-10T13:00:00.000Z',
    });
    const presences = [{ runnerId: 'gcp', heartbeatAt: now, coordinatorSeats: [fable, glm] }];
    assert.match(capacityPresentation(d, now).degraded!.summary, /gpt-5.6-sol available/);
    const blocked = operatorCapacityPresentation(d, now, presences, Date.parse(now));
    assert.ok(blocked.blocking);
    assert.doesNotMatch(JSON.stringify(blocked), /gpt-5.6-sol/);
    const recovered = operatorCapacityPresentation(d, '2026-09-10T13:00:00.000Z', presences, Date.parse(now));
    assert.equal(recovered.blocking, undefined);
    assert.match(recovered.details.join('\n'), /retry eligible now/);
    // Only OpenRouter becomes due while Claude remains parked.
    d.capacity!.byModel['local-sdk:openrouter:openrouter/z-ai/glm-5.3']!.wait.retryAt = now;
    const degraded = operatorCapacityPresentation(d, now, presences, Date.parse(now));
    assert.match(degraded.degraded!.summary, /fallback openrouter\/z-ai\/glm-5.3 available/);
    assert.match(capacityPresentation(d, now).degraded!.summary, /gpt-5.6-sol available/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('operator view never invents capacity from a missing, stale, legacy, or empty hosted presence', () => {
  const d = doc(['gcp']);
  const now = '2026-09-10T12:00:00.000Z';
  d.wakes.push({ id: 'wake_test', reason: 'reconcile', condition: { type: 'immediate' }, status: 'pending', createdAt: now });
  const seats = [{ executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' }];
  for (const presences of [
    [],
    [{ runnerId: 'gcp', heartbeatAt: '2026-09-10T11:00:00.000Z', coordinatorSeats: seats }],
    [{ runnerId: 'unrelated', heartbeatAt: now, coordinatorSeats: seats }],
    [{ runnerId: 'gcp', heartbeatAt: now }],
    [{ runnerId: 'gcp', heartbeatAt: now, coordinatorSeats: [] }],
  ]) {
    const position = operatorCapacityPresentation(d, now, presences, Date.parse(now));
    assert.match(position.unknown!.summary, /coordinator capacity unknown/);
    assert.equal(position.executorUnavailable, undefined);
    assert.equal(position.degraded, undefined);
    assert.doesNotMatch(position.details.join('\n'), /fallback .* available/);
  }
});

test('operator view follows hosted standby preference and does not infer worker seats', () => {
  const d = doc(['gcp', 'standby']);
  const now = '2026-09-10T12:00:00.000Z';
  const fable = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' };
  const glm = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
  d.wakes.push({ id: 'wake_test', reason: 'reconcile', condition: { type: 'immediate' }, status: 'pending', createdAt: now });
  recordCapacityBackoff(d, { ...fable, kind: 'usage_limit', recovery: 'wait_or_enable_usage_credits', source: 'coordinator', sourceId: 'pass_test', detectedAt: now, retryAt: '2026-09-10T13:00:00.000Z' });
  const presences = [
    { runnerId: 'gcp', heartbeatAt: now, coordinatorSeats: [fable] },
    { runnerId: 'standby', heartbeatAt: now, coordinatorSeats: [glm] },
  ];
  const position = operatorCapacityPresentation(d, now, presences, Date.parse(now));
  assert.equal(position.blocking, undefined);
  assert.equal(position.executorUnavailable, undefined);
  d.workstream.assignmentRunnerId = 'gcp';
  d.assignments.push({
    id: 'asg_test', kind: 'work', objective: 'bounded work', briefing: 'report', acceptanceCriteria: [],
    dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' }, createdAtVirtual: now,
  });
  const unknownWorker = operatorCapacityPresentation(d, now, presences, Date.parse(now));
  assert.match(unknownWorker.unknown!.summary, /worker capacity unknown — gcp/);
  assert.equal(unknownWorker.executorUnavailable, undefined);
});
