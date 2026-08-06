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
    retryAt: '2026-08-06T12:15:00.000Z',
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

test('credit exhaustion is a clear WAITING position with only supported recovery actions', () => {
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

  assert.match(status, /WAITING — Claude Agent SDK capacity is exhausted; work is safely parked/);
  assert.match(status, /Claim the included SDK credit in Claude Settings > Usage/);
  assert.match(status, /run `\/usage-credits` in Claude Code/);
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
  const later = { ...credit, sourceId: 'pass_capacity_2', model: 'sonnet', retryAt: '2026-08-06T12:30:00.000Z' };
  const status = renderStatus(doc([
    infrastructureWake('wake_credit_1', credit),
    infrastructureWake('wake_credit_2', later),
  ]));

  assert.equal(occurrences(status, 'Claude Agent SDK capacity is exhausted'), 1);
  assert.equal(occurrences(status, 'infrastructure retry scheduled at'), 1);
  assert.match(status, /infrastructure retry scheduled at 2026-08-06T12:15/);
  assert.doesNotMatch(status, /secret-token-value|other@example\.com|RAW PROVIDER ERROR/);
});
