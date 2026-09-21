import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { fleetAttentionEvidence, runnerOutput } from './fleetHealth.js';
import { arrive, closeStore, createWorkstream, load } from './store.js';
import type { InfrastructureWait } from './types.js';

test('fleet attention evidence includes every real ask while excluding unrelated Workstream truth', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-evidence-'));
  process.env.WEAVER_HOME = home;
  try {
    await createWorkstream({
      slug: 'quiet-private-work',
      title: 'Quiet private work',
      objective: 'DO_NOT_EXPORT_THIS_UNRELATED_OBJECTIVE',
      tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await createWorkstream({
      slug: 'needs-triage',
      title: 'Needs triage',
      objective: 'Resolve the current asks',
      tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('needs-triage', (doc) => {
      doc.assignments.push({
        id: 'asg_already_done', objective: 'Previously completed decision work', briefing: 'private detail',
        kind: 'work', acceptanceCriteria: [], dependsOn: [], state: 'completed', attempts: [],
        adoption: { state: 'accepted' }, createdAtVirtual: '2026-08-26T09:59:00.000Z',
      });
      doc.attention.push({
        id: 'att_real', kind: 'blocker', summary: 'Choose the supported release course.',
        refId: 'asg_already_done', status: 'open', createdAt: '2026-08-26T10:00:00.000Z',
      });
      doc.assignments.push({
        id: 'asg_pilot_wait', objective: 'Routine gated effect', briefing: 'Use the action lane.',
        kind: 'action', exec: {
          cwd: '/repo', verify: 'true', approvalMode: 'pilot-or-human',
          pilotUnavailableSince: '2026-08-26T10:01:00.000Z',
        },
        acceptanceCriteria: [], dependsOn: [], state: 'gated', attempts: [],
        adoption: { state: 'none' }, createdAtVirtual: '2026-08-26T10:01:00.000Z',
      });
      doc.attention.push({
        id: 'att_legacy_pilot', kind: 'approval', refId: 'asg_pilot_wait',
        summary: 'LEGACY_DUPLICATE_APPROVAL_SERVICE_CARD', status: 'open',
        createdAt: '2026-08-26T10:01:00.000Z',
      });
      doc.assignments.push({
        id: 'asg_human_only', objective: 'Publish the reviewed release', briefing: 'Do exactly the approved act.',
        kind: 'action', exec: {
          cwd: '/repo', verify: 'true', approvalMode: 'human-only', ask: 'Approve publishing the reviewed release?',
        },
        acceptanceCriteria: [], dependsOn: [], state: 'gated', attempts: [],
        adoption: { state: 'none' }, createdAtVirtual: '2026-08-26T10:02:00.000Z',
      });
      doc.interactions.push({
        id: 'int_release', kind: 'email_send', to: 'owner@example.com', subject: 'Release ready',
        deliverableId: 'del_release', status: 'awaiting_approval', replies: [],
      });
      doc.assignments.push({
        id: 'asg_unrelated', objective: 'DO_NOT_EXPORT_THIS_UNRELATED_ASSIGNMENT', briefing: 'private detail',
        kind: 'work', acceptanceCriteria: [], dependsOn: [], state: 'queued', attempts: [],
        adoption: { state: 'none' }, createdAtVirtual: '2026-08-26T10:03:00.000Z',
      });
    });

    const docs = [await load('quiet-private-work'), await load('needs-triage')];
    const evidence = fleetAttentionEvidence(docs, ['unreadable-stream'], new Date('2026-08-26T11:00:00.000Z'));
    const encoded = JSON.stringify(evidence);

    assert.deepEqual(evidence.totals, {
      workstreams: 2, activeWorkstreams: 2, openHumanNeeds: 3, approvalServiceWaits: 1,
    });
    assert.deepEqual(evidence.unreadableWorkstreams, ['unreadable-stream']);
    assert.equal(evidence.schemaVersion, 2);
    assert.equal(evidence.incidents.length, 1);
    assert.equal(evidence.workstreams.length, 1);
    assert.equal(evidence.workstreams[0]!.slug, 'needs-triage');
    assert.equal(evidence.workstreams[0]!.revision, docs[1]!.revision);
    assert.deepEqual(
      evidence.workstreams[0]!.humanNeeds.map((need) => need.id).sort(),
      ['asg_human_only', 'att_real', 'int_release'],
    );
    const staleNeed = evidence.workstreams[0]!.humanNeeds.find((need) => need.id === 'att_real');
    assert.equal(staleNeed?.workstreamStatus, 'active');
    assert.deepEqual(staleNeed?.referencedEntity, { kind: 'assignment', state: 'completed' });
    const actionNeed = evidence.workstreams[0]!.humanNeeds.find((need) => need.id === 'asg_human_only');
    assert.deepEqual(actionNeed?.referencedEntity, { kind: 'assignment', state: 'gated' });
    const interactionNeed = evidence.workstreams[0]!.humanNeeds.find((need) => need.id === 'int_release');
    assert.deepEqual(interactionNeed?.referencedEntity, { kind: 'interaction', state: 'awaiting_approval' });
    assert.doesNotMatch(encoded, /LEGACY_DUPLICATE_APPROVAL_SERVICE_CARD/);
    assert.doesNotMatch(encoded, /DO_NOT_EXPORT_THIS_UNRELATED/);
    assert.doesNotMatch(encoded, /Quiet private work|private detail/);
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fleet attention evidence exposes active capacity and unhealthy routine state without prose', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-operational-evidence-'));
  process.env.WEAVER_HOME = home;
  try {
    await createWorkstream({
      slug: 'routine-needs-recovery', title: 'Routine needs recovery',
      objective: 'DO_NOT_EXPORT_ROUTINE_OBJECTIVE', tags: ['routine'], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('routine-needs-recovery', (doc) => {
      doc.assignments.push({
        id: 'asg_review', objective: 'DO_NOT_EXPORT_REVIEW_OBJECTIVE', briefing: 'DO_NOT_EXPORT_BRIEFING',
        kind: 'work', acceptanceCriteria: [], dependsOn: [], state: 'awaiting_review', attempts: [{
          runId: 'run_review', startedAt: '2026-08-26T08:30:00.000Z', endedAt: '2026-08-26T09:00:00.000Z',
        }],
        submission: { summary: 'DO_NOT_EXPORT_SUBMISSION' }, adoption: { state: 'proposed' },
        createdAtVirtual: '2026-08-26T10:00:00.000Z',
      });
      doc.assignments.push({
        id: 'asg_unrelated_queued', objective: 'DO_NOT_EXPORT_QUEUED_OBJECTIVE', briefing: 'private',
        kind: 'work', acceptanceCriteria: [], dependsOn: [], state: 'queued', attempts: [{
          runId: 'run_capacity', startedAt: '2026-08-26T09:00:00.000Z', endedAt: '2026-08-26T09:30:00.000Z',
        }],
        adoption: { state: 'none' }, createdAtVirtual: '2026-08-26T10:01:00.000Z',
      });
      doc.wakes.push({
        id: 'wake_overdue', reason: 'DO_NOT_EXPORT_OVERDUE_WAKE_REASON',
        condition: { type: 'time', dueAtVirtual: '2026-08-26T10:30:00.000Z' },
        status: 'pending', createdAt: '2026-08-26T10:00:00.000Z',
        infrastructure: {
          kind: 'session_limit', recovery: 'automatic_retry', source: 'coordinator',
          sourceId: 'pass_capacity', model: 'claude-sonnet', executor: 'local-sdk', provider: 'anthropic',
          detectedAt: '2026-08-26T10:15:00.000Z', retryAt: '2026-08-26T12:00:00.000Z',
        },
      }, {
        id: 'wake_future', reason: 'DO_NOT_EXPORT_FUTURE_WAKE_REASON',
        condition: { type: 'wall_time', dueAt: '2026-08-26T12:30:00.000Z' },
        status: 'pending', createdAt: '2026-08-26T10:00:00.000Z',
      }, {
        id: 'wake_wall_overdue', reason: 'DO_NOT_EXPORT_WALL_WAKE_REASON',
        condition: { type: 'wall_time', dueAt: '2026-08-26T10:30:00.000Z' },
        status: 'pending', createdAt: '2026-08-26T10:00:00.000Z',
      }, {
        id: 'wake_immediate_overdue', reason: 'DO_NOT_EXPORT_IMMEDIATE_WAKE_REASON',
        condition: { type: 'immediate' }, status: 'pending', createdAt: '2026-08-26T10:30:00.000Z',
      });
      doc.capacity = {
        state: 'backoff',
        byModel: {
          active: {
            wait: {
              kind: 'session_limit', recovery: 'automatic_retry', source: 'coordinator',
              sourceId: 'pass_capacity', model: 'claude-sonnet', executor: 'local-sdk', provider: 'anthropic',
              detectedAt: '2026-08-26T10:15:00.000Z', retryAt: '2026-08-26T12:00:00.000Z',
            },
            consecutiveBackoffs: 2,
            firstBackoffAtVirtual: '2026-08-26T10:00:00.000Z',
            lastBackoffAtVirtual: '2026-08-26T10:15:00.000Z',
          },
          activeWorker: {
            wait: {
              kind: 'rate_limit', recovery: 'automatic_retry', source: 'worker',
              sourceId: 'run_capacity', model: 'worker-model', executor: 'pi', provider: 'zai',
              detectedAt: '2026-08-26T10:20:00.000Z', retryAt: '2026-08-26T13:00:00.000Z',
            },
            consecutiveBackoffs: 1,
            firstBackoffAtVirtual: '2026-08-26T10:20:00.000Z',
            lastBackoffAtVirtual: '2026-08-26T10:20:00.000Z',
          },
          expired: {
            wait: {
              kind: 'rate_limit', recovery: 'automatic_retry', source: 'worker',
              sourceId: 'DO_NOT_EXPORT_EXPIRED_BACKOFF', model: 'old-model',
              detectedAt: '2026-08-26T09:00:00.000Z', retryAt: '2026-08-26T10:00:00.000Z',
            },
            consecutiveBackoffs: 1,
            firstBackoffAtVirtual: '2026-08-26T09:00:00.000Z',
            lastBackoffAtVirtual: '2026-08-26T09:00:00.000Z',
          },
        },
      };
      doc.decisions.push({
        id: 'dec_private', title: 'DO_NOT_EXPORT_DECISION', rationale: 'private', madeBy: 'coordinator',
        status: 'standing', decidedAtVirtual: '2026-08-26T10:00:00.000Z',
      });
    });

    await createWorkstream({
      slug: 'routine-dormant', title: 'Dormant routine', objective: 'DO_NOT_EXPORT_DORMANT_OBJECTIVE',
      tags: ['routine'], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await createWorkstream({
      slug: 'routine-healthy', title: 'Healthy routine', objective: 'DO_NOT_EXPORT_HEALTHY_OBJECTIVE',
      tags: ['routine'], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('routine-healthy', (doc) => doc.wakes.push({
      id: 'wake_healthy', reason: 'DO_NOT_EXPORT_HEALTHY_WAKE_REASON',
      condition: { type: 'time', dueAtVirtual: '2026-08-27T11:00:00.000Z' },
      status: 'pending', createdAt: '2026-08-26T10:00:00.000Z',
    }));

    const operationalDoc = await load('routine-needs-recovery');
    const dormantDoc = await load('routine-dormant');
    const evidence = fleetAttentionEvidence(
      [operationalDoc, dormantDoc, await load('routine-healthy')],
      [],
      new Date('2026-08-26T11:00:00.000Z'),
      new Date('2026-08-26T11:00:00.000Z'),
    );
    const operational = evidence.workstreams.find((doc) => doc.slug === 'routine-needs-recovery');
    const dormant = evidence.workstreams.find((doc) => doc.slug === 'routine-dormant');
    const encoded = JSON.stringify(evidence);

    assert.equal(evidence.schemaVersion, 2);
    assert.deepEqual(operational?.activeCapacityBackoffs, [
      {
        source: 'coordinator', sourceId: 'pass_capacity', sourceEntityKind: 'pass',
        reportableEntity: { kind: 'wake', id: 'wake_overdue', state: 'pending' },
        kind: 'session_limit', recovery: 'automatic_retry', model: 'claude-sonnet',
        executor: 'local-sdk', provider: 'anthropic', retryAt: '2026-08-26T12:00:00.000Z',
        resetAt: undefined, consecutiveBackoffs: 2,
      },
      {
        source: 'worker', sourceId: 'run_capacity', sourceEntityKind: 'attempt',
        reportableEntity: { kind: 'assignment', id: 'asg_unrelated_queued', state: 'queued' },
        kind: 'rate_limit', recovery: 'automatic_retry', model: 'worker-model',
        executor: 'pi', provider: 'zai', retryAt: '2026-08-26T13:00:00.000Z',
        resetAt: undefined, consecutiveBackoffs: 1,
      },
    ]);
    assert.deepEqual(operational?.routineHealth, {
      dormant: false,
      overdueWakes: [
        { id: 'wake_overdue', condition: 'time', dueAt: '2026-08-26T10:30:00.000Z' },
        { id: 'wake_wall_overdue', condition: 'wall_time', dueAt: '2026-08-26T10:30:00.000Z' },
        { id: 'wake_immediate_overdue', condition: 'immediate' },
      ],
      awaitingReviewAssignmentIds: [],
    });
    assert.equal(operational?.workstreamId, operationalDoc.workstream.id);
    assert.deepEqual(dormant?.routineHealth, {
      dormant: true, overdueWakes: [], awaitingReviewAssignmentIds: [],
    });
    assert.equal(dormant?.workstreamId, dormantDoc.workstream.id);
    assert.equal(evidence.workstreams.some((doc) => doc.slug === 'routine-healthy'), false);
    assert.doesNotMatch(encoded, /DO_NOT_EXPORT/);
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('routine health waits for grace and suppresses work already being reconciled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-routine-grace-'));
  process.env.WEAVER_HOME = home;
  const wallNow = new Date('2026-08-26T11:00:00.000Z');
  const nowVirtual = new Date('2026-08-26T11:00:00.000Z');
  const createRoutine = async (slug: string) => createWorkstream({
    slug, title: slug, objective: `DO_NOT_EXPORT_${slug}`, tags: ['routine'],
    successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });
  const addReview = async (slug: string, endedAt: string) => arrive(slug, (doc) => {
    doc.assignments.push({
      id: `asg_${slug}`, objective: `DO_NOT_EXPORT_REVIEW_${slug}`, briefing: 'private',
      kind: 'work', acceptanceCriteria: [], dependsOn: [], state: 'awaiting_review', attempts: [{
        runId: `run_${slug}`, startedAt: '2026-08-26T08:00:00.000Z', endedAt,
      }],
      submission: { summary: 'DO_NOT_EXPORT_SUBMISSION' }, adoption: { state: 'proposed' },
      createdAtVirtual: '2026-08-26T08:00:00.000Z',
    });
  });
  try {
    await createRoutine('stale-review');
    await addReview('stale-review', '2026-08-26T09:00:00.000Z');

    await createRoutine('fresh-review');
    await addReview('fresh-review', '2026-08-26T10:30:00.000Z');

    await createRoutine('woken-review');
    await addReview('woken-review', '2026-08-26T09:00:00.000Z');
    await arrive('woken-review', (doc) => doc.wakes.push({
      id: 'wake_review', reason: 'DO_NOT_EXPORT_REVIEW_WAKE', condition: { type: 'immediate' },
      status: 'pending', createdAt: '2026-08-26T10:59:00.000Z',
    }));

    await createRoutine('leased-review');
    await addReview('leased-review', '2026-08-26T09:00:00.000Z');
    await arrive('leased-review', (doc) => {
      doc.lease = {
        passId: 'pass_live_review', acquiredAt: '2026-08-26T10:50:00.000Z',
        expiresAt: '2026-08-26T11:10:00.000Z',
      };
    });

    await createRoutine('freshly-due');
    await arrive('freshly-due', (doc) => doc.wakes.push({
      id: 'wake_freshly_due', reason: 'DO_NOT_EXPORT_FRESH_WAKE',
      condition: { type: 'time', dueAtVirtual: '2026-08-26T10:55:00.000Z' },
      status: 'pending', createdAt: '2026-08-26T10:00:00.000Z',
    }));

    await createRoutine('leased-overdue');
    await arrive('leased-overdue', (doc) => {
      doc.wakes.push({
        id: 'wake_leased_overdue', reason: 'DO_NOT_EXPORT_LEASED_WAKE',
        condition: { type: 'wall_time', dueAt: '2026-08-26T10:00:00.000Z' },
        status: 'pending', createdAt: '2026-08-26T09:00:00.000Z',
      });
      doc.lease = {
        passId: 'pass_live_wake', acquiredAt: '2026-08-26T10:50:00.000Z',
        expiresAt: '2026-08-26T11:10:00.000Z',
      };
    });

    const slugs = [
      'stale-review', 'fresh-review', 'woken-review', 'leased-review', 'freshly-due', 'leased-overdue',
    ];
    const evidence = fleetAttentionEvidence(
      await Promise.all(slugs.map((slug) => load(slug))), [], wallNow, nowVirtual,
    );
    const stale = evidence.workstreams.find((doc) => doc.slug === 'stale-review');
    const encoded = JSON.stringify(evidence);

    assert.deepEqual(stale?.routineHealth, {
      dormant: false, overdueWakes: [], awaitingReviewAssignmentIds: ['asg_stale-review'],
    });
    assert.deepEqual(evidence.workstreams.map((doc) => doc.slug), ['stale-review']);
    assert.doesNotMatch(encoded, /DO_NOT_EXPORT/);
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('paused outage markers are durable history, not a live fleet incident', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-paused-evidence-'));
  process.env.WEAVER_HOME = home;
  try {
    await createWorkstream({
      slug: 'paused-after-outage',
      title: 'Paused after outage',
      objective: 'Stay paused until deliberately resumed',
      tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('paused-after-outage', (doc) => {
      doc.workstream.status = 'paused';
      doc.assignments.push({
        id: 'asg_paused_pilot_wait', objective: 'A previously gated effect', briefing: 'Remain paused.',
        kind: 'action', exec: {
          cwd: '/repo', verify: 'true', approvalMode: 'pilot-or-human',
          pilotUnavailableSince: '2026-08-26T10:01:00.000Z',
        },
        acceptanceCriteria: [], dependsOn: [], state: 'gated', attempts: [],
        adoption: { state: 'none' }, createdAtVirtual: '2026-08-26T10:01:00.000Z',
      });
    });

    const evidence = fleetAttentionEvidence(
      [await load('paused-after-outage')],
      [],
      new Date('2026-08-26T11:00:00.000Z'),
    );

    assert.equal(evidence.incidents.length, 0);
    assert.equal(evidence.totals.approvalServiceWaits, 0);
    assert.equal(evidence.workstreams.length, 0);
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function capacityWait(retryAt: string): InfrastructureWait {
  return {
    kind: 'session_limit', recovery: 'automatic_retry', source: 'coordinator', sourceId: 'pass_capacity',
    model: 'claude-sonnet', executor: 'local-sdk', provider: 'anthropic',
    detectedAt: '2026-09-21T08:00:00.000Z', retryAt,
  };
}

test('runnerOutput counts only genuinely completed passes and only ACTIVE workstreams toward capacity blocked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-output-passes-'));
  process.env.WEAVER_HOME = home;
  const wallNow = new Date('2026-09-21T12:00:00.000Z');
  try {
    await createWorkstream({
      slug: 'throughput', title: 'Throughput', objective: 'o', tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('throughput', (doc) => {
      // A later endedAt on a non-qualifying pass must never win over an
      // earlier genuinely-completed one — that's the whole point of the filter.
      doc.passes.push(
        {
          id: 'pass_completed', startedAt: '2026-09-21T09:00:00.000Z', endedAt: '2026-09-21T09:30:00.000Z',
          baseRevision: 0, wakeReasons: [], changes: [], outcome: 'completed',
        },
        {
          id: 'pass_infra', startedAt: '2026-09-21T10:00:00.000Z', endedAt: '2026-09-21T10:30:00.000Z',
          baseRevision: 1, wakeReasons: [], changes: [], outcome: 'completed',
          infrastructure: capacityWait('2026-09-21T11:00:00.000Z'),
        },
        {
          id: 'pass_error', startedAt: '2026-09-21T10:30:00.000Z', endedAt: '2026-09-21T11:00:00.000Z',
          baseRevision: 2, wakeReasons: [], changes: [], outcome: 'error',
        },
        {
          id: 'pass_conflicted', startedAt: '2026-09-21T11:00:00.000Z', endedAt: '2026-09-21T11:30:00.000Z',
          baseRevision: 3, wakeReasons: [], changes: [], outcome: 'conflicted',
        },
      );
    });

    await createWorkstream({
      slug: 'paused-with-backoff', title: 'Paused with backoff', objective: 'o',
      tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('paused-with-backoff', (doc) => {
      doc.workstream.status = 'paused';
      doc.capacity = { state: 'backoff', byModel: { active: {
        wait: capacityWait('2026-09-21T13:00:00.000Z'), consecutiveBackoffs: 1,
        firstBackoffAtVirtual: '2026-09-21T08:00:00.000Z', lastBackoffAtVirtual: '2026-09-21T08:00:00.000Z',
      } } };
    });

    await createWorkstream({
      slug: 'active-with-expired-backoff', title: 'Active with expired backoff', objective: 'o',
      tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('active-with-expired-backoff', (doc) => {
      doc.capacity = { state: 'backoff', byModel: { active: {
        wait: capacityWait('2026-09-21T11:00:00.000Z'), consecutiveBackoffs: 1,
        firstBackoffAtVirtual: '2026-09-21T08:00:00.000Z', lastBackoffAtVirtual: '2026-09-21T08:00:00.000Z',
      } } };
    });

    await createWorkstream({
      slug: 'active-with-live-backoff', title: 'Active with live backoff', objective: 'o',
      tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('active-with-live-backoff', (doc) => {
      doc.capacity = { state: 'backoff', byModel: { active: {
        wait: capacityWait('2026-09-21T13:00:00.000Z'), consecutiveBackoffs: 1,
        firstBackoffAtVirtual: '2026-09-21T08:00:00.000Z', lastBackoffAtVirtual: '2026-09-21T08:00:00.000Z',
      } } };
    });

    const docs = await Promise.all(
      ['throughput', 'paused-with-backoff', 'active-with-expired-backoff', 'active-with-live-backoff']
        .map((slug) => load(slug)),
    );
    const output = runnerOutput(docs, wallNow, wallNow);

    assert.equal(output.lastCompletedPassAt, '2026-09-21T09:30:00.000Z', 'the infra/error/conflicted passes must not count, even with later endedAt');
    assert.equal(output.capacityBlocked, 1, 'only the ACTIVE workstream with a live (unexpired) backoff counts');
    assert.equal(output.observedAt, wallNow.toISOString());
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runnerOutput finds the oldest due wake, skipping leased, capacity-blocked, paused, and guarded workstreams', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-output-wakes-'));
  process.env.WEAVER_HOME = home;
  const wallNow = new Date('2026-09-21T12:00:00.000Z');
  const makeActive = (slug: string) => createWorkstream({
    slug, title: slug, objective: 'o', tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  try {
    // The genuinely oldest due wake a runner should report.
    await makeActive('due-winner');
    await arrive('due-winner', (doc) => doc.wakes.push({
      id: 'wake_winner', reason: 'r', status: 'pending', createdAt: '2026-09-21T08:00:00.000Z',
      condition: { type: 'wall_time', dueAt: '2026-09-21T09:00:00.000Z' },
    }));

    // Later than the winner — proves "oldest" isn't just "any due wake".
    await makeActive('due-later');
    await arrive('due-later', (doc) => doc.wakes.push({
      id: 'wake_later', reason: 'r', status: 'pending', createdAt: '2026-09-21T08:00:00.000Z',
      condition: { type: 'wall_time', dueAt: '2026-09-21T10:00:00.000Z' },
    }));

    // Earlier than the winner, but a live lease means a pass is running now.
    await makeActive('due-leased');
    await arrive('due-leased', (doc) => {
      doc.wakes.push({
        id: 'wake_leased', reason: 'r', status: 'pending', createdAt: '2026-09-21T07:00:00.000Z',
        condition: { type: 'wall_time', dueAt: '2026-09-21T07:00:00.000Z' },
      });
      doc.lease = { passId: 'pass_live', acquiredAt: '2026-09-21T11:50:00.000Z', expiresAt: '2026-09-21T12:10:00.000Z' };
    });

    // Earlier still, but the workstream is capacity-blocked.
    await makeActive('due-capacity');
    await arrive('due-capacity', (doc) => {
      doc.wakes.push({
        id: 'wake_capacity', reason: 'r', status: 'pending', createdAt: '2026-09-21T06:00:00.000Z',
        condition: { type: 'wall_time', dueAt: '2026-09-21T06:00:00.000Z' },
      });
      doc.capacity = { state: 'backoff', byModel: { active: {
        wait: capacityWait('2026-09-21T13:00:00.000Z'), consecutiveBackoffs: 1,
        firstBackoffAtVirtual: '2026-09-21T08:00:00.000Z', lastBackoffAtVirtual: '2026-09-21T08:00:00.000Z',
      } } };
    });

    // Earlier still, but the workstream itself is paused, not active.
    await makeActive('due-paused');
    await arrive('due-paused', (doc) => {
      doc.workstream.status = 'paused';
      doc.wakes.push({
        id: 'wake_paused', reason: 'r', status: 'pending', createdAt: '2026-09-21T05:00:00.000Z',
        condition: { type: 'wall_time', dueAt: '2026-09-21T05:00:00.000Z' },
      });
    });

    // Earlier still, but the wake itself is an infrastructure wait.
    await makeActive('due-infra-wake');
    await arrive('due-infra-wake', (doc) => doc.wakes.push({
      id: 'wake_infra', reason: 'r', status: 'pending', createdAt: '2026-09-21T04:00:00.000Z',
      condition: { type: 'wall_time', dueAt: '2026-09-21T04:00:00.000Z' },
      infrastructure: capacityWait('2026-09-21T11:00:00.000Z'),
    }));

    // Earlier still, but the wake is the runaway execution-safety guard.
    await makeActive('due-safety-wake');
    await arrive('due-safety-wake', (doc) => doc.wakes.push({
      id: 'wake_safety', reason: 'r', status: 'pending', createdAt: '2026-09-21T03:00:00.000Z',
      condition: { type: 'wall_time', dueAt: '2026-09-21T03:00:00.000Z' },
      executionSafety: { blockedUntil: '2026-09-21T13:00:00.000Z', observedStarts: 5, limit: 5, windowSeconds: 3600 },
    }));

    // Earliest of all: an ordinary organizational wake that the runaway guard
    // is deliberately holding until its window reopens. Paced, not unserved.
    await makeActive('due-safety-parked');
    await arrive('due-safety-parked', (doc) => {
      doc.wakes.push({
        id: 'wake_parked_org', reason: 'r', status: 'pending', createdAt: '2026-09-21T01:00:00.000Z',
        condition: { type: 'wall_time', dueAt: '2026-09-21T02:00:00.000Z' },
      });
      doc.wakes.push({
        id: 'wake_parked_guard', reason: 'r', status: 'pending', createdAt: '2026-09-21T11:00:00.000Z',
        condition: { type: 'wall_time', dueAt: '2026-09-21T12:30:00.000Z' },
        executionSafety: { blockedUntil: '2026-09-21T12:30:00.000Z', observedStarts: 5, limit: 5, windowSeconds: 3600 },
      });
    });

    // Not yet due at all.
    await makeActive('due-future');
    await arrive('due-future', (doc) => doc.wakes.push({
      id: 'wake_future', reason: 'r', status: 'pending', createdAt: '2026-09-21T08:00:00.000Z',
      condition: { type: 'wall_time', dueAt: '2026-09-21T13:00:00.000Z' },
    }));

    const slugs = [
      'due-winner', 'due-later', 'due-leased', 'due-capacity', 'due-paused',
      'due-infra-wake', 'due-safety-wake', 'due-safety-parked', 'due-future',
    ];
    const docs = await Promise.all(slugs.map((slug) => load(slug)));
    const output = runnerOutput(docs, wallNow, wallNow);

    assert.equal(output.oldestUnservedDueAt, '2026-09-21T09:00:00.000Z');
    assert.equal(output.capacityBlocked, 1);
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runnerOutput uses createdAt as an immediate wake\'s due time, and virtual time for a "time" wake', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-output-immediate-'));
  process.env.WEAVER_HOME = home;
  const wallNow = new Date('2026-09-21T12:00:00.000Z');
  const nowVirtual = new Date('2026-09-25T12:00:00.000Z');
  try {
    await createWorkstream({
      slug: 'due-immediate', title: 'Immediate', objective: 'o', tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('due-immediate', (doc) => doc.wakes.push({
      id: 'wake_immediate', reason: 'r', status: 'pending', createdAt: '2026-09-21T09:30:00.000Z',
      condition: { type: 'immediate' },
    }));

    const immediateOnly = runnerOutput([await load('due-immediate')], wallNow, nowVirtual);
    assert.equal(immediateOnly.oldestUnservedDueAt, '2026-09-21T09:30:00.000Z');

    await createWorkstream({
      slug: 'due-virtual', title: 'Virtual time', objective: 'o', tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('due-virtual', (doc) => doc.wakes.push({
      id: 'wake_virtual', reason: 'r', status: 'pending', createdAt: '2026-09-21T09:00:00.000Z',
      // Due by virtual clock (nowVirtual is 4 days later) despite being far in
      // the future by wall clock — the "time" condition is virtual-time only.
      condition: { type: 'time', dueAtVirtual: '2026-09-23T00:00:00.000Z' },
    }));

    const virtualOnly = runnerOutput([await load('due-virtual')], wallNow, nowVirtual);
    assert.equal(virtualOnly.oldestUnservedDueAt, '2026-09-23T00:00:00.000Z');
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
