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

import { backfillRules, extractUserMessages, parseRulesFile } from './backfill.js';
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

test('rules bullets become shadow policies with file+heading provenance; internal sections, links, prose, and code blocks are ignored', () => {
  const rulesPath = writeRules();
  const report = backfillRules([rulesPath], ['acme'], false);

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
    assert.deepEqual(p.scope.tags, ['acme']);
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
  assert.equal(matchPolicies(['acme']).length, 3);
  assert.equal(matchPolicies(['unrelated']).length, 0);
});

test('authority-granting text is refused with a note, never converted', () => {
  const report = backfillRules([writeRules()], ['acme'], false);
  assert.equal(report.skipped.length, 1);
  assert.ok(report.skipped[0]!.text.includes('Feel free to merge'));
  assert.ok(report.skipped[0]!.reason.includes('authority'));
  assert.ok(!loadPolicies().policies.some((p) => p.statement.includes('merge')));
});

test('re-running backfill is a no-op: dedup on normalized statement', () => {
  const rulesPath = writeRules();
  const first = backfillRules([rulesPath], ['acme'], false);
  assert.equal(first.created.length, 3);

  const second = backfillRules([rulesPath], ['acme'], false);
  assert.equal(second.created.length, 0);
  assert.equal(second.duplicates.length, 3);
  assert.equal(loadPolicies().policies.length, 3);
});

test('--dry-run reports what would be created and writes nothing', () => {
  const report = backfillRules([writeRules()], ['acme'], true);
  assert.equal(report.wouldCreate.length, 3);
  assert.equal(report.created.length, 0);
  assert.equal(loadPolicies().policies.length, 0);
});

test('parseRulesFile requires a level-2+ heading above a rule', () => {
  const p = path.join(tmp, 'flat.md');
  fs.writeFileSync(p, `# Only a title\n\n- A rule with no section heading above it at all.\n`);
  assert.equal(parseRulesFile(p).candidates.length, 0);
});

test('transcript extraction refuses a missing directory and keeps only the human speaking', () => {
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
