import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatedActionPosition } from './tui.js';
import type { Assignment, WorkstreamDoc } from './types.js';

function pilotAction(): Assignment {
  return {
    id: 'asg_pilot',
    objective: 'Open the reviewed change',
    briefing: 'Use the action lane.',
    kind: 'action',
    exec: { cwd: '/repo', verify: 'true', approvalMode: 'pilot-or-human' },
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'gated',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: '2026-08-26T10:00:00.000Z',
  };
}

test('pausing hides a Pilot wait without turning it into a human approval', () => {
  const doc = { workstream: { status: 'active' } } as WorkstreamDoc;
  const assignment = pilotAction();

  assert.equal(gatedActionPosition(doc, assignment), 'pilot-live');
  doc.workstream.status = 'paused';
  assert.equal(gatedActionPosition(doc, assignment), 'pilot-held');

  assignment.exec!.approvalMode = 'human-only';
  assert.equal(gatedActionPosition(doc, assignment), 'human');
});
