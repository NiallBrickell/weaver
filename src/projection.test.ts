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

import { buildProjection, buildProjectionParts } from './projection.js';
import { renderPoliciesForProjection, type PolicyRecord } from './policies.js';
import type { WorkstreamDoc, Decision, Deliverable, Assignment } from './types.js';
import { virtualNow } from './clock.js';

test('the projection exposes durable coordinator host preference without changing worker placement', () => {
  const doc = routineDoc(0);
  doc.workstream.executionPolicy = { coordinatorRunnerOrder: ['mac-primary', 'gcp-standby'] };
  const projection = buildProjection(doc, []);
  assert.match(projection, /Coordinator runner policy: mac-primary → gcp-standby/);
  assert.match(projection, /physical pass placement only/);
});

const NOW = '2026-08-10T00:00:00.000Z';
const BIG_RATIONALE = 'x'.repeat(2000); // supporting prose that must not dominate

/** A routine that has run `cycles` cycles the RIGHT way: ONE standing course
 * for the recurring loop, advanced in place with record_progress — no decision
 * per cycle or step — while each cycle adopts two work products and completes
 * three assignments. Plus a little genuinely-live work at the head. The
 * course's rationale is a legacy oversize one (written before the caps), which
 * must still load and render excerpted. */
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
  // The recurring course: its commitment never changed, so it never needed a
  // successor — only its position moved.
  decisions.push({
    id: 'dec_course',
    title: 'Triage the queue every cycle',
    rationale: `Recurring triage commitment. ${BIG_RATIONALE}`,
    madeBy: 'coordinator',
    status: 'standing',
    decidedAtVirtual: NOW,
    ...(cycles > 0
      ? {
          progress: {
            cycle: cycles,
            step: 2,
            label: `cycle ${cycles} fixes dispatched`,
            awaitingIds: ['asg_live'],
            basisIds: [`del_${cycles - 1}_1`],
            next: 'Review the live candidate, then schedule the next sweep.',
            passId: `pass_${cycles}`,
            atVirtual: NOW,
            cycleStartedAtVirtual: NOW,
          },
        }
      : {}),
  });

  for (let c = 0; c < cycles; c++) {
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
    runnerId: 'mac-studio',
    executionRequirements: { profile: 'bounded-code-repair', modalities: ['text'], complexity: 'high' },
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'awaiting_review',
    attempts: [{
      runId: 'run_live',
      executor: 'codex-sdk',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      runnerId: 'mac-studio',
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
      assignmentRunnerId: 'niall-mac-primary',
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

/** The step-log shape stores written before record_progress still hold: every
 * cycle superseded the previous cycle's course with a fresh 2 KB decision. It
 * must stay bounded and loadable, though it is no longer the right way. */
function legacyStepLogDoc(cycles: number): WorkstreamDoc {
  const doc = routineDoc(cycles);
  for (let c = 0; c < cycles; c++) {
    const prev = c > 0 ? `dec_cycle_${c - 1}` : undefined;
    if (prev) {
      const old = doc.decisions.find((d) => d.id === prev)!;
      old.status = 'superseded';
      old.supersededBy = `dec_cycle_${c}`;
    }
    doc.decisions.push({
      id: `dec_cycle_${c}`,
      title: `Cycle ${c} triage disposition`,
      rationale: `Cycle ${c}: ${BIG_RATIONALE}`,
      madeBy: 'coordinator',
      status: 'standing',
      ...(prev ? { supersedes: prev } : {}),
      decidedAtVirtual: NOW,
    });
  }
  return doc;
}

test('projection does not grow linearly as a routine runs more cycles', () => {
  for (const shape of [routineDoc, legacyStepLogDoc]) {
    const at20 = buildProjection(shape(20), []).length;
    const at80 = buildProjection(shape(80), []).length;
    // 60 extra cycles add 180 completed assignments and 120 adopted
    // deliverables (and, in the legacy step-log shape, 60 retired decisions of
    // 2 KB each) — up to ~250 KB of raw history. The projection must absorb
    // that into bounded tails, not carry it.
    assert.ok(
      at80 - at20 < 2000,
      `${shape.name}: projection grew ${at80 - at20} chars over 60 cycles — history is leaking into the prompt`,
    );
    // And the absolute size stays modest even after many cycles.
    assert.ok(at80 < 20000, `${shape.name}: projection is ${at80} chars after 80 cycles — too large`);
  }
});

test('bounded projection still carries live work and standing commitments', () => {
  const p = buildProjection(routineDoc(50), []);
  // The durable standing commitment survives in full.
  assert.match(p, /Persistent workspace is \/tmp\/routine-clone/);
  // The one recurring course survives, and so does where it stands.
  assert.match(p, /dec_course \[STANDING\] "Triage the queue every cycle"/);
  assert.match(p, /progress: cycle 50 · step 2 "cycle 50 fixes dispatched"/);
  // Live unresolved work survives.
  assert.match(p, /UNIQUE_LIVE_MARKER/);
  assert.match(p, /LIVE candidate awaiting review/);
  // Declared complexity is part of the durable position — a fresh coordinator
  // must see it from the projection, never from a transcript.
  assert.match(p, /requirements:bounded-code-repair\/text\/high-complexity/);
  assert.match(p, /latest-target:codex-sdk\/openai\/gpt-5\.6-sol/);
  assert.match(p, /runner:mac-studio/);
  assert.match(p, /Every new worker\/action Assignment is bound to runner niall-mac-primary/);
  assert.match(p, /Coordinator passes remain fleet-wide/);
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
  const p = buildProjection(legacyStepLogDoc(50), []);
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

test('projection keeps the always-execute action preflight contract across a fresh pass', () => {
  const doc = routineDoc(0);
  doc.assignments.push({
    id: 'asg_observation',
    objective: 'Capture one fresh provider observation',
    briefing: 'Run the exact command and retain its output.',
    kind: 'action',
    exec: {
      cwd: '/repo',
      run: 'provider status',
      verify: 'provider auth-check',
      preflightMode: 'always-execute',
      approval: { by: 'pilot', at: NOW },
    },
    acceptanceCriteria: ['fresh output recorded'],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: NOW,
  });

  const projection = buildProjection(doc, []);
  assert.match(projection, /asg_observation.*preflight:ALWAYS-EXECUTE/);
  assert.match(projection, /fresh command output is the result; approval\/one-shot\/readback unchanged/);
});

test('projection exposes exact cancellable organizational wakes but no harness-owned or historical wakes', () => {
  const doc = routineDoc(0);
  const createdAt = new Date().toISOString();
  const now = virtualNow().getTime();
  const due = (minutes: number) =>
    new Date(now + minutes * 60_000).toISOString();
  const giantReason = `review the adopted cycle at the new cadence ${'x'.repeat(10_000)}`;
  doc.decisions.push({
    id: 'dec_wake_course', title: 'The exact scheduled routine course',
    rationale: 'Typed provenance for every ordinary wake in this fixture.',
    madeBy: 'coordinator', status: 'standing', decidedAtVirtual: createdAt,
  });
  const infrastructure = {
    kind: 'rate_limit' as const,
    recovery: 'automatic_retry' as const,
    source: 'coordinator' as const,
    sourceId: 'pass_capacity',
    executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
    detectedAt: createdAt, retryAt: due(15),
  };
  doc.wakes.push(
    {
      id: 'wake_visible', reason: giantReason,
      condition: { type: 'time', dueAtVirtual: due(120) }, status: 'pending', createdAt,
      organizationalCourseId: 'dec_wake_course',
    },
    {
      id: 'wake_fired_hidden', reason: 'HISTORICAL_FIRED_MARKER',
      condition: { type: 'time', dueAtVirtual: due(3) }, status: 'fired', createdAt,
    },
    {
      id: 'wake_cancelled_hidden', reason: 'HISTORICAL_CANCELLED_MARKER',
      condition: { type: 'time', dueAtVirtual: due(4) }, status: 'cancelled', createdAt,
    },
    {
      id: 'wake_infrastructure_hidden', reason: 'INFRASTRUCTURE_MARKER',
      condition: { type: 'time', dueAtVirtual: infrastructure.retryAt },
      status: 'pending', createdAt, infrastructure,
    },
    {
      id: 'wake_safety_hidden', reason: 'EXECUTION_SAFETY_MARKER',
      condition: { type: 'time', dueAtVirtual: due(6) }, status: 'pending', createdAt,
      executionSafety: { blockedUntil: due(6), observedStarts: 16, limit: 16, windowSeconds: 600 },
    },
    {
      id: 'wake_immediate_hidden', reason: 'IMMEDIATE_MARKER',
      condition: { type: 'immediate' }, status: 'pending', createdAt,
    },
    {
      id: 'wake_wall_hidden', reason: 'WALL_TIME_MARKER',
      condition: { type: 'wall_time', dueAt: due(8) }, status: 'pending', createdAt,
    },
    {
      id: 'wake_overdue_hidden', reason: 'OVERDUE_MARKER',
      condition: { type: 'time', dueAtVirtual: due(-1) }, status: 'pending', createdAt,
    },
  );
  for (let index = 0; index < 1_000; index++) {
    doc.wakes.push({
      id: `wake_history_${index}`,
      reason: `HISTORICAL_WAKE_${index}`,
      condition: { type: 'time', dueAtVirtual: due(10) },
      status: index % 2 === 0 ? 'fired' : 'cancelled',
      createdAt,
    });
  }
  for (let index = 0; index < 1_000; index++) {
    doc.wakes.push({
      id: `wake_pending_backlog_${index}`,
      reason: `PENDING_BACKLOG_${index}`,
      condition: { type: 'time', dueAtVirtual: due(index + 20) },
      status: 'pending', createdAt, organizationalCourseId: 'dec_wake_course',
    });
  }

  const projection = buildProjection(doc, []);
  assert.match(
    projection,
    new RegExp(`wake_visible for dec_wake_course due ${due(120)}: review the adopted cycle at the new cadence`),
  );
  assert.match(projection, /1001 total/);
  assert.match(projection, /call list_cancellable_wakes/);
  assert.doesNotMatch(projection, /PENDING_BACKLOG_999/);
  assert.doesNotMatch(projection, /x{1000}/);
  for (const marker of [
    'HISTORICAL_FIRED_MARKER',
    'HISTORICAL_CANCELLED_MARKER',
    'INFRASTRUCTURE_MARKER',
    'EXECUTION_SAFETY_MARKER',
    'IMMEDIATE_MARKER',
    'WALL_TIME_MARKER',
    'OVERDUE_MARKER',
    'HISTORICAL_WAKE_',
  ]) {
    assert.doesNotMatch(projection, new RegExp(marker));
  }
  assert.ok(projection.length < 20_000, `projection grew to ${projection.length} characters`);
});

test('a standing course renders its recorded progress as one typed line — position, not authority', () => {
  const doc = routineDoc(7);
  const p = buildProjection(doc, []);
  const courseLine = p.split('\n').findIndex((line) => line.startsWith('- dec_course [STANDING]'));
  assert.ok(courseLine >= 0);
  assert.equal(
    p.split('\n')[courseLine + 1],
    `  progress: cycle 7 · step 2 "cycle 7 fixes dispatched" · awaiting [asg_live] · basis [del_6_1] · next: Review the live candidate, then schedule the next sweep. · as of ${NOW} (cycle since ${NOW}) (position, not authority)`,
  );
  // A course with no progress renders no progress line.
  assert.doesNotMatch(buildProjection(routineDoc(0), []), /progress: cycle/);
  // Awaited work that has since settled is marked, from typed state.
  doc.assignments.find((a) => a.id === 'asg_live')!.state = 'completed';
  assert.match(buildProjection(doc, []), /awaiting \[asg_live \(settled\)\]/);
  // Progress never changes what is authoritative: the course is still the
  // same standing commitment, and nothing it cites was adopted by it.
  assert.match(buildProjection(doc, []), /LIVE candidate awaiting review/);
});

/** A supersede chain dec_churn_0 → … → dec_churn_n, successor i decided
 * `hoursAgo(i)` hours before virtual now. Titles are deliberately counter-free
 * so the test proves the nudge reads typed lineage, not prose. */
function churnDoc(successors: number, hoursAgo: (i: number) => number): WorkstreamDoc {
  const doc = routineDoc(0);
  const now = virtualNow().getTime();
  for (let i = 0; i <= successors; i++) {
    doc.decisions.push({
      id: `dec_churn_${i}`,
      title: 'Keep the investigation on its current plan',
      rationale: 'same commitment, restated',
      madeBy: 'coordinator',
      status: i === successors ? 'standing' : 'superseded',
      ...(i > 0 ? { supersedes: `dec_churn_${i - 1}` } : {}),
      ...(i < successors ? { supersededBy: `dec_churn_${i + 1}` } : {}),
      decidedAtVirtual: new Date(now - hoursAgo(i) * 60 * 60_000).toISOString(),
    });
  }
  return doc;
}

test('a supersede lineage churning five or more times in 24h is named and pointed at record_progress', () => {
  const recent = (i: number) => 10 - i; // every successor inside the last 10h
  const five = buildProjection(churnDoc(5, recent), []);
  assert.match(five, /CHURN: dec_churn_5's lineage \(from dec_churn_0\) was superseded 5 times in the last 24h/);
  assert.match(five, /advance it with record_progress/);

  assert.doesNotMatch(buildProjection(churnDoc(4, recent), []), /CHURN:/, 'four supersessions is below the threshold');
  // Six supersessions, but only four of them inside the window.
  const old = (i: number) => (i <= 2 ? 48 - i : 10 - i);
  assert.doesNotMatch(buildProjection(churnDoc(6, old), []), /CHURN:/, 'churn outside the 24h window is history, not a habit');
  // A lineage whose head was closed has nothing left to advance.
  const closed = churnDoc(5, recent);
  closed.decisions.at(-1)!.status = 'closed';
  assert.doesNotMatch(buildProjection(closed, []), /CHURN:/);
});

test('a legacy oversize review boundary is excerpted in the projection and kept whole in state', () => {
  const doc = routineDoc(1);
  const reviewWhen = `review when the baseline moves ${'w'.repeat(2_800)} REVIEW_TAIL`;
  const course = doc.decisions.find((d) => d.id === 'dec_course')!;
  course.reviewWhen = reviewWhen;
  const p = buildProjection(doc, []);
  assert.doesNotMatch(p, /REVIEW_TAIL/);
  assert.match(p, /Review when: review when the baseline moves w+…\./);
  const shown = /Review when: ([^\n]*?)\. \(by/.exec(p)![1]!;
  assert.ok(shown.length <= 201, `review boundary rendered ${shown.length} chars`);
  assert.equal(course.reviewWhen, reviewWhen, 'the typed record is untouched');
});

/** Every event a fresh coordinator was shown before §8 was deduplicated:
 * §7's arrivals plus §8's last-25 tail, as a set of rendered event facts. */
function eventFactsBefore(doc: WorkstreamDoc): Set<string> {
  const cutoff = [...doc.passes].reverse().find((p) => p.endedAt)?.endedAt;
  const arrivals = cutoff ? doc.events.filter((e) => e.at > cutoff) : doc.events;
  return new Set([...arrivals, ...doc.events.slice(-25)].map((e) => `[${e.atVirtual}] ${e.type}: ${e.summary}`));
}

/** The typed facts a fresh coordinator continues from: ids, every event line,
 * and every other rendered line (criteria, constraints, open loops). */
function renderedFacts(projection: string): { ids: Set<string>; events: string[]; lines: Set<string> } {
  const eventLine = /^- \[\d{4}-/;
  return {
    ids: new Set(projection.match(/\b(?:dec|asg|del|att|wake|obs|pol|steer|pass|int|run)_[A-Za-z0-9_]+\b/g) ?? []),
    events: projection.split('\n').filter((l) => eventLine.test(l)).map((l) => l.slice(2)),
    lines: new Set(projection.split('\n').filter((l) => !eventLine.test(l))),
  };
}

/** `events` history lines, the last `newSincePass` of which arrived after the
 * previous pass ended (every one of them when no pass has run yet). */
function withHistory(doc: WorkstreamDoc, events: number, newSincePass: number): WorkstreamDoc {
  const at = (i: number) => new Date(Date.parse(NOW) + i * 60_000).toISOString();
  for (let i = 0; i < events; i++) {
    doc.events.push({ at: at(i), atVirtual: at(i), type: i % 2 ? 'submission.adopted' : 'wake.scheduled', summary: `event ${i} EVENT_FACT_${i}`, refs: [`asg_${i}`] });
  }
  if (newSincePass < events) {
    const passEnd = new Date(Date.parse(at(events - newSincePass - 1)) + 1_000).toISOString();
    doc.passes.push({ id: 'pass_prev', startedAt: NOW, endedAt: passEnd, baseRevision: 1, wakeReasons: [], changes: [], outcome: 'completed' });
  }
  return doc;
}

test('§8 no longer repeats §7 arrivals, and a fresh coordinator is shown exactly the same event facts', () => {
  // Shapes: the common completion wake (a few arrivals inside the tail), a
  // burst larger than the tail, a first pass (no prior pass: every event is
  // an arrival), and a pass with nothing new.
  for (const [events, fresh] of [[60, 4], [60, 40], [12, 12], [30, 0]] as const) {
    const doc = withHistory(routineDoc(3), events, fresh);
    const projection = buildProjection(doc, ['a worker completed']);
    const facts = renderedFacts(projection);
    // The same set of event facts as the pre-dedup rendering…
    assert.deepEqual(new Set(facts.events), eventFactsBefore(doc), `${events}/${fresh}: event facts changed`);
    // …each now rendered exactly once.
    assert.equal(facts.events.length, new Set(facts.events).size, `${events}/${fresh}: an event is still rendered twice`);
    const s8 = projection.slice(projection.indexOf('## 8.'), projection.indexOf('## 9.'));
    const overlap = Math.min(fresh, 25);
    if (overlap) {
      assert.match(s8, new RegExp(`\\(\\+${overlap} newer events? — listed under §7 above, not repeated here\\)`));
    } else {
      assert.doesNotMatch(s8, /listed under §7/);
    }
    // What §8 still lists is the older, contiguous part of the tail.
    const s8Events = s8.split('\n').filter((l) => /^- \[\d{4}-/.test(l));
    assert.equal(s8Events.length, Math.min(events, 25) - overlap);
  }
  // A workstream with no history still says so.
  assert.match(buildProjection(routineDoc(0), []), /## 8\. Recent history[^\n]*\n- \(no history\)/);
});

test('the lossless tightenings leave every typed fact of a representative projection in place', () => {
  const doc = withHistory(routineDoc(30), 40, 5);
  doc.workstream.successCriteria = ['CRITERION_ONE holds', 'CRITERION_TWO holds'];
  doc.workstream.constraints = ['CONSTRAINT_ONE'];
  doc.attention.push({ id: 'att_open', kind: 'blocker', summary: 'OPEN_LOOP needs the human', status: 'open', createdAt: NOW });
  const projection = buildProjection(doc, ['a worker completed']);
  const facts = renderedFacts(projection);
  const expectedIds = [
    ...doc.decisions.filter((d) => d.status === 'standing').map((d) => d.id),
    ...doc.assignments.filter((a) => !['completed', 'cancelled'].includes(a.state)).map((a) => a.id),
    ...doc.deliverables.filter((d) => d.adopted).slice(-25).map((d) => d.id),
    'del_live', 'att_open',
  ];
  for (const id of expectedIds) assert.ok(facts.ids.has(id), `${id} missing from the projection`);
  for (const line of ['- CRITERION_ONE holds', '- CRITERION_TWO holds', '- CONSTRAINT_ONE']) {
    assert.ok(facts.lines.has(line), `${line} missing from the projection`);
  }
  for (const d of doc.decisions.filter((x) => x.status === 'standing')) assert.ok(projection.includes(`"${d.title}"`), d.title);
  assert.match(projection, /att_open \[blocker\] OPEN_LOOP needs the human/);
  assert.deepEqual(new Set(facts.events), eventFactsBefore(doc));
});

/** One doctrine rule and one learned policy, as the policy store holds them. */
function projectionPolicies(): PolicyRecord[] {
  const base = {
    scope: { tags: ['routine'] },
    widensAuthority: false as const,
    evidence: [],
    createdAt: NOW,
  };
  return [
    {
      ...base,
      id: 'pol_doctrine',
      statement: 'DOCTRINE_STATEMENT: merge with a merge commit',
      effect: { kind: 'add_verification', description: 'check the merge method' },
      status: 'active',
      provenance: { source: 'backfill:rules', ref: 'CLAUDE.md § Git', interventionSummary: 'seeded' },
    },
    {
      ...base,
      id: 'pol_learned',
      statement: 'LEARNED_STATEMENT: read the runbook first',
      mechanism: 'open docs/runbook.md',
      effect: { kind: 'advisory', description: 'advise reading the runbook' },
      status: 'shadow',
      provenance: { workstreamSlug: 'other', passId: 'pass_x', interventionSummary: 'the human pointed at the runbook' },
    },
  ];
}

/** A representative document with every volatile section populated. */
function representativeDoc(): WorkstreamDoc {
  const doc = withHistory(routineDoc(30), 40, 5);
  doc.workstream.tags = ['routine'];
  doc.workstream.successCriteria = ['CRITERION_ONE holds', 'CRITERION_TWO holds'];
  doc.workstream.constraints = ['CONSTRAINT_ONE'];
  doc.attention.push({ id: 'att_open', kind: 'blocker', summary: 'OPEN_LOOP needs the human', status: 'open', createdAt: NOW });
  return doc;
}

const nonBlankLines = (text: string): string[] =>
  text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('- virtual now: ')).sort();

test('the stable prefix is byte-identical across passes whose only changes are volatile', () => {
  const doc = representativeDoc();
  const policies = projectionPolicies();
  const first = buildProjectionParts(doc, ['a worker completed'], policies);

  // What moves between two passes without a write to the stable sections:
  // the clock, a finished pass, a new arrival, the revision, the wake reason,
  // the course's recorded position, and a new live assignment.
  const next = structuredClone(doc);
  const later = new Date(Date.parse(NOW) + 3 * 60 * 60_000).toISOString();
  next.passes.push({ id: 'pass_next', startedAt: later, endedAt: later, baseRevision: next.revision, wakeReasons: [], changes: [], outcome: 'completed' });
  next.events.push({ at: later, atVirtual: later, type: 'submission.received', summary: 'NEW_ARRIVAL', refs: [] });
  next.revision += 7;
  next.decisions.find((d) => d.id === 'dec_course')!.progress!.step += 1;
  next.assignments.push({ ...next.assignments.find((a) => a.state !== 'completed')!, id: 'asg_new_live' });
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60 * 60_000;
  let second;
  try {
    second = buildProjectionParts(next, ['a different wake'], policies);
  } finally {
    Date.now = realNow;
  }

  assert.equal(second.stable, first.stable, 'nothing in the stable prefix changed, so not one byte of it may');
  assert.notEqual(second.volatile, first.volatile);
  assert.match(second.volatile, /NEW_ARRIVAL/);
  // Nothing clock-relative, no revision and no wake reason sits above the split.
  for (const volatileText of ['revision=', 'virtual now', 'woken because', 'a worker completed', '## 3.', '## 9.']) {
    assert.ok(!first.stable.includes(volatileText), `stable prefix carries "${volatileText}"`);
  }
  // A real write to a stable section does change it.
  const edited = structuredClone(doc);
  edited.workstream.constraints.push('CONSTRAINT_TWO');
  assert.notEqual(buildProjectionParts(edited, ['a worker completed'], policies).stable, first.stable);
});

test('the projection is stable-first: policies, title, §1, §2, then §3–§9 in order, each once', () => {
  const policies = projectionPolicies();
  const parts = buildProjectionParts(representativeDoc(), ['a worker completed'], policies);
  const whole = parts.stable + parts.volatile;
  assert.equal(buildProjection(representativeDoc(), ['a worker completed'], policies).replace(/virtual now: .*/, ''), whole.replace(/virtual now: .*/, ''));
  const headings = whole.split('\n').filter((line) => /^#{1,2} /.test(line));
  assert.deepEqual(headings.map((h) => h.replace(/^(#+ \d\.|# [A-Z][a-z]+).*/, '$1')), [
    '# Policies', '# Workstream', '## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.', '## 8.', '## 9.',
  ]);
  assert.ok(parts.stable.endsWith('\n') && parts.volatile.startsWith('\n## 3. '), 'the split falls on the blank line before §3');
  assert.ok(parts.stable.includes(renderPoliciesForProjection(policies)), 'the policy block moved whole');
  // Doctrine still renders ahead of learned policy, inside the block.
  assert.ok(parts.stable.indexOf('DOCTRINE_STATEMENT') < parts.stable.indexOf('LEARNED_STATEMENT'));
  // Without policies there is no policy heading, and the title leads.
  assert.ok(buildProjectionParts(representativeDoc(), [], []).stable.startsWith('# Workstream projection: '));
});

test('moving the policy block to the stable prefix changes no fact the coordinator is shown', () => {
  const doc = representativeDoc();
  const policies = projectionPolicies();
  const withPolicies = buildProjection(doc, ['a worker completed'], policies);
  const withoutPolicies = buildProjection(doc, ['a worker completed'], []);
  // Every line of the policy-free projection, every line of the policy block,
  // and one heading: nothing added, dropped, or rewritten by the move.
  assert.deepEqual(
    nonBlankLines(withPolicies),
    [...nonBlankLines(withoutPolicies), ...nonBlankLines(renderPoliciesForProjection(policies)), "# Policies and doctrine matching this workstream's tags"].sort(),
  );
  const facts = renderedFacts(withPolicies);
  for (const id of ['pol_doctrine', 'pol_learned', 'att_open', 'del_live', ...doc.decisions.filter((d) => d.status === 'standing').map((d) => d.id)]) {
    assert.ok(facts.ids.has(id), `${id} missing`);
  }
  for (const line of ['- CRITERION_ONE holds', '- CRITERION_TWO holds', '- CONSTRAINT_ONE']) assert.ok(facts.lines.has(line), line);
  assert.deepEqual(new Set(facts.events), eventFactsBefore(doc));
});
