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
      doc.attention.push({
        id: 'att_real', kind: 'blocker', summary: 'Choose the supported release course.',
        status: 'open', createdAt: '2026-08-26T10:00:00.000Z',
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
    assert.equal(evidence.incidents.length, 1);
    assert.equal(evidence.workstreams.length, 1);
    assert.equal(evidence.workstreams[0]!.slug, 'needs-triage');
    assert.equal(evidence.workstreams[0]!.revision, docs[1]!.revision);
    assert.deepEqual(
      evidence.workstreams[0]!.humanNeeds.map((need) => need.id).sort(),
      ['asg_human_only', 'att_real', 'int_release'],
    );
    assert.doesNotMatch(encoded, /LEGACY_DUPLICATE_APPROVAL_SERVICE_CARD/);
    assert.doesNotMatch(encoded, /DO_NOT_EXPORT_THIS_UNRELATED/);
    assert.doesNotMatch(encoded, /Quiet private work|private detail/);
  } finally {
    await closeStore();
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
