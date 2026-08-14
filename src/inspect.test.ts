/**
 * Deterministic inspector tests: a synthetic doc renders to HTML containing
 * the expected knowledge — no model, no network. The inspector is read-only
 * over typed state, so these tests pin exactly what it may claim: decision
 * lineage as stored, adoption only where a pin exists, and never a secret
 * value in the output.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runInspect, renderOverviewHtml, renderWorkstreamHtml, renderLearnedHtml, passIntegrityWarnings } from './inspect.js';
import { inspectViewedPath, readInspectViewed, writeInspectViewed } from './inspectViewed.js';
import type { InspectViewed } from './inspectViewed.js';
import type { PolicyRecord } from './policies.js';
import { loadPolicies, proposePolicy, recordPolicyOutcome } from './policies.js';
import { setSecret } from './secrets.js';
import { arrive, createWorkstream, load, newId, workstreamDir, weaverHome, writeArtifact } from './store.js';
import { virtualNow } from './clock.js';

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

function makeWorkstream(slug = 'inspect-ws') {
  return createWorkstream({
    slug,
    title: 'Inspect me',
    objective: 'prove the inspector renders typed state',
    tags: ['hiring'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

beforeEach(() => {
  freshHome();
});

/** A doc exercising every section: lineage, deliverables, action, steering. */
async function populate(slug: string): Promise<void> {
  const { relPath, hash } = await writeArtifact(slug, 'draft.md', 'adopted draft content');
  const cand = await writeArtifact(slug, 'cand.md', 'candidate content');
  await arrive(slug, (d, event) => {
    d.decisions.push(
      {
        id: 'dec_old1',
        title: 'Contact candidates by phone',
        rationale: 'initial guess at channel',
        madeBy: 'coordinator',
        passId: 'pass_1',
        status: 'superseded',
        supersededBy: 'dec_new1',
        decidedAtVirtual: virtualNow().toISOString(),
      },
      {
        id: 'dec_new1',
        title: 'Contact candidates by email only',
        rationale: 'human corrected the channel',
        madeBy: 'human',
        status: 'standing',
        supersedes: 'dec_old1',
        appliedPolicyIds: ['pol_test1'],
        decidedAtVirtual: virtualNow().toISOString(),
      },
    );
    d.deliverables.push(
      {
        id: 'del_adopted1',
        title: 'Outreach draft',
        kind: 'document',
        path: relPath,
        contentHash: hash,
        producedByAssignment: 'asg_draft1',
        createdAtVirtual: virtualNow().toISOString(),
        adopted: { contentHash: hash, passId: 'pass_2', atVirtual: virtualNow().toISOString() },
      },
      {
        id: 'del_cand1',
        title: 'Second draft',
        kind: 'document',
        path: cand.relPath,
        contentHash: cand.hash,
        producedByAssignment: 'asg_draft2',
        createdAtVirtual: virtualNow().toISOString(),
      },
    );
    d.assignments.push({
      id: 'asg_act1',
      objective: 'open the tracking PR',
      briefing: 'open a PR with gh',
      kind: 'action',
      exec: {
        cwd: '/tmp',
        verify: 'gh pr view 1',
        approval: { by: 'human', at: new Date().toISOString() },
        verified: { ok: true, output: 'pr #1 is OPEN', at: new Date().toISOString() },
      },
      acceptanceCriteria: [],
      dependsOn: [],
      state: 'awaiting_review',
      attempts: [],
      adoption: { state: 'proposed' },
      createdAtVirtual: virtualNow().toISOString(),
    });
    d.steering.push({ id: 'steer_1', body: 'email only, please', at: new Date().toISOString() });
    d.spend.humanInterventions = 2;
    event('steering.arrived', 'email only, please', ['steer_1']);
    event('action.approved', 'asg_act1 approved by human — queued to run', ['asg_act1']);
  });
}

