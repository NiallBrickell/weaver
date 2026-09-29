/**
 * Conclusion dispositions — how a workstream ended, validated at write time.
 *
 * Drives the real conclude_workstream tool inside a real coordinator pass (a
 * stub executor stands in for the model; the Weaver mutation tools, the
 * revision-checked write, and the evidence gate are all production code), then
 * checks the stored conclusion and what the stats page makes of it. Model
 * quality can neither pass nor fail these: every assertion is on typed state.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCoordinatorPass } from './coordinator.js';
import { conclusionDispositionLabels, dispositionLabel, dispositionOf, isSuccessfulConclusion } from './conclusion.js';
import { computeStats, renderStatsHtml } from './stats.js';
import { renderStatus } from './status.js';
import { renderWorkstreamPrintout } from './printout.js';
import { buildProjection } from './projection.js';
import { arrive, closeStore, createWorkstream, load, workstreamExists } from './store.js';
import { virtualNow } from './clock.js';
import type { CoordinatorExecutor } from './executor/coordinator.js';
import type { ConclusionDisposition, WorkstreamDoc } from './types.js';

const SLUG = 'disp-ws';
const OTHER = 'disp-other';

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV = [
  'WEAVER_HOME', 'WEAVER_STORE', 'WEAVER_RUNNER_ID', 'WEAVER_RUNNER_PLACEMENT_ONLY',
  'WEAVER_COORDINATOR_EXECUTOR', 'WEAVER_COORDINATOR_MODEL', 'WEAVER_COORDINATOR_FALLBACK_EXECUTOR',
  'WEAVER_COORDINATOR_FALLBACK_MODEL', 'WEAVER_COORDINATOR_FALLBACKS',
];

beforeEach(async () => {
  for (const name of ENV) if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  await closeStore();
  for (const name of ENV) delete process.env[name];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-disposition-'));
  process.env.WEAVER_HOME = home;
  for (const slug of [SLUG, OTHER]) {
    await createWorkstream({
      slug,
      title: `Workstream ${slug}`,
      objective: 'Decide whether the cache layer change is worth shipping',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
  }
  await arrive(SLUG, (doc) => {
    const at = virtualNow().toISOString();
    doc.deliverables.push({
      id: 'del_report', title: 'Impact measurement', kind: 'report', path: 'x', contentHash: 'h',
      createdAtVirtual: at,
      adopted: { contentHash: 'h', passId: 'pass_x', atVirtual: at },
    });
    doc.deliverables.push({
      id: 'del_unadopted', title: 'Proposed report', kind: 'report', path: 'y', contentHash: 'h2',
      createdAtVirtual: at,
    });
    doc.decisions.push({
      id: 'dec_self', title: 'This is not worth doing', rationale: 'I think so',
      madeBy: 'coordinator', status: 'standing', decidedAtVirtual: at,
    });
    doc.steering.push({ id: 'str_close', body: 'close this one', at: new Date().toISOString() });
    doc.steering.push({
      id: 'str_withdrawn', body: 'close it (withdrawn)', at: new Date().toISOString(),
      revokedAt: new Date().toISOString(), revokedBy: 'human',
    });
  });
});

afterEach(async () => {
  await closeStore();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: unknown[] };

/** One real coordinator pass whose "model" calls conclude_workstream once. */
async function conclude(args: Record<string, unknown>): Promise<ToolResult> {
  let result: ToolResult | undefined;
  const executor: CoordinatorExecutor = {
    id: 'local-sdk',
    async execute(req) {
      const tool = req.tools.find((t) => t.name === 'conclude_workstream')!;
      result = await (tool.handler(args as never, {}) as Promise<ToolResult>);
      const finish = req.tools.find((t) => t.name === 'finish_pass')!;
      await finish.handler({ summary: 'disposition test', acknowledged_steering: true } as never, {});
      return { costUsd: 0, sessionId: 'disposition' };
    },
  };
  await runCoordinatorPass(SLUG, ['manual'], executor);
  return result!;
}

function text(result: ToolResult): string {
  return (result.content[0] as { text: string }).text;
}

