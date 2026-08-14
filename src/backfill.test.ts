/**
 * Deterministic backfill tests: rules-file parsing lands SHADOW policies with
 * full provenance, re-running dedups, authority-granting text is refused (not
 * converted), --dry-run writes nothing, and the transcript path's plumbing
 * refuses to run without a real directory. No model calls anywhere.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { backfillRules, extractUserMessages, parseRulesFile, planRulesRefresh, renderBackfillReport } from './backfill.js';
import { loadPolicies, matchPolicies } from './policies.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-test-'));
  process.env.WEAVER_HOME = path.join(tmp, 'home');
});

const RULES_MD = `# Team rules

Intro prose that is not a rule and must not become one.

## Working style

- Always run the full test suite and verify it passes before pushing.
- Keep responses concise; prefer bullet points for status updates.
- [Style guide](https://example.com/style)
- Feel free to merge good-looking PRs and send the announcement yourself.

**Close every loop.** A change is done when the outcome is confirmed, not when the diff exists.

## Commands

- \`make dangerous-thing\` runs the deploy pipeline

\`\`\`bash
- this bullet lives in a code block and must be ignored
\`\`\`
`;

function writeRules(): string {
  const p = path.join(tmp, 'CLAUDE.md');
  fs.writeFileSync(p, RULES_MD);
  return p;
}

test('rules bullets become shadow policies with file+heading provenance; internal sections, links, prose, and code blocks are ignored', async () => {
  const rulesPath = writeRules();
  const report = await backfillRules([rulesPath], ['myapp'], false);

  assert.equal(report.created.length, 3);
  const statements = report.created.map((p) => p.statement);
  assert.ok(statements.some((s) => s.includes('full test suite')));
  assert.ok(statements.some((s) => s.includes('concise')));
  assert.ok(statements.some((s) => s.includes('Close every loop')));
  // Nothing from the intro prose, the links-only line, ## Commands, or the fence.
  assert.ok(!statements.some((s) => s.includes('Intro prose')));
  assert.ok(!statements.some((s) => s.includes('Style guide')));
  assert.ok(!statements.some((s) => s.includes('deploy pipeline')));
  assert.ok(!statements.some((s) => s.includes('code block')));

  for (const p of report.created) {
    assert.equal(p.status, 'shadow'); // NEVER active — promotion is earned
    assert.equal(p.widensAuthority, false);
    assert.deepEqual(p.scope.tags, ['myapp']);
    assert.ok('source' in p.provenance && p.provenance.source === 'backfill:rules');
    assert.ok('ref' in p.provenance && p.provenance.ref.includes(rulesPath));
    assert.ok(p.provenance.interventionSummary.includes('Working style'));
  }

  // Verification-mandating text classifies as add_verification; the rest advisory.
  const verify = report.created.find((p) => p.statement.includes('full test suite'))!;
  assert.equal(verify.effect.kind, 'add_verification');
  const concise = report.created.find((p) => p.statement.includes('concise'))!;
  assert.equal(concise.effect.kind, 'advisory');

  // Backfilled policies enter the normal matching path like any other shadow.
  assert.equal((await matchPolicies(['myapp'])).length, 3);
  assert.equal((await matchPolicies(['unrelated'])).length, 0);
});

test('authority-granting text is refused with a note, never converted', async () => {
  const report = await backfillRules([writeRules()], ['myapp'], false);
  assert.equal(report.skipped.length, 1);
  assert.ok(report.skipped[0]!.text.includes('Feel free to merge'));
  assert.ok(report.skipped[0]!.reason.includes('authority'));
  assert.ok(!(await loadPolicies()).policies.some((p) => p.statement.includes('merge')));
});

test('re-running backfill is a no-op: dedup on normalized statement', async () => {
  const rulesPath = writeRules();
  const first = await backfillRules([rulesPath], ['myapp'], false);
  assert.equal(first.created.length, 3);

  const second = await backfillRules([rulesPath], ['myapp'], false);
  assert.equal(second.created.length, 0);
  assert.equal(second.duplicates.length, 3);
  assert.equal((await loadPolicies()).policies.length, 3);
});

test('--dry-run reports what would be created and writes nothing', async () => {
  const report = await backfillRules([writeRules()], ['myapp'], true);
  assert.equal(report.wouldCreate.length, 3);
  assert.equal(report.created.length, 0);
  assert.equal((await loadPolicies()).policies.length, 0);
});

test('parseRulesFile requires a level-2+ heading above a rule', async () => {
  const p = path.join(tmp, 'flat.md');
  fs.writeFileSync(p, `# Only a title\n\n- A rule with no section heading above it at all.\n`);
  assert.equal(parseRulesFile(p).candidates.length, 0);
});

test('transcript extraction refuses a missing directory and keeps only the human speaking', async () => {
  assert.throws(() => extractUserMessages(path.join(tmp, 'nope'), 5), /--claude-projects/);

  const dir = path.join(tmp, 'projects');
  fs.mkdirSync(dir);
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'never push to main directly, always branch first' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } }),
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'use yarn, not npm' }] } }),
  ];
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), lines.join('\n') + '\n');

  const sessions = extractUserMessages(dir, 5);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, 'sess-1');
  assert.deepEqual(sessions[0]!.messages, [
    'never push to main directly, always branch first',
    'use yarn, not npm',
  ]);
});

test('seed roundtrip: sanitized export, shadow import, dedup, authority refused, superseded stays home', async () => {
  const { exportSeed, importSeed, loadPolicies, proposeBackfillPolicy, supersedePolicy } = await import('./policies.js');
  const { grantsAuthority } = await import('./backfill.js');

  await proposeBackfillPolicy({
    statement: 'Never retry an external mutation after an unknown result.',
    tags: ['myapp'], effectKind: 'advisory', effectDescription: 'readback first',
    source: 'backfill:rules', ref: '/Users/someone/private/CLAUDE.md § Rules',
    interventionSummary: 'quote: "the password is hunter2"',
  });
  const dead = await proposeBackfillPolicy({
    statement: 'An outgrown rule.', tags: ['myapp'], effectKind: 'advisory', effectDescription: 'x',
    source: 'backfill:rules', ref: 'CLAUDE.md § Old', interventionSummary: 'n/a',
  });
  await supersedePolicy(dead.id, {
    statement: 'The replacement rule.', tags: ['myapp'], effectKind: 'advisory', effectDescription: 'x',
    workstreamSlug: 'test-ws', passId: 'pass_test', interventionSummary: 'n/a',
  });

  const seed = await exportSeed('niall');
  const raw = JSON.stringify(seed);
  assert.ok(!raw.includes('hunter2'), 'seed leaked an intervention summary');
  assert.ok(!raw.includes('/Users/someone/private'), 'seed leaked an absolute path');
  assert.ok(!raw.includes('An outgrown rule'), 'seed exported a superseded policy');
  assert.equal(seed.policies.length, 2);

  // Import into a fresh home (a teammate's machine).
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-seed-'));
  const withAuthority = { ...seed, policies: [...seed.policies, { statement: 'Feel free to merge PRs yourself whenever.', tags: ['myapp'], effect: { kind: 'advisory' as const, description: 'x' }, origin: 'evil' }] };
  const res = await importSeed(withAuthority, { refuseAuthority: grantsAuthority });
  assert.equal(res.imported, 2);
  assert.equal(res.refused.length, 1);
  assert.ok((await loadPolicies()).policies.every((p) => p.status === 'shadow'));

  const again = await importSeed(withAuthority, { refuseAuthority: grantsAuthority });
  assert.equal(again.imported, 0);
  assert.equal(again.skippedDuplicate, 2);
});

// ---------------------------------------------------------------------------
// Refresh: a rules file is edited, and the store follows it.

const EDITED_RULES = `# Team rules

Intro prose that is not a rule and must not become one.

## Working style

- Always run the full test suite and verify it passes before pushing, and read every failure.
- Keep responses concise; prefer bullet points for status updates.

**Close every loop.** A change is done when the outcome is confirmed, not when the diff exists.
`;

test('re-running after an edited rule updates that policy in place, keeps its id, and leaves its siblings alone', async () => {
  const rulesPath = writeRules();
  const first = await backfillRules([rulesPath], ['myapp'], false);
  assert.equal(first.created.length, 3);
  const before = first.created.find((p) => p.statement.includes('full test suite'))!;
  const untouched = first.created.find((p) => p.statement.includes('concise'))!;

  fs.writeFileSync(rulesPath, EDITED_RULES);
  const second = await backfillRules([rulesPath], ['myapp'], false);

  assert.equal(second.created.length, 0, 'an edited rule is the same rule, not a new one');
  assert.equal(second.refreshed.length, 1);
  assert.equal(second.refreshed[0]!.id, before.id, 'identity survives the edit');
  assert.match(second.refreshed[0]!.after, /read every failure/);
  assert.equal(second.duplicates.length, 2, 'the unedited rules are still a no-op');

  const stored = (await loadPolicies()).policies;
  assert.equal(stored.length, 3, 'refresh updates rather than accumulating a second copy');
  const updated = stored.find((p) => p.id === before.id)!;
  assert.match(updated.statement, /read every failure/);
  assert.equal(updated.createdAt, before.createdAt);
  assert.equal(stored.find((p) => p.id === untouched.id)!.statement, untouched.statement);
});

test('a refreshed rule contests the learned policies scoped to it, so nothing keeps guiding under wording the operator abandoned', async () => {
  const { proposePolicy } = await import('./policies.js');
  const rulesPath = writeRules();
  await backfillRules([rulesPath], ['myapp'], false);
  const learned = await proposePolicy({
    statement: 'Run only the tests near the change when the suite is slow',
    tags: ['myapp'], effectKind: 'advisory', effectDescription: 'x',
    workstreamSlug: 'ws-src', passId: 'pass_1', interventionSummary: 'i',
  });

  fs.writeFileSync(rulesPath, EDITED_RULES);
  const report = await backfillRules([rulesPath], ['myapp'], false);
  assert.deepEqual(report.refreshed[0]!.contested, [learned.id]);

  const stored = (await loadPolicies()).policies.find((p) => p.id === learned.id)!;
  assert.equal(stored.contested?.byPolicyId, report.refreshed[0]!.id);
  assert.match(stored.contested!.note, /refreshed doctrine/);

  const rendered = renderBackfillReport(report, false);
  assert.match(rendered, /rule text updated in place/);
  assert.match(rendered, /contested 1 learned policy/);
});

test('a deleted section retires its policies with the reason; a bullet that merely stopped parsing does not', async () => {
  const rulesPath = writeRules();
  const first = await backfillRules([rulesPath], ['myapp'], false);
  const inStyle = first.created.filter((p) => 'ref' in p.provenance && p.provenance.ref.includes('Working style'));
  assert.equal(inStyle.length, 3);

  // The whole section is gone: those rules are gone with it.
  fs.writeFileSync(rulesPath, `# Team rules\n\n## Release process\n\n- Tag the release before announcing it anywhere.\n`);
  const second = await backfillRules([rulesPath], ['myapp'], false);
  assert.equal(second.retired.length, 3);
  assert.ok(second.retired.every((r) => r.reason.includes('no longer exists')));
  const stored = (await loadPolicies()).policies;
  for (const p of inStyle) {
    const now = stored.find((x) => x.id === p.id)!;
    assert.equal(now.status, 'superseded');
    assert.equal(now.supersededBy, undefined);
  }

  // The section survives but one bullet no longer parses as a rule (here: too
  // short). That is our heuristics changing their mind, not the operator
  // deleting a rule, so nothing is retired.
  const kept = (await loadPolicies()).policies.find((p) => p.statement.includes('Tag the release'))!;
  fs.writeFileSync(rulesPath, `# Team rules\n\n## Release process\n\n- Tag it.\n`);
  const third = await backfillRules([rulesPath], ['myapp'], false);
  assert.equal(third.retired.length, 0);
  assert.equal((await loadPolicies()).policies.find((p) => p.id === kept.id)!.status, 'shadow');
});

test('--dry-run shows the refresh and the contest blast radius before anything is written', async () => {
  const { proposePolicy } = await import('./policies.js');
  const rulesPath = writeRules();
  await backfillRules([rulesPath], ['myapp'], false);
  const learned = await proposePolicy({
    statement: 'Run only the tests near the change when the suite is slow',
    tags: ['myapp'], effectKind: 'advisory', effectDescription: 'x',
    workstreamSlug: 'ws-src', passId: 'pass_1', interventionSummary: 'i',
  });
  const snapshot = JSON.stringify((await loadPolicies()).policies);

  fs.writeFileSync(rulesPath, EDITED_RULES);
  const report = await backfillRules([rulesPath], ['myapp'], true);
  assert.equal(report.refreshed.length, 1);
  assert.deepEqual(report.refreshed[0]!.contested, [learned.id]);
  assert.match(renderBackfillReport(report, true), /would contest 1 learned policy/);
  assert.equal(JSON.stringify((await loadPolicies()).policies), snapshot, '--dry-run writes nothing');
});

test('planRulesRefresh pairs an edited rule with its policy only when each is the other\'s closest match', () => {
  const ref = '/repo/CLAUDE.md § Working style';
  const stored = [
    {
      id: 'pol_tests', statement: 'Always run the full test suite before pushing',
      scope: { tags: ['myapp'] }, effect: { kind: 'add_verification' as const, description: 'x' },
      widensAuthority: false as const, status: 'shadow' as const,
      provenance: { source: 'backfill:rules' as const, ref, interventionSummary: 'i' },
      evidence: [], createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'pol_concise', statement: 'Keep responses concise and prefer bullet points',
      scope: { tags: ['myapp'] }, effect: { kind: 'advisory' as const, description: 'x' },
      widensAuthority: false as const, status: 'shadow' as const,
      provenance: { source: 'backfill:rules' as const, ref, interventionSummary: 'i' },
      evidence: [], createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const candidate = (statement: string) => ({
    statement, effectKind: 'advisory' as const, effectDescription: 'x',
    source: 'backfill:rules' as const, ref, interventionSummary: 'i',
  });

  // Reworded → update; unrelated → create; untouched → unchanged.
  const plan = planRulesRefresh(
    [
      candidate('Always run the full test suite before pushing, and read every failure'),
      candidate('Keep responses concise and prefer bullet points'),
      candidate('Name the workspace directory in every brief'),
    ],
    [{ path: '/repo/CLAUDE.md', sections: [ref] }],
    stored,
  );
  assert.deepEqual(plan.updates.map((u) => u.id), ['pol_tests']);
  assert.deepEqual(plan.unchanged.map((u) => u.id), ['pol_concise']);
  assert.deepEqual(plan.creates.map((c) => c.statement), ['Name the workspace directory in every brief']);
  assert.equal(plan.retires.length, 0);

  // A rewrite that keeps too little of the original is a new rule, not an edit
  // — the conservative direction: an extra candidate to supersede beats
  // overwriting a rule the operator still holds.
  const rewritten = planRulesRefresh(
    [candidate('Ship behind a flag and roll it out to staff first')],
    [{ path: '/repo/CLAUDE.md', sections: [ref] }],
    stored,
  );
  assert.equal(rewritten.updates.length, 0);
  assert.equal(rewritten.creates.length, 1);
});

test('a renamed heading moves the rule instead of deleting it — the operator still has the rule, so the store must too', async () => {
  const rulesPath = writeRules();
  const first = await backfillRules([rulesPath], ['myapp'], false);
  const concise = first.created.find((p) => p.statement.includes('concise'))!;

  // Same three rules, same words, one renamed section.
  fs.writeFileSync(
    rulesPath,
    RULES_MD.replace('## Working style', '## How we work'),
  );
  const second = await backfillRules([rulesPath], ['myapp'], false);

  assert.equal(second.retired.length, 0, 'a rename is not a deletion');
  assert.equal(second.created.length, 0, 'and it is not three new rules either');
  assert.equal(second.moved.length, 3);
  const stored = (await loadPolicies()).policies;
  assert.equal(stored.length, 3);
  const kept = stored.find((p) => p.id === concise.id)!;
  assert.equal(kept.status, 'shadow');
  assert.ok('ref' in kept.provenance && kept.provenance.ref.includes('How we work'), 'the ref follows the text');
  assert.match(renderBackfillReport(second, false), /under a different section/);
});
