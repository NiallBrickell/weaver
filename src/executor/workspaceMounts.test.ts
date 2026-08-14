import { strict as assert } from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OPENHANDS_WORKSPACE,
  planWorkspaceMounts,
} from './workspaceMounts.js';

test('plans deterministic read-write mounts and maps nested sources through cwd', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-workspace-mounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work tree');
  const nested = join(cwd, 'docs', 'source');
  const externalOne = join(root, 'external one');
  const externalTwo = join(root, 'external-two');
  mkdirSync(nested, { recursive: true });
  mkdirSync(externalOne);
  mkdirSync(externalTwo);

  const prompt = [
    `Read ${nested}/brief.md and edit ${cwd}/src/index.ts.`,
    `Compare ${externalOne}/reference.md with ${externalTwo}.`,
    `Do not rewrite the lookalike ${cwd}-archive path.`,
  ].join('\n');
  const plan = planWorkspaceMounts({
    cwd,
    additionalDirectories: [nested, externalOne, nested, externalTwo, cwd],
    prompt,
  });

  assert.equal(plan.workingDirectory, OPENHANDS_WORKSPACE);
  assert.deepEqual(plan.mounts, [
    { hostPath: realpathSync(cwd), containerPath: '/workspace' },
    { hostPath: realpathSync(externalOne), containerPath: '/weaver-sources/1' },
    { hostPath: realpathSync(externalTwo), containerPath: '/weaver-sources/2' },
  ]);
  assert.deepEqual(plan.dockerArgs, [
    '--volume', `${realpathSync(cwd)}:/workspace:rw`,
    '--volume', `${realpathSync(externalOne)}:/weaver-sources/1:rw`,
    '--volume', `${realpathSync(externalTwo)}:/weaver-sources/2:rw`,
  ]);
  assert.match(plan.prompt, /Read \/workspace\/docs\/source\/brief\.md/);
  assert.match(plan.prompt, /edit \/workspace\/src\/index\.ts/);
  assert.match(plan.prompt, /Compare \/weaver-sources\/1\/reference\.md with \/weaver-sources\/2\./);
  assert.ok(plan.prompt.includes(`${cwd}-archive`));
  assert.match(plan.prompt, /OpenHands workspace path mapping \(host → container\):/);
  assert.ok(plan.prompt.includes(`- ${nested} → /workspace/docs/source`));
  assert.ok(plan.prompt.includes(`- ${externalOne} → /weaver-sources/1`));
});

test('deduplicates canonical source directories while rewriting every supplied alias', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-workspace-aliases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  const source = join(root, 'source');
  const alias = join(cwd, 'source-alias');
  mkdirSync(cwd);
  mkdirSync(source);
  symlinkSync(source, alias, 'dir');

  const plan = planWorkspaceMounts({
    cwd,
    additionalDirectories: [alias, source],
    prompt: `Use ${alias}/one.md and ${source}/two.md.`,
  });

  assert.deepEqual(plan.mounts, [
    { hostPath: realpathSync(cwd), containerPath: '/workspace' },
    { hostPath: realpathSync(source), containerPath: '/weaver-sources/1' },
  ]);
  assert.match(plan.prompt, /Use \/weaver-sources\/1\/one\.md and \/weaver-sources\/1\/two\.md\./);
  assert.equal(
    plan.dockerArgs.filter((argument) => argument === '--volume').length,
    2,
  );
});

test('fails clearly for a missing additional source without creating it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-workspace-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  const missing = join(root, 'not-created');
  mkdirSync(cwd);

  assert.throws(
    () => planWorkspaceMounts({
      cwd,
      additionalDirectories: [missing],
      prompt: 'Read the source.',
    }),
    (caught: unknown) => caught instanceof Error &&
      caught.message.startsWith(`OpenHands additional source does not exist: ${missing}`),
  );
  assert.throws(() => realpathSync(missing));
});

test('rejects additional source files as non-directory bind sources', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-workspace-file-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace');
  const file = join(root, 'brief.md');
  mkdirSync(cwd);
  writeFileSync(file, 'brief');

  assert.throws(
    () => planWorkspaceMounts({
      cwd,
      additionalDirectories: [file],
      prompt: 'Read the source.',
    }),
    new RegExp(`OpenHands additional source is not a directory: ${escapeRegExp(file)}`),
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
