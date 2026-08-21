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
import { approveAction } from './humanActs.js';
import {
  actorClass,
  attributionSplit,
  computeStats,
  cumulativeRatio,
  datedInterventions,
  fleetDays,
  interruptionLoad,
  passHealth,
  passHealthTotals,
  policyStatusByDay,
  promotionAt,
  provenanceSplit,
  renderStatsHtml,
  runStats,
  undatedInterventions,
  workerReliability,
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

async function makeWorkstream(slug = 'stats-ws', title = 'Measure me'): Promise<void> {
  await createWorkstream({
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

test('datedInterventions: one human act is one act, pilot approvals are not acts', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
    // A steering that answered two twin attention cards: ONE act.
    d.steering.push({ id: 'steer_1', body: 'do it', at: '2026-08-04T10:00:00.000Z' });
    d.attention.push(
      { id: 'att_1', kind: 'review', summary: 'twin', status: 'resolved', createdAt: '2026-08-04T09:00:00.000Z', resolvedAt: '2026-08-04T10:00:00.500Z', resolvedBy: 'niall' },
      { id: 'att_2', kind: 'review', summary: 'twin', status: 'resolved', createdAt: '2026-08-04T09:00:00.000Z', resolvedAt: '2026-08-04T10:00:00.500Z', resolvedBy: 'niall' },
    );
    // An independent resolution the next day: a second act.
    d.attention.push({ id: 'att_3', kind: 'blocker', summary: 'other', status: 'resolved', createdAt: '2026-08-04T09:00:00.000Z', resolvedAt: '2026-08-05T09:00:00.000Z', resolvedBy: 'niall' });
    // A human gate approval (act) and a pilot auto-approval (NOT an act).
    d.assignments.push(
      { ...baseAssignment('asg_h', '2026-08-04T08:00:00.000Z'), exec: { cwd: '/', verify: 'true', approval: { by: 'human', at: '2026-08-05T10:00:00.000Z' } } },
      { ...baseAssignment('asg_p', '2026-08-04T08:00:00.000Z'), exec: { cwd: '/', verify: 'true', approval: { by: 'pilot', at: '2026-08-05T11:00:00.000Z' } } },
    );
  });
  const acts = datedInterventions(await load('stats-ws'));
  assert.deepEqual(
    acts.map((a) => a.kind),
    ['steering', 'resolution', 'approval'],
  );
  // Steering/approvals predating attribution stay honest instead of guessing.
  assert.deepEqual(
    acts.map((a) => a.actor),
    ['unattributed', 'niall', 'unattributed'],
  );
});

test('system and legacy resolutions never count as human interventions', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
    d.attention.push(
      { id: 'att_p', kind: 'approval', summary: 'a', status: 'resolved', createdAt: '2026-08-04T08:00:00.000Z', resolvedAt: '2026-08-04T09:00:00.000Z', resolvedBy: 'pilot' },
      { id: 'att_c', kind: 'review', summary: 'b', status: 'resolved', createdAt: '2026-08-04T08:00:00.000Z', resolvedAt: '2026-08-04T10:00:00.000Z', resolvedBy: 'coordinator' },
      // Legacy: resolved before attribution existed — indistinguishable from a
      // system act, so it lands in the undated remainder, never a guessed act.
      { id: 'att_l', kind: 'blocker', summary: 'c', status: 'resolved', createdAt: '2026-08-04T08:00:00.000Z', resolvedAt: '2026-08-04T11:00:00.000Z' },
    );
    d.spend.humanInterventions = 1; // the legacy resolution WAS a human act once
  });
  const doc = await load('stats-ws');
  assert.equal(datedInterventions(doc).length, 0);
  assert.equal(undatedInterventions([doc]), 1);
});

test('one keypress is one act: approval folds the card it auto-resolves, actor stamped durably', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
    const gated = baseAssignment('asg_g', '2026-08-04T08:00:00.000Z');
    gated.state = 'gated' as never;
    (gated as { exec?: object }).exec = { cwd: '/', verify: 'true', ask: 'approve?' };
    d.assignments.push(gated);
    d.attention.push({ id: 'att_g', kind: 'approval', summary: 'approve asg_g', refId: 'asg_g', status: 'open', createdAt: '2026-08-04T08:00:00.000Z' });
  });
  process.env.WEAVER_ACTOR = 'claude-session';
  try {
    await approveAction('stats-ws', 'asg_g');
  } finally {
    delete process.env.WEAVER_ACTOR;
  }
  const doc = await load('stats-ws');
  assert.equal(doc.attention[0]!.resolvedBy, 'claude-session');
  const acts = datedInterventions(doc);
  assert.equal(acts.length, 1); // approval + its auto-resolved card = ONE act
  assert.equal(acts[0]!.kind, 'approval');
  assert.equal(acts[0]!.actor, 'claude-session');
  assert.equal(doc.spend.humanInterventions, 1);
  assert.equal(undatedInterventions([doc]), 0); // dated acts match the counter exactly
});

