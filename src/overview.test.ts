/**
 * The team overview is computed only from typed state, so these tests pin
 * what it may claim: grouping by the single managedBy pointer, the
 * disposition fallback for conclusions that predate dispositions, the honest
 * coordinator/worker and billing-basis cost split, the stated merge heuristic,
 * repairs of repairs, and the revision memo that keeps repeated views from
 * re-transferring the fleet. No model, no network, no store.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  billingBasis,
  computeOverview,
  isMergeAction,
  median,
  outcomeClassOf,
  overviewInsights,
  quantify,
  revisionMemo,
  TOP_LEVEL_LABEL,
  type Insight,
  type OverviewInsights,
} from './overview.js';
import type { Assignment, Attempt, ConclusionDisposition, PassRecord, WorkstreamDoc } from './types.js';
import { OverviewPage } from './ui/operator/overview-page.js';

const NOW = new Date('2026-09-29T12:00:00Z');

function doc(slug: string, opts: {
  status?: 'active' | 'paused' | 'done';
  parent?: string;
  conclusion?: { at: string; summary?: string; disposition?: unknown };
  assignments?: Assignment[];
  passes?: PassRecord[];
  decisions?: WorkstreamDoc['decisions'];
  interventions?: number;
} = {}): WorkstreamDoc {
  return {
    schemaVersion: 1,
    revision: 1,
    workstream: {
      id: `ws_${slug}`,
      slug,
      title: `Title ${slug}`,
      objective: `Objective for ${slug}\nsecond line`,
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      status: opts.status ?? 'active',
      ...(opts.parent ? { managedBy: { slug: opts.parent, sinceVirtual: '2026-09-01T00:00:00Z' } } : {}),
      ...(opts.conclusion ? {
        conclusion: {
          passId: 'p_end',
          atVirtual: opts.conclusion.at,
          summary: opts.conclusion.summary ?? 'done',
          evidenceIds: ['d1'],
          // Deliberately untyped: the defensive read must survive values the
          // schema would refuse (e.g. a stored 'mystery').
          ...(opts.conclusion.disposition !== undefined ? { disposition: opts.conclusion.disposition as ConclusionDisposition } : {}),
        },
      } : {}),
      createdAt: '2026-09-01T00:00:00Z',
    },
    decisions: opts.decisions ?? [],
    assignments: opts.assignments ?? [],
    deliverables: [],
    interactions: [],
    observations: [],
    wakes: [],
    steering: [],
    attention: [],
    passes: opts.passes ?? [],
    events: [],
    spend: { coordinatorPasses: (opts.passes ?? []).length, totalCostUsd: 0, humanInterventions: opts.interventions ?? 0 },
    lease: null,
  };
}

function attempt(costUsd: number, executor?: string, provider?: string): Attempt {
  return { runId: `r_${Math.random()}`, startedAt: '2026-09-02T00:00:00Z', costUsd, ...(executor ? { executor } : {}), ...(provider ? { provider } : {}) };
}

function pass(costUsd: number, executor?: string, provider?: string): PassRecord {
  return {
    id: `p_${Math.random()}`,
    startedAt: '2026-09-02T00:00:00Z',
    baseRevision: 1,
    wakeReasons: [],
    changes: [],
    outcome: 'completed',
    costUsd,
    ...(executor ? { executor } : {}),
    ...(provider ? { provider } : {}),
  };
}

function assignment(id: string, opts: Partial<Assignment> = {}): Assignment {
  return {
    id,
    objective: `do ${id}`,
    briefing: 'brief',
    kind: 'work',
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'completed',
    attempts: [attempt(0)],
    adoption: { state: 'accepted' },
    createdAtVirtual: '2026-09-02T00:00:00Z',
    ...opts,
  };
}

test('origins group strictly by managedBy, with top level for unmanaged work', () => {
  const docs = [
    doc('sentry-sweep'),
    doc('thread-review'),
    doc('fix-a', { parent: 'sentry-sweep' }),
    doc('fix-b', { parent: 'sentry-sweep', status: 'done' }),
    doc('fix-c', { parent: 'sentry-sweep', status: 'paused' }),
    doc('reply-a', { parent: 'thread-review' }),
  ];
  const o = computeOverview(docs, [], NOW);
  assert.equal(o.origins.total, 6);
  assert.equal(o.origins.topLevel, 2);
  assert.equal(o.origins.managed, 4);
  const [first, second, third] = o.origins.rows;
  assert.deepEqual(first, { parent: 'sentry-sweep', label: 'sentry-sweep', count: 3, active: 1, paused: 1, done: 1 });
  assert.equal(second!.parent, null);
  assert.equal(second!.label, TOP_LEVEL_LABEL);
  assert.equal(third!.parent, 'thread-review');

  // Now: only active work, grouped by parent, with the latest STANDING decision.
  const withDecisions = computeOverview([
    doc('fix-a', {
      parent: 'sentry-sweep',
      decisions: [
        { id: 'd1', title: 'Old course', rationale: '', madeBy: 'coordinator', status: 'superseded', decidedAtVirtual: '2026-09-03T00:00:00Z' },
        { id: 'd2', title: 'Current course', rationale: '', madeBy: 'coordinator', status: 'standing', decidedAtVirtual: '2026-09-02T00:00:00Z' },
      ],
    }),
    doc('fix-b', { parent: 'sentry-sweep', status: 'done' }),
  ], [], NOW);
  assert.equal(withDecisions.now.active, 1);
  assert.equal(withDecisions.now.groups.length, 1);
  assert.equal(withDecisions.now.groups[0]!.items[0]!.decision, 'Current course');
  assert.equal(withDecisions.now.groups[0]!.items[0]!.objective, 'Objective for fix-a second line');
});

test('disposition is read defensively; absent or unknown falls back to unclassified', () => {
  assert.equal(outcomeClassOf(doc('open')), undefined);
  assert.equal(outcomeClassOf(doc('old', { status: 'done', conclusion: { at: '2026-09-05T00:00:00Z' } })), 'unclassified');
  assert.equal(outcomeClassOf(doc('odd', { status: 'done', conclusion: { at: '2026-09-05T00:00:00Z', disposition: 'mystery' } })), 'unclassified');
  assert.equal(outcomeClassOf(doc('new', { status: 'done', conclusion: { at: '2026-09-05T00:00:00Z', disposition: 'duplicate' } })), 'duplicate');

  const o = computeOverview([
    doc('a', { status: 'done', conclusion: { at: '2026-09-05T00:00:00Z', disposition: 'delivered' }, passes: [pass(2)] }),
    doc('b', { status: 'done', conclusion: { at: '2026-09-06T00:00:00Z', disposition: 'delivered' }, passes: [pass(4)] }),
    doc('c', { status: 'done', conclusion: { at: '2026-09-07T00:00:00Z' }, passes: [pass(10)] }),
    doc('d', { status: 'done' }), // closed with no typed conclusion
    doc('e', { status: 'paused', parent: 'a' }),
  ], [], NOW);
  assert.equal(o.outcomes.concluded, 3);
  assert.deepEqual(o.outcomes.rows.map((r) => [r.outcome, r.count, r.totalUsd, r.medianUsd]), [
    ['delivered', 2, 6, 3],
    ['unclassified', 1, 10, 10],
  ]);
  assert.equal(o.outcomes.doneWithoutConclusion, 1);
  assert.deepEqual(o.outcomes.paused, [{ slug: 'e', title: 'Title e', parent: 'a' }]);
  assert.deepEqual(o.cost.perOutcome, { count: 3, totalUsd: 16, medianUsd: 4 });
});

test('cost splits coordinator vs worker, by family, and labels billing basis honestly', () => {
  const o = computeOverview([
    doc('sweep', { passes: [pass(3, 'local-sdk', 'anthropic')] }),
    doc('fix', {
      parent: 'sweep',
      passes: [pass(3, 'local-sdk', 'anthropic')],
      assignments: [assignment('a1', { attempts: [attempt(2, 'pi', 'openrouter'), attempt(-1), attempt(Number.NaN)] })],
    }),
    doc('solo', { passes: [pass(1)], assignments: [assignment('a2', { attempts: [attempt(1, 'codex-sdk', 'openai')] })] }),
  ], [], NOW);
  assert.equal(o.cost.coordinatorUsd, 7);
  assert.equal(o.cost.workerUsd, 3); // negative and NaN costs never count
  assert.equal(o.cost.totalUsd, 10);
  assert.equal(o.cost.coordinatorShare, 0.7);

  // A routine's family is itself plus its children; unrelated top-level work is "top level".
  const sweep = o.cost.byFamily.find((f) => f.family === 'sweep')!;
  assert.deepEqual([sweep.workstreams, sweep.ownUsd, sweep.childrenUsd, sweep.totalUsd], [2, 3, 5, 8]);
  const top = o.cost.byFamily.find((f) => f.family === null)!;
  assert.deepEqual([top.workstreams, top.totalUsd], [1, 2]);

  const anthropic = o.cost.byProvider.find((p) => p.executor === 'local-sdk')!;
  assert.equal(anthropic.basis, 'subscription-notional');
  assert.equal(anthropic.coordinatorUsd, 6);
  const openrouter = o.cost.byProvider.find((p) => p.provider === 'openrouter')!;
  assert.equal(openrouter.basis, 'cash');
  assert.equal(openrouter.workerUsd, 2);
  assert.equal(o.cost.byProvider.find((p) => p.executor === 'codex-sdk')!.basis, 'unknown');
  assert.equal(o.cost.byProvider.find((p) => p.executor === '—')!.label, 'Not recorded (older records)');
  assert.deepEqual(o.cost.byBasis, { 'subscription-notional': 6, cash: 2, unknown: 2 });

  assert.equal(billingBasis(undefined, 'anthropic').basis, 'subscription-notional');
  assert.equal(billingBasis('pi', 'openrouter').basis, 'cash');
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
});

test('merge heuristic matches gh pr merge actions and counts only readback-confirmed ones as confirmed', () => {
  const exec = (run: string | undefined, verified?: { ok: boolean }) => ({
    cwd: '/repo',
    verify: 'gh pr view 1 --json state',
    ...(run ? { run } : {}),
    ...(verified ? { verified: { ...verified, output: '', at: '2026-09-02T00:00:00Z' } } : {}),
  });
  const merged = assignment('m1', { kind: 'action', exec: exec('gh pr merge 12 --merge', { ok: true }) });
  const failed = assignment('m2', { kind: 'action', exec: exec('gh  pr merge 13', { ok: false }) });
  const byObjective = assignment('m3', { kind: 'action', objective: 'Run `gh pr merge 14 --merge` once green', exec: exec(undefined) });
  const push = assignment('p1', { kind: 'action', exec: exec('git push origin fix', { ok: true }) });
  const workMentioningMerge = assignment('w1', { kind: 'work', objective: 'explain gh pr merge flags' });
  assert.equal(isMergeAction(merged), true);
  assert.equal(isMergeAction(push), false);
  assert.equal(isMergeAction(workMentioningMerge), false);

  const o = computeOverview([doc('x', { assignments: [merged, failed, byObjective, push, workMentioningMerge] })], [], NOW);
  assert.deepEqual(o.signals.merges, { total: 3, confirmed: 1, failedReadback: 1, notRun: 1 });
});

test('repairs of repairs are managed workstreams whose parent is itself managed', () => {
  const o = computeOverview([
    doc('steward'),
    doc('repair', { parent: 'steward' }),
    doc('repair-of-repair', { parent: 'repair' }),
    doc('orphan', { parent: 'gone' }), // parent not in the fleet: not provably a repair of a repair
  ], [], NOW);
  assert.deepEqual(o.signals.repairsOfRepairs, { count: 1, managed: 3, slugs: ['repair-of-repair'] });
});

test('usefulness signals reuse stats: adoption, first attempt, interventions per successful outcome', () => {
  const o = computeOverview([
    doc('a', {
      status: 'done',
      interventions: 3,
      conclusion: { at: '2026-09-05T00:00:00Z' },
      assignments: [
        assignment('a1'),
        assignment('a2', { attempts: [attempt(0), attempt(0)] }),
        assignment('a3', { adoption: { state: 'rejected' } }),
        assignment('a4', { state: 'awaiting_review', adoption: { state: 'proposed' } }),
      ],
    }),
    doc('b', { status: 'done', conclusion: { at: '2026-09-06T00:00:00Z' } }),
  ], [], NOW);
  assert.deepEqual(o.signals.adoption, { accepted: 2, rejected: 1, judged: 3, pending: 1, superseded: 0 });
  assert.equal(o.signals.firstAttempt.completed, 3);
  assert.equal(o.signals.firstAttempt.firstAttempt, 2);
  assert.equal(o.signals.interventions.count, 3);
  assert.equal(o.signals.interventions.successfulOutcomes, 2);
  assert.equal(o.signals.interventions.perOutcome, 1.5);
});

test('worked examples: one per way work ends, readable runs preferred, a workstream under one tab only', () => {
  const many = (prefix: string, n: number, rejected = 0) => Array.from({ length: n }, (_, i) =>
    assignment(`${prefix}${i}`, {
      createdAtVirtual: `2026-09-0${9 - (i % 9)}T00:00:00Z`,
      kind: i === 0 ? 'action' : 'work',
      adoption: { state: i < rejected ? 'rejected' : 'accepted' },
    }));
  const o = computeOverview([
    doc('older', { status: 'done', conclusion: { at: '2026-09-10T00:00:00Z' }, assignments: many('o', 5) }),
    doc('newest-small', { status: 'done', conclusion: { at: '2026-09-20T00:00:00Z' }, assignments: many('s', 4) }),
    doc('chosen', { status: 'done', parent: 'sweep', conclusion: { at: '2026-09-15T00:00:00Z', summary: 'Merged the fix', disposition: 'delivered' }, assignments: many('c', 6) }),
    // Newer and delivered, but mostly rejected retries: a poor first example.
    doc('messy', { status: 'done', conclusion: { at: '2026-09-18T00:00:00Z', disposition: 'delivered' }, assignments: many('m', 8, 5) }),
    doc('stopped', { status: 'done', conclusion: { at: '2026-09-12T00:00:00Z', disposition: 'not_worth_doing' }, assignments: many('n', 5) }),
    doc('unconcluded', { assignments: many('u', 8) }),
  ], [], NOW);
  assert.deepEqual(o.examples.map((e) => [e.kind, e.slug]), [['delivered', 'chosen'], ['investigated', 'older'], ['stopped', 'stopped']]);
  const example = o.examples[0]!;
  assert.equal(example.parent, 'sweep');
  assert.equal(example.outcome, 'delivered');
  assert.equal(example.summary, 'Merged the fix');
  assert.equal(example.assignments, 6);
  assert.equal(example.actions, 1);
  // The example is the shared workstream timeline (src/timeline.ts), ending
  // in the conclusion with its disposition.
  const rows = example.timeline.entries.filter((e) => e.type !== 'gap');
  const conclusion = rows.at(-1)!;
  assert.equal(conclusion.type === 'conclusion' && conclusion.disposition, 'delivered');

  // With no readable delivered run, the newest delivered one still shows.
  const onlyMessy = computeOverview([
    doc('messy', { status: 'done', conclusion: { at: '2026-09-18T00:00:00Z', disposition: 'delivered' }, assignments: many('m', 8, 5) }),
  ], [], NOW);
  assert.deepEqual(onlyMessy.examples.map((e) => e.slug), ['messy']);

  assert.deepEqual(computeOverview([doc('none')], [], NOW).examples, []);
});

test('revisionMemo computes once per revision and shares one in-flight compute', async () => {
  let revision = 'r1';
  let computes = 0;
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const memo = revisionMemo(async () => revision, async () => {
    computes += 1;
    await gate;
    return { revision, value: `value-${revision}-${computes}` };
  });

  assert.equal(await memo(), 'value-r1-1');
  assert.equal(await memo(), 'value-r1-1');
  assert.equal(computes, 1);

  revision = 'r2';
  gate = new Promise<void>((resolve) => { release = resolve; });
  const both = Promise.all([memo(), memo()]);
  release();
  assert.deepEqual(await both, ['value-r2-2', 'value-r2-2']);
  assert.equal(computes, 2);
  assert.equal(await memo(), 'value-r2-2');
  assert.equal(computes, 2);
});

// ---------------------------------------------------------------------------
// Insights: the takeaway sentences each section leads with

const texts = (items: Insight[]) => items.map((item) => item.text);
const allTexts = (insights: OverviewInsights) => Object.values(insights).flatMap(texts);

test('quantify says a share the way a person would, and never rounds away the extremes', () => {
  assert.equal(quantify(5, 5, 'results'), 'all results');
  assert.equal(quantify(0, 5, 'results'), 'no results');
  assert.equal(quantify(0, 0, 'results'), 'no results');
  assert.equal(quantify(4, 5, 'results'), '4 in 5 results');
  assert.equal(quantify(3466, 4206, 'results'), 'about 5 in 6 results');
  assert.equal(quantify(1, 2, 'jobs'), 'half the jobs');
  assert.equal(quantify(94, 100, 'results'), '94% of results');
  // Close to all is still not all.
  assert.equal(quantify(999, 1000, 'results'), '100% of results');
});

test('insights on an empty fleet say so plainly, with no numbers that are not there', () => {
  const insights = overviewInsights(computeOverview([], [], NOW));
  assert.deepEqual(texts(insights.intro), ["Weaver hasn't taken on any jobs yet."]);
  assert.deepEqual(texts(insights.origins), ['There are no jobs yet, so nothing has started any work.']);
  assert.deepEqual(texts(insights.now), ['Nothing is active right now.']);
  assert.deepEqual(texts(insights.outcomes), ['No job has finished yet.']);
  assert.deepEqual(texts(insights.signals), ['Weaver has not checked any results yet.']);
  assert.deepEqual(texts(insights.cost), ['No cost has been recorded yet.']);
  for (const text of allTexts(insights)) assert.doesNotMatch(text, /NaN|undefined|Infinity|null/);
});

test('insights lead with what the numbers support: where work comes from and what is active now', () => {
  const needsYou = doc('fix-needs-you', { parent: 'sentry-sweep' });
  needsYou.attention = [{ id: 'att1', kind: 'approval', summary: 'Approve the merge', status: 'open', createdAt: '2026-09-28T00:00:00Z' }];
  const working = doc('fix-working', { parent: 'sentry-sweep', assignments: [assignment('run1', { state: 'running', adoption: { state: 'proposed' } })] });
  const capacity = doc('fix-capacity', { parent: 'sentry-sweep' });
  capacity.wakes = [{
    id: 'w1', reason: 'provider capacity', status: 'pending', createdAt: '2026-09-28T00:00:00Z',
    condition: { type: 'wall_time', dueAt: '2026-09-29T13:00:00Z' },
    infrastructure: { kind: 'rate_limit', source: 'coordinator', sourceId: 'p1', model: 'm', detectedAt: '2026-09-28T00:00:00Z', retryAt: '2026-09-29T13:00:00Z' } as unknown as NonNullable<WorkstreamDoc['wakes'][number]['infrastructure']>,
  }];
  const scheduled = doc('thread-reply', { parent: 'thread-review' });
  scheduled.wakes = [{ id: 'w2', reason: 'check tomorrow', status: 'pending', createdAt: '2026-09-28T00:00:00Z', condition: { type: 'time', dueAtVirtual: '2026-09-30T00:00:00Z' } }];
  const docs = [
    doc('sentry-sweep', { status: 'done', conclusion: { at: '2026-09-20T00:00:00Z' } }),
    doc('thread-review', { status: 'paused' }),
    needsYou,
    working,
    capacity,
    scheduled,
    doc('ready-one'),
  ];
  const o = computeOverview(docs, [], NOW);
  assert.deepEqual(o.now.breakdown, { needsYou: 1, working: 1, capacity: 1, scheduled: 1, ready: 1 });
  const insights = overviewInsights(o);
  assert.deepEqual(texts(insights.origins), [
    'Most jobs are started by other jobs, not by people: 4 of 7.',
    'The jobs that started the most others are sentry-sweep (3) and thread-review (1).',
  ]);
  assert.deepEqual(texts(insights.now), [
    '5 jobs are active. 1 is being worked on right now, 1 is waiting for a scheduled check, 1 is waiting for model capacity, 1 is ready for its next step and 1 needs you.',
    'The most active jobs sit under sentry-sweep: 3 of 5.',
  ]);
  assert.deepEqual(texts(insights.intro), [
    'Weaver has taken on 7 jobs so far and split them into 1 smaller piece of work.',
    '1 is finished, 5 are active and 1 is paused.',
  ]);

  // One bucket: every active job in the same state, one parent.
  const one = overviewInsights(computeOverview([doc('routine'), doc('child-a', { parent: 'routine' }), doc('child-b', { parent: 'routine' })], [], NOW));
  assert.deepEqual(texts(one.now), ['3 jobs are active. All of them are ready for their next step.', 'Nothing needs you right now.', 'The most active jobs sit under routine: 2 of 3.']);
  assert.deepEqual(texts(one.origins), ['Most jobs are started by other jobs, not by people: 2 of 3.', 'All 2 of those came from routine.']);

  // People-led fleet.
  const people = overviewInsights(computeOverview([doc('a'), doc('b'), doc('c', { parent: 'a' })], [], NOW));
  assert.equal(texts(people.origins)[0], 'Most jobs were started directly by people: 2 of 3. Other jobs started the remaining 1.');
  const solo = overviewInsights(computeOverview([doc('a')], [], NOW));
  assert.deepEqual(texts(solo.origins), ['Every job so far was started directly by a person: 1 of 1.']);
  assert.deepEqual(texts(solo.now), ['1 job is active. It is ready for its next step.', 'Nothing needs you right now.']);

  // Capacity holding up a large share of active work is flagged.
  const stuck = overviewInsights(computeOverview([capacity, doc('ready-one')], [], NOW));
  assert.deepEqual(stuck.now.filter((i) => i.flag).map((i) => i.text), ['Model capacity is holding up a lot of work: 1 of 2 active jobs are waiting for it.']);
});

test('insights on how jobs ended separate the unrecorded past from what was recorded since', () => {
  const finished = (slug: string, disposition?: string, cost = 0) =>
    doc(slug, { status: 'done', conclusion: { at: '2026-09-20T00:00:00Z', ...(disposition ? { disposition } : {}) }, passes: [pass(cost)] });
  const mixed = overviewInsights(computeOverview([
    finished('old-1', undefined, 10), finished('old-2', undefined, 20), finished('old-3', undefined, 30),
    finished('new-1', 'delivered', 4), finished('new-2', 'delivered', 6), finished('new-3', 'not_worth_doing', 2),
    doc('closed', { status: 'done' }),
    doc('parked', { status: 'paused' }),
  ], [], NOW));
  assert.deepEqual(texts(mixed.outcomes), [
    '6 jobs have finished. 3 finished before Weaver started recording how a job ended. Since then, 2 delivered something and 1 wasn\'t worth doing.',
    'A typical finished job cost $8.00.',
    '1 more was closed without saying how it ended.',
    '1 job is paused: a person stopped it, and it can be picked back up.',
  ]);
  const legacy = overviewInsights(computeOverview([finished('old-1'), finished('old-2'), finished('new-1', 'duplicate')], [], NOW));
  assert.equal(texts(legacy.outcomes)[0], '3 jobs have finished. Most of them (2) finished before Weaver started recording how a job ended. Since then, 1 duplicated another job.');
  const onlyLegacy = overviewInsights(computeOverview([finished('old-1')], [], NOW));
  assert.deepEqual(texts(onlyLegacy.outcomes), ['1 job has finished. It finished before Weaver started recording how a job ended, so there is no breakdown yet.']);
  const oneBucket = overviewInsights(computeOverview([finished('a', 'delivered'), finished('b', 'delivered')], [], NOW));
  assert.deepEqual(texts(oneBucket.outcomes), ['2 jobs have finished. All of them delivered something.']);
});

test('usefulness insights state the share with its figures and flag what looks off', () => {
  const judged = (prefix: string, n: number, rejected: number) => Array.from({ length: n }, (_, i) =>
    assignment(`${prefix}${i}`, { adoption: { state: i < rejected ? 'rejected' : 'accepted' } }));
  const o = computeOverview([
    doc('sweep', { status: 'done', conclusion: { at: '2026-09-20T00:00:00Z' } }),
    doc('sweep-fix', { parent: 'sweep', assignments: judged('s', 30, 15), interventions: 2 }),
    doc('manual', { status: 'done', conclusion: { at: '2026-09-21T00:00:00Z' }, assignments: judged('m', 60, 3) }),
  ], [], NOW);
  const signals = overviewInsights(o).signals;
  assert.deepEqual(texts(signals.filter((i) => !i.flag)), [
    '4 in 5 results were accepted when Weaver checked them: 72 of 90.',
    'All finished pieces of work succeeded on the first try: 90 of 90.',
    '1 in 3 jobs needed a person to step in: 1 of 3. Across the fleet that is 1.0 interventions per successfully finished job, the number Weaver is trying to push down.',
  ]);
  assert.deepEqual(texts(signals.filter((i) => i.flag)), [
    'Rejections are higher than usual for the work under sweep: 50% of their results were rejected, against 20% across all jobs.',
  ]);

  // A family below the minimum sample is never called out, however bad.
  const small = computeOverview([doc('x', { assignments: judged('x', 5, 5) }), doc('y', { assignments: judged('y', 50, 0) })], [], NOW);
  assert.equal(overviewInsights(small).signals.filter((i) => i.flag).length, 0);

  // Capacity waits, merges and repairs of repairs.
  const merge = (id: string, ok?: boolean) => assignment(id, {
    kind: 'action',
    exec: { cwd: '/repo', verify: 'gh pr view', run: 'gh pr merge 1 --merge', ...(ok === undefined ? {} : { verified: { ok, output: '', at: '2026-09-02T00:00:00Z' } }) },
  });
  const backoff: PassRecord = {
    ...pass(0),
    outcome: 'error',
    infrastructure: { kind: 'rate_limit', source: 'coordinator', sourceId: 'p', model: 'm', detectedAt: '2026-09-02T00:00:00Z', retryAt: '2026-09-02T01:00:00Z' } as unknown as NonNullable<PassRecord['infrastructure']>,
  };
  const busy = computeOverview([
    doc('steward'),
    doc('repair', { parent: 'steward', assignments: [merge('m1', true), merge('m2', false), merge('m3', false), merge('m4')], passes: [pass(0), backoff] }),
    doc('repair-of-repair', { parent: 'repair' }),
  ], [], NOW);
  const flags = texts(overviewInsights(busy).signals.filter((i) => i.flag));
  assert.ok(flags.includes('Half the check-ins had to wait because the model provider was out of capacity: 1 of 2. That slows work down, but nothing is lost.'), flags.join('\n'));
  assert.ok(flags.includes('1 job was opened by a job that another job had opened: 50% of the jobs started by other jobs. A rising share would mean fixes are causing more fixes.'), flags.join('\n'));
  assert.ok(flags.includes('Weaver tried to merge 4 pull requests. 1 was confirmed merged when checked on GitHub afterwards, 2 didn\'t go through and 1 haven\'t run.'), flags.join('\n'));
});

test('cost insights name where the money goes, the biggest single job per day, and what is real money', () => {
  const o = computeOverview([
    doc('daily-update', { passes: [pass(60, 'local-sdk', 'anthropic')] }),
    doc('sweep', { passes: [pass(10, 'local-sdk', 'anthropic')] }),
    doc('fix', { parent: 'sweep', passes: [pass(10, 'local-sdk', 'anthropic')], assignments: [assignment('a1', { attempts: [attempt(20, 'pi', 'openrouter')] })] }),
  ], [], NOW);
  // Every fixture job was created on 1 Sep; NOW is midday on 29 Sep.
  assert.equal(o.cost.days, 29);
  assert.deepEqual(texts(overviewInsights(o).cost), [
    'Weaver has recorded $100 of model cost over 29 days, about $3.45 a day.',
    'Most of the spend is Weaver deciding what to do next, not the work itself: 80%.',
    'The single most expensive job is “Title daily-update” at $60.00, about $2.07 a day over 29 days (60% of all spend).',
    'Of the groups of work that one job started, the group under sweep costs the most: $40.00 (40% of the total).',
    '$20.00 was real money, paid per use through OpenRouter. $80.00 is a list-price estimate for runs covered by a subscription, not money actually spent.',
  ]);

  // Mostly worker spend, all on a subscription, one job: no outlier to name.
  const workers = computeOverview([
    doc('solo', { passes: [pass(1, 'local-sdk', 'anthropic')], assignments: [assignment('a', { attempts: [attempt(9, 'local-sdk', 'anthropic')] })] }),
  ], [], NOW);
  assert.deepEqual(texts(overviewInsights(workers).cost), [
    'Weaver has recorded $10.00 of model cost over 29 days, about $0.34 a day.',
    'Most of the spend is the work itself: 90% went to the agents doing the jobs.',
    'All of it is a list-price estimate for runs covered by a subscription, not money actually spent.',
  ]);
});

/** The page's visible text, with tags, scripts and entity escapes removed and
 * slug-shaped tokens (like `durable-readback-sweep`) dropped: a job's name is
 * the fleet's data, not the page's vocabulary. */
