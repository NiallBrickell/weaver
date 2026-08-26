/**
 * The projection stays bounded as a routine runs cycle after cycle.
 *
 * A long-running routine accumulates completed assignments, adopted
 * deliverables, and retired decisions forever. The projection is the
 * coordinator's ENTIRE position, so if it grew linearly with that history a
 * fresh pass would drown in a prompt that reads like a transcript — exactly
 * the failure kernel rules 2 and 4 forbid. These tests pin the size bound and
 * prove that what a fresh coordinator needs to CONTINUE still survives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProjection } from './projection.js';
import type { WorkstreamDoc, Decision, Deliverable, Assignment } from './types.js';

const NOW = '2026-08-10T00:00:00.000Z';
const BIG_RATIONALE = 'x'.repeat(2000); // supporting prose that must not dominate

/** A routine that has run `cycles` cycles the RIGHT way: each cycle records one
 * course (superseding the previous cycle's), adopts two work products, and
 * completes three assignments. Plus a little genuinely-live work at the head. */
function routineDoc(cycles: number): WorkstreamDoc {
  const decisions: Decision[] = [];
  const deliverables: Deliverable[] = [];
  const assignments: Assignment[] = [];

  // One durable, genuinely-standing commitment that must always survive.
  decisions.push({
    id: 'dec_workspace',
    title: 'Persistent workspace is /tmp/routine-clone',
    rationale: 'Reuse one clone across cycles; concurrent mutating work gets worktrees off it.',
    madeBy: 'coordinator',
    status: 'standing',
    decidedAtVirtual: NOW,
  });

  for (let c = 0; c < cycles; c++) {
    const prev = c > 0 ? `dec_cycle_${c - 1}` : undefined;
    if (prev) {
      const old = decisions.find((d) => d.id === prev)!;
      old.status = 'superseded';
      old.supersededBy = `dec_cycle_${c}`;
    }
    decisions.push({
      id: `dec_cycle_${c}`,
      title: `Cycle ${c} triage disposition`,
      rationale: `Cycle ${c}: ${BIG_RATIONALE}`,
      madeBy: 'coordinator',
      status: 'standing',
      ...(prev ? { supersedes: prev } : {}),
      decidedAtVirtual: NOW,
    });
    for (let k = 0; k < 2; k++) {
      deliverables.push({
        id: `del_${c}_${k}`,
        title: `Cycle ${c} sweep report ${k}`,
        kind: 'report',
        path: `del_${c}_${k}.md`,
        contentHash: `${c}${k}`.padEnd(64, '0'),
        adopted: { contentHash: `${c}${k}`.padEnd(64, '0'), passId: `pass_${c}`, atVirtual: NOW },
        createdAtVirtual: NOW,
      } as Deliverable);
    }
    for (let k = 0; k < 3; k++) {
      assignments.push({
        id: `asg_${c}_${k}`,
        objective: `Cycle ${c} fix issue ${k} UNIQUE_COMPLETED_MARKER`,
        briefing: 'b',
        kind: 'work',
        acceptanceCriteria: [],
        dependsOn: [],
        state: 'completed',
        attempts: [],
        adoption: { state: 'accepted' },
        createdAtVirtual: NOW,
      });
    }
  }

  // Live head: one candidate awaiting review + one queued assignment.
  deliverables.push({
    id: 'del_live',
    title: 'LIVE candidate awaiting review',
    kind: 'report',
    path: 'del_live.md',
    contentHash: 'live'.padEnd(64, '0'),
    createdAtVirtual: NOW,
  } as Deliverable);
  assignments.push({
    id: 'asg_live',
    objective: 'LIVE queued work UNIQUE_LIVE_MARKER',
    briefing: 'b',
    kind: 'work',
    executionRequirements: { profile: 'bounded-code-repair', modalities: ['text'], complexity: 'high' },
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'awaiting_review',
    attempts: [{
      runId: 'run_live',
      executor: 'codex-sdk',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      startedAt: NOW,
    }],
    adoption: { state: 'proposed' },
    submission: { summary: 'ready for your review', deliverableId: 'del_live' },
    createdAtVirtual: NOW,
  });

  return {
    schemaVersion: 1,
    revision: cycles + 1,
    workstream: {
      id: 'ws_routine',
      slug: 'sweep-routine',
      title: 'Sweep routine',
      objective: 'Continuously triage the queue',
      tags: ['routine'],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      budget: { maxCoordinatorPasses: 100000, maxCostUsd: 100000 },
      status: 'active',
      createdAt: NOW,
    },
    decisions,
    assignments,
    deliverables,
    interactions: [],
    observations: [],
    wakes: [],
    steering: [],
    attention: [],
    passes: [],
    events: [],
    spend: { coordinatorPasses: cycles, totalCostUsd: 0, humanInterventions: 0 },
    capacity: null,
    lease: null,
  };
}

test('projection does not grow linearly as a routine runs more cycles', () => {
  const at20 = buildProjection(routineDoc(20), []).length;
  const at80 = buildProjection(routineDoc(80), []).length;
  // 60 extra cycles add 180 completed assignments, 120 adopted deliverables,
  // and 60 retired decisions of 2 KB each — ~250 KB of raw history. The
  // projection must absorb that into bounded tails, not carry it.
  assert.ok(
    at80 - at20 < 2000,
    `projection grew ${at80 - at20} chars over 60 cycles — history is leaking into the prompt`,
  );
  // And the absolute size stays modest even after many cycles.
  assert.ok(at80 < 20000, `projection is ${at80} chars after 80 cycles — too large`);
});

