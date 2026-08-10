/**
 * The five-question status view renders durable infrastructure state, never
 * raw SDK/provider errors. No model call or live credential is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderStatus } from './status.js';
import type {
  CapacityCategory,
  InfrastructureRecovery,
  InfrastructureWait,
  Wake,
  WorkstreamDoc,
} from './types.js';

const NOW = '2026-08-06T12:00:00.000Z';
// renderStatus compares retryAt against the REAL clock (virtualNow), so
// "scheduled later" fixtures must be genuinely in the future — a hardcoded
// tomorrow-ish timestamp becomes a time bomb the moment wall time passes it
// (this suite broke at exactly 2026-08-06T12:15Z).
const FUTURE_1 = new Date(Date.now() + 60 * 60_000).toISOString();
const FUTURE_2 = new Date(Date.now() + 90 * 60_000).toISOString();

function infrastructure(
  kind: CapacityCategory,
  recovery: InfrastructureRecovery,
  overrides: Partial<InfrastructureWait> = {},
): InfrastructureWait {
  return {
    kind,
    recovery,
    source: 'coordinator',
    sourceId: 'pass_capacity',
    model: 'claude-fable-5',
    detectedAt: NOW,
    retryAt: FUTURE_1,
    ...overrides,
  };
}

function infrastructureWake(
  id: string,
  wait: InfrastructureWait,
  reason = 'RAW PROVIDER ERROR bearer secret-token-value account=other@example.com',
): Wake {
  return {
    id,
    reason,
    condition: { type: 'time', dueAtVirtual: wait.retryAt },
    status: 'pending',
    createdAt: NOW,
    infrastructure: wait,
  };
}

function doc(wakes: Wake[]): WorkstreamDoc {
  const capacity = Object.fromEntries(
    wakes
      .filter((wake) => wake.infrastructure)
      .map((wake) => [
        wake.infrastructure!.model,
        {
          wait: wake.infrastructure!,
          consecutiveBackoffs: 1,
          firstBackoffAtVirtual: wake.infrastructure!.detectedAt,
          lastBackoffAtVirtual: wake.infrastructure!.detectedAt,
        },
      ]),
  );
  return {
    schemaVersion: 1,
    revision: 3,
    workstream: {
      id: 'ws_status',
      slug: 'capacity-status',
      title: 'Capacity status',
      objective: 'Keep durable work moving safely',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      budget: { maxCoordinatorPasses: 10, maxCostUsd: 10 },
      status: 'active',
      createdAt: NOW,
    },
    decisions: [],
    assignments: [],
    deliverables: [],
    interactions: [],
    observations: [],
    wakes,
    steering: [],
    attention: [],
    passes: [],
    events: [],
    spend: { coordinatorPasses: 1, totalCostUsd: 0, humanInterventions: 0 },
    capacity: Object.keys(capacity).length ? { state: 'backoff', byModel: capacity } : null,
    lease: null,
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test('legacy credit state renders the current plan-usage recovery contract', () => {
  const credit = infrastructure(
    'sdk_credit_exhausted',
    'claim_sdk_credit_or_enable_usage_credits',
  );
  const ordinary: Wake = {
    id: 'wake_ordinary',
    reason: 'review the adopted evidence',
    condition: { type: 'time', dueAtVirtual: '2026-08-07T09:00:00.000Z' },
    status: 'pending',
    createdAt: NOW,
  };
  const status = renderStatus(doc([infrastructureWake('wake_credit', credit), ordinary]));

  assert.match(status, /WAITING — Claude plan usage is limited; work is safely parked/);
  assert.match(status, /Check `\/usage` in Claude Code/);
  assert.match(status, /explicitly enable usage credits in Claude Settings > Usage/);
  assert.match(status, /weaver capacity retry capacity-status/);
  assert.match(status, /wake at 2026-08-07T09:00: review the adopted evidence/);
  assert.match(status, /## Needs you\n  \(nothing — the workstream can proceed without you\)/);
});

test('authentication failure gives the manual Claude login recovery and no token workflow', () => {
  const auth = infrastructure('auth', 'reauthenticate');
  const status = renderStatus(doc([infrastructureWake('wake_auth', auth)]));

  assert.match(status, /WAITING — Claude authentication needs attention; work is safely parked/);
  assert.match(status, /Run `claude auth login` in a terminal/);
  assert.match(status, /Weaver never accepts credentials or tokens/);
  assert.doesNotMatch(status, /switch accounts|rotate|mint|pool/i);
});

test('duplicate infrastructure wakes collapse and raw provider/account values never render', () => {
  const credit = infrastructure(
    'sdk_credit_exhausted',
    'claim_sdk_credit_or_enable_usage_credits',
  );
  const later = { ...credit, sourceId: 'pass_capacity_2', model: 'sonnet', retryAt: FUTURE_2 };
  const status = renderStatus(doc([
    infrastructureWake('wake_credit_1', credit),
    infrastructureWake('wake_credit_2', later),
  ]));

  assert.equal(occurrences(status, 'Claude plan usage is limited'), 1);
  assert.equal(occurrences(status, 'infrastructure retry scheduled at'), 1);
  assert.match(status, new RegExp(`infrastructure retry scheduled at ${FUTURE_1.slice(0, 16).replace(/[-:]/g, '\\$&')}`));
  assert.doesNotMatch(status, /secret-token-value|other@example\.com|RAW PROVIDER ERROR/);
});

test('an overdue capacity wait stops claiming the workstream is parked while work runs', () => {
  // A stored wait only clears when that model runs again, so a workstream that
  // has since moved to another model keeps the old entry forever. NOW answering
  // "parked" while a worker is running is the five-question contract lying.
  const stale = infrastructure('other', 'automatic_retry', {
    model: 'claude-opus-5',
    retryAt: '2026-08-06T12:00:00.000Z',
  });
  const parked = doc([infrastructureWake('wake_stale', stale)]);
  parked.assignments.push({
    id: 'asg_live',
    objective: 'Census the eight repos',
    briefing: 'read-only',
    kind: 'work',
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'running',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: NOW,
  });
  const status = renderStatus(parked);

  assert.doesNotMatch(status, /WAITING —/);
  assert.doesNotMatch(status, /work is safely parked/);
  assert.match(status, /working: asg_live "Census the eight repos"/);
  assert.match(status, /infrastructure retry is due now/);
});

test('a wait whose retry is still ahead is reported as a live block', () => {
  const rate = infrastructure('rate_limit', 'automatic_retry', { retryAt: FUTURE_1 });
  const status = renderStatus(doc([infrastructureWake('wake_rate', rate)]));

  assert.match(status, /WAITING — Claude is rate limited; work is safely parked/);
  assert.match(status, /infrastructure retry scheduled at/);
});

test('a successful probe exposes its due reconciliation after clearing capacity state', () => {
  const credit = infrastructure(
    'sdk_credit_exhausted',
    'claim_sdk_credit_or_enable_usage_credits',
    { retryAt: '2026-08-06T12:00:00.000Z' },
  );
  const wake = infrastructureWake('wake_recovered', credit);
  wake.condition = { type: 'immediate' };
  const recovered = doc([wake]);
  recovered.capacity = null;
  const status = renderStatus(recovered);

  assert.match(status, /READY — Claude capacity recovered; reconciliation is due now/);
  assert.doesNotMatch(status, /workstream is dormant/);
  assert.doesNotMatch(status, /RAW PROVIDER ERROR/);
});
