/**
 * Deterministic learning-loop tests: scoped matching, ATTRIBUTABLE and
 * CROSS-WORKSTREAM promotion, contested negative evidence, atomic supersession
 * lineage, the authority-text firewall on live proposals, legacy-row loading,
 * and the structural no-widened-authority guarantee. No model, no network.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  grantsAuthority,
  loadPolicies,
  matchPolicies,
  proposePolicy,
  recordPolicyOutcome,
  renderPoliciesForProjection,
  reviewClearPolicy,
  supersedePolicy,
  validatePolicyCitations,
} from './policies.js';
import { arrive, createWorkstream, mutatePolicies } from './store.js';
import { virtualNow } from './clock.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
});

function propose(tags: string[] = ['hiring'], slug = 'ws-one') {
  return proposePolicy({
    statement: 'Company-specific claims in candidate-facing artifacts come only from principal-supplied facts',
    tags,
    effectKind: 'add_verification',
    effectDescription: 'Verify every company claim against the facts pack before adoption',
    workstreamSlug: slug,
    passId: 'pass_x',
    steeringId: 'steer_x',
    interventionSummary: 'Coordinator proposed derived claims; human required source-attributable facts only',
  });
}

/** Create a workstream and a decision in it that CITES `policyId` — the real
 * applying decision an outcome must point at. Returns the decision id. */
async function citeInWorkstream(
  slug: string,
  policyId: string,
  opts: { tags?: string[]; decidedAtVirtual?: string } = {},
): Promise<string> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'o',
    tags: opts.tags ?? ['hiring'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });
  const decId = `dec_${slug}`;
  await arrive(slug, (d) => {
    d.decisions.push({
      id: decId,
      title: 'apply the policy',
      rationale: 'applied it',
      madeBy: 'coordinator',
      passId: `pass_${slug}`,
      status: 'standing',
      appliedPolicyIds: [policyId],
      decidedAtVirtual: opts.decidedAtVirtual ?? virtualNow().toISOString(),
    });
  });
  return decId;
}

function outcome(policyId: string, slug: string, decId: string, interventionFree: boolean) {
  return recordPolicyOutcome({
    policyId,
    workstreamSlug: slug,
    passId: `pass_${slug}`,
    applyingDecisionId: decId,
    note: interventionFree ? 'applied; no correction needed' : 'applied, but the human corrected the same point',
    interventionFree,
  });
}

async function statusOf(id: string): Promise<string> {
  return (await loadPolicies()).policies.find((x) => x.id === id)!.status;
}

test('a proposed policy starts in shadow and matches only workstreams sharing a tag', async () => {
  const p = await propose(['hiring', 'outreach']);
  assert.equal(p.status, 'shadow');
  assert.equal(p.widensAuthority, false);

  assert.equal((await matchPolicies(['hiring'])).length, 1);
  assert.equal((await matchPolicies(['outreach', 'unrelated'])).length, 1);
  assert.equal((await matchPolicies(['marketing'])).length, 0);
  assert.equal((await matchPolicies([])).length, 0);
});

test('promotion is cross-workstream: source-only intervention-free evidence stays shadow; a different workstream promotes exactly once', async () => {
  const p = await propose(['hiring'], 'ws-source');

  // Evidence from the SOURCE workstream — even intervention-free and cited —
  // keeps it shadow: a policy cannot certify itself on its own origin.
  const srcDec = await citeInWorkstream('ws-source', p.id);
  await outcome(p.id, 'ws-source', srcDec, true);
  assert.equal(await statusOf(p.id), 'shadow');

  // A DIFFERENT workstream's cited, intervention-free outcome promotes it.
  const otherDec = await citeInWorkstream('ws-other', p.id);
  const promoted = await outcome(p.id, 'ws-other', otherDec, true);
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.evidence.length, 2);

  // A third such outcome does not re-promote or otherwise change status.
  const thirdDec = await citeInWorkstream('ws-third', p.id);
  const again = await outcome(p.id, 'ws-third', thirdDec, true);
  assert.equal(again.status, 'active');
  assert.equal(again.evidence.length, 3);
});

