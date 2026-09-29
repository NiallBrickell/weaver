/**
 * The fleet-status model: one bucket per job, decided where the job card is
 * decided, grouped by fleetGlance, and rendered with the same numbers in the
 * board strip, the sidebar block, and the fleet notice.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { recordCapacityBackoff } from './capacity.js';
import { virtualNow } from './clock.js';
import { startOperatorUi, type RunningOperatorUi } from './operatorUi.js';
import { arrive, createWorkstream, heartbeatRunner, listWorkstreams, load } from './store.js';
import type { Assignment, InfrastructureWait, WorkstreamDoc } from './types.js';
import {
  FLEET_BUCKETS,
  fleetBoard,
  fleetGlance,
  fleetRunnerLine,
  type FleetBucket,
  type FleetGlanceView,
} from './ui/inspect/model.js';

const CAPACITY_ENV = {
  WEAVER_COORDINATOR_EXECUTOR: 'local-sdk',
  WEAVER_COORDINATOR_MODEL: 'claude-primary',
  WEAVER_COORDINATOR_FALLBACKS: 'codex-sdk:gpt-fallback',
  WEAVER_RUNNER_EXECUTORS: 'local-sdk,codex-sdk',
} as const;

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-fleet-glance-'));
  process.env.WEAVER_HOME = home;
  saved = Object.fromEntries(Object.keys(CAPACITY_ENV).map((name) => [name, process.env[name]]));
  Object.assign(process.env, CAPACITY_ENV);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function makeWorkstream(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: `Job ${slug}`,
    objective: `Deliver ${slug}`,
    tags: ['product'],
    successCriteria: ['A reviewer can verify the result'],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
}

function running(id: string): Assignment {
  return {
    id,
    objective: `Complete ${id}`,
    briefing: `Bounded brief for ${id}`,
    kind: 'work',
    acceptanceCriteria: [`Verify ${id}`],
    dependsOn: [],
    state: 'running',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: virtualNow().toISOString(),
  };
}

function primaryLimited(now: Date): InfrastructureWait {
  return {
    kind: 'rate_limit',
    recovery: 'automatic_retry',
    source: 'coordinator',
    sourceId: 'pass_primary',
    executor: 'local-sdk',
    provider: 'anthropic',
    model: 'claude-primary',
    detectedAt: now.toISOString(),
    retryAt: new Date(now.getTime() + 3_600_000).toISOString(),
  };
}

function limitPrimary(doc: WorkstreamDoc, now: Date): void {
  const wait = primaryLimited(now);
  recordCapacityBackoff(doc, wait);
  doc.wakes.push({
    id: `wake_${doc.workstream.slug}`,
    reason: 'Retry the primary coordinator',
    condition: { type: 'time', dueAtVirtual: wait.retryAt! },
    status: 'pending',
    createdAt: now.toISOString(),
    infrastructure: wait,
  });
}

function limitWholeChain(doc: WorkstreamDoc, now: Date): void {
  limitPrimary(doc, now);
  recordCapacityBackoff(doc, {
    ...primaryLimited(now),
    sourceId: 'pass_fallback',
    executor: 'codex-sdk',
    provider: 'openai',
    model: 'gpt-fallback',
    retryAt: new Date(now.getTime() + 1_800_000).toISOString(),
  });
}

/** One synthetic fleet with a job in every bucket, plus two precedence
 * edge cases (a running job on a fallback, an ask on a blocked job). */
async function seedFleet(now: Date): Promise<void> {
  const slugs = [
    'needs-you', 'needs-you-and-blocked', 'blocked', 'running-blocked', 'degraded',
    'running-degraded', 'working', 'waiting', 'paused', 'done-recent', 'done-old',
  ];
  for (const slug of slugs) await makeWorkstream(slug);
  const ask = (doc: WorkstreamDoc) => doc.attention.push({
    id: `att_${doc.workstream.slug}`, kind: 'review', summary: 'Choose the publication policy', status: 'open', createdAt: now.toISOString(),
  });
  await arrive('needs-you', ask);
  await arrive('needs-you-and-blocked', (doc) => { ask(doc); limitWholeChain(doc, now); });
  await arrive('blocked', (doc) => limitWholeChain(doc, now));
  await arrive('running-blocked', (doc) => { doc.assignments.push(running('asg_rb')); limitWholeChain(doc, now); });
  await arrive('degraded', (doc) => limitPrimary(doc, now));
  await arrive('running-degraded', (doc) => { doc.assignments.push(running('asg_rd')); limitPrimary(doc, now); });
  await arrive('working', (doc) => { doc.assignments.push(running('asg_w')); });
  await arrive('waiting', (doc) => {
    doc.wakes.push({
      id: 'wake_later', reason: 'Check back tomorrow',
      condition: { type: 'time', dueAtVirtual: new Date(now.getTime() + 86_400_000).toISOString() },
      status: 'pending', createdAt: now.toISOString(),
    });
  });
  await arrive('paused', (doc) => { doc.workstream.status = 'paused'; });
  await arrive('done-recent', (doc) => {
    doc.workstream.status = 'done';
    doc.workstream.conclusion = { passId: 'pass_r', atVirtual: new Date(now.getTime() - 2 * 86_400_000).toISOString(), summary: 'Shipped.', evidenceIds: [] };
  });
  await arrive('done-old', (doc) => {
    doc.workstream.status = 'done';
    doc.workstream.conclusion = { passId: 'pass_o', atVirtual: new Date(now.getTime() - 30 * 86_400_000).toISOString(), summary: 'Long ago.', evidenceIds: [] };
  });
}

