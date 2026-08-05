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

import { runInspect, renderOverviewHtml, renderWorkstreamHtml } from './inspect.js';
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
function populate(slug: string): void {
  const { relPath, hash } = writeArtifact(slug, 'draft.md', 'adopted draft content');
  const cand = writeArtifact(slug, 'cand.md', 'candidate content');
  arrive(slug, (d, event) => {
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

test('inspect on a synthetic doc renders lineage, adoption, actions, and interventions', () => {
  makeWorkstream();
  populate('inspect-ws');
  const pol = proposePolicy({
    statement: 'Verify candidate email addresses before drafting outreach',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'adds an email-verification step',
    workstreamSlug: 'inspect-ws',
    passId: 'pass_1',
    interventionSummary: 'human corrected an unverified address',
  });
  recordPolicyOutcome({
    policyId: pol.id,
    workstreamSlug: 'other-ws',
    passId: 'pass_9',
    note: 'applied cleanly',
    interventionFree: true,
  });

  const out = runInspect('inspect-ws');
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
  const doc = load('inspect-ws');
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

test('overview renders all workstreams and the global policy store; empty sections are honest', () => {
  makeWorkstream('ws-one');
  makeWorkstream('ws-two');
  const pol = proposePolicy({
    statement: 'Always dry-run destructive commands first',
    tags: ['ops'],
    effectKind: 'advisory',
    effectDescription: 'advises a dry run',
    workstreamSlug: 'ws-one',
    passId: 'pass_1',
    interventionSummary: 'human caught a destructive command',
  });

  const out = runInspect();
  assert.equal(out, path.join(weaverHome(), 'inspect.html'));
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /ws-one/);
  assert.match(html, /ws-two/);
  assert.ok(html.includes(pol.id));
  // Per-workstream pages exist so overview links resolve.
  assert.ok(fs.existsSync(path.join(workstreamDir('ws-one'), 'inspect.html')));
  assert.ok(fs.existsSync(path.join(workstreamDir('ws-two'), 'inspect.html')));
  // A fresh workstream's page renders empty sections honestly, not invented.
  const wsHtml = fs.readFileSync(path.join(workstreamDir('ws-one'), 'inspect.html'), 'utf8');
  assert.match(wsHtml, /No decisions recorded yet/);
  assert.match(wsHtml, /No deliverables produced yet/);
  assert.match(wsHtml, /No real-world actions/);

  // No workstreams at all is still an honest page.
  freshHome();
  const emptyHtml = renderOverviewHtml([], loadPolicies().policies);
  assert.match(emptyHtml, /No workstreams under this WEAVER_HOME/);
  assert.match(emptyHtml, /No learned policies/);
});

test('rendered HTML is redacted: a known secret value never reaches the file', () => {
  makeWorkstream();
  // The value lands in state BEFORE the secret is known (so the store-side
  // assertNoSecretValues guard could not have caught it) — the inspector's
  // own redaction lens must still scrub it.
  arrive('inspect-ws', (d) => {
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

  const out = runInspect('inspect-ws');
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(!html.includes('tok-verysecret9'));
  assert.ok(html.includes('«secret:STAGING_TOKEN»'));

  // The pure renderer (pre-redaction) is what would have leaked — proving the
  // redaction step is load-bearing, not incidental.
  const raw = renderWorkstreamHtml(load('inspect-ws'), []);
  assert.ok(raw.includes('tok-verysecret9'));
});

test('entering at one workstream still generates the fleet page its back link points to', () => {
  // The dashboard's [i] on a selected stream lands here directly, so this page
  // is an entry point, not only a click-through from the overview.
  makeWorkstream('ws-one');
  makeWorkstream('ws-two');

  const out = runInspect('ws-one');
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

test('one unreadable workstream does not blank the others; it is named, not dropped', () => {
  makeWorkstream('ws-good');
  makeWorkstream('ws-broken');
  fs.writeFileSync(path.join(workstreamDir('ws-broken'), 'workstream.json'), '{ not json');

  const out = runInspect();
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /href="ws-good\/inspect\.html"/);
  assert.match(html, /Unreadable, no page generated/);
  assert.match(html, /ws-broken/);
  assert.ok(fs.existsSync(path.join(workstreamDir('ws-good'), 'inspect.html')));

  // Asking for the broken one by name is still a loud failure, not an empty page.
  assert.throws(() => runInspect('ws-broken'));
});

test('escaping: state text cannot inject markup into the page', () => {
  makeWorkstream();
  arrive('inspect-ws', (d) => {
    d.decisions.push({
      id: newId('dec'),
      title: '<script>alert(1)</script>',
      rationale: 'contains <b>markup</b> & "quotes"',
      madeBy: 'coordinator',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  const html = renderWorkstreamHtml(load('inspect-ws'), []);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  // The click-detail JSON block must not be terminated early by state text.
  assert.ok(!/<script type="application\/json"[^>]*>[^<]*<script>/.test(html));
});
