import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createWorkstream, arrive, load } from './store.js';
import { virtualNow } from './clock.js';
import type { Assignment } from './types.js';
import { probeWorkstreamPrConflicts, prConflictToken, sweepPrConflicts, type PrConflictIO } from './prConflicts.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-prconflict-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function makeEgressWorkstream(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'test PR conflict watch',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive(slug, (d) => {
    d.assignments.push({
      id: 'asg_pr',
      objective: 'open the PR',
      briefing: 'n/a',
      kind: 'action',
      exec: {
        cwd: '/tmp/some-worktree',
        verify: "gh pr list --head feat/x --state open --json headRefOid --jq '.[0].headRefOid'",
        approval: { by: 'human', at: new Date().toISOString() },
        verified: { ok: true, output: 'abc', at: new Date().toISOString() },
      },
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'awaiting_review',
      attempts: [{ runId: 'run_1', model: 'sonnet', startedAt: new Date().toISOString() }],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    } as Assignment);
  });
}

function io(mergeable: string, headRefOid = 'deadbeefcafe'): PrConflictIO {
  return {
    branchOf: () => 'feat/x',
    openPrForBranch: () => ({ number: 77, headRefOid, mergeable }),
  };
}

test('a CONFLICTING PR wakes its owning stream exactly once per head', async () => {
  await makeEgressWorkstream('pr-conflict-ws');
  assert.equal(await probeWorkstreamPrConflicts('pr-conflict-ws', io('CONFLICTING')), 1);
  let doc = await load('pr-conflict-ws');
  const wake = doc.wakes.find((w) => w.reason.includes('PR #77'));
  assert.ok(wake, 'the stream is woken with the conflict fact');
  assert.equal(wake!.condition.type, 'immediate');
  assert.ok(doc.events.some((e) => e.type === 'pr.conflict_detected' && e.summary.includes(prConflictToken(77, 'deadbeefcafe'))));

  // Same head, still conflicting: no second wake — the fact is already known.
  assert.equal(await probeWorkstreamPrConflicts('pr-conflict-ws', io('CONFLICTING')), 0);
  doc = await load('pr-conflict-ws');
  assert.equal(doc.wakes.filter((w) => w.reason.includes('PR #77')).length, 1);

  // A rebase moved the head but it STILL conflicts: new information, one new wake.
  assert.equal(await probeWorkstreamPrConflicts('pr-conflict-ws', io('CONFLICTING', 'a1b2c3d4e5f6')), 1);
});

test('MERGEABLE and UNKNOWN mergeability wake nothing', async () => {
  await makeEgressWorkstream('pr-clean-ws');
  assert.equal(await probeWorkstreamPrConflicts('pr-clean-ws', io('MERGEABLE')), 0);
  assert.equal(await probeWorkstreamPrConflicts('pr-clean-ws', io('UNKNOWN')), 0);
  assert.equal((await load('pr-clean-ws')).wakes.length, 0);
});

test('unreadable checkouts and absent PRs fail open', async () => {
  await makeEgressWorkstream('pr-gone-ws');
  const dead: PrConflictIO = { branchOf: () => null, openPrForBranch: () => null };
  assert.equal(await probeWorkstreamPrConflicts('pr-gone-ws', dead), 0);
  const noPr: PrConflictIO = { branchOf: () => 'feat/x', openPrForBranch: () => null };
  assert.equal(await probeWorkstreamPrConflicts('pr-gone-ws', noPr), 0);
});

test('the sweep throttles per stream', async () => {
  await makeEgressWorkstream('pr-throttle-ws');
  let probes = 0;
  const counting: PrConflictIO = {
    branchOf: () => { probes++; return null; },
    openPrForBranch: () => null,
  };
  const state = new Map<string, number>();
  await sweepPrConflicts(state, () => {}, counting, 60_000);
  await sweepPrConflicts(state, () => {}, counting, 60_000);
  assert.equal(probes, 1, 'a second sweep inside the interval must not re-probe');
});
