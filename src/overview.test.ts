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

import {
  billingBasis,
  computeOverview,
  isMergeAction,
  median,
  outcomeClassOf,
  revisionMemo,
  TOP_LEVEL_LABEL,
} from './overview.js';
import type { Assignment, Attempt, PassRecord, WorkstreamDoc } from './types.js';

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
          ...(opts.conclusion.disposition !== undefined ? { disposition: opts.conclusion.disposition } : {}),
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
  assert.equal(o.cost.byProvider.find((p) => p.executor === '—')!.label, 'Target not recorded (older records)');
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

test('worked example is the most recent conclusion with at least five assignments, in created order', () => {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) =>
    assignment(`${prefix}${i}`, { createdAtVirtual: `2026-09-0${9 - i}T00:00:00Z`, kind: i === 0 ? 'action' : 'work' }));
  const o = computeOverview([
    doc('older', { status: 'done', conclusion: { at: '2026-09-10T00:00:00Z' }, assignments: many('o', 5) }),
    doc('newest-small', { status: 'done', conclusion: { at: '2026-09-20T00:00:00Z' }, assignments: many('s', 4) }),
    doc('chosen', { status: 'done', parent: 'sweep', conclusion: { at: '2026-09-15T00:00:00Z', summary: 'Merged the fix', disposition: 'delivered' }, assignments: many('c', 6) }),
    doc('unconcluded', { assignments: many('u', 8) }),
  ], [], NOW);
  const example = o.example!;
  assert.equal(example.slug, 'chosen');
  assert.equal(example.parent, 'sweep');
  assert.equal(example.outcome, 'delivered');
  assert.equal(example.summary, 'Merged the fix');
  assert.equal(example.assignments, 6);
  assert.equal(example.actions, 1);
  assert.deepEqual(example.steps.map((s) => s.id), ['c5', 'c4', 'c3', 'c2', 'c1', 'c0']);
  assert.equal(example.steps.at(-1)!.kind, 'action');

  assert.equal(computeOverview([doc('none')], [], NOW).example, undefined);
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