test('inspect on a synthetic doc renders lineage, adoption, actions, and interventions', async () => {
  await makeWorkstream();
  await populate('inspect-ws');
  const pol = await proposePolicy({
    statement: 'Verify candidate email addresses before drafting outreach',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'adds an email-verification step',
    workstreamSlug: 'inspect-ws',
    passId: 'pass_1',
    interventionSummary: 'human corrected an unverified address',
  });
  // Promotion is cross-workstream and decision-attributed: a DIFFERENT
  // workstream applies the policy (citing it on a decision) and succeeds.
  await makeWorkstream('other-ws');
  await arrive('other-ws', (d) => {
    d.decisions.push({
      id: 'dec_apply1',
      title: 'apply the verification policy',
      rationale: 'r',
      madeBy: 'coordinator',
      passId: 'pass_9',
      status: 'standing',
      appliedPolicyIds: [pol.id],
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  await recordPolicyOutcome({
    policyId: pol.id,
    workstreamSlug: 'other-ws',
    passId: 'pass_9',
    applyingDecisionId: 'dec_apply1',
    note: 'applied cleanly',
    interventionFree: true,
  });

  const out = await runInspect('inspect-ws');
  assert.equal(out, path.join(workstreamDir('inspect-ws'), 'inspect.html'));
  const html = fs.readFileSync(out, 'utf8');

  // Decision lineage: both nodes, distinct authorship, supersession visible.
  assert.match(html, /dec_old1/);
  assert.match(html, /dec_new1/);
  assert.match(html, /superseded by/);
  assert.match(html, /dnode human standing/);
  assert.match(html, /dnode coordinator superseded/);
  // Rationale reaches the click-detail data, and the applied policy is cited.
  assert.match(html, /human corrected the channel/);
  assert.match(html, /pol_test1/);

  // Policy panel: statement, promoted status, intervention-free evidence.
  assert.ok(html.includes(pol.id));
  assert.match(html, /Verify candidate email addresses/);
  assert.match(html, /status-active/);
  assert.match(html, /intervention-free/);

  // Deliverables: adoption ≠ completion — pinned hash for adopted, candidate listed.
  const doc = await load('inspect-ws');
  const pinned = doc.deliverables.find((d) => d.id === 'del_adopted1')!.adopted!.contentHash.slice(0, 8);
  assert.ok(html.includes(pinned));
  assert.match(html, /del_adopted1/);
  assert.match(html, /pass_2/);
  assert.match(html, /del_cand1/);
  assert.match(html, /candidate, adoption=/);

  // Actions audit: approval + readback verdict + output snippet.
  assert.match(html, /asg_act1/);
  assert.match(html, /approved by human/);
  assert.match(html, /CONFIRMED/);
  assert.match(html, /pr #1 is OPEN/);

  // Interventions timeline from the event tail.
  assert.match(html, /email only, please/);
  assert.match(html, /asg_act1 approved by human/);
});

test('overview renders all workstreams and links the policy store on its own page; empty sections are honest', async () => {
  await makeWorkstream('ws-one');
  await makeWorkstream('ws-two');
  await proposePolicy({
    statement: 'Always dry-run destructive commands first',
    tags: ['ops'],
    effectKind: 'advisory',
    effectDescription: 'advises a dry run',
    workstreamSlug: 'ws-one',
    passId: 'pass_1',
    interventionSummary: 'human caught a destructive command',
  });

  const out = await runInspect();
  assert.equal(out, path.join(weaverHome(), 'inspect.html'));
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /ws-one/);
  assert.match(html, /ws-two/);
  // The store is a library, not status: the overview links it and carries none
  // of its prose — that wall is what made the fleet page unreadable.
  assert.ok(!html.includes('Always dry-run destructive commands first'));
  assert.match(html, /href="learned\.html">Learned <span class="nav-count">1<\/span>/);
  const learned = fs.readFileSync(path.join(weaverHome(), 'learned.html'), 'utf8');
  assert.ok(learned.includes('Always dry-run destructive commands first'));
  assert.match(learned, /Shadow, unproven \(1\)/);
  assert.match(html, /href="printouts\/index\.html"[^>]*>Printouts/);
  const printoutHub = path.join(weaverHome(), 'printouts', 'index.html');
  assert.ok(fs.existsSync(printoutHub));
  assert.match(fs.readFileSync(printoutHub, 'utf8'), /No printout has been opened yet/);
  // Per-workstream pages exist so overview links resolve.
  assert.ok(fs.existsSync(path.join(workstreamDir('ws-one'), 'inspect.html')));
  assert.ok(fs.existsSync(path.join(workstreamDir('ws-two'), 'inspect.html')));
  // A fresh workstream's page renders empty sections honestly, not invented.
  const wsHtml = fs.readFileSync(path.join(workstreamDir('ws-one'), 'inspect.html'), 'utf8');
  assert.match(wsHtml, /No decisions recorded yet/);
  assert.match(wsHtml, /No deliverables produced yet/);
  assert.match(wsHtml, /No real-world actions/);
  assert.match(wsHtml, /href="\.\.\/printouts\/index\.html#ws-one"[^>]*>Printouts/);

  // No workstreams at all is still an honest page, and so is an empty store.
  freshHome();
  const emptyHtml = renderOverviewHtml([], (await loadPolicies()).policies);
  assert.match(emptyHtml, /No workstreams under this WEAVER_HOME/);
  assert.match(renderLearnedHtml([]), /No learned policies/);
});

test('rendered HTML is redacted: a known secret value never reaches the file', async () => {
  await makeWorkstream();
  // The value lands in state BEFORE the secret is known (so the store-side
  // assertNoSecretValues guard could not have caught it) — the inspector's
  // own redaction lens must still scrub it.
  await arrive('inspect-ws', (d) => {
    d.decisions.push({
      id: 'dec_leak1',
      title: 'Use the staging token',
      rationale: 'token tok-verysecret9 works on staging',
      madeBy: 'coordinator',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  setSecret('STAGING_TOKEN', 'tok-verysecret9', 'inspect-ws');

  const out = await runInspect('inspect-ws');
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(!html.includes('tok-verysecret9'));
  assert.ok(html.includes('«secret:STAGING_TOKEN»'));

  // The pure renderer (pre-redaction) is what would have leaked — proving the
  // redaction step is load-bearing, not incidental.
  const raw = renderWorkstreamHtml(await load('inspect-ws'), []);
  assert.ok(raw.includes('tok-verysecret9'));
});

test('entering at one workstream still generates the fleet page its back link points to', async () => {
  // The dashboard's [i] on a selected stream lands here directly, so this page
  // is an entry point, not only a click-through from the overview.
  await makeWorkstream('ws-one');
  await makeWorkstream('ws-two');

  const out = await runInspect('ws-one');
  assert.equal(out, path.join(workstreamDir('ws-one'), 'inspect.html'));
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /href="\.\.\/inspect\.html"/);

  // …and the target of that link exists, listing both workstreams.
  const overview = path.join(weaverHome(), 'inspect.html');
  assert.ok(fs.existsSync(overview));
  const overviewHtml = fs.readFileSync(overview, 'utf8');
  assert.match(overviewHtml, /href="ws-one\/inspect\.html"/);
  assert.match(overviewHtml, /href="ws-two\/inspect\.html"/);
});

test('one unreadable workstream does not blank the others; it is named, not dropped', async () => {
  await makeWorkstream('ws-good');
  await makeWorkstream('ws-broken');
  fs.writeFileSync(path.join(workstreamDir('ws-broken'), 'workstream.json'), '{ not json');

  const out = await runInspect();
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /href="ws-good\/inspect\.html"/);
  assert.match(html, /Unreadable, no page generated/);
  assert.match(html, /ws-broken/);
  assert.ok(fs.existsSync(path.join(workstreamDir('ws-good'), 'inspect.html')));

  // Asking for the broken one by name is still a loud failure, not an empty page.
  await assert.rejects(runInspect('ws-broken'));
});

test('escaping: state text cannot inject markup into the page', async () => {
  await makeWorkstream();
  await arrive('inspect-ws', (d) => {
    d.decisions.push({
      id: newId('dec'),
      title: '<script>alert(1)</script>',
      rationale: 'contains <b>markup</b> & "quotes"',
      madeBy: 'coordinator',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  const html = renderWorkstreamHtml(await load('inspect-ws'), []);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // The click-detail JSON block must not be terminated early by state text.
  assert.ok(!/<script type="application\/json"[^>]*>[^<]*<script>/.test(html));
});

// ---------------------------------------------------------------------------
// The five questions on the fleet page.

/** A policy record built directly: the renderers are pure over typed state, so
 * grouping is provable without driving the whole learning loop to reach a
 * status. Statuses and evidence are exactly what the store would hold. */
function policyFixture(over: Partial<PolicyRecord> & Pick<PolicyRecord, 'id' | 'statement'>): PolicyRecord {
  return {
    scope: { tags: ['erdo'] },
    effect: { kind: 'advisory', description: 'advises' },
    widensAuthority: false,
    status: 'shadow',
    provenance: { source: 'seed', ref: 'a-teammate', interventionSummary: 'seeded practice' },
    evidence: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function evidenceFixture(workstreamSlug: string, at = '2026-02-01T00:00:00.000Z') {
  return { workstreamSlug, passId: 'pass_e', note: 'held up', interventionFree: true, at };
}

test('the policy store is rows, not prose: one line per policy, the record in the fold, long tails collapsed', () => {
  const active = policyFixture({
    id: 'pol_active',
    statement: 'Confirm CI is green before merging',
    status: 'active',
    evidence: [
      evidenceFixture('ws-a'),
      { workstreamSlug: 'ws-b', passId: 'pass_e', note: 'needed a human save', interventionFree: false, at: '2026-02-02T00:00:00.000Z' },
    ],
  });
  const provenShadow = policyFixture({
    id: 'pol_proven',
    statement: 'Read the provider back after an unknown send',
    evidence: [evidenceFixture('ws-c')],
  });
  const unproven = policyFixture({ id: 'pol_unproven', statement: 'Name the dataset a read is for' });
  const retired = policyFixture({
    id: 'pol_retired',
    statement: 'The rule that got replaced',
    status: 'superseded',
    supersededBy: 'pol_active',
  });
  const html = renderLearnedHtml([unproven, retired, provenShadow, active]);

  // The header reconciles with the groups below it, computed not asserted-by-hand.
  assert.match(html, /1 active · 2 shadow \(2 unproven\) · 1 superseded/);
  assert.match(html, /4 advisory/);

  // Every policy is exactly one collapsed row; nothing renders as an open card.
  assert.equal(html.match(/class="row policy"/g)?.length, 4, 'one row per policy, all four');
  assert.ok(html.includes('pol_active'));
  assert.ok(html.includes('pol_unproven'), 'the fold keeps the full record, id included');

  // The row's summary tallies the evidence; the narrative folds one level down.
  assert.match(html, /1 clean<\/span> · <span class="warn">1 intervened/);
  assert.match(html, /<details class="evd"><summary>[^<]*<span class="ok">✓ intervention-free<\/span> · ws-a/);
  assert.ok(html.indexOf('held up') > html.indexOf('✓ intervention-free'), 'the narrative sits behind the verdict, not beside it');

  // Active is rendered apart from, and ahead of, the shadow groups.
  assert.ok(html.indexOf('Active (1)') < html.indexOf('Shadow, with evidence (1)'));
  assert.ok(html.indexOf('Shadow, with evidence (1)') < html.indexOf('Shadow, unproven (1)'));

  // The unproven statement is present — inside the collapsed group, after it.
  assert.ok(html.includes('Name the dataset a read is for'));
  assert.ok(html.indexOf('Shadow, unproven (1)') < html.indexOf('Name the dataset a read is for'));
  assert.match(html, /<details><summary>Shadow, unproven \(1\)<\/summary>/);

  // Superseded keeps its lineage, collapsed.
  assert.match(html, /<details><summary>Superseded \(1\)<\/summary>/);
  assert.ok(html.includes('superseded by <code>pol_active</code>'));

  // Contested policies are their own group, whatever their status.
  const contestedHtml = renderLearnedHtml([
    policyFixture({
      id: 'pol_contested',
      statement: 'A rule a human pushed back on',
      contested: { at: '2026-03-01T00:00:00.000Z', workstreamSlug: 'ws-d', note: 'needed a correction anyway' },
    }),
  ]);
  assert.match(contestedHtml, /Contested \(1\)/);
  assert.ok(contestedHtml.includes('pol_contested'));
});

test('a workstream page shows the policies that shaped IT, not everything sharing a tag', async () => {
  await makeWorkstream('scoped-ws');
  await arrive('scoped-ws', (d) => {
    d.decisions.push({
      id: 'dec_cite',
      title: 'apply the cited policy',
      rationale: 'it fits',
      madeBy: 'coordinator',
      passId: 'pass_1',
      status: 'standing',
      appliedPolicyIds: ['pol_applied'],
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  const doc = await load('scoped-ws');
  // The doc's tags are ['hiring'] (makeWorkstream), so a tag-only match is the
  // case that used to put 351 of 371 policies on every page.
  const tagOnly = policyFixture({
    id: 'pol_tagonly',
    statement: 'A rule that merely shares this stream tag',
    scope: { tags: ['hiring'] },
  });
  const learnedHere = policyFixture({
    id: 'pol_learned',
    statement: 'A rule this stream taught the fleet',
    provenance: { workstreamSlug: 'scoped-ws', passId: 'pass_1', interventionSummary: 'a correction here' },
  });
  const evidencedHere = policyFixture({
    id: 'pol_evidenced',
    statement: 'A rule this stream held up',
    evidence: [evidenceFixture('scoped-ws')],
  });
  const appliedHere = policyFixture({ id: 'pol_applied', statement: 'A rule a decision here cited' });
  const html = renderWorkstreamHtml(doc, [tagOnly, learnedHere, evidencedHere, appliedHere]);

  assert.match(html, /Policies in play here/);
  assert.ok(html.includes('pol_learned'), 'learned here');
  assert.ok(html.includes('pol_evidenced'), 'evidenced here');
  assert.ok(html.includes('pol_applied'), 'cited by a decision here');
  assert.ok(!html.includes('pol_tagonly'), 'a shared tag is not evidence this stream was shaped by it');
  // The wider, tag-scoped store stays one click away, with its real total.
  assert.match(html, /href="\.\.\/learned\.html">Full policy store \(4\)/);

  // A stream nothing has shaped yet says so, rather than borrowing the fleet's.
  await makeWorkstream('untouched-ws');
  const untouched = renderWorkstreamHtml(await load('untouched-ws'), [tagOnly, learnedHere]);
  assert.match(untouched, /No policy has been learned here, applied here, or evidenced here yet/);
});

test('since you left: the window opens at the previous generation, and a first visit says so', async () => {
  await makeWorkstream('since-ws');
  const before = '2026-05-01T00:00:00.000Z';
  const stamp = '2026-05-02T00:00:00.000Z';
  const after = '2026-05-03T00:00:00.000Z';
  await arrive('since-ws', (d) => {
    d.decisions.push(
      {
        id: 'dec_before',
        title: 'The course you already knew about',
        rationale: 'decided while you were watching',
        madeBy: 'coordinator',
        status: 'superseded',
        decidedAtVirtual: before,
      },
      {
        id: 'dec_after',
        title: 'The course that changed while you were away',
        rationale: 'decided after you left',
        madeBy: 'coordinator',
        status: 'standing',
        decidedAtVirtual: after,
      },
    );
  });
  const docs = [await load('since-ws')];
  const viewed: InspectViewed = { schemaVersion: 1, wallAt: stamp, virtualAt: stamp };
  const oldPolicy = policyFixture({ id: 'pol_old', statement: 'Known before you left', createdAt: before });
  const newPolicy = policyFixture({ id: 'pol_new', statement: 'Learned while you were away', createdAt: after });

  // Scoped to the section: the policy store below legitimately lists every
  // policy ever learned, so "not in the window" means not in THIS section.
  const sinceSection = (page: string): string => {
    const from = page.indexOf('<h2>Since you left</h2>');
    assert.notEqual(from, -1, 'the page has a since-you-left section');
    return page.slice(from, page.indexOf('</section>', from));
  };
  const since = sinceSection(renderOverviewHtml(docs, [oldPolicy, newPolicy], [], viewed));
  assert.ok(since.includes('The course that changed while you were away'));
  assert.ok(!since.includes('The course you already knew about'), 'the window has a left edge');
  assert.match(since, /Decisions made \(1\)/);
  assert.match(since, /New policies \(1\)/);
  assert.ok(since.includes('Learned while you were away'));
  assert.ok(!since.includes('Known before you left'));

  // No stamp at all is honest about being the first look, never "nothing changed".
  const first = renderOverviewHtml(docs, [oldPolicy, newPolicy], [], null);
  assert.match(first, /First visit — the next generation will know what changed/);
  assert.ok(!first.includes('The course that changed while you were away'));

  // A stamp with nothing after it says exactly that.
  const quiet = renderOverviewHtml(docs, [], [], { schemaVersion: 1, wallAt: after, virtualAt: after });
  assert.match(quiet, /Nothing has changed since you last looked/);
});

test('the fleet page leads with what needs a person, most urgent first', async () => {
  await makeWorkstream('needy-ws');
  await arrive('needy-ws', (d) => {
    d.attention.push(
      {
        id: 'att_review',
        kind: 'review',
        summary: 'review the draft plan',
        status: 'open',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'att_block',
        kind: 'blocker',
        summary: 'the repo has a colliding open PR',
        status: 'open',
        createdAt: '2026-06-03T00:00:00.000Z',
      },
      {
        id: 'att_resolved',
        kind: 'blocker',
        summary: 'already dealt with',
        status: 'resolved',
        createdAt: '2026-06-02T00:00:00.000Z',
      },
    );
    d.assignments.push({
      id: 'asg_gated',
      objective: 'push the branch',
      briefing: 'b',
      kind: 'action',
      exec: { cwd: '/tmp', verify: 'git log -1', ask: 'push the fix branch to origin' },
      acceptanceCriteria: [],
      dependsOn: [],
      state: 'gated',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: '2026-06-02T00:00:00.000Z',
    });
  });
  const html = renderOverviewHtml([await load('needy-ws')], []);

  assert.match(html, /Needs you <span class="count">3<\/span>/);
  assert.ok(html.indexOf('the repo has a colliding open PR') < html.indexOf('push the fix branch to origin'));
  assert.ok(html.indexOf('push the fix branch to origin') < html.indexOf('review the draft plan'));
  assert.ok(!html.includes('already dealt with'), 'a resolved item is not waiting for anyone');
  // The fleet row reflects the same count and wears the state word for it.
  assert.match(html, /<td class="state">needs you<\/td>\n<td>3<\/td>/);

  // Nothing open is stated plainly rather than left as an empty table.
  await makeWorkstream('calm-ws');
  assert.match(renderOverviewHtml([await load('calm-ws')], []), /Nothing needs you\./);
});

test('the fleet table replaces the card wall: one row per stream, done streams collapsed', async () => {
  await makeWorkstream('live-ws');
  await makeWorkstream('finished-ws');
  await arrive('live-ws', (d) => {
    d.wakes.push({
      id: 'wake_1',
      reason: 'check the deploy has landed',
      condition: { type: 'time', dueAtVirtual: new Date(virtualNow().getTime() + 7_200_000).toISOString() },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  });
  await arrive('finished-ws', (d) => {
    d.workstream.status = 'done';
    d.workstream.conclusion = {
      passId: 'pass_9',
      atVirtual: '2026-07-01T00:00:00.000Z',
      summary: 'shipped',
      evidenceIds: ['dec_1'],
    };
  });
  const html = renderOverviewHtml([await load('live-ws'), await load('finished-ws')], []);

  assert.match(html, /<h2>Fleet <span class="count">1 live · 1 done<\/span><\/h2>/);
  assert.match(html, /waiting · in 2h — check the deploy has landed/);
  assert.match(html, /<details><summary>Done \(1\)<\/summary>/);
  // The done stream is inside the collapsed group, not on the live table.
  assert.ok(html.indexOf('Done (1)') < html.indexOf('finished-ws/inspect.html'));
  // Both pages remain reachable, and an unreadable slug is still named.
  assert.match(html, /href="live-ws\/inspect\.html"/);
  const withBroken = renderOverviewHtml([await load('live-ws')], [], ['ws-broken']);
  assert.match(withBroken, /Unreadable, no page generated/);
});

test('the viewed stamp round-trips, tolerates damage, and is written only after the pages are', async () => {
  assert.equal(readInspectViewed(), null, 'no stamp before the first look');

  const written = writeInspectViewed();
  const readBack = readInspectViewed();
  assert.deepEqual(readBack, written);
  assert.equal(readBack!.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(readBack!.wallAt)));
  assert.ok(Number.isFinite(Date.parse(readBack!.virtualAt)));

  // Anything unusable reads as "we don't know when you last looked" — which
  // renders the honest first-visit line, never a false "nothing changed".
  fs.writeFileSync(inspectViewedPath(), '{ not json');
  assert.equal(readInspectViewed(), null);
  fs.writeFileSync(inspectViewedPath(), JSON.stringify({ schemaVersion: 2, wallAt: 'x', virtualAt: 'y' }));
  assert.equal(readInspectViewed(), null);
  fs.writeFileSync(inspectViewedPath(), JSON.stringify({ schemaVersion: 1, wallAt: 'not-a-date', virtualAt: 'nope' }));
  assert.equal(readInspectViewed(), null);

  // End to end: generating the pages IS the human look, so the first run reads
  // no stamp and the second one reads the first run's.
  fs.rmSync(inspectViewedPath());
  await makeWorkstream('stamped-ws');
  const first = fs.readFileSync(await runInspect(), 'utf8');
  assert.match(first, /First visit — the next generation will know what changed/);
  assert.ok(readInspectViewed(), 'the generation stamped itself');
  const second = fs.readFileSync(await runInspect(), 'utf8');
  assert.match(second, /Nothing has changed since you last looked/);
});

test('passIntegrityWarnings flags a completed pass that has no summary', () => {
  const doc = {
    passes: [
      { id: 'pass_ok', outcome: 'completed', summary: 'did the thing', startedAt: '', baseRevision: 1, wakeReasons: [], changes: [] },
      { id: 'pass_bad', outcome: 'completed', startedAt: '', baseRevision: 1, wakeReasons: [], changes: [] },
      { id: 'pass_conf', outcome: 'conflicted', startedAt: '', baseRevision: 1, wakeReasons: [], changes: [] },
    ],
  } as unknown as Parameters<typeof passIntegrityWarnings>[0];
  const warnings = passIntegrityWarnings(doc);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /pass_bad: completed without a summary/);
});

test('a long decision history answers with the standing course first; the graph folds but keeps every node', async () => {
  await makeWorkstream('long-lineage-ws');
  await arrive('long-lineage-ws', (d) => {
    for (let i = 0; i < 17; i++) {
      d.decisions.push({
        id: `dec_${i}`,
        title: i === 16 ? 'The current heading' : `Course ${i}`,
        rationale: 'r',
        madeBy: 'coordinator',
        passId: 'pass_1',
        status: i === 16 ? 'standing' : 'superseded',
        ...(i < 16 ? { supersededBy: `dec_${i + 1}` } : {}),
        ...(i > 0 ? { supersedes: `dec_${i - 1}` } : {}),
        decidedAtVirtual: virtualNow().toISOString(),
      });
    }
  });
  const html = renderWorkstreamHtml(await load('long-lineage-ws'), []);
  assert.match(html, /Current course \(1\)/);
  assert.ok(html.includes('The current heading'), 'the standing decision reads as text, before any graph');
  assert.match(html, /<details><summary>Full lineage graph \(17 decisions\)<\/summary>/);
  assert.ok(html.includes('dec_0'), 'the fold keeps every node — nothing leaves the record');

  // A short history keeps its graph in the open, where it reads best.
  await makeWorkstream('short-lineage-ws');
  await arrive('short-lineage-ws', (d) => {
    d.decisions.push({
      id: 'dec_only',
      title: 'One decision',
      rationale: 'r',
      madeBy: 'human',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  const short = renderWorkstreamHtml(await load('short-lineage-ws'), []);
  assert.ok(!short.includes('Full lineage graph'), 'a small graph never folds');
});

test('deliverables read newest first and fold after a screenful, complete', async () => {
  await makeWorkstream('dels-ws');
  await arrive('dels-ws', (d) => {
    for (let i = 0; i < 12; i++) {
      d.deliverables.push({
        id: `del_${i}`,
        title: `Evidence ${i}`,
        kind: 'document',
        path: `a${i}.md`,
        contentHash: `hash${i}`,
        producedByAssignment: `asg_${i}`,
        createdAtVirtual: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        adopted: {
          contentHash: `hash${i}`,
          passId: 'pass_1',
          atVirtual: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        },
      });
    }
  });
  const html = renderWorkstreamHtml(await load('dels-ws'), []);
  assert.match(html, /Older adopted \(2\)/);
  assert.ok(html.includes('del_0'), 'the fold keeps the oldest rows, nothing truncated away');
  assert.ok(html.indexOf('del_11') < html.indexOf('del_9'), 'newest adopted first');
  assert.ok(html.indexOf('Older adopted (2)') < html.indexOf('del_1</code>'), 'the two oldest sit inside the fold');
});

test('the actions audit keeps motion in the open and folds settled history after a screenful', async () => {
  await makeWorkstream('actions-ws');
  await arrive('actions-ws', (d) => {
    d.assignments.push({
      id: 'asg_gated',
      objective: 'a consequential act awaiting a person',
      briefing: 'gated briefing text',
      kind: 'action',
      acceptanceCriteria: [],
      dependsOn: [],
      state: 'gated',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    });
    for (let i = 0; i < 12; i++) {
      d.assignments.push({
        id: `asg_done_${i}`,
        objective: `settled act ${i}`,
        briefing: `briefing ${i}`,
        kind: 'action',
        acceptanceCriteria: [],
        dependsOn: [],
        state: 'completed',
        attempts: [],
        adoption: { state: 'accepted' },
        createdAtVirtual: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
  });
  const html = renderWorkstreamHtml(await load('actions-ws'), []);
  // A worker briefing is context, not the approved act: it folds per card.
  assert.match(html, /<details><summary>full worker briefing<\/summary>/);
  // 12 settled acts: ten stay in the open, the two oldest fold — complete.
  assert.match(html, /Older actions \(2\)/);
  assert.ok(html.includes('asg_done_0'), 'the fold holds the full card, nothing truncated away');
  // In motion outranks settled, and settled reads newest first.
  assert.ok(html.indexOf('asg_gated') < html.indexOf('asg_done_11'), 'gated first');
  assert.ok(html.indexOf('asg_done_11') < html.indexOf('asg_done_9'), 'newest settled first');
});