const EXPECTED: Record<FleetBucket, string[]> = {
  'needs-you': ['needs-you', 'needs-you-and-blocked'],
  blocked: ['blocked', 'running-blocked'],
  degraded: ['degraded', 'running-degraded'],
  working: ['working'],
  waiting: ['waiting'],
  paused: ['paused'],
  done: ['done-recent'],
};

function bucketSlugs(glance: FleetGlanceView): Record<string, string[]> {
  return Object.fromEntries(glance.buckets.map((bucket) => [bucket.key, [...bucket.slugs].sort()]));
}

test('every job lands in exactly one bucket with needs-you > paused > blocked > degraded > working > waiting', async () => {
  const now = new Date();
  await seedFleet(now);
  const docs = await Promise.all((await listWorkstreams()).map((slug) => load(slug)));
  const board = fleetBoard(docs, [], new Map(), [], now, now);
  const glance = fleetGlance(board, fleetRunnerLine([], { state: 'running' }, now), now);

  assert.deepEqual(glance.buckets.map((bucket) => bucket.key), [...FLEET_BUCKETS]);
  assert.deepEqual(bucketSlugs(glance), EXPECTED);
  const counted = glance.buckets.filter((bucket) => bucket.key !== 'done').flatMap((bucket) => bucket.slugs);
  assert.equal(new Set(counted).size, counted.length, 'no active job is counted twice');
  assert.equal(counted.length, Object.values(board.lanes).flat().length, 'every active card is counted');

  // The card label never contradicts the bucket it was counted in.
  const card = (slug: string) => Object.values(board.lanes).flat().find((candidate) => candidate.slug === slug)!;
  assert.equal(card('degraded').state, 'On backup model');
  assert.equal(card('running-degraded').state, 'Working · on backup model');
  assert.equal(card('running-blocked').state, 'Working · next step blocked');
  assert.equal(card('blocked').state, 'Temporarily blocked');
  assert.equal(card('paused').state, 'Paused');

  assert.equal(glance.headline, '2 need you · 2 blocked · 2 on a backup model');
  assert.equal(glance.tone, 'warning');
});

test('an idle healthy fleet is all clear; degraded and stale runners are named with their reason', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');
  const emptyBoard = fleetBoard([], [], new Map(), [], now, now);
  const clear = fleetGlance(emptyBoard, fleetRunnerLine([{ runnerId: 'gcp', heartbeatAt: now.toISOString() }], undefined, now), now);
  assert.equal(clear.headline, 'All clear');
  assert.equal(clear.tone, 'healthy');
  assert.equal(clear.runners.summary, '1 runner online: gcp');

  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const runners = fleetRunnerLine([
    { runnerId: 'gcp', heartbeatAt: at(5_000) },
    { runnerId: 'gcp', heartbeatAt: at(90_000) },
    { runnerId: 'vm-full', heartbeatAt: at(2_000), degraded: 'state directory has 100 MiB free, under the 512 MiB floor' },
    { runnerId: 'mac', heartbeatAt: at(3_600_000) },
    { runnerId: 'retired-box', heartbeatAt: at(3 * 86_400_000) },
  ], undefined, now);
  assert.deepEqual(runners.healthy, ['gcp']);
  assert.deepEqual(runners.degraded, [{ id: 'vm-full', reason: 'state directory has 100 MiB free, under the 512 MiB floor' }]);
  assert.deepEqual(runners.stale.map((runner) => runner.id), ['mac']);
  assert.equal(runners.retired, 1);
  assert.equal(runners.tone, 'critical');
  assert.match(runners.summary, /^Runner vm-full has stopped taking jobs: state directory has 100 MiB free/);
  assert.match(runners.summary, /mac hasn't checked in for 1h$/);

  const degraded = fleetGlance(emptyBoard, runners, now);
  assert.equal(degraded.tone, 'critical');
  assert.equal(degraded.headline, '1 runner down · 1 runner not checking in');

  const none = fleetRunnerLine([], { state: 'offline' }, now);
  assert.equal(none.tone, 'warning');
  assert.equal(fleetGlance(emptyBoard, none, now).headline, 'No runner online');
  const stalled = fleetRunnerLine([], { state: 'stalled' }, now);
  assert.equal(stalled.tone, 'critical');
  assert.deepEqual(stalled.degraded.map((runner) => runner.id), ['local runner']);
});