async function assertRefused(args: Record<string, unknown>, pattern: RegExp): Promise<void> {
  const result = await conclude(args);
  assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(args)}: ${text(result)}`);
  assert.match(text(result), pattern);
  const doc = await load(SLUG);
  assert.equal(doc.workstream.conclusion, undefined, 'a refused conclusion is never stored');
  assert.equal(doc.workstream.status, 'active');
}

// --- valid paths ------------------------------------------------------------

for (const disposition of ['delivered', 'no_change_needed', 'not_worth_doing'] as const) {
  test(`${disposition} concludes on an adopted deliverable and is stored with its disposition`, async () => {
    const result = await conclude({ summary: 's', disposition, evidence_ids: ['del_report'] });
    assert.equal(result.isError, undefined, text(result));
    const doc = await load(SLUG);
    assert.equal(doc.workstream.status, 'done');
    assert.equal(doc.workstream.conclusion?.disposition, disposition);
    assert.deepEqual(doc.workstream.conclusion?.evidenceIds, ['del_report']);
    assert.equal(doc.workstream.conclusion?.duplicateOf, undefined);
    assert.equal(doc.workstream.conclusion?.directedBy, undefined);
  });
}

test('not_worth_doing may rest on human steering instead of a deliverable', async () => {
  const result = await conclude({ summary: 's', disposition: 'not_worth_doing', evidence_ids: ['str_close'] });
  assert.equal(result.isError, undefined, text(result));
  assert.equal((await load(SLUG)).workstream.conclusion?.disposition, 'not_worth_doing');
});

test('duplicate concludes against another existing workstream', async () => {
  const result = await conclude({ summary: 's', disposition: 'duplicate', duplicate_of: OTHER });
  assert.equal(result.isError, undefined, text(result));
  const c = (await load(SLUG)).workstream.conclusion!;
  assert.equal(c.disposition, 'duplicate');
  assert.equal(c.duplicateOf, OTHER);
  assert.deepEqual(c.evidenceIds, []);
});

test('directed_closed concludes on the human steering and records it as evidence', async () => {
  const result = await conclude({ summary: 's', disposition: 'directed_closed', directed_by: 'str_close' });
  assert.equal(result.isError, undefined, text(result));
  const c = (await load(SLUG)).workstream.conclusion!;
  assert.equal(c.disposition, 'directed_closed');
  assert.equal(c.directedBy, 'str_close');
  assert.deepEqual(c.evidenceIds, ['str_close']);
});

// --- invalid paths ----------------------------------------------------------

test('a missing disposition is refused', async () => {
  await assertRefused({ summary: 's', evidence_ids: ['del_report'] }, /requires a disposition/);
});

test('an unknown disposition is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'abandoned', evidence_ids: ['del_report'] }, /requires a disposition/);
});

test('not_worth_doing cannot self-certify on the coordinator\'s own decision', async () => {
  await assertRefused({ summary: 's', disposition: 'not_worth_doing', evidence_ids: ['dec_self'] }, /cannot self-certify/);
});

test('not_worth_doing with no evidence at all is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'not_worth_doing' }, /at least one typed evidence id/);
});

test('not_worth_doing on an unadopted (proposed) deliverable is refused — adoption is the bar', async () => {
  await assertRefused({ summary: 's', disposition: 'not_worth_doing', evidence_ids: ['del_unadopted'] }, /not an adopted deliverable/);
});

test('delivered keeps the existing rule: a coordinator decision is not evidence', async () => {
  await assertRefused({ summary: 's', disposition: 'delivered', evidence_ids: ['dec_self'] }, /cannot self-certify/);
});

test('duplicate of itself is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'duplicate', duplicate_of: SLUG }, /duplicate of itself/);
});

test('duplicate of a nonexistent slug is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'duplicate', duplicate_of: 'no-such-ws' }, /names no existing workstream/);
});

test('duplicate without duplicate_of is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'duplicate' }, /requires duplicate_of/);
});

test('a path-shaped duplicate_of names nothing', async () => {
  assert.equal(await workstreamExists(`../${path.basename(home)}/${OTHER}`), false);
  assert.equal(await workstreamExists(OTHER), true);
  await assertRefused({ summary: 's', disposition: 'duplicate', duplicate_of: `../${OTHER}` }, /names no existing workstream/);
});

test('directed_closed with an unknown steering id is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'directed_closed', directed_by: 'str_nope' }, /not a \(non-withdrawn\) steering record/);
});

test('directed_closed on a withdrawn steer is refused — it never directed anything', async () => {
  await assertRefused({ summary: 's', disposition: 'directed_closed', directed_by: 'str_withdrawn' }, /not a \(non-withdrawn\) steering record/);
});

test('directed_closed on a coordinator decision id is refused', async () => {
  await assertRefused({ summary: 's', disposition: 'directed_closed', directed_by: 'dec_self' }, /steering record/);
});

test('fields belonging to another disposition are refused, not silently dropped', async () => {
  await assertRefused({ summary: 's', disposition: 'delivered', evidence_ids: ['del_report'], duplicate_of: OTHER }, /duplicate_of applies only/);
  await assertRefused({ summary: 's', disposition: 'duplicate', duplicate_of: OTHER, directed_by: 'str_close' }, /directed_by applies only/);
});

test('a withdrawn steer is no longer conclusion evidence for any disposition', async () => {
  await assertRefused({ summary: 's', disposition: 'delivered', evidence_ids: ['str_withdrawn'] }, /not an adopted deliverable/);
});

// --- legacy + surfaces --------------------------------------------------------

test('a legacy conclusion without a disposition loads, reads as unclassified, and counts as success', async () => {
  await arrive(SLUG, (doc) => {
    doc.workstream.status = 'done';
    doc.workstream.conclusion = { passId: 'pass_old', atVirtual: virtualNow().toISOString(), summary: 'old', evidenceIds: ['del_report'] };
  });
  const doc = await load(SLUG);
  assert.equal(dispositionOf(doc.workstream.conclusion!), 'unclassified');
  assert.equal(isSuccessfulConclusion(doc.workstream.conclusion!), true);
  assert.equal(doc.workstream.conclusion!.disposition, undefined, 'never backfilled by guessing');
  const stats = computeStats([doc], [], new Date());
  assert.equal(stats.totals.successfulOutcomes, 1);
  assert.equal(stats.totals.unclassifiedOutcomes, 1);
  assert.equal(stats.totals.closedWithoutDelivery, 0);
  assert.equal(stats.rows[0]!.disposition, 'unclassified');
  assert.equal(stats.rows[0]!.concluded, true);
  assert.match(renderStatus(doc), /Conclusion: unclassified/);
});

test('the disposition is rendered on status, printout, and the projection', async () => {
  const result = await conclude({ summary: 'measured: not worth it', disposition: 'not_worth_doing', evidence_ids: ['del_report'] });
  assert.equal(result.isError, undefined, text(result));
  const doc = await load(SLUG);
  assert.match(renderStatus(doc), /Conclusion: not worth doing — measured: not worth it/);
  assert.match(renderWorkstreamPrintout(doc, [], [], new Date().toISOString(), undefined, []), /Disposition \(validated at conclusion\): not worth doing/);
  assert.match(buildProjection(doc, ['manual']), /disposition: not worth doing/);
});

function concludedDoc(slug: string, disposition: ConclusionDisposition | undefined, interventions = 0): WorkstreamDoc {
  return {
    schemaVersion: 1,
    revision: 1,
    workstream: {
      id: `ws_${slug}`, slug, title: slug, objective: 'o', successCriteria: [], constraints: [], tags: [],
      autonomy: { sendsRequireApproval: true }, status: 'done', createdAt: '2026-08-01T00:00:00.000Z',
      conclusion: {
        passId: `pass_${slug}`, atVirtual: '2026-08-02T00:00:00.000Z', summary: slug, evidenceIds: [],
        ...(disposition ? { disposition } : {}),
      },
    },
    decisions: [], assignments: [], deliverables: [], interactions: [], observations: [], wakes: [],
    steering: [], attention: [], passes: [], events: [],
    spend: { coordinatorPasses: 1, humanInterventions: interventions },
  } as unknown as WorkstreamDoc;
}

test('stats split successful outcomes from closures without delivery', () => {
  const docs = [
    concludedDoc('a-delivered', 'delivered', 2),
    concludedDoc('b-nochange', 'no_change_needed', 1),
    concludedDoc('c-legacy', undefined, 1),
    concludedDoc('d-notworth', 'not_worth_doing', 2),
    concludedDoc('e-dup', 'duplicate'),
    concludedDoc('f-directed', 'directed_closed'),
    concludedDoc('g-notworth', 'not_worth_doing'),
  ];
  const stats = computeStats(docs, [], new Date('2026-08-03T00:00:00.000Z'));
  const t = stats.totals;
  assert.equal(t.successfulOutcomes, 3, 'delivered + no_change_needed + legacy unclassified');
  assert.equal(t.unclassifiedOutcomes, 1);
  assert.equal(t.closedWithoutDelivery, 4);
  assert.deepEqual(t.dispositions, {
    delivered: 1, no_change_needed: 1, not_worth_doing: 2, duplicate: 1, directed_closed: 1, unclassified: 1,
  });
  // The outcome curve divides only by successful outcomes.
  assert.equal(stats.ratio.at(-1)!.conclusions, 3);
  assert.equal(t.interventionsPerOutcome, 6 / 3);
  const row = (slug: string) => stats.rows.find((r) => r.slug === slug)!;
  assert.equal(row('d-notworth').concluded, false);
  assert.equal(row('d-notworth').disposition, 'not_worth_doing');
  assert.equal(row('a-delivered').concluded, true);
  const html = renderStatsHtml(stats);
  assert.match(html, /Closed without delivery/);
  assert.match(html, /2 not worth doing · 1 duplicate · 1 closed by human direction/);
  assert.match(html, /closed · not worth doing/);
  assert.match(html, /✓ concluded \(unclassified, legacy\)/);
  assert.match(html, /never reclassified by guessing/);
});

test('the gate itself is pure over the doc: duplicate existence is supplied by the caller', async () => {
  const doc = await load(SLUG);
  assert.throws(() => conclusionDispositionLabels(doc, { disposition: 'duplicate', evidenceIds: [], duplicateOf: OTHER }, false), /names no existing workstream/);
  assert.equal(conclusionDispositionLabels(doc, { disposition: 'duplicate', evidenceIds: [], duplicateOf: OTHER }, true).length, 1);
  assert.equal(dispositionLabel({ disposition: 'duplicate', duplicateOf: OTHER }), `duplicate of ${OTHER}`);
});