test('interruptionLoad: top-3 actors chart, tail folds to other, totals stay unfolded', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
    const day = (n: number, actor: string) => ({ id: `steer_${actor}${n}`, body: 'x', by: actor, at: `2026-08-04T0${n}:00:00.000Z` });
    d.steering.push(
      day(1, 'niall'), day(2, 'niall'), day(3, 'niall'),
      day(4, 'claude-session'), day(5, 'claude-session'),
      day(6, 'codex-session'), day(7, 'codex-session'),
      day(8, 'intern'),
    );
  });
  const load_ = interruptionLoad([await load('stats-ws')], ['2026-08-04']);
  assert.deepEqual(load_.segments, ['niall', 'claude-session', 'codex-session', 'other']);
  assert.deepEqual(load_.rows[0]!.counts, { niall: 3, 'claude-session': 2, 'codex-session': 2, other: 1 });
  assert.equal(load_.totals.length, 4); // intern unfolded in the table
  assert.equal(load_.totals[0]!.byKind.steering, 3);
});

test('fleetDays: gap-filled, adoption dated by pin, rejection dated by its pass', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
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
  const days = fleetDays([await load('stats-ws')], '2026-08-04');
  assert.deepEqual(days.map((d) => d.day), ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
  assert.equal(days[0]!.rejections, 1); // dated by pass_1's startedAt
  assert.equal(days[1]!.passes, 0); // gap day, zero-filled
  assert.equal(days[2]!.adoptions, 1); // dated by the adoption pin
});