function visibleCopy(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Internal vocabulary the overview must never show a newcomer. */
const BANNED_OVERVIEW_PHRASES = [/typed record/i, /readback/i, /gated external effect/i, /durable/i, /\boutcomes\b/i];

test('the rendered overview leads with its insights and uses none of the internal vocabulary', () => {
  const docs = [
    doc('durable-readback-outcomes-sweep'),
    doc('child-one', { parent: 'durable-readback-outcomes-sweep', passes: [pass(5, 'local-sdk', 'anthropic')] }),
    doc('child-two', { parent: 'durable-readback-outcomes-sweep', status: 'done', conclusion: { at: '2026-09-20T00:00:00Z', disposition: 'delivered' } }),
  ];
  const overview = computeOverview(docs, [], NOW);
  const html = renderToStaticMarkup(createElement(OverviewPage, { overview, scopeLabel: 'Test fleet' }));
  const copy = visibleCopy(html);
  for (const sentence of allTexts(overviewInsights(overview))) {
    assert.ok(copy.includes(visibleCopy(sentence).trim()), `missing insight: ${sentence}`);
  }
  assert.match(html, /data-testid="overview-insights"/);
  assert.match(copy, /This counts merges, not whether the code was good\./);
  assert.doesNotMatch(copy, /What this page cannot tell you yet/);
  for (const phrase of BANNED_OVERVIEW_PHRASES) assert.doesNotMatch(copy, phrase);
  // The slug itself still renders: stripping is only for the vocabulary check.
  assert.match(html, /durable-readback-outcomes-sweep/);
});
