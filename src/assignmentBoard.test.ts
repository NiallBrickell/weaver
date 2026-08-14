/** Deterministic tests for the pure Assignment-board read model. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignmentBoard } from './assignmentBoard.js';
import type { Assignment } from './types.js';

function assignment(
  id: string,
  state: Assignment['state'],
  adoption: Assignment['adoption']['state'] = 'none',
  createdAtVirtual = '2026-08-14T09:00:00.000Z',
): Assignment {
  return {
    id,
    objective: `Objective for ${id}`,
    briefing: `Brief for ${id}`,
    kind: 'work',
    acceptanceCriteria: [],
    dependsOn: [],
    state,
    attempts: [],
    adoption: { state: adoption },
    createdAtVirtual,
  };
}

test('every assignment state lands in its honest lane or the archive', () => {
  const view = assignmentBoard({
    assignments: [
      assignment('asg_queued', 'queued'),
      assignment('asg_running', 'running'),
      assignment('asg_gated', 'gated'),
      assignment('asg_review', 'awaiting_review', 'proposed'),
      assignment('asg_accepted', 'completed', 'accepted'),
      assignment('asg_completed_unadopted', 'completed', 'proposed'),
      assignment('asg_failed', 'failed'),
      assignment('asg_cancelled', 'cancelled'),
      assignment('asg_rejected', 'completed', 'rejected'),
      assignment('asg_superseded', 'completed', 'superseded'),
    ],
  });

  assert.deepEqual(view.lanes.planned.map((card) => card.id), ['asg_queued']);
  assert.deepEqual(view.lanes.working.map((card) => card.id), ['asg_running']);
  assert.deepEqual(view.lanes.review.map((card) => card.id), ['asg_gated', 'asg_review']);
  assert.deepEqual(view.lanes.accepted.map((card) => card.id), ['asg_accepted']);
  assert.equal(view.archive.total, 5);
  assert.deepEqual(view.archive.byState, {
    gated: 0,
    queued: 0,
    running: 0,
    awaiting_review: 0,
    completed: 3,
    failed: 1,
    cancelled: 1,
  });
  assert.deepEqual(view.archive.byAdoption, {
    none: 2,
    proposed: 1,
    accepted: 0,
    rejected: 1,
    superseded: 1,
  });
  assert.deepEqual(
    view.archive.cards.map((card) => card.id),
    [
      'asg_cancelled',
      'asg_completed_unadopted',
      'asg_failed',
      'asg_rejected',
      'asg_superseded',
    ],
    'same-age archive cards use a stable newest-first id tiebreak',
  );
});

test('cards expose dependency acceptance and only the latest attempt', () => {
  const accepted = assignment('asg_dep_accepted', 'completed', 'accepted');
  const merelyCompleted = assignment('asg_dep_rejected', 'completed', 'rejected');
  const planned = assignment('asg_next', 'queued');
  planned.executionRequirements = { profile: 'bounded-code-repair', modalities: ['text'] };
  planned.dependsOn = ['asg_dep_accepted', 'asg_dep_rejected', 'asg_missing'];
  planned.attempts = [
    {
      runId: 'run_old',
      model: 'haiku',
      startedAt: '2026-08-14T08:00:00.000Z',
      endedAt: '2026-08-14T08:01:00.000Z',
      terminalReason: 'no_submission',
    },
    {
      runId: 'run_latest',
      executor: 'codex-sdk',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      startedAt: '2026-08-14T08:05:00.000Z',
      endedAt: '2026-08-14T08:09:00.000Z',
      terminalReason: 'completed',
    },
  ];
  planned.submission = { summary: 'Ready for the next bounded step', deliverableId: 'del_1' };

  const card = assignmentBoard({ assignments: [accepted, merelyCompleted, planned] }).lanes.planned[0]!;
  assert.deepEqual(card.dependencies, [
    { id: 'asg_dep_accepted', objective: 'Objective for asg_dep_accepted', accepted: true },
    { id: 'asg_dep_rejected', objective: 'Objective for asg_dep_rejected', accepted: false },
    { id: 'asg_missing', accepted: false },
  ]);
  assert.equal(card.attemptCount, 2);
  assert.deepEqual(card.attempts.map((attempt) => attempt.runId), ['run_old', 'run_latest']);
  assert.deepEqual(card.adoption, { state: 'none' });
  assert.deepEqual(card.acceptanceCriteria, []);
  assert.deepEqual(card.executionRequirements, {
    profile: 'bounded-code-repair', modalities: ['text'],
  });
  assert.deepEqual(card.latestAttempt, {
    runId: 'run_latest',
    startedAt: '2026-08-14T08:05:00.000Z',
    endedAt: '2026-08-14T08:09:00.000Z',
    executor: 'codex-sdk',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    terminalReason: 'completed',
  });
  assert.deepEqual(card.submission, {
    summary: 'Ready for the next bounded step',
    deliverableId: 'del_1',
  });
});

test('live work sorts oldest-first and Accepted retains every card newest-first', () => {
  const view = assignmentBoard({
    assignments: [
      assignment('asg_planned_new', 'queued', 'none', '2026-08-14T12:00:00.000Z'),
      assignment('asg_planned_old', 'queued', 'none', '2026-08-14T08:00:00.000Z'),
      assignment('asg_accepted_old', 'completed', 'accepted', '2026-08-10T08:00:00.000Z'),
      assignment('asg_accepted_new', 'completed', 'accepted', '2026-08-14T08:00:00.000Z'),
      assignment('asg_accepted_middle', 'completed', 'accepted', '2026-08-12T08:00:00.000Z'),
    ],
  });

  assert.deepEqual(view.lanes.planned.map((card) => card.id), ['asg_planned_old', 'asg_planned_new']);
  assert.deepEqual(
    view.lanes.accepted.map((card) => card.id),
    ['asg_accepted_new', 'asg_accepted_middle', 'asg_accepted_old'],
  );
});

test('archive cards remain inspectable newest-first', () => {
  const view = assignmentBoard({
    assignments: [
      assignment('asg_failed_old', 'failed', 'none', '2026-08-10T08:00:00.000Z'),
      assignment('asg_rejected_new', 'completed', 'rejected', '2026-08-14T08:00:00.000Z'),
      assignment('asg_cancelled_middle', 'cancelled', 'none', '2026-08-12T08:00:00.000Z'),
    ],
  });

  assert.deepEqual(
    view.archive.cards.map((card) => card.id),
    ['asg_rejected_new', 'asg_cancelled_middle', 'asg_failed_old'],
  );
});

test('a gated action awaits approval while a verified action reports readback truth', () => {
  const gated = assignment('asg_gated_action', 'gated');
  gated.kind = 'action';
  gated.exec = { cwd: '/repo', verify: 'gh pr view 42 --json mergedAt' };

  const verified = assignment('asg_verified_action', 'awaiting_review', 'proposed');
  verified.kind = 'action';
  verified.exec = {
    cwd: '/repo',
    verify: 'gh pr view 42 --json mergedAt',
    approval: { by: 'human', at: '2026-08-14T09:00:00.000Z' },
    verified: { ok: true, output: '{"mergedAt":"2026-08-14T09:10:00Z"}', at: '2026-08-14T09:10:01.000Z' },
  };

  const failedReadback = assignment('asg_failed_readback', 'awaiting_review', 'proposed');
  failedReadback.kind = 'action';
  failedReadback.exec = {
    cwd: '/repo',
    verify: 'gh pr view 43 --json mergedAt',
    approval: { by: 'pilot', at: '2026-08-14T09:00:00.000Z' },
    verified: { ok: false, output: 'not merged', at: '2026-08-14T09:10:01.000Z' },
  };

  const review = assignmentBoard({ assignments: [gated, verified, failedReadback] }).lanes.review;
  const byId = new Map(review.map((card) => [card.id, card]));
  assert.deepEqual(byId.get('asg_gated_action')!.action, {
    awaitingApproval: true,
    approved: false,
    verify: 'gh pr view 42 --json mergedAt',
    readback: 'pending',
  });
  assert.deepEqual(byId.get('asg_verified_action')!.action, {
    awaitingApproval: false,
    approved: true,
    approvalBy: 'human',
    approvalAt: '2026-08-14T09:00:00.000Z',
    verify: 'gh pr view 42 --json mergedAt',
    readback: 'confirmed',
    readbackAt: '2026-08-14T09:10:01.000Z',
    readbackOutput: '{"mergedAt":"2026-08-14T09:10:00Z"}',
  });
  assert.deepEqual(byId.get('asg_failed_readback')!.action, {
    awaitingApproval: false,
    approved: true,
    approvalBy: 'pilot',
    approvalAt: '2026-08-14T09:00:00.000Z',
    verify: 'gh pr view 43 --json mergedAt',
    readback: 'failed',
    readbackAt: '2026-08-14T09:10:01.000Z',
    readbackOutput: 'not merged',
  });
});

test('rejected and superseded adoption cannot leak into nominally live lanes', () => {
  const view = assignmentBoard({
    assignments: [
      assignment('asg_rejected_running', 'running', 'rejected'),
      assignment('asg_superseded_queued', 'queued', 'superseded'),
      assignment('asg_accepted_but_failed', 'failed', 'accepted'),
    ],
  });

  assert.deepEqual(view.lanes, { planned: [], working: [], review: [], accepted: [] });
  assert.equal(view.archive.total, 3);
  assert.equal(view.archive.byAdoption.rejected, 1);
  assert.equal(view.archive.byAdoption.superseded, 1);
  assert.equal(view.archive.byAdoption.accepted, 1);
});
