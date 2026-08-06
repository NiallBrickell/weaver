/** Deterministic printout contract: no model, network, or terminal required. */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { conclusionEvidenceLabels } from './conclusion.js';
import { acknowledgePrintout, deliverPrintout, preparePrintout, type PrintoutReport } from './printout.js';
import { proposeBackfillPolicy, recordPolicyOutcome } from './policies.js';
import { buildProjection } from './projection.js';
import { emitTail } from './tail.js';
import { setSecret } from './secrets.js';
import { arrive, createWorkstream, listWorkstreams, load, mutate, printoutJournalDir, workstreamDir } from './store.js';
import type { Assignment, Deliverable } from './types.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-printout-'));
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
});

function make(slug: string): void {
  createWorkstream({
    slug,
    title: `Printout ${slug}`,
    objective: `prove what ${slug} actually accomplished`,
    tags: ['test'],
    successCriteria: ['external effects have deterministic readback'],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });
}

function delivered(slug?: string): PrintoutReport {
  const report = preparePrintout(slug);
  acknowledgePrintout(report);
  return report;
}

function assignment(id: string, kind: Assignment['kind'], objective: string, extra: Partial<Assignment> = {}): Assignment {
  return {
    id,
    objective,
    briefing: `brief for ${objective}`,
    kind,
    acceptanceCriteria: ['evidence is inspectable'],
    dependsOn: [],
    state: 'completed',
    attempts: [{ runId: `run_${id}`, startedAt: '2026-08-06T08:00:00.000Z', endedAt: '2026-08-06T08:01:00.000Z' }],
    adoption: { state: 'none' },
    createdAtVirtual: '2026-08-06T07:59:00.000Z',
    ...extra,
  };
}

function deliverable(id: string, assignmentId: string, adopted: boolean): Deliverable {
  const hash = (adopted ? 'b' : 'a').repeat(64);
  return {
    id,
    title: `${id} report`,
    kind: 'report',
    path: `${id}.md`,
    contentHash: hash,
    producedByAssignment: assignmentId,
    createdAtVirtual: '2026-08-06T08:01:00.000Z',
    ...(adopted ? { adopted: { contentHash: hash, passId: 'pass_1', atVirtual: '2026-08-06T08:02:00.000Z' } } : {}),
  };
}

test('printout separates claims, adoption, deterministic readback, and provider receipts', () => {
  make('truth');
  delivered('truth');
  const candidate = deliverable('del_candidate', 'asg_research', false);
  const accepted = deliverable('del_accepted', 'asg_pr', true);
  arrive('truth', (doc, event) => {
    doc.deliverables.push(candidate, accepted);
    doc.assignments.push(
      assignment('asg_research', 'research', 'Inspect the release history', {
        readDirs: ['/repo'], state: 'awaiting_review', submission: { summary: 'Found relevant commits', deliverableId: candidate.id }, adoption: { state: 'proposed' },
      }),
      assignment('asg_claim', 'action', 'Merge PR 42', {
        state: 'awaiting_review', exec: { cwd: '/repo', verify: 'gh pr view 42 --json mergedAt' }, submission: { summary: 'PR merged' }, adoption: { state: 'proposed' },
      }),
      assignment('asg_failed', 'action', 'Deploy PR 42', {
        exec: { cwd: '/repo', verify: 'curl -f https://example.test/version', verified: { ok: false, output: 'old version', at: '2026-08-06T08:03:00.000Z' } },
      }),
      assignment('asg_pr', 'action', 'Open pull request 42', {
        exec: { cwd: '/repo', verify: 'gh pr view 42 --json url', approval: { by: 'pilot', at: '2026-08-06T08:00:00.000Z' }, verified: { ok: true, output: 'https://github.test/pull/42', at: '2026-08-06T08:02:00.000Z' } },
        submission: { summary: 'Opened the PR', deliverableId: accepted.id }, adoption: { state: 'accepted', passId: 'pass_1', reason: 'readback checked' },
      }),
    );
    doc.interactions.push({ id: 'int_1', kind: 'email_send', to: 'owner@example.test', subject: 'Release complete', deliverableId: accepted.id, status: 'confirmed', externalRef: 'provider_1', sentAtVirtual: '2026-08-06T08:05:00.000Z', replies: [] });
    event('fixture.completed', 'worker says PR merged and production tested', ['asg_research', 'asg_claim', 'asg_failed', 'asg_pr', 'int_1']);
  });
  setSecret('TOKEN', 'secret-printout-value', 'truth');
  emitTail('truth', 'worker', 'asg_research', 'tool', 'Read /repo/release.ts with secret-printout-value');
  emitTail('truth', 'worker', 'asg_claim', 'text', 'PR merged and deployed, trust me');

  const report = preparePrintout('truth').text;
  assert.match(report, /PROPOSED research — asg_research/);
  assert.match(report, /NO READBACK — EXTERNAL EFFECT NOT CONFIRMED — asg_claim/);
  assert.match(report, /Submission: PR merged \(a claim until accepted\)/);
  assert.match(report, /READBACK FAILED — EXTERNAL EFFECT NOT CONFIRMED — asg_failed/);
  assert.match(report, /VERIFIED EXTERNAL EFFECT — asg_pr/);
  assert.match(report, /https:\/\/github\.test\/pull\/42/);
  assert.match(report, /Provider receipt: provider_1/);
  assert.match(report, /Observed run activity[\s\S]*Read \/repo\/release\.ts/);
  assert.doesNotMatch(report, /trust me/);
  assert.doesNotMatch(report, /secret-printout-value/);
  assert.match(report, /«secret:TOKEN»/);
});