test('a backfill policy (no source workstream) is promoted by any real cited outcome', async () => {
  // proposeBackfillPolicy → no source; the cross-workstream rule degrades to
  // "any workstream's cited intervention-free outcome qualifies".
  const { proposeBackfillPolicy } = await import('./policies.js');
  const p = await proposeBackfillPolicy({
    statement: 'Run the full test suite before adopting a code deliverable',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'require a green test run',
    source: 'seed',
    ref: 'team',
    interventionSummary: 'seeded',
  });
  const dec = await citeInWorkstream('ws-a', p.id);
  const promoted = await outcome(p.id, 'ws-a', dec, true);
  assert.equal(promoted.status, 'active');
});

test('evidence without a valid applying decision is rejected', async () => {
  const p = await propose(['hiring'], 'ws-src');
  await createWorkstream({
    slug: 'ws-apply',
    title: 'ws-apply',
    objective: 'o',
    tags: ['hiring'],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });

  // (a) No such decision id in the workstream.
  await assert.rejects(
    outcome(p.id, 'ws-apply', 'dec_nope', true),
    /no decision dec_nope/,
  );

  // (b) A decision exists but does not cite this policy.
  await arrive('ws-apply', (d) => {
    d.decisions.push({
      id: 'dec_uncited',
      title: 'unrelated',
      rationale: 'r',
      madeBy: 'coordinator',
      passId: 'pass_1',
      status: 'standing',
      decidedAtVirtual: virtualNow().toISOString(),
    });
  });
  await assert.rejects(
    outcome(p.id, 'ws-apply', 'dec_uncited', true),
    /does not cite policy/,
  );

  // (c) The cited decision post-dates the outcome (a future decision cannot
  // justify a past success).
  const future = new Date(virtualNow().getTime() + 60 * 60_000).toISOString();
  await arrive('ws-apply', (d) => {
    d.decisions.push({
      id: 'dec_future',
      title: 'future',
      rationale: 'r',
      madeBy: 'coordinator',
      passId: 'pass_2',
      status: 'standing',
      appliedPolicyIds: [p.id],
      decidedAtVirtual: future,
    });
  });
  await assert.rejects(
    outcome(p.id, 'ws-apply', 'dec_future', true),
    /post-dates this outcome/,
  );

  // None of the rejected attempts recorded evidence or promoted the policy.
  const stored = (await loadPolicies()).policies.find((x) => x.id === p.id)!;
  assert.equal(stored.evidence.length, 0);
  assert.equal(stored.status, 'shadow');
});

test('legacy evidence rows (no applyingDecisionId) load, are preserved, and never qualify a promotion', async () => {
  const p = await propose(['hiring'], 'ws-legacy-src');
  // Simulate a legacy row written before the integrity model — no
  // applyingDecisionId. It must load fine and stay on the record.
  await mutatePolicies((s) => {
    const rec = s.policies.find((x) => x.id === p.id)!;
    rec.evidence.push({
      workstreamSlug: 'ws-old',
      passId: 'pass_old',
      note: 'legacy intervention-free row from before attribution existed',
      interventionFree: true,
      at: new Date().toISOString(),
    });
  });
  const loaded = (await loadPolicies()).policies.find((x) => x.id === p.id)!;
  assert.equal(loaded.evidence.length, 1);
  assert.equal(loaded.evidence[0]!.applyingDecisionId, undefined);
  // The legacy positive row does NOT promote — it is unverifiable under the
  // new version. A fresh, cited, cross-workstream outcome still can.
  assert.equal(loaded.status, 'shadow');

  const dec = await citeInWorkstream('ws-new', p.id);
  const promoted = await outcome(p.id, 'ws-new', dec, true);
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.evidence.length, 2);
});