test('cumulativeRatio: outcome curve divides by conclusions, adopted is a separate leading curve', async () => {
  const days = fleetDays([], '2026-08-01');
  assert.deepEqual(days, []);
  const series = cumulativeRatio([
    { day: '2026-08-01', interventions: 3, conclusions: 0, adoptions: 2, rejections: 0, autoApproved: 0, humanApproved: 0, passes: 1 },
    { day: '2026-08-02', interventions: 1, conclusions: 2, adoptions: 2, rejections: 0, autoApproved: 0, humanApproved: 0, passes: 1 },
  ]);
  // The outcome curve is null until the first qualified conclusion exists,
  // even while adopted work products already accumulate (adoption ≠ success).
  assert.equal(series[0]!.ratio, null);
  assert.equal(series[0]!.ratioAdopted, 1.5); // 3 interventions / 2 adopted
  assert.equal(series[1]!.ratio, 2); // 4 interventions / 2 conclusions
  assert.equal(series[1]!.ratioAdopted, 1); // 4 interventions / 4 adopted
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

test('policy timeline: promotion at first intervention-free evidence, supersession at superseder creation', async () => {
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

test('provenanceSplit: seeded vs learned live', async () => {
  const split = provenanceSplit([
    policy({ id: 'p1', status: 'active' }),
    policy({ id: 'p2', provenance: { workstreamSlug: 'w', passId: 'p', interventionSummary: 'corrected' } }),
  ]);
  assert.deepEqual(split.seeded, { active: 1, shadow: 0, superseded: 0 });
  assert.deepEqual(split.learned, { active: 0, shadow: 1, superseded: 0 });
});

test('undated interventions are reported, never hidden and never negative', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
    d.steering.push({ id: 'steer_1', body: 'dated act', at: '2026-08-04T10:00:00.000Z' });
    d.spend.humanInterventions = 3; // counter includes 2 acts with no durable timestamp
  });
  assert.equal(undatedInterventions([await load('stats-ws')]), 2);
  await arrive('stats-ws', (d) => {
    d.spend.humanInterventions = 0; // defensive: counter behind the records
  });
  assert.equal(undatedInterventions([await load('stats-ws')]), 0);
});

test('renderStatsHtml: empty fleet renders honestly, never invents data', async () => {
  const html = renderStatsHtml(computeStats([], [], new Date('2026-08-05T00:00:00.000Z')));
  assert.match(html, /No fleet activity yet/);
  assert.match(html, /Does each outcome need you less often/);
  assert.match(html, /success denominator: qualified typed conclusions/);
  assert.match(html, /leading indicator, not outcome success/);
  assert.match(html, /Adoption ≠ completion/);
  assert.doesNotMatch(html, /Convergence dashboard/);
  assert.doesNotMatch(html, /NaN/);
});

test('runStats writes stats.html with secrets redacted', async () => {
  // The value lands in state BEFORE it becomes a secret (the store rejects
  // writes that embed known secret values) — output redaction covers exactly
  // this: content that predates the secret's registration.
  await makeWorkstream('secret-ws', 'Title mentioning hunter2-value');
  await arrive('secret-ws', (d) => {
    d.steering.push({ id: 'steer_1', body: 'go', at: '2026-08-04T10:00:00.000Z' });
    d.spend.humanInterventions = 1; // the headline ratio anchors to the counter
    d.deliverables.push({
      id: 'del_1', title: 'done', kind: 'markdown', path: 'a.md', contentHash: 'h1', createdAtVirtual: '2026-08-04T11:00:00.000Z',
      adopted: { contentHash: 'h1', passId: 'pass_1', atVirtual: '2026-08-04T11:00:00.000Z' },
    });
    d.workstream.conclusion = { passId: 'pass_1', atVirtual: '2026-08-04T11:30:00.000Z', summary: 'done', evidenceIds: ['del_1'] };
  });
  setSecret('TOKEN', 'hunter2-value');
  const out = await runStats(new Date('2026-08-05T00:00:00.000Z'));
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(out.endsWith('stats.html'));
  assert.doesNotMatch(html, /hunter2-value/);
  assert.match(html, /secret-ws/);
  const payload = JSON.parse(html.match(/<script type="application\/json" id="stats-data">(.*?)<\/script>/s)![1]!) as {
    totals: { interventionsPerOutcome: number | null; interventionsPerAdopted: number | null; successfulOutcomes: number };
  };
  // One dated intervention over one qualified conclusion (the success target),
  // with the adopted-work leading indicator kept as a distinct number.
  assert.equal(payload.totals.successfulOutcomes, 1);
  assert.equal(payload.totals.interventionsPerOutcome, 1);
  assert.equal(payload.totals.interventionsPerAdopted, 1);
});

test('passHealth: infrastructure backoff is never a logical failure, conflicted is neither', () => {
  const base = { id: 'p', startedAt: '2026-08-01T00:00:00.000Z', baseRevision: 1, wakeReasons: [], changes: [] };
  const wait = { kind: 'rate_limit', recovery: 'automatic_retry', source: 'coordinator', sourceId: 'p', model: 'm', detectedAt: '2026-08-01T00:00:00.000Z', retryAt: '2026-08-01T01:00:00.000Z' } as const;
  assert.equal(passHealth({ ...base, outcome: 'completed' }), 'completed');
  assert.equal(passHealth({ ...base, outcome: 'error' }), 'logicalFailure');
  assert.equal(passHealth({ ...base, outcome: 'no_finish' }), 'logicalFailure');
  // The engine stamps error+infrastructure on a provider outage; the outage
  // wins — it is a backoff, not the coordinator being wrong.
  assert.equal(passHealth({ ...base, outcome: 'error', infrastructure: wait }), 'providerBackoff');
  // conflicted is not in the schema union today; classified forward-compatibly
  // as neither success nor logical failure (the revision check working).
  assert.equal(passHealth({ ...base, outcome: 'conflicted' as never }), 'conflicted');
  assert.equal(passHealth({ ...base, outcome: 'running' }), 'running');
});

test('actorClass: human, agent-session, pilot/system, and unattributed split apart', () => {
  assert.equal(actorClass('niall'), 'human');
  assert.equal(actorClass('claude-session'), 'session');
  assert.equal(actorClass('codex-session'), 'session');
  assert.equal(actorClass('pilot'), 'pilot');
  assert.equal(actorClass('coordinator'), 'pilot');
  assert.equal(actorClass('unattributed'), 'unattributed');
});

test('outcome scoreboard: conclusions are success, adopted/backoff/conflicted/actors report honestly', async () => {
  // Workstream A: a genuine successful outcome — a qualified typed conclusion,
  // one clean pass, and interventions from a human, an agent session, a
  // legacy (unattributed) act, plus a delegated pilot auto-approval.
  await createWorkstream({
    slug: 'ws-a', title: 'concluded', objective: 'o', tags: ['hiring'], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 9, maxCostUsd: 9 },
  });
  await arrive('ws-a', (d) => {
    d.workstream.conclusion = { passId: 'pa1', atVirtual: '2026-08-03T12:00:00.000Z', summary: 'shipped', evidenceIds: ['del_a'] };
    d.spend.humanInterventions = 3; // human steer + session steer + legacy steer
    d.spend.totalCostUsd = 6;
    d.deliverables.push({ id: 'del_a', title: 'd', kind: 'md', path: 'a.md', contentHash: 'h', createdAtVirtual: '2026-08-03T10:00:00.000Z', adopted: { contentHash: 'h', passId: 'pa1', atVirtual: '2026-08-03T11:00:00.000Z' } });
    d.steering.push(
      { id: 's_f', body: 'human steer', by: 'niall', at: '2026-08-01T09:00:00.000Z' },
      { id: 's_s', body: 'session steer', by: 'claude-session', at: '2026-08-01T10:00:00.000Z' },
      // A legacy steer predating actor attribution (no `by`): a real, dated human
      // act, but attributable to neither the human nor a session bucket.
      { id: 's_u', body: 'legacy steer', at: '2026-08-01T11:00:00.000Z' },
    );
    // A completed action approved by pilot (delegated authority, not a human act)
    // that took two attempts (a recovered flake).
    d.assignments.push({
      ...baseAssignment('asg_a', '2026-08-01T08:00:00.000Z'),
      exec: { cwd: '/', verify: 'true', approval: { by: 'pilot', at: '2026-08-02T10:00:00.000Z' } },
      attempts: [
        { runId: 'r1', startedAt: '2026-08-01T08:10:00.000Z', costUsd: 0.5 },
        { runId: 'r2', startedAt: '2026-08-01T08:20:00.000Z', costUsd: 0.5 },
      ],
    });
    // Passes: one clean success, one provider backoff (error+infrastructure),
    // one conflicted (neither), one plain logical failure.
    const wait = { kind: 'rate_limit', recovery: 'automatic_retry', source: 'coordinator', sourceId: 'pa2', model: 'm', detectedAt: '2026-08-01T00:00:00.000Z', retryAt: '2026-08-01T01:00:00.000Z' } as const;
    d.passes.push(
      { id: 'pa1', startedAt: '2026-08-03T12:00:00.000Z', baseRevision: 1, wakeReasons: [], changes: [], outcome: 'completed' },
      { id: 'pa2', startedAt: '2026-08-03T13:00:00.000Z', baseRevision: 1, wakeReasons: [], changes: [], outcome: 'error', infrastructure: wait },
      { id: 'pa3', startedAt: '2026-08-03T14:00:00.000Z', baseRevision: 1, wakeReasons: [], changes: [], outcome: 'conflicted' as never },
      { id: 'pa4', startedAt: '2026-08-03T15:00:00.000Z', baseRevision: 1, wakeReasons: [], changes: [], outcome: 'no_finish' },
    );
  });

  // Workstream B: NOT concluded, but it has adopted work products. Adopted work
  // is a leading indicator and must never inflate the success count.
  await createWorkstream({
    slug: 'ws-b', title: 'adopted only', objective: 'o', tags: ['hiring'], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 9, maxCostUsd: 9 },
  });
  await arrive('ws-b', (d) => {
    d.spend.humanInterventions = 0;
    d.spend.totalCostUsd = 4;
    d.deliverables.push(
      { id: 'del_b1', title: 'd', kind: 'md', path: 'b1.md', contentHash: 'h', createdAtVirtual: '2026-08-02T10:00:00.000Z', adopted: { contentHash: 'h', passId: 'pb1', atVirtual: '2026-08-02T11:00:00.000Z' } },
      { id: 'del_b2', title: 'd', kind: 'md', path: 'b2.md', contentHash: 'h', createdAtVirtual: '2026-08-02T12:00:00.000Z', adopted: { contentHash: 'h', passId: 'pb1', atVirtual: '2026-08-02T13:00:00.000Z' } },
    );
    // A worker assignment completed on its first attempt.
    d.assignments.push({ ...baseAssignment('asg_b', '2026-08-02T08:00:00.000Z'), attempts: [{ runId: 'rb', startedAt: '2026-08-02T08:05:00.000Z', costUsd: 0.2 }] });
  });

  const docs = [await load('ws-a'), await load('ws-b')];
  // A learned-policy that earned active — must stay separate from pilot approvals.
  const learned = policy({ id: 'pol_learned', status: 'active', provenance: { workstreamSlug: 'ws-a', passId: 'p', interventionSummary: 'corrected' } });
  const stats = computeStats(docs, [learned], new Date('2026-08-05T00:00:00.000Z'));
  const tot = stats.totals;

  // (1) Success denominator = qualified typed conclusions; adopted is separate.
  assert.equal(tot.successfulOutcomes, 1, 'only ws-a concluded');
  assert.equal(tot.adoptions, 3, 'three adopted work products across the fleet');
  assert.notEqual(tot.successfulOutcomes, tot.adoptions, 'adopted work is never the success count');
  assert.equal(tot.interventionsPerOutcome, 3, '3 interventions / 1 conclusion');
  assert.equal(tot.interventionsPerAdopted, 1, '3 interventions / 3 adopted (leading indicator)');
  // SDK dollar estimates stay stored for backward compatibility, but the
  // operator scoreboard does not turn them into outcome or fleet metrics.
  assert.ok(!('costUsd' in tot));
  assert.ok(!('costPerOutcome' in tot));
  assert.ok(!('costPerAdopted' in tot));
  assert.ok(stats.days.every((day) => !('costUsd' in day)));
  assert.ok(stats.rows.every((row) => !('costUsd' in row)));
  const html = renderStatsHtml(stats);
  assert.doesNotMatch(html, /SDK estimate|costUsd|\$10(?:\.00)?/);

  // (2) Provider backoff is not a logical failure; conflicted is neither.
  assert.equal(tot.passHealth.completed, 1);
  assert.equal(tot.passHealth.providerBackoff, 1, 'error+infrastructure is a backoff');
  assert.equal(tot.passHealth.logicalFailure, 1, 'only the no_finish with no infrastructure');
  assert.equal(tot.passHealth.conflicted, 1, 'conflicted counted on its own, never as error');

  // (3) Actor buckets split into distinct numbers, never collapsed.
  assert.deepEqual(tot.attribution, { human: 1, session: 1, unattributed: 1, pilot: 1 });
  assert.equal(tot.attribution.human + tot.attribution.session + tot.attribution.unattributed, 3, 'the three dated human acts partition cleanly');
  // Pilot auto-approvals are delegated authority, reported separately from
  // learned-policy effects — the two are distinct fields and one never folds
  // into the other, even when both happen to be 1.
  assert.equal(tot.attribution.pilot, 1, 'one delegated pilot auto-approval');
  assert.equal(tot.autoApproved, 1, 'pilot count tracks auto-approvals');
  assert.equal(tot.policiesActive, 1, 'one learned policy earned active — a separate axis');

  // (4) Worker reliability: one first-try completion (ws-b) and one recovered
  // completion after a retry (ws-a); recovery rate over assignments needing it.
  assert.equal(tot.reliability.completed, 2);
  assert.equal(tot.reliability.firstAttempt, 1);
  assert.equal(tot.reliability.recovered, 1);
  assert.equal(tot.reliability.firstAttemptRate, 0.5);
  assert.equal(tot.reliability.recoveryRate, 1, 'the one assignment that needed a retry recovered');
});

