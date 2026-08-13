import { test } from 'node:test';
import assert from 'node:assert/strict';

import { activitySummary } from './activity.js';
import type { WorkstreamDoc } from './types.js';

function doc(): WorkstreamDoc {
  return {
    schemaVersion: 1,
    revision: 1,
    workstream: {
      id: 'ws_activity', slug: 'activity', title: 'Activity', objective: 'Show honest activity',
      tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
      executionSafety: { maxModelStarts: 30, windowSeconds: 3600 }, status: 'active',
      createdAt: '2026-08-13T09:00:00.000Z',
    },
    decisions: [{
      id: 'dec_1', title: 'Proceed', rationale: 'Evidence supports it', madeBy: 'coordinator',
      status: 'standing', decidedAtVirtual: '2026-08-13T08:00:00.000Z',
    }],
    assignments: [{
      id: 'asg_1', objective: 'Do work', briefing: 'Do work', kind: 'work', acceptanceCriteria: [],
      dependsOn: [], state: 'running', attempts: [{ runId: 'run_1', model: 'sonnet', startedAt: '2026-08-13T09:48:00.000Z' }],
      adoption: { state: 'none' }, createdAtVirtual: '2026-08-13T09:00:00.000Z',
    }],
    deliverables: [], interactions: [], observations: [], wakes: [], steering: [], attention: [], passes: [], events: [],
    spend: { coordinatorPasses: 0, totalCostUsd: 0, humanInterventions: 0 }, capacity: null, lease: null,
  };
}

test('compact activity uses wall time for execution and virtual time for decisions', () => {
  assert.equal(
    activitySummary(doc(), new Date('2026-08-13T10:00:00.000Z'), new Date('2026-08-13T09:30:00.000Z')),
    '12m in flight · decision 1h30m ago',
  );
});

test('completed attempts and engine history do not pretend to be in flight', () => {
  const value = doc();
  value.assignments[0]!.state = 'completed';
  value.assignments[0]!.attempts[0]!.endedAt = '2026-08-13T09:55:00.000Z';
  value.assignments[0]!.attempts[0]!.model = 'engine';
  assert.equal(
    activitySummary(value, new Date('2026-08-13T10:00:00.000Z'), new Date('2026-08-13T09:30:00.000Z')),
    'decision 1h30m ago',
  );
});