test('negative evidence contests an active policy and pulls it out of active projection guidance — without demoting', async () => {
  const p = await propose(['hiring'], 'ws-src2');
  // Promote it first (cross-workstream, cited).
  const dec = await citeInWorkstream('ws-promote', p.id);
  await outcome(p.id, 'ws-promote', dec, true);
  assert.equal(await statusOf(p.id), 'active');

  // Negative evidence from another workstream contests it.
  const negDec = await citeInWorkstream('ws-neg', p.id);
  const contested = await outcome(p.id, 'ws-neg', negDec, false);
  assert.equal(contested.status, 'active'); // NEVER auto-demoted
  assert.ok(contested.contested);
  assert.equal(contested.contested!.workstreamSlug, 'ws-neg');

  // Projection: it renders under the "under review" heading, not as guidance.
  const render = renderPoliciesForProjection((await loadPolicies()).policies);
  assert.match(render, /Contested — UNDER REVIEW/);
  assert.match(render, /CONTESTED in ws-neg/);

  // A human review-clear resolves it; positive evidence alone would not.
  const cleared = await reviewClearPolicy(p.id, 'situational, policy still sound');
  assert.equal(cleared.contested, undefined);
  const render2 = renderPoliciesForProjection((await loadPolicies()).policies);
  assert.doesNotMatch(render2, /UNDER REVIEW/);
});

test('negative evidence on a shadow policy contests it and blocks promotion until resolved', async () => {
  const p = await propose(['hiring'], 'ws-src3');
  const negDec = await citeInWorkstream('ws-neg2', p.id);
  await outcome(p.id, 'ws-neg2', negDec, false);
  assert.equal(await statusOf(p.id), 'shadow');

  // Even a good cross-workstream outcome cannot promote while contested.
  const goodDec = await citeInWorkstream('ws-good', p.id);
  await outcome(p.id, 'ws-good', goodDec, true);
  assert.equal(await statusOf(p.id), 'shadow');

  // Clear the contest, then a fresh good outcome promotes.
  await reviewClearPolicy(p.id, 'reviewed');
  const finalDec = await citeInWorkstream('ws-final', p.id);
  const promoted = await outcome(p.id, 'ws-final', finalDec, true);
  assert.equal(promoted.status, 'active');
});

test('citation validation: dangling, superseded, and scope-mismatched ids are rejected; a valid one passes', async () => {
  const p = await propose(['hiring'], 'ws-c');
  const policies = (await loadPolicies()).policies;

  assert.equal(validatePolicyCitations([p.id], policies, ['hiring']), null);
  assert.match(validatePolicyCitations(['pol_nope'], policies, ['hiring'])!, /no policy pol_nope/);
  assert.match(validatePolicyCitations([p.id], policies, ['finance'])!, /does not match/);

  // Superseded: its replacement must be cited instead.
  const rep = await supersedePolicy(p.id, {
    statement: 'Verify claims AND enumerate them for confirm-or-correct',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'enumerate derived claims',
    workstreamSlug: 'ws-c',
    passId: 'pass_c',
    interventionSummary: 'sharpened',
  });
  const after = (await loadPolicies()).policies;
  assert.match(validatePolicyCitations([p.id], after, ['hiring'])!, /is superseded by/);
  assert.equal(validatePolicyCitations([rep.id], after, ['hiring']), null);
});

test('supersession is one atomic mutation with symmetric lineage; rejects self, nonexistent, and superseded replacements', async () => {
  const p1 = await propose(['hiring'], 'ws-s');
  const p2 = await supersedePolicy(p1.id, {
    statement: 'Principal-facing claims are verified AND enumerated for confirm-or-correct',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'Enumerate derived claims for principal confirmation',
    workstreamSlug: 'ws-s',
    passId: 'pass_s',
    interventionSummary: 'Original rule did not distinguish derived from fabricated claims',
  });

  const store = await loadPolicies();
  const old = store.policies.find((x) => x.id === p1.id)!;
  const rep = store.policies.find((x) => x.id === p2.id)!;
  // Symmetric lineage, both sides written.
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, p2.id);
  assert.equal(rep.supersedes, p1.id);
  // Superseded policy leaves matching; replacement takes its place.
  const matched = await matchPolicies(['hiring']);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.id, p2.id);

  // Guards.
  await assert.rejects(supersedePolicy('pol_missing', { withExisting: p2.id }), /no policy pol_missing/);
  await assert.rejects(supersedePolicy(p2.id, { withExisting: p2.id }), /cannot supersede itself/);
  await assert.rejects(supersedePolicy(p2.id, { withExisting: 'pol_missing' }), /no replacement policy/);
  await assert.rejects(supersedePolicy(p2.id, { withExisting: p1.id }), /is itself superseded/);
});

