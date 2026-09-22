import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { arrive, createWorkstream, load } from './store.js';
import type { AttentionReadbackIO, PrStateReadback } from './attentionReadback.js';
import { extractPrCitations, runAttentionHints, workstreamRepos } from './attentionHints.js';
import type { AttentionItem } from './types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-attnhints-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function makeWorkstream(
  slug: string,
  opts: { constraints?: string[]; status?: 'active' | 'paused' | 'done' } = {},
): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'test attention hints',
    tags: [],
    successCriteria: [],
    constraints: opts.constraints ?? [],
    autonomy: { sendsRequireApproval: true },
  });
  if (opts.status && opts.status !== 'active') {
    await arrive(slug, (d) => {
      d.workstream.status = opts.status!;
    });
  }
}

async function addCard(
  slug: string,
  card: Pick<AttentionItem, 'id' | 'kind' | 'summary'> & Partial<AttentionItem>,
): Promise<void> {
  await arrive(slug, (d) => {
    d.attention.push({
      status: 'open',
      createdAt: new Date().toISOString(),
      ...card,
    } as AttentionItem);
  });
}

function stubIo(byRepo: Record<string, Map<number, PrStateReadback> | null | (() => Map<number, PrStateReadback> | null)>): AttentionReadbackIO {
  return {
    async githubPrStates(repo) {
      const entry = byRepo[repo.toLowerCase()];
      return typeof entry === 'function' ? entry() : entry ?? null;
    },
    async sentryIssueStatus() {
      return null;
    },
  };
}

function silent(): { out: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), lines };
}

// ---------------------------------------------------------------------------
// extractPrCitations — pure

test('extractPrCitations: URL form, with and without https://', () => {
  assert.deepEqual(
    extractPrCitations('see https://github.com/erdoai/erdo/pull/2686 for context', []),
    [{ repo: 'erdoai/erdo', number: 2686 }],
  );
  assert.deepEqual(
    extractPrCitations('see github.com/erdoai/erdo/pull/2686 for context', []),
    [{ repo: 'erdoai/erdo', number: 2686 }],
  );
});

test('extractPrCitations: owner/repo#n form is unambiguous with zero workstream repos', () => {
  assert.deepEqual(
    extractPrCitations('blocked on erdoai/erdo#2686 landing', []),
    [{ repo: 'erdoai/erdo', number: 2686 }],
  );
});

test('extractPrCitations: bare #n binds only with exactly one workstream repo', () => {
  assert.deepEqual(
    extractPrCitations('waiting on #42 to merge', ['erdoai/erdo']),
    [{ repo: 'erdoai/erdo', number: 42 }],
  );
  assert.deepEqual(extractPrCitations('waiting on #42 to merge', []), []);
  assert.deepEqual(extractPrCitations('waiting on #42 to merge', ['erdoai/erdo', 'erdoai/devbot']), []);
});

test('extractPrCitations: foo#12 and /#12 are never bound as bare citations', () => {
  assert.deepEqual(extractPrCitations('see foo#12 in the log', ['erdoai/erdo']), []);
  assert.deepEqual(extractPrCitations('path is /#12 in the log', ['erdoai/erdo']), []);
});

test('extractPrCitations: dedupes by repo (case-insensitive) and number, keeping first-seen casing', () => {
  const out = extractPrCitations(
    'erdoai/erdo#2686 and again ERDOAI/ERDO#2686 and https://github.com/erdoai/erdo/pull/2686',
    [],
  );
  assert.deepEqual(out, [{ repo: 'erdoai/erdo', number: 2686 }]);
});

// ---------------------------------------------------------------------------
// workstreamRepos

test('workstreamRepos: union of constraint URLs and readDirs repos, deduped', async () => {
  await makeWorkstream('ws-repos', { constraints: ['see https://github.com/erdoai/erdo for context'] });
  await arrive('ws-repos', (d) => {
    d.assignments.push({
      id: 'asg_1',
      objective: 'n/a',
      briefing: 'n/a',
      kind: 'work',
      readDirs: ['/repo/erdo', '/repo/missing'],
      acceptanceCriteria: ['n/a'],
      dependsOn: [],
      state: 'queued',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: new Date().toISOString(),
    } as never);
  });
  const doc = await load('ws-repos');
  const repoOfDir = (dir: string) => (dir === '/repo/erdo' ? 'erdoai/erdo' : dir === '/repo/missing' ? 'erdoai/devbot' : null);
  assert.deepEqual(workstreamRepos(doc, repoOfDir), ['erdoai/erdo', 'erdoai/devbot']);
});

// ---------------------------------------------------------------------------
// runAttentionHints

