import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CAPACITY_RECOVERED_ACTOR,
  READBACK_ACTOR,
  capacitySuccessIndex,
  liveAttentionReadbackIO,
  parseExternalFacts,
  readbackIntervalMs,
  sweepAttentionReadbacks,
  type AttentionReadbackIO,
  type PrStateReadback,
} from './attentionReadback.js';
import { virtualNow } from './clock.js';
import { arrive, createWorkstream, load } from './store.js';
import type { AttentionItem, ExternalFact, InfrastructureWait, WorkstreamDoc } from './types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-attention-readback-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;
const PR_FACT: ExternalFact = { kind: 'github_pr_state', repo: 'erdoai/erdo', number: 2686, states: ['MERGED', 'CLOSED'] };
const SENTRY_FACT: ExternalFact = { kind: 'sentry_issue_status', org: 'erdo', shortId: 'GO-ZX', statuses: ['resolved', 'ignored'] };

async function stream(slug: string, status: 'active' | 'paused' | 'done' = 'active'): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'test needs-you readback',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  if (status !== 'active') await arrive(slug, (d) => { d.workstream.status = status; });
}

async function raise(slug: string, item: Partial<AttentionItem> & { id: string }): Promise<void> {
  await arrive(slug, (d) => {
    d.attention.push({
      kind: 'blocker',
      summary: `card ${item.id}`,
      status: 'open',
      createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      ...item,
    });
  });
}

async function cache(...slugs: string[]): Promise<Map<string, WorkstreamDoc>> {
  const out = new Map<string, WorkstreamDoc>();
  for (const slug of slugs) out.set(slug, await load(slug));
  return out;
}

function prIO(state: PrStateReadback['state'] | 'throw' | 'null', calls: string[] = []): AttentionReadbackIO {
  return {
    async githubPrStates(repo, numbers) {
      calls.push(`gh ${repo} ${numbers.join(',')}`);
      if (state === 'throw') throw new Error('network down');
      if (state === 'null') return null;
      return new Map(numbers.map((number) => [number, {
        number,
        state,
        ...(state === 'MERGED' ? { mergedAt: '2026-09-18T12:26:00Z' } : {}),
        url: `https://github.com/${repo}/pull/${number}`,
      }]));
    },
    async sentryIssueStatus(org, shortId) {
      calls.push(`sentry ${org}/${shortId}`);
      return null;
    },
  };
}

const quiet = () => {};

test('a MERGED PR closes its declared card with evidence, an event and a wake — never an intervention', async () => {
  await stream('pr-owner');
  await raise('pr-owner', { id: 'att_pr', resolvesWhen: { any: [PR_FACT] } });
  const before = await load('pr-owner');

  const closed = await sweepAttentionReadbacks(await cache('pr-owner'), new Map(), quiet, { io: prIO('MERGED'), ledger: { recovered: {} } });

  assert.equal(closed, 1);
  const after = await load('pr-owner');
  assert.equal(after.revision, before.revision + 1, 'exactly one write');
  const card = after.attention[0]!;
  assert.equal(card.status, 'resolved');
  assert.equal(card.resolvedBy, READBACK_ACTOR);
  assert.ok(card.resolvedAt);
  assert.equal(card.resolution?.by, READBACK_ACTOR);
  assert.deepEqual(card.resolution?.evidence.map((e) => e.fact), [PR_FACT]);
  assert.match(card.resolution!.evidence[0]!.observed, /erdoai\/erdo#2686 MERGED at 2026-09-18T12:26:00Z/);
  assert.equal(card.resolution!.evidence[0]!.url, 'https://github.com/erdoai/erdo/pull/2686');
  assert.ok(after.events.some((e) => e.type === 'attention.readback_resolved' && e.refs?.includes('att_pr')));
  const wakes = after.wakes.filter((w) => w.status === 'pending' && w.condition.type === 'immediate');
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!.reason, /att_pr closed by readback/);
  assert.equal(after.spend.humanInterventions, before.spend.humanInterventions);
});