let running_: RunningOperatorUi | undefined;
afterEach(async () => {
  await running_?.close();
  running_ = undefined;
});

function counts(html: string, prefix: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of html.matchAll(new RegExp(`data-testid="${prefix}-([a-z-]+)" data-count="(\\d+)"`, 'g'))) {
    found[match[1]!] = Number(match[2]);
  }
  return found;
}

test('the board strip, sidebar block, and fleet notice show the model counts, and ?state= filters the board', async () => {
  const now = new Date();
  await seedFleet(now);
  await heartbeatRunner('vm-full', now.toISOString(), undefined, 'state directory cannot commit');
  running_ = await startOperatorUi();
  const base = `http://127.0.0.1:${running_.port}`;

  const html = await (await fetch(`${base}/board`)).text();
  const expected = Object.fromEntries(Object.entries(EXPECTED).map(([key, slugs]) => [key, slugs.length]));
  assert.deepEqual(counts(html, 'fleet-bucket'), expected, 'every board tile renders its model count');
  const sidebar = Object.fromEntries(Object.entries(expected).filter(([, count]) => count > 0));
  assert.deepEqual(counts(html, 'sidebar-bucket'), sidebar, 'the sidebar shows the same non-empty counts');
  assert.match(html, /data-testid="fleet-status-headline"[^>]*>1 runner down · 2 need you · 2 blocked · 2 on a backup model</);
  assert.match(html, /data-testid="fleet-runner-line" data-tone="critical" role="alert"/);
  assert.match(html, /Runner vm-full has stopped taking jobs: state directory cannot commit/);
  assert.match(html, /data-testid="sidebar-runner-degraded"/);
  // The fleet notice counts come from the same model.
  assert.match(html, /2 jobs are blocked and can(&#x27;|')t continue right now\. 2 jobs are running on a backup model because the main model is limited\./);
  assert.match(html, /href="\/board\?state=degraded" data-inplace=""/);

  // The sidebar is on every page and links to the filtered board.
  const fleetPage = await (await fetch(`${base}/fleet`)).text();
  assert.deepEqual(counts(fleetPage, 'sidebar-bucket'), sidebar);
  assert.match(fleetPage, /data-testid="sidebar-bucket-degraded" data-count="2"/);

  const filtered = await (await fetch(`${base}/board?state=degraded`)).text();
  assert.match(filtered, /data-testid="board-filtered" data-filter="degraded"/);
  const shown = [...filtered.matchAll(/data-testid="board-workstream-([a-z-]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(shown, EXPECTED.degraded);
  assert.match(filtered, /Running on a backup model because the main model is limited/);
  assert.match(filtered, /data-testid="fleet-bucket-degraded"[^>]*aria-current="true"/);
  assert.match(filtered, /href="\/board" data-inplace="" data-testid="fleet-bucket-degraded"/, 'the active tile clears the filter');

  const done = await (await fetch(`${base}/board?state=done`)).text();
  assert.deepEqual([...done.matchAll(/data-testid="board-workstream-([a-z-]+)"/g)].map((match) => match[1]), ['done-recent']);

  for (const url of [`${base}/board?state=bogus`, `${base}/board`]) {
    const all = await (await fetch(url)).text();
    assert.doesNotMatch(all, /data-testid="board-filtered"/);
    assert.match(all, /data-testid="board-workstream-waiting"/);
    assert.match(all, /data-testid="board-workstream-needs-you"/);
  }
});

test('a runner going degraded changes the fleet revision so open boards refresh their counts', async () => {
  const { currentFleetRevision } = await import('./operatorUi.js');
  const now = new Date('2026-09-29T12:00:10.000Z');
  const heads = async () => [{ slug: 'alpha', revision: 3 }];
  const seat = { executor: 'local-sdk', provider: 'anthropic', model: 'claude-primary' };
  const healthy = await currentFleetRevision(heads, async () => [{ runnerId: 'gcp', heartbeatAt: now.toISOString(), coordinatorSeats: [seat] }], now, now);
  const degraded = await currentFleetRevision(heads, async () => [{ runnerId: 'gcp', heartbeatAt: now.toISOString(), coordinatorSeats: [seat], degraded: 'disk full' }], now, now);
  assert.notEqual(healthy, degraded);
});