test('bounded projection still carries live work and standing commitments', () => {
  const p = buildProjection(routineDoc(50), []);
  // The durable standing commitment survives in full.
  assert.match(p, /Persistent workspace is \/tmp\/routine-clone/);
  // The latest cycle course (still standing) survives.
  assert.match(p, /Cycle 49 triage disposition/);
  // Live unresolved work survives.
  assert.match(p, /UNIQUE_LIVE_MARKER/);
  assert.match(p, /LIVE candidate awaiting review/);
  // Declared complexity is part of the durable position — a fresh coordinator
  // must see it from the projection, never from a transcript.
  assert.match(p, /requirements:bounded-code-repair\/text\/high-complexity/);
  assert.match(p, /latest-target:codex-sdk\/openai\/gpt-5\.6-sol/);
});

test('a legacy approval-service outage card is operational state, never a fresh-coordinator human ask', () => {
  const doc = routineDoc(0);
  doc.assignments.push({
    id: 'asg_pilot_wait', objective: 'Open the reviewed change', briefing: 'Use the gated action path.',
    kind: 'action', exec: { cwd: '/repo', verify: 'true', approvalMode: 'pilot-or-human', pilotUnavailableSince: NOW },
    acceptanceCriteria: [], dependsOn: [], state: 'gated', attempts: [], adoption: { state: 'none' }, createdAtVirtual: NOW,
  });
  doc.attention.push({
    id: 'att_legacy_pilot', kind: 'approval', refId: 'asg_pilot_wait',
    summary: 'Pilot has been unavailable; approve manually or restart it.', status: 'open', createdAt: NOW,
  });

  const projection = buildProjection(doc, []);
  assert.match(projection, /Needs a human[\s\S]*- \(nothing\)/);
  assert.match(projection, /Operational dependency waits[\s\S]*asg_pilot_wait: approval service unavailable/);
  assert.doesNotMatch(projection, /approve manually or restart it/);

  doc.workstream.status = 'paused';
  const paused = buildProjection(doc, []);
  assert.match(paused, /Needs a human[\s\S]*- \(nothing\)/);
  assert.match(paused, /Operational dependency waits[\s\S]*- \(none\)/);
  assert.doesNotMatch(paused, /approve manually or restart it/);
});

test('legacy dollar and lifetime pass caps never reach the coordinator as remaining authority', () => {
  const p = buildProjection(routineDoc(50), []);
  assert.doesNotMatch(p, /Remaining budget|passes so far|\$100000/);
  assert.match(p, /Authority & execution safety/);
  assert.match(p, /30 model starts in any rolling 60m/);
});

test('completed assignments are counted, not enumerated', () => {
  const p = buildProjection(routineDoc(50), []);
  assert.doesNotMatch(p, /UNIQUE_COMPLETED_MARKER/, 'completed assignments must not be listed');
  assert.match(p, /completed\/cancelled assignments, not shown/);
});

test('older adopted deliverables and retired decisions are summarized, not dumped', () => {
  const p = buildProjection(routineDoc(50), []);
  assert.match(p, /earlier adopted work products/);
  assert.match(p, /earlier retired decisions/);
});

test('a long standing rationale is excerpted, never dumped whole', () => {
  const p = buildProjection(routineDoc(3), []);
  // The 2000-char rationale must be truncated with an ellipsis.
  assert.ok(!p.includes(BIG_RATIONALE), 'full 2 KB rationale leaked into the projection');
  assert.match(p, /…/);
});

test('a rejected candidate does not linger as "awaiting review"', () => {
  const doc = routineDoc(1);
  doc.deliverables.push({
    id: 'del_rejected',
    title: 'REJECTED_CANDIDATE_MARKER',
    kind: 'report',
    path: 'del_rejected.md',
    contentHash: 'rej'.padEnd(64, '0'),
    createdAtVirtual: NOW,
  } as Deliverable);
  doc.assignments.push({
    id: 'asg_rejected',
    objective: 'produced a rejected candidate',
    briefing: 'b',
    kind: 'work',
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'failed',
    attempts: [],
    adoption: { state: 'rejected' },
    submission: { summary: 's', deliverableId: 'del_rejected' },
    createdAtVirtual: NOW,
  });
  const p = buildProjection(doc, []);
  assert.doesNotMatch(p, /REJECTED_CANDIDATE_MARKER/, 'a rejected candidate must not show as awaiting review');
});

test('many standing decisions trigger the convergence nudge', () => {
  // A routine doing it WRONG: every cycle leaves a NEW standing decision.
  const doc = routineDoc(0);
  for (let i = 0; i < 25; i++) {
    doc.decisions.push({
      id: `dec_stale_${i}`,
      title: `stale cycle course ${i}`,
      rationale: 'left standing by mistake',
      madeBy: 'coordinator',
      status: 'standing',
      decidedAtVirtual: NOW,
    });
  }
  const p = buildProjection(doc, []);
  assert.match(p, /standing decisions are commitments, not a cycle log/i);
});