test('an OPEN PR, an unreadable provider, or no answer writes nothing', async () => {
  await stream('pr-open');
  await raise('pr-open', { id: 'att_open', resolvesWhen: { any: [PR_FACT] } });
  const before = await load('pr-open');
  const logs: string[] = [];

  for (const state of ['OPEN', 'throw', 'null'] as const) {
    const closed = await sweepAttentionReadbacks(await cache('pr-open'), new Map(), (l) => logs.push(l), { io: prIO(state), ledger: { recovered: {} } });
    assert.equal(closed, 0, state);
  }

  const after = await load('pr-open');
  assert.equal(after.revision, before.revision, 'no write for OPEN, an error, or an unknown answer');
  assert.equal(after.attention[0]!.status, 'open');
  assert.ok(logs.some((l) => /PR states unreadable \(network down\)/.test(l)), 'a failed read is logged, never silent');
});

test('a card someone else closed first is a no-op, not a second write', async () => {
  await stream('pr-race');
  await raise('pr-race', { id: 'att_race', resolvesWhen: { any: [PR_FACT] } });
  const stale = await cache('pr-race');
  await arrive('pr-race', (d) => {
    d.attention[0]!.status = 'resolved';
    d.attention[0]!.resolvedBy = 'coordinator';
  });
  const before = await load('pr-race');

  const closed = await sweepAttentionReadbacks(stale, new Map(), quiet, { io: prIO('MERGED'), ledger: { recovered: {} } });

  assert.equal(closed, 0);
  const after = await load('pr-race');
  assert.equal(after.revision, before.revision);
  assert.equal(after.attention[0]!.resolvedBy, 'coordinator');
  assert.equal(after.attention[0]!.resolution, undefined);
});

test('a card still open after a concurrent unrelated write is closed on the fresh revision', async () => {
  await stream('pr-moved');
  await raise('pr-moved', { id: 'att_moved', resolvesWhen: { any: [PR_FACT] } });
  const stale = await cache('pr-moved');
  await arrive('pr-moved', (d) => { d.workstream.tags = ['moved']; });

  assert.equal(await sweepAttentionReadbacks(stale, new Map(), quiet, { io: prIO('MERGED'), ledger: { recovered: {} } }), 1);
  const after = await load('pr-moved');
  assert.equal(after.attention[0]!.status, 'resolved');
  assert.deepEqual(after.workstream.tags, ['moved']);
});

test('the runner-memory throttle suppresses repeat provider reads until the card-age interval elapses', async () => {
  await stream('pr-throttle');
  await raise('pr-throttle', { id: 'att_t', resolvesWhen: { any: [PR_FACT] } });
  const docs = await cache('pr-throttle');
  const nextCheckAt = new Map<string, number>();
  const calls: string[] = [];
  const now = Date.now();

  await sweepAttentionReadbacks(docs, nextCheckAt, quiet, { io: prIO('OPEN', calls), now, ledger: { recovered: {} } });
  await sweepAttentionReadbacks(docs, nextCheckAt, quiet, { io: prIO('OPEN', calls), now: now + 60_000, ledger: { recovered: {} } });
  assert.equal(calls.length, 1, 'a second sweep inside the window reads nothing');

  // The card is ~2h old: the window is 15 minutes.
  assert.equal(nextCheckAt.get('att_t'), now + 15 * 60_000);
  await sweepAttentionReadbacks(docs, nextCheckAt, quiet, { io: prIO('OPEN', calls), now: now + 15 * 60_000, ledger: { recovered: {} } });
  assert.equal(calls.length, 2);

  // Entries for cards that are no longer open are pruned.
  nextCheckAt.set('att_gone', now);
  await sweepAttentionReadbacks(docs, nextCheckAt, quiet, { io: prIO('OPEN', calls), now: now + 16 * 60_000, ledger: { recovered: {} } });
  assert.equal(nextCheckAt.has('att_gone'), false);
});

