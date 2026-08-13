/**
 * The bot ingress adapter: token-gated, idempotent create-or-get, untrusted
 * observations that wake the stream, read-only status — and no authority
 * channel. Deterministic: no model anywhere, just HTTP over the fs store.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { startServer, type RunningServer } from './serve.js';
import { load } from './store.js';

const TOKEN = 'test-secret-token';
let home: string;
let srv: RunningServer;
let base: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-serve-'));
  process.env.WEAVER_HOME = home;
  srv = await startServer({ token: TOKEN });
  base = `http://127.0.0.1:${srv.port}`;
});

afterEach(async () => {
  await srv.close();
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function auth(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
}

test('a bot registers its workstream idempotently on a source key', async () => {
  const payload = { source_key: 'devbot:pr:1957', title: 'Fix the composer', objective: 'land PR #1957' };
  const r1 = await fetch(`${base}/workstreams`, auth(payload));
  assert.equal(r1.status, 201);
  const b1 = (await r1.json()) as { slug: string; created: boolean };
  assert.equal(b1.created, true);

  // Second call with the same source key is a no-op GET — not a duplicate.
  const r2 = await fetch(`${base}/workstreams`, auth(payload));
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as { slug: string; created: boolean };
  assert.equal(b2.created, false);
  assert.equal(b2.slug, b1.slug);

  // Exactly one workstream landed.
  const doc = await load(b1.slug);
  assert.equal(doc.workstream.sourceKey, 'devbot:pr:1957');
  assert.deepEqual(doc.workstream.executionSafety, { windowSeconds: 3600, maxModelStarts: 30 });
});

test('legacy lifetime cap inputs fail explicitly instead of becoming ignored safety theatre', async () => {
  const response = await fetch(`${base}/workstreams`, auth({
    source_key: 'legacy:cap', title: 'Legacy', objective: 'do work', max_cost_usd: 5,
  }));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /were removed.*provider billing controls/);
});

test('invalid rolling safety inputs fail instead of silently weakening the guard', async () => {
  const response = await fetch(`${base}/workstreams`, auth({
    source_key: 'bad:guard', title: 'Bad guard', objective: 'do work', max_model_starts: 0,
  }));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /must be positive integers/);
});

test('a workstream is created with an immediate wake so the runner picks it up', async () => {
  const r = await fetch(`${base}/workstreams`, auth({ source_key: 'ux:app', title: 'UX health', objective: 'watch UX over time' }));
  const { slug } = (await r.json()) as { slug: string };
  const doc = await load(slug);
  assert.ok(doc.wakes.some((w) => w.status === 'pending'), 'creation queued a wake');
});

test('an observation is recorded, wakes the stream, and is idempotent on its key', async () => {
  const c = await fetch(`${base}/workstreams`, auth({ source_key: 'ux:app', title: 'UX', objective: 'o' }));
  const { slug } = (await c.json()) as { slug: string };

  const o1 = await fetch(`${base}/workstreams/${slug}/observations`, auth({ source: 'ux-bot', summary: 'nav contrast is too low on mobile', key: 'ux-bot:finding:1' }));
  assert.equal(o1.status, 201);

  const doc = await load(slug);
  assert.equal(doc.observations.length, 1);
  assert.equal(doc.observations[0]!.source, 'ux-bot');
  assert.ok(doc.observations.some((obs) => obs.summary.includes('contrast')));

  // Same idempotency key → no second observation.
  const o2 = await fetch(`${base}/workstreams/${slug}/observations`, auth({ source: 'ux-bot', summary: 'nav contrast is too low on mobile', key: 'ux-bot:finding:1' }));
  assert.equal(o2.status, 200);
  const b2 = (await o2.json()) as { duplicate: boolean };
  assert.equal(b2.duplicate, true);
  assert.equal((await load(slug)).observations.length, 1);
});

test('GET returns the five-questions position for a bot to read', async () => {
  const c = await fetch(`${base}/workstreams`, auth({ source_key: 's:1', title: 'Reads', objective: 'be readable' }));
  const { slug } = (await c.json()) as { slug: string };
  const r = await fetch(`${base}/workstreams/${slug}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { slug: string; status: string; status_text: string };
  assert.equal(body.slug, slug);
  assert.equal(body.status, 'active');
  assert.ok(body.status_text.length > 0);
});

test('the adapter fails closed without a valid bearer token', async () => {
  const noAuth = await fetch(`${base}/workstreams`, { method: 'POST', body: '{}' });
  assert.equal(noAuth.status, 401);
  const wrong = await fetch(`${base}/workstreams`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope' },
    body: '{}',
  });
  assert.equal(wrong.status, 401);
});

test('unknown workstream and unknown route are honest 404s', async () => {
  const missing = await fetch(`${base}/workstreams/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(missing.status, 404);
  const route = await fetch(`${base}/nonsense`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(route.status, 404);
});

test('there is no authority channel: steering/approval routes do not exist', async () => {
  const c = await fetch(`${base}/workstreams`, auth({ source_key: 's:2', title: 'T', objective: 'o' }));
  const { slug } = (await c.json()) as { slug: string };
  // A bot cannot steer, approve, or adopt through this adapter — those are the
  // human's authority channels and are deliberately absent.
  for (const p of ['steer', 'approve', 'adopt']) {
    const r = await fetch(`${base}/workstreams/${slug}/${p}`, auth({ body: 'x' }));
    assert.equal(r.status, 404, `${p} must not be an ingress route`);
  }
});
