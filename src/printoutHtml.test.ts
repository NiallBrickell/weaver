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

async function make(slug: string, title = `Printout ${slug}`): Promise<void> {
  await createWorkstream({
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

async function delivered(slug?: string): Promise<void> {
  acknowledgePrintout(await preparePrintout(slug));
}

test('HTML is a continuous engineering document, self-contained, escaped, and copyable', async () => {
  await make('semantic', '<img src=x onerror=alert(1)> & semantic');
  await arrive('semantic', (doc, event) => {
    doc.assignments.push({
      id: 'asg_verified', objective: 'Open PR <script>alert(2)</script>', briefing: 'use gh', kind: 'action',
      exec: { cwd: '/tmp', verify: 'gh pr view', verified: { ok: true, output: 'PR is OPEN', at: new Date().toISOString() } },
      acceptanceCriteria: [], dependsOn: [], state: 'completed', attempts: [], adoption: { state: 'accepted', passId: 'pass_1' },
      createdAtVirtual: new Date().toISOString(),
    });
    event('action.verified', 'PR readback passed');
  });

  const html = renderPrintoutHtml(await preparePrintout('semantic'));
  assert.match(html, /<article class="edition">/);
  assert.match(html, /<section class="workstream" id="workstream-semantic">/);
  assert.match(html, /<section class="report-section technical">/);
  assert.match(html, /--paper:#f7f9f8/);
  assert.match(html, /font-family:Charter/);
  assert.match(html, /max-width:46rem/);
  assert.doesNotMatch(html, /<details\b|scope-card|\bpill\b/);
  assert.match(html, /href="\.\.\/\.\.\/index\.html"/);
  assert.match(html, /href="\.\.\/\.\.\/\.\.\/semantic\/inspect\.html"/);
  assert.match(html, /Copy plain-text report/);
  assert.match(html, /event\.key === 'C'/);
  assert.match(html, /VERIFIED EXTERNAL EFFECT/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\(2\)<\/script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; semantic/);
  assert.doesNotMatch(html, /<link\b|<script\b[^>]*\bsrc=|@import\s|url\(https?:/);
});

test('fleet HTML places every source in one visible document flow', async () => {
  await make('alpha', 'Alpha stream');
  await make('beta', 'Beta stream');

  const html = renderPrintoutHtml(await preparePrintout());
  const alpha = html.indexOf('<section class="workstream" id="workstream-alpha">');
  const beta = html.indexOf('<section class="workstream" id="workstream-beta">');
  const policies = html.indexOf('<section class="policy-report" id="global-learning">');
  assert.ok(alpha >= 0 && beta > alpha && policies > beta);
  assert.match(html, /href="#workstream-alpha">Alpha stream<\/a>/);
  assert.match(html, /href="#workstream-beta">Beta stream<\/a>/);
  assert.doesNotMatch(html, /<details\b|scope-grid|scope-card|\bpill\b/);
});

test('browser handoff gates the exact frozen checkpoint and preserves concurrent arrivals', async () => {
  await make('race');
  await delivered('race');
  await arrive('race', (_doc, event) => event('first.change', 'first frozen change'));
  const beforePublishRevision = (await load('race')).revision;
  let releaseOpen!: () => void;
  const browserGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  // The publish flow is async end to end (the store is), so the test must
  // wait for the browser handoff to BEGIN before asserting the frozen state.
  let openStarted!: () => void;
  const openStartedGate = new Promise<void>((resolve) => { openStarted = resolve; });
  let openedPath = '';

  const pending = publishPrintoutHtml('race', {
    openFile: async (filePath) => {
      openedPath = filePath;
      assert.ok(fs.existsSync(filePath));
      assert.ok(fs.existsSync(path.join(weaverHome(), 'printouts', 'index.html')));
      openStarted();
      await browserGate;
    },
  });
  await openStartedGate;
  assert.ok(openedPath.endsWith('.html'));
  assert.equal((await load('race')).revision, beforePublishRevision);

  await arrive('race', (_doc, event) => event('second.change', 'arrived during browser handoff'));
  releaseOpen();
  const published = await pending;
  const archived = fs.readFileSync(published.path, 'utf8');
  assert.match(archived, /first frozen change/);
  assert.doesNotMatch(archived, /arrived during browser handoff/);

  const next = (await preparePrintout('race')).text;
  assert.doesNotMatch(next, /first frozen change/);
  assert.match(next, /arrived during browser handoff/);
});

test('failed browser opening leaves the window pending while retaining a discoverable archive', async () => {
  await make('open-failure');
  await delivered('open-failure');
  await arrive('open-failure', (_doc, event) => event('pending.change', 'repeat this window'));

  await assert.rejects(
    publishPrintoutHtml('open-failure', { openFile: async () => { throw new Error('no browser'); } }),
    /HTML is available at .*no browser/,
  );
  assert.match((await preparePrintout('open-failure')).text, /repeat this window/);
  const hub = fs.readFileSync(path.join(weaverHome(), 'printouts', 'index.html'), 'utf8');
  assert.match(hub, /open-failure/);
  assert.match(hub, /archives\/open-failure\/.*\.html/);
});

test('archives are immutable and the hub retains every delivered window', async () => {
  await make('archive');
  const first = await publishPrintoutHtml('archive', { openFile: async () => {} });
  const firstBytes = fs.readFileSync(first.path);
  await arrive('archive', (_doc, event) => event('later.change', 'a second window'));
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
  await make('odd.dot');
  await make('odd+dot');
  const first = await publishPrintoutHtml('odd.dot', { openFile: async () => {} });
  const second = await publishPrintoutHtml('odd+dot', { openFile: async () => {} });

  assert.notEqual(path.dirname(first.path), path.dirname(second.path));
  assert.ok(first.path.startsWith(path.join(weaverHome(), 'printouts', 'archives') + path.sep));
  assert.ok(second.path.startsWith(path.join(weaverHome(), 'printouts', 'archives') + path.sep));
});

test('the hub has an honest empty state, skips malformed metadata, and ignores metadata hrefs', async () => {
  const emptyHub = await writePrintoutIndex();
  assert.match(fs.readFileSync(emptyHub, 'utf8'), /No printout has been opened yet/);

  const dir = path.join(weaverHome(), 'printouts', 'archives', 'unsafe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'valid.html'), '<!doctype html><title>safe</title>');
  fs.writeFileSync(path.join(dir, 'valid.json'), JSON.stringify({
    schemaVersion: 1, scope: 'unsafe', through: '2026-08-06T12:00:00.000Z', workstreamCount: 1,
    relativePath: '../../outside.html', published: true,
  }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  const rebuilt = fs.readFileSync(await writePrintoutIndex(), 'utf8');
  assert.match(rebuilt, /archives\/unsafe\/valid\.html/);
  assert.doesNotMatch(rebuilt, /\.\.\/\.\.\/outside\.html/);
  assert.match(rebuilt, /Unreadable archives/);
  assert.match(rebuilt, /unsafe\/broken\.json/);
});

test('fleet archives and knowledge pages redact colliding local secret names', async () => {
  await make('alpha');
  await make('beta');
  const alphaValue = 'alpha-local-secret-4815';
  const betaValue = 'beta-local-secret-9264';
  await proposeBackfillPolicy({
    statement: `Never expose ${alphaValue} or ${betaValue}`,
    tags: ['shared'],
    effectKind: 'advisory',
    effectDescription: `redact ${alphaValue} and ${betaValue}`,
    source: 'seed',
    ref: 'security',
    interventionSummary: 'seeded before the values were registered',
  });
  // Each workstream's own typed state also carries BOTH values, so every page
  // is asked to redact the neighbouring workstream's colliding TOKEN as well
  // as its own. (The seeded policy above covers learned.html, which lists the
  // whole store; a workstream page shows only the policies that shaped it, so
  // its leak has to come from its own state. The fleet overview carries no
  // policy prose and no secret-bearing state in this fixture, so it is only
  // asserted clean, not marked.)
  for (const slug of ['alpha', 'beta']) {
    await arrive(slug, (doc) => {
      doc.decisions.push({
        id: `dec_${slug}_token`,
        title: 'Use the local token',
        rationale: `tokens ${alphaValue} and ${betaValue} both work here`,
        madeBy: 'coordinator',
        status: 'standing',
        decidedAtVirtual: new Date().toISOString(),
      });
    });
  }
  setSecret('TOKEN', alphaValue, 'alpha');
  setSecret('TOKEN', betaValue, 'beta');

  const published = await publishPrintoutHtml(undefined, { openFile: async () => {} });
  await runInspect();
  const overviewPath = path.join(weaverHome(), 'inspect.html');
  for (const file of [
    published.path,
    published.hubPath,
    overviewPath,
    path.join(weaverHome(), 'learned.html'),
    path.join(weaverHome(), 'alpha', 'inspect.html'),
    path.join(weaverHome(), 'beta', 'inspect.html'),
  ]) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, new RegExp(`${alphaValue}|${betaValue}`), file);
    if (file !== published.hubPath && file !== overviewPath) assert.match(content, /«secret:/, file);
  }
});
