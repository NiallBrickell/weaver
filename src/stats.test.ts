/**
 * Deterministic stats tests: the convergence dashboard is computed from
 * durable typed records, so these tests pin exactly what it may claim — an
 * intervention timeline that cannot double-count one human act, adoption
 * dated by its pin, promotion dated by its first intervention-free evidence,
 * and the undated remainder reported instead of hidden. No model, no network.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PolicyRecord } from './policies.js';
import {
  computeStats,
  cumulativeRatio,
  datedInterventions,
  fleetDays,
  policyStatusByDay,
  promotionAt,
  provenanceSplit,
  renderStatsHtml,
  runStats,
  undatedInterventions,
} from './stats.js';
import { setSecret } from './secrets.js';
import { arrive, createWorkstream, load } from './store.js';
import type { Attempt, WorkstreamDoc } from './types.js';

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

beforeEach(() => {
  freshHome();
});

function makeWorkstream(slug = 'stats-ws', title = 'Measure me'): void {
  createWorkstream({
    slug,
    title,
    objective: 'prove the stats layer computes from durable state',
    tags: ['hiring'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

function baseAssignment(id: string, at: string) {
  return {
    id,
    objective: 'obj',
    briefing: 'brief',
    kind: 'action' as const,
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'completed' as const,
    attempts: [] as Attempt[],
    adoption: { state: 'none' as const },
    createdAtVirtual: at,
  };
}

test('datedInterventions: one human act is one act, pilot approvals are not acts', () => {
  makeWorkstream();
  arrive('stats-ws', (d) => {
    // A steering that answered two twin attention cards: ONE act.
    d.steering.push({ id: 'steer_1', body: 'do it', at: '2026-08-04T10:00:00.000Z' });
    d.attention.push(
      { id: 'att_1', kind: 'review', summary: 'twin', status: 'resolved', createdAt: '2026-08-04T09:00:00.000Z', resolvedAt: '2026-08-04T10:00:00.500Z' },
      { id: 'att_2', kind: 'review', summary: 'twin', status: 'resolved', createdAt: '2026-08-04T09:00:00.000Z', resolvedAt: '2026-08-04T10:00:00.500Z' },
    );
    // An independent resolution the next day: a second act.
    d.attention.push({ id: 'att_3', kind: 'blocker', summary: 'other', status: 'resolved', createdAt: '2026-08-04T09:00:00.000Z', resolvedAt: '2026-08-05T09:00:00.000Z' });
    // A human gate approval (act) and a pilot auto-approval (NOT an act).
    d.assignments.push(
      { ...baseAssignment('asg_h', '2026-08-04T08:00:00.000Z'), exec: { cwd: '/', verify: 'true', approval: { by: 'human', at: '2026-08-05T10:00:00.000Z' } } },
      { ...baseAssignment('asg_p', '2026-08-04T08:00:00.000Z'), exec: { cwd: '/', verify: 'true', approval: { by: 'pilot', at: '2026-08-05T11:00:00.000Z' } } },
    );
  });
  const acts = datedInterventions(load('stats-ws'));
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['steering', 'attention_resolution', 'gate_approval'],
  );
});

test('fleetDays: gap-filled, adoption dated by pin, rejection dated by its pass, costs summed', () => {
  makeWorkstream();
  arrive('stats-ws', (d) => {
    d.passes.push({ id: 'pass_1', startedAt: '2026-08-01T12:00:00.000Z', baseRevision: 1, wakeReasons: [], changes: [], outcome: 'completed', costUsd: 2 });
    d.passes.push({ id: 'pass_2', startedAt: '2026-08-03T12:00:00.000Z', baseRevision: 2, wakeReasons: [], changes: [], outcome: 'completed', costUsd: 1 });
    d.deliverables.push({
      id: 'del_1', title: 'adopted', kind: 'markdown', path: 'a.md', contentHash: 'h1', createdAtVirtual: '2026-08-01T13:00:00.000Z',
      adopted: { contentHash: 'h1', passId: 'pass_2', atVirtual: '2026-08-03T12:30:00.000Z' },
    });
    const rejected = baseAssignment('asg_r', '2026-08-01T12:00:00.000Z');
    rejected.adoption = { state: 'rejected', passId: 'pass_1' } as never;
    rejected.attempts.push({ runId: 'run_1', startedAt: '2026-08-01T12:05:00.000Z', costUsd: 0.5 });
    d.assignments.push(rejected);
  });
  const days = fleetDays([load('stats-ws')], '2026-08-04');
  assert.deepEqual(days.map((d) => d.day), ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
  assert.equal(days[0]!.rejections, 1); // dated by pass_1's startedAt
  assert.equal(days[0]!.costUsd, 2.5); // pass cost + attempt cost
  assert.equal(days[1]!.passes, 0); // gap day, zero-filled
  assert.equal(days[2]!.adoptions, 1); // dated by the adoption pin
});

test('cumulativeRatio: null until the first adoption, then interventions/adoptions', () => {
  const days = fleetDays([], '2026-08-01');
  assert.deepEqual(days, []);
  const series = cumulativeRatio([
    { day: '2026-08-01', interventions: 3, adoptions: 0, rejections: 0, autoApproved: 0, humanApproved: 0, passes: 1, costUsd: 0 },
    { day: '2026-08-02', interventions: 1, adoptions: 2, rejections: 0, autoApproved: 0, humanApproved: 0, passes: 1, costUsd: 0 },
  ]);
  assert.equal(series[0]!.ratio, null);
  assert.equal(series[1]!.ratio, 2); // 4 interventions / 2 adoptions
});

function policy(over: Partial<PolicyRecord>): PolicyRecord {
  return {
    id: 'pol_x',
    statement: 'rule',
    scope: { tags: ['hiring'] },
    effect: { kind: 'advisory', description: 'advise' },
    widensAuthority: false,
    status: 'shadow',
    provenance: { source: 'backfill:rules', ref: 'CLAUDE.md § x', interventionSummary: 'seeded' },
    evidence: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

test('policy timeline: promotion at first intervention-free evidence, supersession at superseder creation', () => {
  const promoted = policy({
    id: 'pol_a',
    status: 'active',
    evidence: [
      { workstreamSlug: 'w', passId: 'p1', note: 'intervened', interventionFree: false, at: '2026-08-02T00:00:00.000Z' },
      { workstreamSlug: 'w', passId: 'p2', note: 'clean', interventionFree: true, at: '2026-08-03T00:00:00.000Z' },
    ],
  });
  assert.equal(promotionAt(promoted), '2026-08-03T00:00:00.000Z');
  const superseder = policy({ id: 'pol_new', createdAt: '2026-08-04T00:00:00.000Z' });
  const superseded = policy({ id: 'pol_old', status: 'superseded', supersededBy: 'pol_new' });
  const series = policyStatusByDay([promoted, superseder, superseded], ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
  assert.deepEqual(series[1], { day: '2026-08-02', active: 0, shadow: 2, superseded: 0 });
  assert.deepEqual(series[2], { day: '2026-08-03', active: 1, shadow: 1, superseded: 0 });
  // pol_old leaves shadow FOR superseded the day pol_new lands; pol_new enters shadow.
  assert.deepEqual(series[3], { day: '2026-08-04', active: 1, shadow: 1, superseded: 1 });
});

test('provenanceSplit: seeded vs learned live', () => {
  const split = provenanceSplit([
    policy({ id: 'p1', status: 'active' }),
    policy({ id: 'p2', provenance: { workstreamSlug: 'w', passId: 'p', interventionSummary: 'corrected' } }),
  ]);
  assert.deepEqual(split.seeded, { active: 1, shadow: 0, superseded: 0 });
  assert.deepEqual(split.learned, { active: 0, shadow: 1, superseded: 0 });
});

test('undated interventions are reported, never hidden and never negative', () => {
  makeWorkstream();
  arrive('stats-ws', (d) => {
    d.steering.push({ id: 'steer_1', body: 'dated act', at: '2026-08-04T10:00:00.000Z' });
    d.spend.humanInterventions = 3; // counter includes 2 acts with no durable timestamp
  });
  assert.equal(undatedInterventions([load('stats-ws')]), 2);
  arrive('stats-ws', (d) => {
    d.spend.humanInterventions = 0; // defensive: counter behind the records
  });
  assert.equal(undatedInterventions([load('stats-ws')]), 0);
});

test('renderStatsHtml: empty fleet renders honestly, never invents data', () => {
  const html = renderStatsHtml(computeStats([], [], new Date('2026-08-05T00:00:00.000Z')));
  assert.match(html, /No fleet activity yet/);
  assert.doesNotMatch(html, /NaN/);
});

test('runStats writes stats.html with secrets redacted', () => {
  // The value lands in state BEFORE it becomes a secret (the store rejects
  // writes that embed known secret values) — output redaction covers exactly
  // this: content that predates the secret's registration.
  makeWorkstream('secret-ws', 'Title mentioning hunter2-value');
  arrive('secret-ws', (d) => {
    d.steering.push({ id: 'steer_1', body: 'go', at: '2026-08-04T10:00:00.000Z' });
    d.deliverables.push({
      id: 'del_1', title: 'done', kind: 'markdown', path: 'a.md', contentHash: 'h1', createdAtVirtual: '2026-08-04T11:00:00.000Z',
      adopted: { contentHash: 'h1', passId: 'pass_1', atVirtual: '2026-08-04T11:00:00.000Z' },
    });
  });
  setSecret('TOKEN', 'hunter2-value');
  const out = runStats(new Date('2026-08-05T00:00:00.000Z'));
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(out.endsWith('stats.html'));
  assert.doesNotMatch(html, /hunter2-value/);
  assert.match(html, /secret-ws/);
  // The one dated intervention over the one adopted outcome.
  const payload = JSON.parse(html.match(/<script type="application\/json" id="stats-data">(.*?)<\/script>/s)![1]!) as {
    totals: { perOutcome: number | null };
  };
  assert.equal(payload.totals.perOutcome, 1);
});

test('computeStats week-ago delta needs eight days of history', () => {
  makeWorkstream();
  arrive('stats-ws', (d) => {
    d.steering.push({ id: 'steer_1', body: 'go', at: '2026-08-01T10:00:00.000Z' });
    d.deliverables.push({
      id: 'del_1', title: 'done', kind: 'markdown', path: 'a.md', contentHash: 'h1', createdAtVirtual: '2026-08-01T11:00:00.000Z',
      adopted: { contentHash: 'h1', passId: 'pass_1', atVirtual: '2026-08-01T11:00:00.000Z' },
    });
  });
  const docs: WorkstreamDoc[] = [load('stats-ws')];
  const short = computeStats(docs, [], new Date('2026-08-05T00:00:00.000Z'));
  assert.equal(short.totals.perOutcomeWeekAgo, null);
  const long = computeStats(docs, [], new Date('2026-08-12T00:00:00.000Z'));
  assert.equal(long.totals.perOutcomeWeekAgo, 1); // ratio was already 1.0 a week before
});