test('the readback interval backs off with card age and caps at six hours', () => {
  assert.equal(readbackIntervalMs(0), 5 * 60_000);
  assert.equal(readbackIntervalMs(2 * HOUR), 15 * 60_000);
  assert.equal(readbackIntervalMs(3 * 24 * HOUR), HOUR);
  assert.equal(readbackIntervalMs(90 * 24 * HOUR), 6 * HOUR);
});

test('one GitHub query per repository covers every due card citing it', async () => {
  await stream('pr-a');
  await stream('pr-b');
  await raise('pr-a', { id: 'att_a', resolvesWhen: { any: [PR_FACT] } });
  await raise('pr-b', { id: 'att_b', resolvesWhen: { any: [{ ...PR_FACT, number: 2674 } as ExternalFact] } });
  const calls: string[] = [];

  assert.equal(await sweepAttentionReadbacks(await cache('pr-a', 'pr-b'), new Map(), quiet, { io: prIO('MERGED', calls), ledger: { recovered: {} } }), 2);
  assert.deepEqual(calls, ['gh erdoai/erdo 2686,2674']);
});

test('a paused workstream\'s card closes from readback without waking the stream', async () => {
  await stream('pr-paused', 'paused');
  await raise('pr-paused', { id: 'att_paused', resolvesWhen: { any: [PR_FACT] } });

  assert.equal(await sweepAttentionReadbacks(await cache('pr-paused'), new Map(), quiet, { io: prIO('MERGED'), ledger: { recovered: {} } }), 1);
  const after = await load('pr-paused');
  assert.equal(after.attention[0]!.status, 'resolved');
  assert.equal(after.workstream.status, 'paused');
  assert.equal(after.wakes.length, 0, 'a paused stream is woken only by its own resume');
});

