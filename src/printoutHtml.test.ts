/** Deterministic HTML/archive contract: no browser, model, or network. */

import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runInspect } from './inspect.js';
import { proposeBackfillPolicy } from './policies.js';
import { acknowledgePrintout, preparePrintout } from './printout.js';
import { publishPrintoutHtml, renderPrintoutHtml, writePrintoutIndex } from './printoutHtml.js';
import { setSecret } from './secrets.js';
import { arrive, createWorkstream, load, weaverHome } from './store.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-printout-html-'));
});

function make(slug: string, title = `Printout ${slug}`): void {
  createWorkstream({
    slug,
    title,
    objective: `make ${slug} legible`,
    tags: ['shared'],
    successCriteria: ['the outcome is evidence-backed'],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });
}

function delivered(slug?: string): void {
  acknowledgePrintout(preparePrintout(slug));
}

test('HTML is semantic, self-contained, escaped, collapsible, and copyable', () => {
  make('semantic', '<img src=x onerror=alert(1)> & semantic');
  arrive('semantic', (doc, event) => {
    doc.assignments.push({
      id: 'asg_verified', objective: 'Open PR <script>alert(2)</script>', briefing: 'use gh', kind: 'action',
      exec: { cwd: '/tmp', verify: 'gh pr view', verified: { ok: true, output: 'PR is OPEN', at: new Date().toISOString() } },
      acceptanceCriteria: [], dependsOn: [], state: 'completed', attempts: [], adoption: { state: 'accepted', passId: 'pass_1' },
      createdAtVirtual: new Date().toISOString(),
    });
    event('action.verified', 'PR readback passed');
  });

  const html = renderPrintoutHtml(preparePrintout('semantic'));
  assert.match(html, /class="hero"/);
  assert.match(html, /<details class="report" id="semantic" open>/);
  assert.match(html, /<details class="technical"><summary>Exact typed mutation timeline/);
  assert.match(html, /Copy plain-text report/);
  assert.match(html, /event\.key === 'C'/);
  assert.match(html, /VERIFIED EXTERNAL EFFECT/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; semantic/);
  assert.doesNotMatch(html, /<link\b|<script\b[^>]*\bsrc=|@import\s|url\(https?:/);
});

test('browser handoff gates the exact frozen checkpoint and preserves concurrent arrivals', async () => {
  make('race');
  delivered('race');
  arrive('race', (_doc, event) => event('first.change', 'first frozen change'));
  const beforePublishRevision = load('race').revision;
  let releaseOpen!: () => void;
  const browserGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let openedPath = '';

  const pending = publishPrintoutHtml('race', {
    openFile: async (filePath) => {
      openedPath = filePath;
      assert.ok(fs.existsSync(filePath));
      assert.ok(fs.existsSync(path.join(weaverHome(), 'printouts', 'index.html')));
      await browserGate;
    },
  });
  assert.ok(openedPath.endsWith('.html'));
  assert.equal(load('race').revision, beforePublishRevision);

  arrive('race', (_doc, event) => event('second.change', 'arrived during browser handoff'));
  releaseOpen();
  const published = await pending;
  const archived = fs.readFileSync(published.path, 'utf8');
  assert.match(archived, /first frozen change/);
  assert.doesNotMatch(archived, /arrived during browser handoff/);

  const next = preparePrintout('race').text;
  assert.doesNotMatch(next, /first frozen change/);
  assert.match(next, /arrived during browser handoff/);
});

test('failed browser opening leaves the window pending while retaining a discoverable archive', async () => {
  make('open-failure');
  delivered('open-failure');
  arrive('open-failure', (_doc, event) => event('pending.change', 'repeat this window'));

  await assert.rejects(
    publishPrintoutHtml('open-failure', { openFile: async () => { throw new Error('no browser'); } }),
    /HTML is available at .*no browser/,
  );
  assert.match(preparePrintout('open-failure').text, /repeat this window/);
  const hub = fs.readFileSync(path.join(weaverHome(), 'printouts', 'index.html'), 'utf8');
  assert.match(hub, /open-failure/);
  assert.match(hub, /archives\/open-failure\/.*\.html/);
});

test('archives are immutable and the hub retains every delivered window', async () => {
  make('archive');
  const first = await publishPrintoutHtml('archive', { openFile: async () => {} });
  const firstBytes = fs.readFileSync(first.path);
  arrive('archive', (_doc, event) => event('later.change', 'a second window'));
  const second = await publishPrintoutHtml('archive', { openFile: async () => {} });

  assert.notEqual(first.path, second.path);
  assert.deepEqual(fs.readFileSync(first.path), firstBytes);
  const hub = fs.readFileSync(second.hubPath, 'utf8');
  const firstHref = path.relative(path.dirname(second.hubPath), first.path).split(path.sep).join('/');
  const secondHref = path.relative(path.dirname(second.hubPath), second.path).split(path.sep).join('/');
  assert.match(hub, new RegExp(firstHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(hub, new RegExp(secondHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('unusual scopes cannot collide in the archive filesystem', async () => {
  make('odd.dot');
  make('odd+dot');
  const first = await publishPrintoutHtml('odd.dot', { openFile: async () => {} });
  const second = await publishPrintoutHtml('odd+dot', { openFile: async () => {} });

  assert.notEqual(path.dirname(first.path), path.dirname(second.path));
  assert.ok(first.path.startsWith(path.join(weaverHome(), 'printouts', 'archives') + path.sep));
  assert.ok(second.path.startsWith(path.join(weaverHome(), 'printouts', 'archives') + path.sep));
});

test('the hub has an honest empty state, skips malformed metadata, and ignores metadata hrefs', () => {
  const emptyHub = writePrintoutIndex();
  assert.match(fs.readFileSync(emptyHub, 'utf8'), /No printout has been opened yet/);

  const dir = path.join(weaverHome(), 'printouts', 'archives', 'unsafe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'valid.html'), '<!doctype html><title>safe</title>');
  fs.writeFileSync(path.join(dir, 'valid.json'), JSON.stringify({
    schemaVersion: 1, scope: 'unsafe', through: '2026-08-06T12:00:00.000Z', workstreamCount: 1,
    relativePath: '../../outside.html', published: true,
  }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  const rebuilt = fs.readFileSync(writePrintoutIndex(), 'utf8');
  assert.match(rebuilt, /archives\/unsafe\/valid\.html/);
  assert.doesNotMatch(rebuilt, /\.\.\/\.\.\/outside\.html/);
  assert.match(rebuilt, /Unreadable archives/);
  assert.match(rebuilt, /unsafe\/broken\.json/);
});

test('fleet archives and knowledge pages redact colliding local secret names', async () => {
  make('alpha');
  make('beta');
  const alphaValue = 'alpha-local-secret-4815';
  const betaValue = 'beta-local-secret-9264';
  proposeBackfillPolicy({
    statement: `Never expose ${alphaValue} or ${betaValue}`,
    tags: ['shared'],
    effectKind: 'advisory',
    effectDescription: `redact ${alphaValue} and ${betaValue}`,
    source: 'seed',
    ref: 'security',
    interventionSummary: 'seeded before the values were registered',
  });
  setSecret('TOKEN', alphaValue, 'alpha');
  setSecret('TOKEN', betaValue, 'beta');

  const published = await publishPrintoutHtml(undefined, { openFile: async () => {} });
  runInspect();
  for (const file of [
    published.path,
    published.hubPath,
    path.join(weaverHome(), 'inspect.html'),
    path.join(weaverHome(), 'alpha', 'inspect.html'),
    path.join(weaverHome(), 'beta', 'inspect.html'),
  ]) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, new RegExp(`${alphaValue}|${betaValue}`), file);
    if (file !== published.hubPath) assert.match(content, /«secret:/, file);
  }
});
