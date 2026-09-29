/**
 * The workstream timeline is pure over typed records, so these tests pin what
 * it may show: chronological order, derived wait rows and the wake that
 * explains them, retry folding from typed adoption/state only, decision
 * lineage, withdrawn steers, the conclusion's disposition, and the default
 * row limit. No model, no store, no event tail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatWait, RETRY_RULE, workstreamTimeline, type TimelineEntry } from './timeline.js';
import type { Assignment, Decision, Steering, Wake, WorkstreamDoc } from './types.js';

const NOW = new Date('2026-09-29T12:00:00Z');

function doc(opts: Partial<Omit<WorkstreamDoc, 'workstream'>> & { status?: 'active' | 'paused' | 'done'; conclusion?: WorkstreamDoc['workstream']['conclusion'] } = {}): WorkstreamDoc {
  const { status, conclusion, ...rest } = opts;
  return {
    schemaVersion: 1,
    revision: 1,
    workstream: {
      id: 'ws_t',
      slug: 't',
      title: 'T',
      objective: 'objective',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      status: status ?? 'done',
      ...(conclusion ? { conclusion } : {}),
      createdAt: '2026-09-01T00:00:00Z',
    },
    decisions: [],
    assignments: [],
    deliverables: [],
    interactions: [],
    observations: [],
    wakes: [],
    steering: [],
    attention: [],
    passes: [],
    events: [],
    spend: { coordinatorPasses: 0, totalCostUsd: 0, humanInterventions: 0 },
    lease: null,
    ...rest,
  };
}

function assignment(id: string, at: string, opts: Partial<Assignment> = {}): Assignment {
  return {
    id,
    objective: `do ${id}`,
    briefing: 'brief',
    kind: 'work',
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'completed',
    attempts: [{ runId: `r_${id}`, startedAt: at, executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus' }],
    adoption: { state: 'accepted' },
    createdAtVirtual: at,
    ...opts,
  };
}

const rejected = { state: 'completed' as const, adoption: { state: 'rejected' as const, reason: 'no' } };

function decision(id: string, at: string, opts: Partial<Decision> = {}): Decision {
  return { id, title: `course ${id}`, rationale: 'because', madeBy: 'coordinator', status: 'standing', decidedAtVirtual: at, ...opts };
}

function wake(id: string, createdAt: string, dueAtVirtual: string, reason: string, status: Wake['status'] = 'fired'): Wake {
  return { id, reason, condition: { type: 'time', dueAtVirtual }, status, createdAt };
}

function shape(entries: TimelineEntry[]): string[] {
  return entries.map((e) => {
    switch (e.type) {
      case 'assignment': return e.assignment.id;
      case 'retries': return `retries(${e.steps.map((s) => s.id).join(',')})`;
      case 'decision': return `decision:${e.id}`;
      case 'steer': return `steer:${e.id}`;
      case 'gap': return `gap:${e.label}`;
      case 'conclusion': return 'conclusion';
      case 'attention': return `attention:${e.id}:${e.phase}`;
      case 'verdict': return `verdict:${e.on}:${e.verdict}`;
      case 'cycle': return `cycle:${e.cycle}`;
    }
  });
}

test('rows are in chronological order across record types, with same-instant ties ordered decision before dispatch', () => {
  const t = workstreamTimeline(doc({
    assignments: [assignment('a2', '2026-09-02T02:00:00Z'), assignment('a1', '2026-09-02T01:00:00Z')],
    decisions: [decision('d1', '2026-09-02T01:00:00Z')],
    steering: [{ id: 's1', body: 'focus on X', at: '2026-09-02T00:30:00Z', by: 'niall', consumedByPass: 'p1' }],
    attention: [{ id: 'n1', kind: 'approval', summary: 'approve it?', status: 'resolved', createdAt: '2026-09-02T01:30:00Z', resolvedAt: '2026-09-02T01:45:00Z', resolvedBy: 'niall' }],
    conclusion: { passId: 'p9', atVirtual: '2026-09-02T03:00:00Z', summary: 'done', evidenceIds: ['a2'], disposition: 'delivered' },
  }), { now: NOW });
  assert.deepEqual(shape(t.entries), ['steer:s1', 'decision:d1', 'a1', 'attention:n1:asked', 'attention:n1:resolved', 'a2', 'conclusion']);
  const a1 = t.entries[2]!;
  assert.ok(a1.type === 'assignment');
  assert.deepEqual(a1.assignment.lastTarget, { executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus' });
  assert.equal(a1.assignment.attempts, 1);
  assert.equal(t.total, 7);
  assert.equal(t.omitted, 0);
});

test('a quiet stretch of six hours or more becomes one wait row, explained by the time wake that covered it', () => {
  const t = workstreamTimeline(doc({
    assignments: [
      assignment('a1', '2026-09-02T00:00:00Z'),
      assignment('a2', '2026-09-02T05:59:00Z'), // 5h59m later: below threshold
      assignment('a3', '2026-09-04T10:00:00Z'), // 2d 4h 1m later
    ],
    wakes: [
      wake('w-other', '2026-09-01T00:00:00Z', '2026-09-01T12:00:00Z', 'earlier check'),
      wake('w1', '2026-09-02T06:00:00Z', '2026-09-04T09:55:00Z', 'check the PR again in two days'),
      wake('w-cancelled', '2026-09-02T06:00:00Z', '2026-09-04T10:00:00Z', 'cancelled check', 'cancelled'),
    ],
  }), { now: NOW });
  assert.deepEqual(shape(t.entries), ['a1', 'a2', 'gap:2d 4h', 'a3']);
  const gap = t.entries[2]!;
  assert.ok(gap.type === 'gap');
  assert.equal(gap.reason, 'check the PR again in two days');
  assert.equal(gap.at, '2026-09-02T05:59:00.000Z');
  assert.equal(gap.endAt, '2026-09-04T10:00:00.000Z');
  assert.equal(t.total, 3, 'gap rows are not counted as entries');

  // Exactly six hours is a gap; no wake covering it means no reason.
  const exact = workstreamTimeline(doc({
    assignments: [assignment('a1', '2026-09-02T00:00:00Z'), assignment('a2', '2026-09-02T06:00:00Z')],
  }), { now: NOW });
  assert.deepEqual(shape(exact.entries), ['a1', 'gap:6h', 'a2']);
  assert.ok(exact.entries[1]!.type === 'gap' && exact.entries[1]!.reason === undefined);
});

test('a workstream still waiting shows an ongoing wait to now with its pending wake; a done one does not', () => {
  const base = {
    assignments: [assignment('a1', '2026-09-27T00:00:00Z')],
    wakes: [wake('w1', '2026-09-27T00:05:00Z', '2026-09-30T00:00:00Z', 'next daily sweep', 'pending')],
  };
  const active = workstreamTimeline(doc({ ...base, status: 'active' }), { now: NOW });
  const last = active.entries.at(-1)!;
  assert.ok(last.type === 'gap');
  assert.equal(last.ongoing, true);
  assert.equal(last.label, '2d 12h');
  assert.equal(last.reason, 'next daily sweep');
  assert.deepEqual(shape(workstreamTimeline(doc({ ...base, status: 'done' }), { now: NOW }).entries), ['a1']);
});

test('consecutive same-kind assignments fold when every earlier one was rejected, then accepted', () => {
  const t = workstreamTimeline(doc({
    assignments: [
      assignment('r1', '2026-09-02T01:00:00Z', rejected),
      assignment('r2', '2026-09-02T02:00:00Z', rejected),
      assignment('r3', '2026-09-02T03:00:00Z', rejected),
      assignment('r4', '2026-09-02T04:00:00Z', rejected),
      assignment('r5', '2026-09-02T05:00:00Z'),
    ],
  }), { now: NOW });
  assert.deepEqual(shape(t.entries), ['retries(r1,r2,r3,r4,r5)']);
  const row = t.entries[0]!;
  assert.ok(row.type === 'retries');
  assert.equal(row.rejected, 4);
  assert.equal(row.failed, 0);
  assert.equal(row.finalOutcome, 'accepted');
  assert.equal(row.at, '2026-09-02T01:00:00Z');
  assert.equal(row.endAt, '2026-09-02T05:00:00Z');
  assert.match(RETRY_RULE, /rejected or failed/);
});

test('failed runs fold like rejections; an accepted one in the middle ends the run', () => {
  const t = workstreamTimeline(doc({
    assignments: [
      assignment('f1', '2026-09-02T01:00:00Z', { state: 'failed', adoption: { state: 'none' } }),
      assignment('f2', '2026-09-02T02:00:00Z', { state: 'running', adoption: { state: 'none' } }),
      assignment('ok', '2026-09-02T03:00:00Z'),
      assignment('after', '2026-09-02T04:00:00Z'),
    ],
  }), { now: NOW });
  // f2 was not rejected/failed, so ok does not join the run; ok was accepted, so after does not.
  assert.deepEqual(shape(t.entries), ['retries(f1,f2)', 'ok', 'after']);
  const row = t.entries[0]!;
  assert.ok(row.type === 'retries');
  assert.equal(row.failed, 1);
  assert.equal(row.finalOutcome, 'running');
});

test('a different kind, or any other record between them, breaks a retry run', () => {
  const differentKind = workstreamTimeline(doc({
    assignments: [
      assignment('w1', '2026-09-02T01:00:00Z', rejected),
      assignment('x1', '2026-09-02T02:00:00Z', { kind: 'action' }),
    ],
  }), { now: NOW });
  assert.deepEqual(shape(differentKind.entries), ['w1', 'x1']);

  const interleaved = workstreamTimeline(doc({
    assignments: [
      assignment('w1', '2026-09-02T01:00:00Z', rejected),
      assignment('w2', '2026-09-02T03:00:00Z'),
    ],
    steering: [{ id: 's1', body: 'try the other approach', at: '2026-09-02T02:00:00Z', consumedByPass: 'p2' }],
  }), { now: NOW });
  assert.deepEqual(shape(interleaved.entries), ['w1', 'steer:s1', 'w2']);
});

test('decisions carry supersession lineage both ways, and closure with its reason', () => {
  const t = workstreamTimeline(doc({
    decisions: [
      decision('d1', '2026-09-02T00:00:00Z', { status: 'superseded', supersededBy: 'd2' }),
      decision('d2', '2026-09-03T00:00:00Z', { supersedes: 'd1', status: 'closed', closedReason: 'work finished' }),
      decision('d3', '2026-09-03T01:00:00Z', {
        progress: { cycle: 3, step: 1, label: 'sweep 3', awaitingIds: [], basisIds: [], passId: 'p', atVirtual: '2026-09-03T02:00:00Z', cycleStartedAtVirtual: '2026-09-03T02:00:00Z' },
      }),
    ],
  }), { now: NOW });
  assert.deepEqual(shape(t.entries), ['decision:d1', 'gap:1d', 'decision:d2', 'decision:d3', 'cycle:3']);
  const d1 = t.entries[0]!;
  const d2 = t.entries[2]!;
  assert.ok(d1.type === 'decision' && d2.type === 'decision');
  assert.deepEqual(d1.supersededBy, { id: 'd2', title: 'course d2' });
  assert.equal(d1.status, 'superseded');
  assert.deepEqual(d2.supersedes, { id: 'd1', title: 'course d1' });
  assert.equal(d2.status, 'closed');
  assert.equal(d2.closedReason, 'work finished');
  const cycle = t.entries[4]!;
  assert.ok(cycle.type === 'cycle' && cycle.decisionId === 'd3' && cycle.label === 'sweep 3');
});

test('withdrawn steers stay on the record and are marked; human verdicts are their own rows, pilot approvals are not', () => {
  const steers: Steering[] = [
    { id: 's1', body: 'stop the rollout', at: '2026-09-02T00:00:00Z', by: 'niall', revokedAt: '2026-09-02T00:05:00Z', revokedBy: 'niall' },
    { id: 's2', body: 'ship it', at: '2026-09-02T00:10:00Z', by: 'niall' },
  ];
  const t = workstreamTimeline(doc({
    steering: steers,
    assignments: [
      assignment('merge', '2026-09-02T01:00:00Z', {
        kind: 'action',
        exec: { cwd: '/x', verify: 'true', approval: { by: 'human', at: '2026-09-02T01:10:00Z', actor: 'niall' } },
      }),
      assignment('merge2', '2026-09-02T02:00:00Z', {
        kind: 'action',
        exec: { cwd: '/x', verify: 'true', approval: { by: 'pilot', at: '2026-09-02T02:01:00Z' } },
      }),
      assignment('merge3', '2026-09-02T03:00:00Z', {
        kind: 'action', state: 'cancelled', adoption: { state: 'none' },
        exec: { cwd: '/x', verify: 'true', rejection: { actor: 'niall', at: '2026-09-02T03:05:00Z', reason: 'not now' } },
      }),
    ],
  }), { now: NOW });
  assert.deepEqual(shape(t.entries), ['steer:s1', 'steer:s2', 'merge', 'verdict:action:approved', 'merge2', 'merge3', 'verdict:action:rejected']);
  const s1 = t.entries[0]!;
  const s2 = t.entries[1]!;
  assert.ok(s1.type === 'steer' && s2.type === 'steer');
  assert.deepEqual(s1.withdrawn, { at: '2026-09-02T00:05:00Z', by: 'niall' });
  assert.equal(s2.withdrawn, undefined);
  assert.equal(s2.read, false);
  const rejection = t.entries.at(-1)!;
  assert.ok(rejection.type === 'verdict' && rejection.by === 'niall' && rejection.note === 'not now');
});

test('the conclusion carries its disposition; a legacy conclusion reads as unclassified', () => {
  const delivered = workstreamTimeline(doc({
    conclusion: { passId: 'p1', atVirtual: '2026-09-02T00:00:00Z', summary: 'shipped', evidenceIds: ['a'], disposition: 'duplicate', duplicateOf: 'other' },
  }), { now: NOW });
  const row = delivered.entries[0]!;
  assert.ok(row.type === 'conclusion');
  assert.equal(row.disposition, 'duplicate');
  assert.equal(row.dispositionLabel, 'duplicate of other');
  assert.equal(row.successful, false);

  const legacy = workstreamTimeline(doc({
    conclusion: { passId: 'p1', atVirtual: '2026-09-02T00:00:00Z', summary: 'old', evidenceIds: [] },
  }), { now: NOW });
  const old = legacy.entries[0]!;
  assert.ok(old.type === 'conclusion');
  assert.equal(old.disposition, 'unclassified');
  assert.equal(old.successful, true);
});

test('long objectives are cut to one line with the full text kept for expansion', () => {
  const long = `${'word '.repeat(60)}end`;
  const t = workstreamTimeline(doc({
    assignments: [
      assignment('long', '2026-09-02T00:00:00Z', { objective: long }),
      assignment('multi', '2026-09-02T00:01:00Z', { objective: 'first\nsecond' }),
      assignment('short', '2026-09-02T00:02:00Z'),
    ],
  }), { now: NOW });
  const [a, b, c] = t.entries.map((e) => (e.type === 'assignment' ? e.assignment : undefined));
  assert.ok(a && b && c);
  assert.equal(a.truncated, true);
  assert.ok(a.summary.length <= 160 && a.summary.endsWith('…'));
  assert.equal(a.objective, long);
  assert.equal(b.truncated, true, 'a collapsed line break is still expandable to the original');
  assert.equal(b.summary, 'first second');
  assert.equal(c.truncated, false);
});

test('the default shows the most recent 60 rows; all=1 shows every row', () => {
  const assignments = Array.from({ length: 75 }, (_, i) =>
    assignment(`a${String(i).padStart(2, '0')}`, new Date(Date.parse('2026-09-02T00:00:00Z') + i * 60_000).toISOString()));
  // A long wait right before the kept window must not lead the page.
  assignments[15] = assignment('a15', '2026-09-10T00:00:00Z');
  for (let i = 16; i < 75; i += 1) assignments[i] = assignment(`a${i}`, new Date(Date.parse('2026-09-10T00:00:00Z') + (i - 15) * 60_000).toISOString());
  const d = doc({ assignments });
  const recent = workstreamTimeline(d, { now: NOW });
  assert.equal(recent.total, 75);
  assert.equal(recent.omitted, 15);
  assert.equal(recent.entries.filter((e) => e.type !== 'gap').length, 60);
  assert.equal(recent.entries[0]!.type, 'assignment');
  assert.ok(recent.entries[0]!.type === 'assignment' && recent.entries[0]!.assignment.id === 'a15');

  const all = workstreamTimeline(d, { now: NOW, limit: 'all' });
  assert.equal(all.omitted, 0);
  assert.equal(all.entries.filter((e) => e.type !== 'gap').length, 75);
  assert.ok(all.entries.some((e) => e.type === 'gap'));
});

test('the timeline never reads the bounded event tail', () => {
  const d = doc({ assignments: [assignment('a1', '2026-09-02T00:00:00Z')] });
  d.events = [{ at: '2026-09-02T00:00:00Z', atVirtual: '2026-09-02T00:00:00Z', type: 'assignment.created', summary: 'SHOULD NOT APPEAR' }];
  assert.doesNotMatch(JSON.stringify(workstreamTimeline(d, { now: NOW })), /SHOULD NOT APPEAR/);
});

test('wait durations read as days and hours', () => {
  assert.equal(formatWait(6 * 3_600_000), '6h');
  assert.equal(formatWait(6.5 * 3_600_000), '6h 30m');
  assert.equal(formatWait(52 * 3_600_000), '2d 4h');
  assert.equal(formatWait(48 * 3_600_000), '2d');
});
