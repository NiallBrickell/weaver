import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { it } from 'node:test';
import { COORDINATOR_SYSTEM_PROMPT } from './coordinator.js';

// "Founder" was renamed to "the human" in code in August, but the word lived
// on in docs, examples copied into workstream constraints, and stored history
// that every fresh pass re-read and imitated. The prompts now name the word
// only to forbid it; nothing else in the repo may reintroduce it.
it('the repo says "the human", never "founder", outside the rule that forbids it', () => {
  const files = execFileSync('git', ['ls-files', 'src', 'docs', 'docs-public', 'AGENTS.md', 'CLAUDE.md', 'README.md'], {
    encoding: 'utf8',
  }).split('\n').filter((file) => file && file !== 'src/vocabulary.test.ts' && fs.existsSync(file));
  const offenders = files.flatMap((file) =>
    fs.readFileSync(file, 'utf8').split('\n')
      .map((line, index) => ({ file, line: index + 1, text: line }))
      .filter(({ text }) => /founder/i.test(text) && !/never "founder"|Never "founder"/.test(text)));
  assert.deepEqual(offenders.map(({ file, line }) => `${file}:${line}`), []);
  assert.match(COORDINATOR_SYSTEM_PROMPT, /Never "founder"/);
});
