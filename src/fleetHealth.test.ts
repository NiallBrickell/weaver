import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { fleetAttentionEvidence } from './fleetHealth.js';
import { arrive, closeStore, createWorkstream, load } from './store.js';

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