test('attributionSplit / passHealthTotals / workerReliability are honest on an empty fleet', () => {
  assert.deepEqual(attributionSplit([]), { human: 0, session: 0, unattributed: 0, pilot: 0 });
  assert.deepEqual(passHealthTotals([]), { completed: 0, providerBackoff: 0, logicalFailure: 0, conflicted: 0, running: 0 });
  const rel = workerReliability([]);
  assert.equal(rel.firstAttemptRate, null);
  assert.equal(rel.recoveryRate, null);
});

test('computeStats week-ago delta needs eight days of history', async () => {
  await makeWorkstream();
  await arrive('stats-ws', (d) => {
    d.steering.push({ id: 'steer_1', body: 'go', at: '2026-08-01T10:00:00.000Z' });
    d.deliverables.push({
      id: 'del_1', title: 'done', kind: 'markdown', path: 'a.md', contentHash: 'h1', createdAtVirtual: '2026-08-01T11:00:00.000Z',
      adopted: { contentHash: 'h1', passId: 'pass_1', atVirtual: '2026-08-01T11:00:00.000Z' },
    });
    d.workstream.conclusion = { passId: 'pass_1', atVirtual: '2026-08-01T11:00:00.000Z', summary: 'done', evidenceIds: ['del_1'] };
  });
  const docs: WorkstreamDoc[] = [await load('stats-ws')];
  const short = computeStats(docs, [], new Date('2026-08-05T00:00:00.000Z'));
  assert.equal(short.totals.perOutcomeWeekAgo, null);
  const long = computeStats(docs, [], new Date('2026-08-12T00:00:00.000Z'));
  // The outcome curve (per qualified conclusion) was already 1.0 a week before.
  assert.equal(long.totals.perOutcomeWeekAgo, 1);
});
