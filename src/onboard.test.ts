import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachToExisting, deriveFallback, parseDerivation, sanitizeSlug } from './onboard.js';
import { localTextModel } from './modelConfig.js';
import { createWorkstream, load, mutate } from './store.js';

test('sanitizeSlug: kebabs, bounds, and dodges collisions', () => {
  const taken = new Set(['upload-bug', 'upload-bug-2']);
  assert.equal(sanitizeSlug('Upload BUG!!', new Set()), 'upload-bug');
  assert.equal(sanitizeSlug('upload bug', taken), 'upload-bug-3');
  assert.equal(sanitizeSlug('///', new Set()), 'task');
  assert.ok(sanitizeSlug('x'.repeat(100), new Set()).length <= 40);
});

test('deriveFallback: the message survives verbatim as the objective', () => {
  const msg = 'A user hit an upload issue yesterday, no progress bar, check PostHog';
  const d = deriveFallback(msg, new Set());
  assert.equal(d.objective, msg);
  assert.equal(d.routine, false);
  assert.match(d.slug, /^[a-z0-9-]+$/);
});

test('deriveFallback: an explicit done-statement becomes the success criterion', () => {
  const d = deriveFallback('fix the banner', new Set(), 'verified live post-merge, read-only');
  assert.deepEqual(d.successCriteria, ['verified live post-merge, read-only']);
});

test('parseDerivation: fenced JSON parses; garbage and missing fields do not', () => {
  const ok = parseDerivation(
    'Here you go:\n```json\n{"slug":"Fix Upload","title":"t","objective":"o","successCriteria":["a",3],"routine":true}\n```',
    new Set(),
  );
  assert.ok(ok && ok.kind === 'create');
  assert.equal(ok.derived.slug, 'fix-upload');
  assert.deepEqual(ok.derived.successCriteria, ['a']);
  assert.equal(ok.derived.routine, true);
  assert.equal(parseDerivation('no json here', new Set()), null);
  assert.equal(parseDerivation('{"title":"only"}', new Set()), null);
});

test('parseDerivation: attachTo routes to an existing slug, never a hallucinated one', () => {
  const taken = new Set(['video-animations']);
  const attach = parseDerivation('{"attachTo":"video-animations"}', taken);
  assert.deepEqual(attach, { kind: 'attach', slug: 'video-animations' });
  // A slug the fleet doesn't have falls through to ordinary creation.
  assert.equal(parseDerivation('{"attachTo":"made-up-stream"}', taken), null);
});

test('localTextModel: a provider-prefixed worker model never reaches the local SDK', () => {
  const prev = process.env.WEAVER_WORKER_MODEL;
  try {
    process.env.WEAVER_WORKER_MODEL = 'zai-coding-plan/glm-5.3';
    assert.equal(localTextModel(), 'sonnet');
    process.env.WEAVER_WORKER_MODEL = 'opus';
    assert.equal(localTextModel(), 'opus');
  } finally {
    if (prev === undefined) delete process.env.WEAVER_WORKER_MODEL;
    else process.env.WEAVER_WORKER_MODEL = prev;
  }
});

// --- attachToExisting: steering delivery + reopen, against a real temp store ---

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-onboard-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function seed(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: 'Landing-page video animations',
    objective: 'ship ambient videos',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
}

test('attachToExisting: active stream gets the message as steering and a wake', async () => {
  await seed('videos');
  const r = await attachToExisting('videos', 'the videos are missing again', 'pages show videos');
  assert.deepEqual(r, { action: 'steered', slug: 'videos', title: 'Landing-page video animations', reopened: false });
  const d = await load('videos');
  const note = d.steering[0];
  assert.ok(note);
  assert.match(note.body, /missing again/);
  assert.match(note.body, /Done means: pages show videos/);
  assert.ok(d.wakes.some((w) => w.status === 'pending'));
  assert.equal(d.workstream.status, 'active');
});

test('attachToExisting: a concluded stream is reopened, lineage kept', async () => {
  await seed('videos');
  const doc = await load('videos');
  await mutate('videos', doc.revision, (d, event) => {
    d.workstream.status = 'done';
    d.workstream.conclusion = { passId: 'pass_x', atVirtual: new Date().toISOString(), summary: 'shipped', evidenceIds: [] };
    event('workstream.concluded', 'shipped');
  });
  const r = await attachToExisting('videos', 'it broke again');
  assert.equal(r.action, 'steered');
  assert.equal(r.action === 'steered' && r.reopened, true);
  const after = await load('videos');
  assert.equal(after.workstream.status, 'active');
  assert.equal(after.steering.length, 1);
  // The reopen event carries the prior conclusion — supersession, not amnesia.
  assert.ok(after.events.some((e) => e.type === 'workstream.reopened' && e.summary.includes('shipped')));
});