test('eventless writes retain exact intermediate failed and passing readbacks', () => {
  make('exact');
  delivered('exact');
  arrive('exact', (doc) => doc.assignments.push(assignment('asg_release', 'action', 'Verify production', {
    exec: { cwd: '/repo', verify: 'check-version', verified: { ok: false, output: 'version 41', at: '2026-08-06T09:00:00.000Z' } },
  })));
  arrive('exact', (doc) => {
    doc.assignments[0]!.exec!.verified = { ok: true, output: 'version 42', at: '2026-08-06T09:01:00.000Z' };
    doc.spend.totalCostUsd = 1.25;
  });

  const report = preparePrintout('exact').text;
  assert.match(report, /VERIFIED EXTERNAL EFFECT[\s\S]*version 42/);
  assert.match(report, /"ok":false[\s\S]*"output":"version 41"/);
  assert.match(report, /\/exec\/verified\/ok false → true/);
  assert.match(report, /\/exec\/verified\/output "version 41" → "version 42"/);
  assert.match(report, /spend: \/totalCostUsd 0 → 1\.25/);
});

test('typed provider capacity changes survive eventless writes', () => {
  make('capacity');
  delivered('capacity');
  arrive('capacity', (doc) => {
    doc.capacity = {
      state: 'backoff',
      byModel: {
        sonnet: {
          wait: {
            kind: 'rate_limit',
            recovery: 'automatic_retry',
            source: 'worker',
            sourceId: 'run_limited',
            model: 'sonnet',
            detectedAt: '2026-08-06T09:00:00.000Z',
            retryAt: '2026-08-06T09:15:00.000Z',
          },
          consecutiveBackoffs: 1,
          firstBackoffAtVirtual: '2026-08-06T09:00:00.000Z',
          lastBackoffAtVirtual: '2026-08-06T09:00:00.000Z',
        },
      },
    };
  });

  const report = preparePrintout('capacity').text;
  assert.match(report, /Provider capacity: sonnet rate_limit, retry 2026-08-06T09:15:00\.000Z/);
  assert.match(report, /capacity: \/ null → \{"state":"backoff"/);
});

test('preparing and acknowledging P never changes organizational revision or conflicts with a live writer', () => {
  make('readonly');
  const expected = load('readonly').revision;
  const report = preparePrintout('readonly');
  assert.equal(load('readonly').revision, expected);
  acknowledgePrintout(report);
  assert.equal(load('readonly').revision, expected);
  mutate('readonly', expected, (doc) => { doc.workstream.title = 'live writer committed'; });
  assert.equal(load('readonly').workstream.title, 'live writer committed');
});

test('acknowledgement happens after delivery and keeps concurrent arrivals for the next report', () => {
  make('delivery');
  delivered('delivery');
  arrive('delivery', (_doc, event) => event('first.change', 'first visible change'));
  const frozen = preparePrintout('delivery');
  assert.match(frozen.text, /first visible change/);
  arrive('delivery', (_doc, event) => event('concurrent.change', 'arrived after freeze'));
  assert.doesNotMatch(frozen.text, /arrived after freeze/);
  acknowledgePrintout(frozen);
  const next = preparePrintout('delivery');
  assert.match(next.text, /arrived after freeze/);
});

test('a failed CLI-style output write leaves the activity window unacknowledged', async () => {
  make('failed-output');
  delivered('failed-output');
  arrive('failed-output', (_doc, event) => event('still.pending', 'must repeat after EPIPE'));
  const report = preparePrintout('failed-output');
  await assert.rejects(deliverPrintout(report, (_text, callback) => callback(new Error('EPIPE'))), /EPIPE/);
  assert.match(preparePrintout('failed-output').text, /must repeat after EPIPE/);
});

test('typed conclusion accepts only adopted, verified, or standing evidence ids', () => {
  make('done');
  arrive('done', (doc) => {
    doc.deliverables.push(deliverable('del_done', 'asg_work', true));
    doc.assignments.push(assignment('asg_verified', 'action', 'Merge the PR', {
      exec: { cwd: '/repo', verify: 'gh pr view', verified: { ok: true, output: 'merged', at: '2026-08-06T09:00:00.000Z' } },
    }));
    doc.decisions.push({ id: 'dec_stop', title: 'Objective met', rationale: 'verified result', madeBy: 'coordinator', status: 'standing', decidedAtVirtual: '2026-08-06T09:01:00.000Z' });
  });
  const doc = load('done');
  assert.equal(conclusionEvidenceLabels(doc, ['del_done', 'asg_verified', 'dec_stop']).length, 3);
  assert.throws(() => conclusionEvidenceLabels(doc, ['missing']), /not an adopted deliverable/);
  assert.throws(() => conclusionEvidenceLabels(doc, []), /at least one/);
  arrive('done', (current, event) => {
    conclusionEvidenceLabels(current, ['asg_verified']);
    current.workstream.status = 'done';
    current.workstream.conclusion = { passId: 'pass_done', atVirtual: '2026-08-06T10:00:00.000Z', summary: 'PR was merged', evidenceIds: ['asg_verified'] };
    event('workstream.concluded', 'PR was merged', ['asg_verified']);
  });
  assert.match(preparePrintout('done').text, /Typed completion evidence IDs \(validated at conclusion\): asg_verified/);
  assert.match(buildProjection(load('done'), []), /Validated evidence ids: asg_verified/);
});

test('a legacy first print is honest about gaps and retains its surviving tail', () => {
  make('legacy');
  fs.rmSync(path.join(printoutJournalDir('legacy'), 'revisions'), { recursive: true });
  arrive('legacy', (doc, event) => {
    doc.workstream.title = 'Legacy changed after upgrade';
    event('legacy.new_change', 'new receipt after upgrade');
  });
  const report = preparePrintout('legacy').text;
  assert.match(report, /predates printout journals/);
  assert.match(report, /Surviving pre-journal activity/);
  assert.match(report, /workstream\.created/);
  assert.match(report, /new receipt after upgrade/);
});

test('append-only journal outlives the bounded 200-event projection tail', () => {
  make('long-window');
  delivered('long-window');
  for (let index = 0; index < 230; index++) arrive('long-window', (_doc, event) => event('test.activity', `activity ${index}`));
  assert.equal(load('long-window').events.length, 200);
  const report = preparePrintout('long-window');
  assert.equal(report.workstreams[0]!.eventCount, 230);
  assert.match(report.text, /activity 0/);
  assert.match(report.text, /activity 229/);
});

test('growing attempt history is journaled as leaf appends rather than quadratic snapshots', () => {
  make('compact');
  delivered('compact');
  arrive('compact', (doc) => doc.assignments.push(assignment('asg_many', 'research', 'Run many bounded attempts', { attempts: [] })));
  for (let index = 0; index < 250; index++) {
    arrive('compact', (doc) => doc.assignments[0]!.attempts.push({
      runId: `run_${index}`,
      startedAt: `2026-08-06T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
      endedAt: `2026-08-06T09:${String(index % 60).padStart(2, '0')}:01.000Z`,
    }));
  }
  const dir = path.join(printoutJournalDir('compact'), 'revisions');
  const files = fs.readdirSync(dir).filter((name) => name.startsWith('revision-'));
  const bytes = files.reduce((total, name) => total + fs.statSync(path.join(dir, name)).size, 0);
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'revision-0000000000000251.json'), 'utf8')) as { changes: { fields: { path: string }[] }[] };
  assert.ok(bytes < 1_000_000, `journal grew to ${bytes} bytes`);
  assert.deepEqual(last.changes[0]!.fields.map((field) => field.path), ['/attempts/249']);
});

test('selected and fleet checkpoints are independent and fleet includes global policies', () => {
  make('alpha');
  make('beta');
  delivered();
  arrive('alpha', (_doc, event) => event('alpha.changed', 'alpha alone changed'));
  arrive('beta', (_doc, event) => event('beta.changed', 'beta alone changed'));
  const policy = proposeBackfillPolicy({ statement: 'Verify before announcing', tags: ['test'], effectKind: 'add_verification', effectDescription: 'require a readback', source: 'seed', ref: 'team', interventionSummary: 'seeded' });
  recordPolicyOutcome({ policyId: policy.id, workstreamSlug: 'alpha', passId: 'pass_1', note: 'helped', interventionFree: true });

  const alpha = delivered('alpha').text;
  assert.match(alpha, /alpha alone changed/);
  const fleet = preparePrintout();
  assert.match(fleet.text, /Printout alpha[\s\S]*Nothing new was recorded/);
  assert.match(fleet.text, /beta alone changed/);
  assert.match(fleet.text, /Global learning activity/);
  assert.match(fleet.text, /Verify before announcing/);
  assert.match(fleet.text, /\/status "shadow" → "active"/);
});

test('literal workstream field transitions are printed, not reduced to an entity id', () => {
  make('fields');
  delivered('fields');
  arrive('fields', (doc) => {
    doc.workstream.objective = 'middle objective';
    doc.workstream.constraints.push('first constraint');
    doc.workstream.budget.maxCostUsd = 30;
  });
  arrive('fields', (doc) => {
    doc.workstream.objective = 'final objective';
    doc.workstream.constraints[0] = 'final constraint';
    doc.workstream.budget.maxCostUsd = 40;
  });
  const text = preparePrintout('fields').text;
  assert.match(text, /\/objective "prove what fields actually accomplished" → "middle objective"/);
  assert.match(text, /\/objective "middle objective" → "final objective"/);
  assert.match(text, /\/constraints\/0 absent → "first constraint"/);
  assert.match(text, /\/constraints\/0 "first constraint" → "final constraint"/);
  assert.match(text, /\/budget\/maxCostUsd 30 → 40/);
});

test('a post-checkpoint journal gap shows current workstream and policy facts', () => {
  make('gap');
  delivered();
  arrive('gap', (doc) => {
    doc.workstream.constraints.push('deploy only to eu-west-2');
    doc.steering.push({ id: 'steer_gap', body: 'Use the blue environment', at: '2026-08-06T08:59:00.000Z' });
    doc.assignments.push(assignment('asg_gap', 'action', 'Verify the missing revision', {
      exec: { cwd: '/repo', verify: 'check', verified: { ok: true, output: 'confirmed', at: '2026-08-06T09:00:00.000Z' } },
    }));
  });
  fs.rmSync(path.join(printoutJournalDir('gap'), 'revisions', 'revision-0000000000000001.json'));
  const policy = proposeBackfillPolicy({ statement: 'Gap policy stays visible', tags: ['test'], effectKind: 'advisory', effectDescription: 'show current state', source: 'seed', ref: 'team', interventionSummary: 'seeded' });
  recordPolicyOutcome({ policyId: policy.id, workstreamSlug: 'gap', passId: 'pass_gap', note: 'prevented an incorrect deploy', interventionFree: true });
  fs.rmSync(path.join(process.env.WEAVER_HOME!, '.printout', 'policies', 'revisions', 'revision-0000000000000001.json'));

  const fleet = preparePrintout();
  assert.match(fleet.text, /missing for revisions 1/);
  assert.match(fleet.text, /VERIFIED EXTERNAL EFFECT — asg_gap/);
  assert.match(fleet.text, /deploy only to eu-west-2/);
  assert.match(fleet.text, /Use the blue environment/);
  assert.match(fleet.text, new RegExp(`${policy.id} \\[active\/advisory\\]`));
  assert.match(fleet.text, /show current state/);
  assert.match(fleet.text, /prevented an incorrect deploy/);
});

test('fleet printout names a malformed global policy store', () => {
  make('healthy-policy-view');
  fs.writeFileSync(path.join(process.env.WEAVER_HOME!, 'policies.json'), '{not json');
  const fleet = preparePrintout();
  assert.match(fleet.text, /Unreadable global policy store/);
  assert.match(fleet.text, /cannot read global policy store/);
  assert.equal(fleet.errors.some((error) => error.slug === 'global-policies'), true);
});

test('fleet printout names an unreadable stream without blanking healthy streams', () => {
  make('healthy');
  const badDir = workstreamDir('unreadable');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'workstream.json'), '{not json');
  assert.deepEqual(listWorkstreams(), ['healthy', 'unreadable']);
  const fleet = preparePrintout();
  assert.match(fleet.text, /Printout healthy/);
  assert.match(fleet.text, /Unreadable workstreams/);
  assert.match(fleet.text, /unreadable:/);
  assert.equal(fleet.errors.length, 1);
});
