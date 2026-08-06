/**
 * Deterministic learning-loop tests: scoped matching, earned promotion,
 * supersession lineage, and the structural no-widened-authority guarantee.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadPolicies,
  matchPolicies,
  proposePolicy,
  recordPolicyOutcome,
  supersedePolicy,
} from './policies.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
});

function propose(tags: string[] = ['hiring']) {
  return proposePolicy({
    statement: 'Company-specific claims in candidate-facing artifacts come only from principal-supplied facts',
    tags,
    effectKind: 'add_verification',
    effectDescription: 'Verify every company claim against the facts pack before adoption',
    workstreamSlug: 'ws-one',
    passId: 'pass_x',
    steeringId: 'steer_x',
    interventionSummary: 'Coordinator proposed derived claims; human required source-attributable facts only',
  });
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

test('promotion is earned: intervention-free evidence promotes shadow → active; corrected evidence does not', async () => {
  const p1 = await propose();
  await recordPolicyOutcome({
    policyId: p1.id,
    workstreamSlug: 'ws-two',
    passId: 'pass_y',
    note: 'applied, but the human still had to correct the same point',
    interventionFree: false,
  });
  assert.equal((await loadPolicies()).policies.find((x) => x.id === p1.id)!.status, 'shadow');

  const updated = await recordPolicyOutcome({
    policyId: p1.id,
    workstreamSlug: 'ws-three',
    passId: 'pass_z',
    note: 'applied; no correction needed on this point',
    interventionFree: true,
  });
  assert.equal(updated.status, 'active');
  assert.equal(updated.evidence.length, 2);
});

test('supersession keeps lineage and removes the old policy from matching', async () => {
  const p1 = await propose();
  const p2 = await supersedePolicy(p1.id, {
    statement: 'Principal-facing claims are verified against the facts pack AND enumerated for confirm-or-correct',
    tags: ['hiring'],
    effectKind: 'add_verification',
    effectDescription: 'Enumerate derived claims for principal confirmation',
    workstreamSlug: 'ws-four',
    passId: 'pass_w',
    interventionSummary: 'Original rule did not distinguish derived claims from fabricated ones',
  });
  const store = await loadPolicies();
  const old = store.policies.find((x) => x.id === p1.id)!;
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, p2.id);

  const matched = await matchPolicies(['hiring']);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.id, p2.id);
});

test('outcome evidence on a superseded policy is rejected', async () => {
  const p1 = await propose();
  await supersedePolicy(p1.id, {
    statement: 'replacement',
    tags: ['hiring'],
    effectKind: 'advisory',
    effectDescription: 'advice',
    workstreamSlug: 'ws',
    passId: 'p',
    interventionSummary: 's',
  });
  await assert.rejects(
    recordPolicyOutcome({
      policyId: p1.id,
      workstreamSlug: 'ws',
      passId: 'p',
      note: 'stale evidence',
      interventionFree: true,
    }),
  );
});

test('the effect vocabulary is closed: only verification, narrowing, or advice are representable', async () => {
  // Type-level guarantee exercised at runtime: the store never contains a
  // widening effect because no constructor accepts one.
  await propose();
  for (const p of (await loadPolicies()).policies) {
    assert.ok(['add_verification', 'narrow_authority', 'advisory'].includes(p.effect.kind));
    assert.equal(p.widensAuthority, false);
  }
});
