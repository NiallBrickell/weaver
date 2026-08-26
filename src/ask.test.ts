/**
 * Deterministic digest-contract tests: the digest is the ask command's
 * grounding anchor, so it must surface every workstream (live and archived)
 * with the ids a citation needs. The model call itself is not tested here.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildFleetDigest } from './ask.js';
import { arrive, createWorkstream, weaverHome, workstreamDir } from './store.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-ask-'));
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
});

test('digest covers live and archived streams with citable ids', async () => {
  await createWorkstream({
    slug: 'live-one',
    title: 'Live stream',
    objective: 'do the live thing',
    tags: ['t'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive('live-one', (d, event) => {
    d.attention.push({
      id: 'att_x1',
      kind: 'blocker',
      summary: 'needs a decision about the thing',
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    d.assignments.push({
      id: 'asg_pilot_wait', objective: 'Open the reviewed change', briefing: 'Use the gated action path.',
      kind: 'action', exec: { cwd: '/repo', verify: 'true', approvalMode: 'pilot-or-human', pilotUnavailableSince: '2026-08-26T10:00:00.000Z' },
      acceptanceCriteria: [], dependsOn: [], state: 'gated', attempts: [], adoption: { state: 'none' }, createdAtVirtual: '2026-08-26T10:00:00.000Z',
    });
    d.attention.push({
      id: 'att_legacy_pilot', kind: 'approval', refId: 'asg_pilot_wait',
      summary: 'Pilot unavailable; approve manually.', status: 'open', createdAt: '2026-08-26T10:00:00.000Z',
    });
    event('attention.raised', 'needs a decision', ['att_x1']);
  });
  // Archive a second stream by moving its dir wholesale.
  await createWorkstream({
    slug: 'old-one',
    title: 'Old stream',
    objective: 'finished long ago',
    tags: ['t'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const archive = path.join(weaverHome(), '_archive');
  fs.mkdirSync(archive, { recursive: true });
  fs.renameSync(workstreamDir('old-one'), path.join(archive, 'old-one'));

  const digest = await buildFleetDigest();
  assert.match(digest, /## live-one \[active\] — Live stream/);
  assert.match(digest, /att_x1/);
  assert.match(digest, /operational wait: approval service unavailable/);
  assert.doesNotMatch(digest, /att_legacy_pilot|approve manually/);
  assert.match(digest, /## old-one \(archived\)/);
  assert.match(digest, /finished long ago/);
});