test('supersede by linking an EXISTING replacement writes lineage without a new record', async () => {
  const p1 = await propose(['hiring'], 'ws-e1');
  const p2 = await proposePolicy({
    statement: 'A sharper, already-existing rule about claim verification',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'verify then enumerate',
    workstreamSlug: 'ws-e2',
    passId: 'pass_e2',
    interventionSummary: 'authored separately',
  });
  const before = (await loadPolicies()).policies.length;
  const linked = await supersedePolicy(p1.id, { withExisting: p2.id });
  const store = await loadPolicies();
  assert.equal(store.policies.length, before); // no new record
  assert.equal(linked.id, p2.id);
  assert.equal(store.policies.find((x) => x.id === p1.id)!.supersededBy, p2.id);
  assert.equal(store.policies.find((x) => x.id === p2.id)!.supersedes, p1.id);
});

test('outcome evidence on a superseded policy is rejected', async () => {
  const p1 = await propose(['hiring'], 'ws-sup');
  await supersedePolicy(p1.id, {
    statement: 'replacement rule that verifies before adopting',
    tags: ['hiring'],
    effectKind: 'advisory',
    effectDescription: 'advice',
    workstreamSlug: 'ws-sup',
    passId: 'pass_sup',
    interventionSummary: 's',
  });
  const dec = await citeInWorkstream('ws-late', p1.id);
  await assert.rejects(outcome(p1.id, 'ws-late', dec, true), /superseded/);
});

test('the live proposal path refuses grant-shaped statements, including "MAY merge ... only when"', async () => {
  // The exact case the old restricting-word escape missed.
  await assert.rejects(
    proposePolicy({
      statement: 'A workstream MAY merge its own PR into main only when CI is green',
      tags: ['hiring'],
      effectKind: 'advisory',
      effectDescription: 'x',
      workstreamSlug: 'ws-g',
      passId: 'pass_g',
      interventionSummary: 'i',
    }),
    /conferring authority/,
  );
  // Bare grant verb with no restricting language is also refused.
  await assert.rejects(
    proposePolicy({
      statement: 'Merge good-looking PRs and send the announcement yourself',
      tags: ['hiring'],
      effectKind: 'advisory',
      effectDescription: 'x',
      workstreamSlug: 'ws-g',
      passId: 'pass_g',
      interventionSummary: 'i',
    }),
    /conferring authority/,
  );
  // Advisory-under-an-existing-grant is allowed ("only merge after CI passes"
  // — no permission modal).
  const ok = await proposePolicy({
    statement: 'Only merge after CI passes and a second reviewer approves',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'gate the merge on CI + review',
    workstreamSlug: 'ws-g',
    passId: 'pass_g',
    interventionSummary: 'i',
  });
  assert.equal(ok.status, 'shadow');
});

test('grantsAuthority lexical gate: permission modals refuse even when hedged with "only"', () => {
  assert.equal(grantsAuthority('The workstream MAY merge its own PR only when CI is green'), true);
  assert.equal(grantsAuthority('Reviewers are allowed to deploy to prod once approved'), true);
  assert.equal(grantsAuthority('Feel free to merge good-looking PRs yourself'), true);
  // Advises under an existing grant — not a conferral.
  assert.equal(grantsAuthority('Only merge after CI passes'), false);
  assert.equal(grantsAuthority('Never deploy on a Friday'), false);
  // No grant verb at all.
  assert.equal(grantsAuthority('Always run the full test suite before pushing'), false);
});

test('the effect vocabulary is closed: only verification, narrowing, or advice are representable', async () => {
  await propose();
  for (const p of (await loadPolicies()).policies) {
    assert.ok(['add_verification', 'narrow_authority', 'advisory'].includes(p.effect.kind));
    assert.equal(p.widensAuthority, false);
  }
});