test('dry run: a MERGED PR citation produces wouldPost > 0 and writes nothing', async () => {
  await makeWorkstream('ws-dry');
  await addCard('ws-dry', { id: 'att_1', kind: 'blocker', summary: 'blocked on erdoai/erdo#2686 landing' });
  const before = await load('ws-dry');

  const io = stubIo({
    'erdoai/erdo': new Map([[2686, { number: 2686, state: 'MERGED', mergedAt: '2026-09-18T12:26:00Z' }]]),
  });
  const { out, lines } = silent();
  const result = await runAttentionHints({ apply: false, io, out });

  assert.equal(result.wouldPost, 1);
  assert.equal(result.posted, 0);
  assert.equal(result.duplicates, 0);
  assert.ok(lines.some((l) => l.includes('att_1 cites erdoai/erdo#2686 — MERGED at 2026-09-18T12:26Z; if the card only waited on that, withdraw it')));

  const after = await load('ws-dry');
  assert.equal(after.revision, before.revision, 'dry run must not write at all');
  assert.equal(after.observations.length, 0);
});

test('--apply posts exactly one observation per (card, PR, state); a second apply is all duplicates and revision is unchanged', async () => {
  await makeWorkstream('ws-apply');
  await addCard('ws-apply', { id: 'att_2', kind: 'blocker', summary: 'blocked on erdoai/erdo#2686 landing' });

  const io = stubIo({
    'erdoai/erdo': new Map([[2686, { number: 2686, state: 'MERGED', mergedAt: '2026-09-18T12:26:00Z' }]]),
  });

  const first = await runAttentionHints({ apply: true, io, out: () => {} });
  assert.equal(first.posted, 1);
  assert.equal(first.duplicates, 0);

  const afterFirst = await load('ws-apply');
  assert.equal(afterFirst.observations.length, 1);
  assert.equal(afterFirst.observations[0]!.source, 'attention-hints');
  assert.equal(afterFirst.observations[0]!.ingressKey, 'attention-hint:att_2:erdoai/erdo#2686:MERGED');
  assert.equal(
    afterFirst.observations[0]!.summary,
    'att_2 cites erdoai/erdo#2686 — MERGED at 2026-09-18T12:26Z; if the card only waited on that, withdraw it',
  );

  // Card stays open, never resolved, and this is never a human intervention.
  const card = afterFirst.attention.find((a) => a.id === 'att_2')!;
  assert.equal(card.status, 'open');
  assert.equal(afterFirst.spend.humanInterventions, 0);

  const revisionAfterFirst = afterFirst.revision;
  const second = await runAttentionHints({ apply: true, io, out: () => {} });
  assert.equal(second.posted, 0);
  assert.equal(second.duplicates, 1);

  const afterSecond = await load('ws-apply');
  assert.equal(afterSecond.revision, revisionAfterFirst, 'an all-duplicate apply must not write');
  assert.equal(afterSecond.observations.length, 1);
});

test('an OPEN PR produces no hint', async () => {
  await makeWorkstream('ws-open-pr');
  await addCard('ws-open-pr', { id: 'att_3', kind: 'blocker', summary: 'blocked on erdoai/erdo#2686 landing' });
  const io = stubIo({ 'erdoai/erdo': new Map([[2686, { number: 2686, state: 'OPEN' }]]) });
  const result = await runAttentionHints({ apply: true, io, out: () => {} });
  assert.equal(result.posted, 0);
  assert.equal(result.wouldPost, 0);
  assert.equal((await load('ws-open-pr')).observations.length, 0);
});

test('io returning null reports the repo as skipped and posts nothing', async () => {
  await makeWorkstream('ws-unreadable');
  await addCard('ws-unreadable', { id: 'att_4', kind: 'blocker', summary: 'blocked on erdoai/erdo#2686 landing' });
  const io = stubIo({ 'erdoai/erdo': null });
  const { out, lines } = silent();
  const result = await runAttentionHints({ apply: true, io, out });
  assert.equal(result.posted, 0);
  assert.deepEqual(result.skippedRepos, ['erdoai/erdo']);
  assert.ok(lines.some((l) => l.includes('skipped erdoai/erdo')));
});

test('a card that already declares that exact github_pr_state fact is not hinted', async () => {
  await makeWorkstream('ws-declared');
  await addCard('ws-declared', {
    id: 'att_5',
    kind: 'blocker',
    summary: 'blocked on erdoai/erdo#2686 landing',
    resolvesWhen: { any: [{ kind: 'github_pr_state', repo: 'erdoai/erdo', number: 2686, states: ['MERGED', 'CLOSED'] }] },
  });
  const io = stubIo({
    'erdoai/erdo': new Map([[2686, { number: 2686, state: 'MERGED', mergedAt: '2026-09-18T12:26:00Z' }]]),
  });
  const result = await runAttentionHints({ apply: true, io, out: () => {} });
  assert.equal(result.posted, 0);
  assert.equal(result.wouldPost, 0);
});

test('a done workstream is never hinted', async () => {
  await makeWorkstream('ws-done', { status: 'done' });
  await addCard('ws-done', { id: 'att_6', kind: 'blocker', summary: 'blocked on erdoai/erdo#2686 landing' });
  const io = stubIo({
    'erdoai/erdo': new Map([[2686, { number: 2686, state: 'MERGED', mergedAt: '2026-09-18T12:26:00Z' }]]),
  });
  const { out, lines } = silent();
  const result = await runAttentionHints({ apply: true, io, out });
  assert.equal(result.posted, 0);
  assert.equal(result.wouldPost, 0);
  assert.ok(lines.some((l) => l.includes('skipped 1 open card')));
});