test('a resolved Sentry issue closes its card; an absent read token skips the check without any request', async () => {
  await stream('sentry-owner');
  await raise('sentry-owner', { id: 'att_sentry', resolvesWhen: { any: [SENTRY_FACT] } });
  const requests: string[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)} ${new Headers(init?.headers).get('Authorization')}`);
    return new Response(JSON.stringify({
      shortId: 'GO-ZX',
      group: { status: 'resolved', permalink: 'https://erdo.sentry.io/issues/123/' },
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  const noToken = liveAttentionReadbackIO({ fetch: fetchStub, sentryToken: () => undefined, mintGitHubReadToken: async () => null });
  const before = await load('sentry-owner');
  assert.equal(await sweepAttentionReadbacks(await cache('sentry-owner'), new Map(), quiet, { io: noToken, ledger: { recovered: {} } }), 0);
  assert.equal(requests.length, 0);
  assert.equal((await load('sentry-owner')).revision, before.revision);

  const withToken = liveAttentionReadbackIO({ fetch: fetchStub, sentryToken: () => 'sntry-read', mintGitHubReadToken: async () => null });
  assert.equal(await sweepAttentionReadbacks(await cache('sentry-owner'), new Map(), quiet, { io: withToken, ledger: { recovered: {} } }), 1);
  assert.deepEqual(requests, ['GET https://sentry.io/api/0/organizations/erdo/shortids/GO-ZX/ Bearer sntry-read']);
  const card = (await load('sentry-owner')).attention[0]!;
  assert.equal(card.status, 'resolved');
  assert.equal(card.resolution!.evidence[0]!.observed, 'Sentry erdo/GO-ZX resolved');
  assert.equal(card.resolution!.evidence[0]!.url, 'https://erdo.sentry.io/issues/123/');
  assert.doesNotMatch(JSON.stringify(await load('sentry-owner')), /sntry-read/, 'the token never reaches typed state');
});

test('an unresolved Sentry issue or a failed Sentry read leaves the card open', async () => {
  await stream('sentry-open');
  await raise('sentry-open', { id: 'att_s', resolvesWhen: { any: [SENTRY_FACT] } });
  const before = await load('sentry-open');
  for (const response of [
    () => new Response(JSON.stringify({ shortId: 'GO-ZX', group: { status: 'unresolved' } }), { status: 200 }),
    () => new Response('nope', { status: 403 }),
  ]) {
    const io = liveAttentionReadbackIO({
      fetch: (async () => response()) as typeof globalThis.fetch,
      sentryToken: () => 'sntry-read',
      mintGitHubReadToken: async () => null,
    });
    assert.equal(await sweepAttentionReadbacks(await cache('sentry-open'), new Map(), quiet, { io, ledger: { recovered: {} } }), 0);
  }
  assert.equal((await load('sentry-open')).revision, before.revision);
});

test('the live GitHub readback batches one GraphQL query with the App read token and fails open', async () => {
  const bodies: string[] = [];
  const auth: string[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.github.com/graphql');
    bodies.push(String(init?.body));
    auth.push(new Headers(init?.headers).get('Authorization') ?? '');
    return new Response(JSON.stringify({
      data: {
        repository: {
          pr2686: { number: 2686, state: 'MERGED', mergedAt: '2026-09-18T12:26:00Z', closedAt: '2026-09-18T12:26:00Z', url: 'https://github.com/erdoai/erdo/pull/2686' },
          pr2687: { number: 2687, state: 'OPEN', mergedAt: null, closedAt: null, url: 'https://github.com/erdoai/erdo/pull/2687' },
          pr9999: null,
        },
      },
      errors: [{ type: 'NOT_FOUND' }],
    }), { status: 200 });
  }) as typeof globalThis.fetch;
  const minted: string[] = [];
  const io = liveAttentionReadbackIO({
    fetch: fetchStub,
    mintGitHubReadToken: async (repo) => { minted.push(repo); return 'ghs_read'; },
    sentryToken: () => undefined,
  });

  const states = await io.githubPrStates('erdoai/erdo', [2687, 2686, 9999, 2686]);
  assert.deepEqual(minted, ['erdoai/erdo']);
  assert.deepEqual(auth, ['Bearer ghs_read']);
  assert.equal(bodies.length, 1);
  const body = JSON.parse(bodies[0]!) as { query: string; variables: Record<string, string> };
  assert.deepEqual(body.variables, { owner: 'erdoai', name: 'erdo' });
  assert.match(body.query, /pr2686: pullRequest\(number: 2686\)/);
  assert.equal(states!.get(2686)!.state, 'MERGED');
  assert.equal(states!.get(2687)!.state, 'OPEN');
  assert.equal(states!.has(9999), false, 'a PR GitHub cannot show is unknown, never closed');

  const noApp = liveAttentionReadbackIO({ fetch: fetchStub, mintGitHubReadToken: async () => null, sentryToken: () => undefined });
  assert.equal(await noApp.githubPrStates('erdoai/erdo', [1]), null);
  assert.equal(bodies.length, 1, 'no GitHub App → no request at all');

  const failing = liveAttentionReadbackIO({
    fetch: (async () => new Response('', { status: 502 })) as typeof globalThis.fetch,
    mintGitHubReadToken: async () => 'ghs_read',
    sentryToken: () => undefined,
  });
  await assert.rejects(failing.githubPrStates('erdoai/erdo', [1]), /HTTP 502/);
});

test('declared facts are validated; unknown kinds and harness-owned capacity facts are refused', () => {
  assert.deepEqual(parseExternalFacts([
    { kind: 'github_pr_state', repo: 'erdoai/erdo', number: 2686, states: ['MERGED', 'MERGED', 'CLOSED'] },
    { kind: 'sentry_issue_status', org: 'erdo', shortId: 'go-zx', statuses: ['resolved'] },
  ]), [
    { kind: 'github_pr_state', repo: 'erdoai/erdo', number: 2686, states: ['MERGED', 'CLOSED'] },
    { kind: 'sentry_issue_status', org: 'erdo', shortId: 'GO-ZX', statuses: ['resolved'] },
  ]);
  const refused: Array<[unknown, RegExp]> = [
    [[{ kind: 'linear_issue_state', id: 'ENG-1' }], /not a known fact/],
    [[{ kind: 'github_pr_state', repo: 'erdo', number: 1, states: ['MERGED'] }], /owner\/name/],
    [[{ kind: 'github_pr_state', repo: 'https://github.com/erdoai/erdo', number: 1, states: ['MERGED'] }], /owner\/name/],
    [[{ kind: 'github_pr_state', repo: 'erdoai/erdo', number: 0, states: ['MERGED'] }], /positive integer/],
    [[{ kind: 'github_pr_state', repo: 'erdoai/erdo', number: 1.5, states: ['MERGED'] }], /positive integer/],
    [[{ kind: 'github_pr_state', repo: 'erdoai/erdo', number: 1, states: ['OPEN'] }], /MERGED \| CLOSED/],
    [[{ kind: 'github_pr_state', repo: 'erdoai/erdo', number: 1, states: [] }], /non-empty/],
    [[{ kind: 'sentry_issue_status', org: 'erdo', shortId: 'not a short id', statuses: ['resolved'] }], /short id/],
    [[{ kind: 'sentry_issue_status', org: 'erdo', shortId: '12345', statuses: ['resolved'] }], /short id/],
    [[{ kind: 'sentry_issue_status', org: 'bad org!', shortId: 'GO-ZX', statuses: ['resolved'] }], /organization slug/],
    [[{ kind: 'sentry_issue_status', org: 'erdo', shortId: 'GO-ZX', statuses: ['unresolved'] }], /resolved \| ignored/],
    [[{ kind: 'capacity_target_unblocked', role: 'worker', target: { executor: 'x', provider: 'y', model: 'z' } }], /harness-owned/],
    [[], /at least one/],
    [Array.from({ length: 6 }, (_, i) => ({ kind: 'github_pr_state', repo: 'erdoai/erdo', number: i + 1, states: ['MERGED'] })), /at most 5/],
    ['erdoai/erdo#1', /array/],
  ];
  for (const [raw, message] of refused) assert.throws(() => parseExternalFacts(raw), message, JSON.stringify(raw));
  assert.deepEqual(
    parseExternalFacts([{ kind: 'capacity_target_unblocked', role: 'worker', target: { executor: 'openhands', provider: 'openrouter', model: 'm' } }], { allowCapacity: true }),
    [{ kind: 'capacity_target_unblocked', role: 'worker', target: { executor: 'openhands', provider: 'openrouter', model: 'm' } }],
  );
});

// ---------------------------------------------------------------------------
// Capacity cards: typed-state rules, no provider calls

function capacityWait(overrides: Partial<InfrastructureWait> = {}): InfrastructureWait {
  return {
    kind: 'usage_limit',
    recovery: 'wait_or_enable_usage_credits',
    source: 'coordinator',
    sourceId: 'pass_failed',
    model: 'openrouter/z-ai/glm-5.3',
    executor: 'local-sdk',
    provider: 'openrouter',
    detectedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    // Already due: the fleet release skips such waits, but the card must
    // still close (rule i does not depend on retryAt).
    retryAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    ...overrides,
  };
}

/** A LEGACY capacity card: no declared fact, only refId → the wake's typed wait. */
async function legacyCapacityCard(slug: string, wait: InfrastructureWait, createdAt: string): Promise<void> {
  await arrive(slug, (d) => {
    d.wakes.push({
      id: 'wake_capacity',
      reason: 'provider usage limited',
      condition: { type: 'time', dueAtVirtual: wait.retryAt },
      status: 'fired',
      createdAt,
      infrastructure: wait,
    });
    d.capacity = {
      state: 'backoff',
      byModel: {
        [`${wait.executor}:${wait.provider}:${wait.model}`]: {
          wait,
          consecutiveBackoffs: 12,
          firstBackoffAtVirtual: wait.detectedAt,
          lastBackoffAtVirtual: wait.detectedAt,
        },
      },
    };
    d.attention.push({
      id: 'att_capacity',
      kind: 'capacity',
      summary: 'OpenRouter capacity via local-sdk (openrouter/z-ai/glm-5.3/usage_limit) has blocked work 12 times.',
      refId: 'wake_capacity',
      status: 'open',
      createdAt,
    });
  });
}

test('rule (i): a fleet-ledger success on the exact target after the card closes it, even with retryAt past and the stream paused', async () => {
  await stream('cap-ledger', 'paused');
  const createdAt = new Date(Date.now() - 2 * HOUR).toISOString();
  await legacyCapacityCard('cap-ledger', capacityWait(), createdAt);
  const before = await load('cap-ledger');
  const calls: string[] = [];

  // A ledger success BEFORE the card proves nothing about it.
  const early = new Date(Date.now() - 3 * HOUR).toISOString();
  assert.equal(await sweepAttentionReadbacks(await cache('cap-ledger'), new Map(), quiet, {
    io: prIO('MERGED', calls), ledger: { recovered: { 'local-sdk:openrouter:openrouter/z-ai/glm-5.3': early } },
  }), 0);
  assert.equal((await load('cap-ledger')).revision, before.revision);

  const later = new Date(Date.now() - HOUR).toISOString();
  assert.equal(await sweepAttentionReadbacks(await cache('cap-ledger'), new Map(), quiet, {
    io: prIO('MERGED', calls), ledger: { recovered: { 'local-sdk:openrouter:openrouter/z-ai/glm-5.3': later } },
  }), 1);
  assert.deepEqual(calls, [], 'capacity cards never call a provider');
  const after = await load('cap-ledger');
  const card = after.attention[0]!;
  assert.equal(card.status, 'resolved');
  assert.equal(card.resolvedBy, CAPACITY_RECOVERED_ACTOR);
  assert.equal(card.resolution!.by, CAPACITY_RECOVERED_ACTOR);
  assert.deepEqual(card.resolution!.evidence[0]!.fact, {
    kind: 'capacity_target_unblocked', role: 'coordinator',
    target: { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' },
  });
  assert.match(card.resolution!.evidence[0]!.observed, /fleet recovery ledger/);
  assert.deepEqual(after.capacity, before.capacity, 'routing backoff records are untouched');
  assert.equal(after.wakes.filter((w) => w.status === 'pending').length, 0, 'no wake for a capacity close');
  assert.equal(after.spend.humanInterventions, before.spend.humanInterventions);
  assert.ok(after.events.some((e) => e.type === 'attention.capacity_recovered'));
});

test('rule (i): another workstream\'s recorded pass on the exact target closes the card', async () => {
  await stream('cap-parked');
  await stream('cap-prover');
  const createdAt = new Date(Date.now() - 2 * HOUR).toISOString();
  await legacyCapacityCard('cap-parked', capacityWait(), createdAt);
  await arrive('cap-prover', (d) => {
    d.passes.push({
      id: 'pass_prover', startedAt: new Date(Date.now() - HOUR).toISOString(),
      endedAt: new Date(Date.now() - HOUR + 60_000).toISOString(), baseRevision: 1, wakeReasons: [],
      executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3',
      changes: [], outcome: 'error',
    });
  });
  const docs = await cache('cap-parked', 'cap-prover');
  assert.equal(capacitySuccessIndex(docs.values()).get('local-sdk:openrouter:openrouter/z-ai/glm-5.3')?.source, 'pass pass_prover in cap-prover');

  assert.equal(await sweepAttentionReadbacks(docs, new Map(), quiet, { io: prIO('OPEN'), ledger: { recovered: {} } }), 1);
  assert.match((await load('cap-parked')).attention[0]!.resolution!.evidence[0]!.observed, /pass pass_prover in cap-prover/);
});

test('rule (ii): a completed pass on ANY target after the card closes a coordinator capacity card', async () => {
  await stream('cap-flowing');
  const createdAt = new Date(Date.now() - 2 * HOUR).toISOString();
  await legacyCapacityCard('cap-flowing', capacityWait(), createdAt);
  await arrive('cap-flowing', (d) => {
    // Fallback seat carried the work; the limited pool itself never recovered.
    d.passes.push({
      id: 'pass_fallback', startedAt: new Date(Date.now() - HOUR).toISOString(),
      endedAt: new Date(Date.now() - HOUR + 60_000).toISOString(), baseRevision: 1, wakeReasons: [],
      executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
      changes: [], outcome: 'completed',
    });
  });
  assert.equal(await sweepAttentionReadbacks(await cache('cap-flowing'), new Map(), quiet, { io: prIO('OPEN'), ledger: { recovered: {} } }), 1);
  const card = (await load('cap-flowing')).attention[0]!;
  assert.equal(card.resolvedBy, CAPACITY_RECOVERED_ACTOR);
  assert.match(card.resolution!.evidence[0]!.observed, /coordinator pass pass_fallback completed/);
});

test('rule (ii) is role-scoped: coordinator passes never close a worker capacity card, submitted worker work does', async () => {
  await stream('cap-worker');
  const createdAt = new Date(Date.now() - 2 * HOUR).toISOString();
  await legacyCapacityCard('cap-worker', capacityWait({ source: 'worker', sourceId: 'run_failed', executor: 'openhands' }), createdAt);
  await arrive('cap-worker', (d) => {
    d.passes.push({
      id: 'pass_ok', startedAt: new Date(Date.now() - HOUR).toISOString(),
      endedAt: new Date(Date.now() - HOUR + 60_000).toISOString(), baseRevision: 1, wakeReasons: [],
      executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5', changes: [], outcome: 'completed',
    });
  });
  assert.equal(await sweepAttentionReadbacks(await cache('cap-worker'), new Map(), quiet, { io: prIO('OPEN'), ledger: { recovered: {} } }), 0);

  await arrive('cap-worker', (d) => {
    d.assignments.push({
      id: 'asg_done', objective: 'o', briefing: 'b', kind: 'work', acceptanceCriteria: [], dependsOn: [],
      state: 'awaiting_review',
      attempts: [{
        runId: 'run_ok', executor: 'openhands', provider: 'moonshot', model: 'kimi',
        startedAt: new Date(Date.now() - HOUR).toISOString(), endedAt: new Date(Date.now() - HOUR + 60_000).toISOString(),
      }],
      submission: { summary: 'done' },
      adoption: { state: 'proposed' },
      createdAtVirtual: virtualNow().toISOString(),
    });
  });
  assert.equal(await sweepAttentionReadbacks(await cache('cap-worker'), new Map(), quiet, { io: prIO('OPEN'), ledger: { recovered: {} } }), 1);
  assert.match((await load('cap-worker')).attention[0]!.resolution!.evidence[0]!.observed, /worker attempt run_ok on asg_done submitted/);
});

test('capacity cards stay open while nothing has moved since they were raised', async () => {
  await stream('cap-stuck');
  const createdAt = new Date(Date.now() - HOUR).toISOString();
  await legacyCapacityCard('cap-stuck', capacityWait(), createdAt);
  await arrive('cap-stuck', (d) => {
    // Older completed pass, and a newer infrastructure-parked one: neither counts.
    d.passes.push(
      { id: 'pass_old', startedAt: new Date(Date.now() - 3 * HOUR).toISOString(), endedAt: new Date(Date.now() - 3 * HOUR).toISOString(), baseRevision: 1, wakeReasons: [], executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5', changes: [], outcome: 'completed' },
      { id: 'pass_parked', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), baseRevision: 1, wakeReasons: [], executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3', changes: [], outcome: 'error', infrastructure: capacityWait() },
    );
  });
  const before = await load('cap-stuck');
  assert.equal(await sweepAttentionReadbacks(await cache('cap-stuck'), new Map(), quiet, { io: prIO('OPEN'), ledger: { recovered: {} } }), 0);
  assert.equal((await load('cap-stuck')).revision, before.revision);
});
