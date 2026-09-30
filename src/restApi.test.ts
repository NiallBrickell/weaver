/**
 * The /api/v1/ bearer API is a read surface plus one untrusted answer path:
 * its tokens are separate from the browser session, the read token can never
 * write, the fleet listing never re-loads a document whose revision did not
 * change, an answer is the exact Observation the browser form records, and
 * the event feed speaks plain English.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTeamWorkstream, startOperatorUi, type RunningOperatorUi } from './operatorUi.js';
import { needVersion } from './needResponses.js';
import { WorkstreamIndex, workstreamEvents } from './restApi.js';
import { arrive, heartbeatRunner, listWorkstreamHeads, load, type WorkstreamHead } from './store.js';
import type { WorkstreamDoc } from './types.js';
import { workstreamNeeds } from './ui/inspect/model.js';

const READ = 'read-token-for-tests';
const RESPOND = 'respond-token-for-tests';

let home: string;
let running: RunningOperatorUi | undefined;
let base: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-rest-api-'));
  process.env.WEAVER_HOME = home;
  running = await startOperatorUi({ apiTokens: { read: READ, respond: RESPOND } });
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function get(pathname: string, token?: string): Promise<Response> {
  return fetch(`${base}${pathname}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
}

function postJson(pathname: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams(fields),
  };
}

const DECISION = 'DECISION NEEDED: Choose the release course. (A) Continue on green tests. (B) Ask for another review.';

async function jobWithDecision(requestId: string): Promise<string> {
  const created = await createTeamWorkstream({ message: 'Resolve the release choice.', requestId, actor: 'alice' });
  await arrive(created.slug, (doc, event) => {
    doc.attention.push({ id: 'att_release', kind: 'blocker', summary: DECISION, status: 'open', createdAt: new Date().toISOString() });
    event('attention.opened', 'release choice requested');
  });
  return created.slug;
}

async function currentVersion(slug: string): Promise<string> {
  return needVersion(workstreamNeeds(await load(slug))[0]!);
}

test('auth matrix: no token is 401, read token reads but cannot answer, respond token answers', async () => {
  const slug = await jobWithDecision('auth-matrix');
  const responsePath = `/api/v1/workstreams/${slug}/needs/attention/att_release/responses`;
  const answer = async () => ({ version: await currentVersion(slug), choice: 'A', response_id: randomUUID() });

  const none = await get('/api/v1/workstreams');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await get('/api/v1/workstreams', 'wrong-token')).status, 401);
  assert.equal((await postJson(responsePath, await answer())).status, 401);

  const read = await get('/api/v1/workstreams', READ);
  assert.equal(read.status, 200);
  const listed = await read.json() as { workstreams: Array<{ slug: string; needs_count: number }> };
  assert.equal(listed.workstreams.find((row) => row.slug === slug)?.needs_count, 1);
  assert.equal((await get('/api/v1/workstreams', RESPOND)).status, 200, 'the respond token also reads');

  const before = (await load(slug)).observations.length;
  const forbidden = await postJson(responsePath, await answer(), READ);
  assert.equal(forbidden.status, 403);
  assert.equal((await load(slug)).observations.length, before, 'a read-token POST writes nothing');

  const created = await postJson(responsePath, await answer(), RESPOND);
  assert.equal(created.status, 201);
  assert.equal((await load(slug)).observations.length, before + 1);
});

test('a disabled token matches nothing, and the API never accepts the browser session', async () => {
  await running!.close();
  running = await startOperatorUi({ token: 'basic-secret', apiTokens: {} });
  base = `http://127.0.0.1:${running.port}`;
  const basic = `Basic ${Buffer.from('alice:basic-secret').toString('base64')}`;
  assert.equal((await fetch(`${base}/api/v1/workstreams`, { headers: { authorization: basic } })).status, 401);
  assert.equal((await get('/api/v1/workstreams', '')).status, 401);
  assert.equal((await get('/api/v1/runners', READ)).status, 401, 'an unset token is disabled, not empty-matching');
  // The browser pages keep their Basic gate unchanged.
  assert.equal((await fetch(`${base}/board`, { headers: { authorization: basic } })).status, 200);
});

test('the listing loads only documents whose revision changed, and shares one head read per TTL', async () => {
  for (let i = 0; i < 5; i += 1) {
    await createTeamWorkstream({ message: `Job number ${i} needs doing.`, requestId: `listing-${i}`, actor: 'alice' });
  }
  const loads: string[] = [];
  let headReads = 0;
  let clock = 0;
  const index = new WorkstreamIndex({
    heads: async (): Promise<WorkstreamHead[]> => {
      headReads += 1;
      return listWorkstreamHeads();
    },
    load: async (slug: string): Promise<WorkstreamDoc> => {
      loads.push(slug);
      return load(slug);
    },
    now: () => clock,
    ttlMs: 10_000,
  });

  const first = await index.rows();
  assert.equal(first.length, 5);
  assert.equal(loads.length, 5, 'a cold index derives each workstream once');

  clock += 1_000;
  await index.rows();
  assert.equal(headReads, 1, 'inside the TTL no store call is made at all');
  assert.equal(loads.length, 5);

  const changed = first[2]!.summary.slug;
  await arrive(changed, (doc, event) => {
    doc.workstream.tags.push('urgent');
    event('workstream.tagged', 'tagged');
  });
  clock += 10_000;
  const after = await index.rows();
  assert.equal(headReads, 2);
  assert.deepEqual(loads.slice(5), [changed], 'only the changed revision is loaded');
  assert.deepEqual(after.find((row) => row.summary.slug === changed)?.summary.tags.includes('urgent'), true);

  clock += 10_000;
  await index.rows();
  assert.equal(loads.length, 6, 'an unchanged fleet loads no bodies');
});

test('workstream listing filters and summary shape', async () => {
  const slug = await jobWithDecision('summary-shape');
  await createTeamWorkstream({ message: 'Another unrelated job.', requestId: 'summary-other', actor: 'bob' });
  await arrive(slug, (doc, event) => {
    doc.workstream.tags.push('release');
    event('workstream.tagged', 'tagged');
  });
  const body = await (await get('/api/v1/workstreams?tag=release&status=active', READ)).json() as { workstreams: Array<Record<string, unknown>> };
  assert.equal(body.workstreams.length, 1);
  const row = body.workstreams[0]!;
  assert.equal(row.slug, slug);
  assert.equal(row.status, 'active');
  assert.equal(row.needs_count, 1);
  assert.equal(row.current_assignment, null);
  assert.ok(Array.isArray(row.waiting));
  assert.equal(typeof row.revision, 'number');
  assert.ok(String(row.source_key).startsWith('ui:request:'));
  assert.ok(String(row.objective_excerpt).length <= 200);
  assert.ok(Number.isFinite(Date.parse(String(row.updated_at))));

  const future = new Date(Date.now() + 60_000).toISOString();
  const none = await (await get(`/api/v1/workstreams?updated_since=${encodeURIComponent(future)}`, READ)).json() as { workstreams: unknown[] };
  assert.equal(none.workstreams.length, 0);
  assert.equal((await get('/api/v1/workstreams?limit=0', READ)).status, 400);
  assert.equal((await get('/api/v1/workstreams?updated_since=yesterday', READ)).status, 400);

  const detail = await (await get(`/api/v1/workstreams/${slug}`, READ)).json() as Record<string, unknown>;
  assert.equal(detail.slug, slug);
  assert.ok(Array.isArray(detail.decisions) && Array.isArray(detail.deliverables) && Array.isArray(detail.waits));
  assert.equal((await get('/api/v1/workstreams/no-such-job', READ)).status, 404);
  const assignments = await (await get(`/api/v1/workstreams/${slug}/assignments`, READ)).json() as { assignments: unknown[] };
  assert.deepEqual(assignments.assignments, []);
});

test('needs listing presents open cards with choices and the version an answer must echo', async () => {
  const slug = await jobWithDecision('needs-listing');
  await createTeamWorkstream({ message: 'A job with nothing to ask.', requestId: 'needs-quiet', actor: 'bob' });
  const body = await (await get('/api/v1/needs', READ)).json() as { needs: Array<Record<string, unknown>> };
  assert.equal(body.needs.length, 1);
  const need = body.needs[0]!;
  assert.equal(need.workstream, slug);
  assert.equal(need.source_type, 'attention');
  assert.equal(need.source_id, 'att_release');
  assert.equal(need.version, await currentVersion(slug));
  assert.equal(need.kind, 'blocker');
  assert.equal(need.title, 'Choose the release course.');
  assert.deepEqual((need.choices as Array<{ label: string }>).map((choice) => choice.label), ['A', 'B']);
  const scoped = await (await get(`/api/v1/needs?workstream=other`, READ)).json() as { needs: unknown[] };
  assert.equal(scoped.needs.length, 0);
});

test('an answer to a changed card is 409, malformed is 400, and neither writes', async () => {
  const slug = await jobWithDecision('conflict');
  const responsePath = `/api/v1/workstreams/${slug}/needs/attention/att_release/responses`;
  const staleVersion = await currentVersion(slug);
  await arrive(slug, (doc, event) => {
    doc.attention[0]!.summary = 'DECISION NEEDED: The course changed. (A) Wait for the new evidence.';
    event('attention.updated', 'choice changed');
  });
  const before = (await load(slug)).observations.length;
  const stale = await postJson(responsePath, { version: staleVersion, choice: 'A', response_id: randomUUID() }, RESPOND);
  assert.equal(stale.status, 409);
  assert.equal((await load(slug)).observations.length, before);

  const version = await currentVersion(slug);
  for (const bad of [
    { version, choice: 'A' },
    { version, choice: 'A', response_id: 'not-a-uuid' },
    { version, choice: 'Z', response_id: randomUUID() },
    { version, response_id: randomUUID() },
    { version, choice: 'A', custom: 'both', response_id: randomUUID() },
    { version: 7, choice: 'A', response_id: randomUUID() },
  ]) {
    assert.equal((await postJson(responsePath, bad, RESPOND)).status, 400, JSON.stringify(bad));
  }
  const notJson = await fetch(`${base}${responsePath}`, {
    method: 'POST', headers: { authorization: `Bearer ${RESPOND}`, 'content-type': 'text/plain' }, body: 'A',
  });
  assert.equal(notJson.status, 400);
  assert.equal((await load(slug)).observations.length, before);
});

test('an API answer is recorded exactly as the browser form records it', async () => {
  const apiSlug = await jobWithDecision('identical-api');
  const browserSlug = await jobWithDecision('identical-browser');
  const note = 'Yes, but only after the smoke test passes.';
  const responseId = randomUUID();

  const api = await postJson(`/api/v1/workstreams/${apiSlug}/needs/attention/att_release/responses`, {
    version: await currentVersion(apiSlug), choice: 'A', note, response_id: responseId,
  }, RESPOND);
  assert.equal(api.status, 201);
  const retry = await postJson(`/api/v1/workstreams/${apiSlug}/needs/attention/att_release/responses`, {
    version: await currentVersion(apiSlug), choice: 'A', note, response_id: responseId,
  }, RESPOND);
  assert.equal(retry.status, 201);
  assert.equal((await retry.json() as { duplicate: boolean }).duplicate, true, 'an exact retry is one durable response');

  const browser = await fetch(`${base}/workstreams/${browserSlug}/responses`, form({
    need_source_type: 'attention', need_id: 'att_release', need_version: await currentVersion(browserSlug),
    response_id: responseId, choice: 'A', note,
  }));
  assert.equal(browser.status, 303);

  const recorded = async (slug: string) => {
    const doc = await load(slug);
    const responses = doc.observations.filter((observation) => observation.source.startsWith('operator-ui-response:'));
    return { doc, responses };
  };
  const fromApi = await recorded(apiSlug);
  const fromBrowser = await recorded(browserSlug);
  assert.equal(fromApi.responses.length, 1);
  assert.equal(fromBrowser.responses.length, 1);
  assert.equal(fromApi.responses[0]!.summary, fromBrowser.responses[0]!.summary);
  assert.equal(fromApi.responses[0]!.summary, 'Response to blocker request: A — Continue on green tests.\nCondition or note: Yes, but only after the smoke test passes.');
  assert.equal(fromApi.responses[0]!.ingressKey, fromBrowser.responses[0]!.ingressKey, 'same version, id, and answer: same idempotency key');
  assert.equal(fromApi.responses[0]!.source, 'operator-ui-response:api:team');
  for (const { doc } of [fromApi, fromBrowser]) {
    assert.equal(doc.steering.length, 0, 'an answer is never steering');
    assert.equal(doc.spend.humanInterventions, 0);
    assert.equal(doc.attention[0]!.status, 'open', 'an answer wakes reconciliation; it does not close the card');
    assert.equal(doc.wakes.filter((wake) => wake.reason.includes('operator-ui-response')).length, 1);
  }
});

test('event messages are plain English with no internal vocabulary', async () => {
  const slug = await jobWithDecision('events');
  const now = new Date();
  await arrive(slug, (doc) => {
    const at = now.toISOString();
    doc.decisions.push({
      id: 'dec_1', title: 'Ship behind the feature flag', rationale: 'Lowest risk.', madeBy: 'coordinator',
      status: 'standing', decidedAtVirtual: at,
    });
    const assignment = (id: string, state: 'completed' | 'failed' | 'gated' | 'running', adoption: 'accepted' | 'rejected' | 'none' | 'proposed', kind: 'work' | 'action' = 'work') => ({
      id, objective: `Task ${id}`, briefing: 'b', kind, acceptanceCriteria: [], dependsOn: [], state,
      attempts: [{ runId: `run_${id}`, startedAt: at }], adoption: { state: adoption }, createdAtVirtual: at,
    });
    doc.assignments.push(
      assignment('asg_a', 'completed', 'accepted'),
      assignment('asg_b', 'failed', 'none'),
      assignment('asg_c', 'running', 'proposed'),
      { ...assignment('asg_d', 'gated', 'none', 'action'), exec: { cwd: '/tmp', verify: 'true', approval: { by: 'human', at, actor: 'alice' } } },
    );
    doc.attention.push({ id: 'att_done', kind: 'review', summary: 'Check the numbers.', status: 'resolved', createdAt: at, resolvedAt: at, resolvedBy: 'engine:readback' });
    doc.steering.push({ id: 'steer_1', body: 'Prefer the small change.', at, by: 'alice' } as WorkstreamDoc['steering'][number]);
    doc.workstream.conclusion = { passId: 'pass_1', atVirtual: at, summary: 'Shipped.', evidenceIds: [], disposition: 'delivered' };
  });

  const body = await (await get(`/api/v1/workstreams/${slug}/events?limit=500`, READ)).json() as { events: Array<{ id: string; ts: string; kind: string; message: string }>; cursor: string | null };
  assert.ok(body.events.length >= 8);
  const banned = /typed record|readback|gated external effect|adoption|adopted|projection|durable|coordinator|assignment|attention|engine:|steer\b|\basg_|\batt_/i;
  for (const event of body.events) {
    assert.doesNotMatch(event.message, banned, event.message);
    assert.ok(Number.isFinite(Date.parse(event.ts)));
  }
  const direct = workstreamEvents(await load(slug));
  assert.deepEqual(body.events.map((event) => event.message), direct.map((event) => event.message));

  // Cursor paging: the cursor resumes after the last event returned.
  const firstPage = await (await get(`/api/v1/workstreams/${slug}/events?limit=500`, READ)).json() as { cursor: string };
  const empty = await (await get(`/api/v1/workstreams/${slug}/events?after=${encodeURIComponent(firstPage.cursor)}`, READ)).json() as { events: unknown[]; cursor: string };
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, firstPage.cursor);
  assert.equal((await get(`/api/v1/workstreams/${slug}/events?after=garbage`, READ)).status, 400);
});

test('runner presence reports age, seats, and degradation without loading workstreams', async () => {
  await heartbeatRunner('gcp-box', new Date().toISOString(), [{ executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus' }]);
  await heartbeatRunner('old-box', new Date(Date.now() - 3_600_000).toISOString(), undefined, 'state directory is full');
  const body = await (await get('/api/v1/runners', READ)).json() as { runners: Array<Record<string, unknown>> };
  assert.deepEqual(body.runners.map((runner) => runner.id), ['gcp-box', 'old-box']);
  const [fresh, stale] = body.runners;
  assert.equal(fresh!.live, true);
  assert.equal(fresh!.degraded, null);
  assert.deepEqual(fresh!.coordinator_seats, [{ executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus' }]);
  assert.equal(stale!.live, false);
  assert.equal(stale!.degraded, 'state directory is full');
  assert.ok(Number(stale!.age_seconds) >= 3_599);
});
