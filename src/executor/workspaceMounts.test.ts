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
import { fileURLToPath } from 'node:url';
import {
  assertWorkerDirectoriesAllowed,
  OPENHANDS_WORKSPACE,
  planWorkspaceMounts,
  WorkerDirectoryRefusedError,
  workerDirectoryRefusal,
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

/** This test file's own checkout — the installation a runner would execute. */
const WEAVER_CHECKOUT = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Simulate one execution host's layout under a temporary root: the runner
 * user's HOME, WEAVER_HOME, the workspace root, and the process-wide
 * CLAUDE_CONFIG_DIR/CODEX_HOME/DOCKER_HOST selectors. Restored afterwards.
 */
function hostLayout(
  t: { after(fn: () => void): void },
  layout: (root: string) => { home: string; weaverHome: string; workspaceRoot?: string },
): { root: string; home: string; weaverHome: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weaver-worker-dirs-')));
  const names = ['HOME', 'WEAVER_HOME', 'WEAVER_WORKSPACE_ROOT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DOCKER_HOST'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const { home, weaverHome, workspaceRoot } = layout(root);
  mkdirSync(home, { recursive: true });
  mkdirSync(weaverHome, { recursive: true });
  writeFileSync(join(weaverHome, 'executor-secrets.env'), 'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64=never-mounted\n');
  process.env.HOME = home;
  process.env.WEAVER_HOME = weaverHome;
  if (workspaceRoot) {
    mkdirSync(workspaceRoot, { recursive: true });
    process.env.WEAVER_WORKSPACE_ROOT = workspaceRoot;
  } else {
    delete process.env.WEAVER_WORKSPACE_ROOT;
  }
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.DOCKER_HOST;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, weaverHome };
}

test('state, secret, and login directories are refused whether named, contained, or nested', (t) => {
  const { home, weaverHome } = hostLayout(t, (root) => ({
    home: join(root, 'home', 'weaver'),
    weaverHome: join(root, 'home', 'weaver', 'state'),
    workspaceRoot: join(root, 'home', 'weaver', 'workspaces'),
  }));
  for (const name of ['.ssh', '.config/gh', '.weaver', '.claude', '.codex']) mkdirSync(join(home, name), { recursive: true });

  const refused: Array<[string, RegExp]> = [
    [weaverHome, /^is Weaver's state directory/],
    [join(weaverHome, 'some-stream'), /^sits under Weaver's state directory/],
    [home, /^is the runner user's home directory/],
    ['/', /^is the filesystem root/],
    [join(home, '.ssh'), /^is the runner user's SSH keys/],
    [join(home, '.config', 'gh'), /^sits under the runner user's tool logins/],
    [join(home, '.weaver'), /^is the runner user's Weaver directory/],
    [join(home, '.weaver', 'workspaces', 'x'), /^sits under the runner user's Weaver directory/],
    [join(home, '.claude', 'projects'), /^sits under the runner user's Claude Code login/],
    [join(home, '.codex'), /^is the runner user's Codex login/],
    ['/etc/weaver', /^is the hosted runner's service configuration/],
    ['/etc/weaver/env', /^sits under the hosted runner's service configuration/],
    ['/proc/1', /^sits under the host's process table/],
    [WEAVER_CHECKOUT, /^is the running Weaver installation/],
    [join(WEAVER_CHECKOUT, 'src'), /^sits under the running Weaver installation/],
  ];
  for (const [directory, reason] of refused) {
    assert.match(workerDirectoryRefusal(directory) ?? '(allowed)', reason, directory);
    assert.throws(() => assertWorkerDirectoriesAllowed([directory]), WorkerDirectoryRefusedError, directory);
  }
  // A parent that merely CONTAINS the state directory would mount it too.
  assert.match(workerDirectoryRefusal(join(home, '..')) ?? '(allowed)', /^contains /);
  // A different spelling of the same directory is the same directory.
  assert.match(workerDirectoryRefusal(`${weaverHome}/./`) ?? '(allowed)', /^is Weaver's state directory/);
  assert.match(workerDirectoryRefusal(join(weaverHome, 'x', '..')) ?? '(allowed)', /^is Weaver's state directory/);
});

test('the hosted and Mac workspace layouts still pass', (t) => {
  const hosted = hostLayout(t, (root) => ({
    home: join(root, 'home', 'weaver'),
    weaverHome: join(root, 'home', 'weaver', 'state'),
    workspaceRoot: join(root, 'home', 'weaver', 'workspaces'),
  }));
  for (const directory of [
    join(hosted.home, 'workspaces'),
    join(hosted.home, 'workspaces', 'erdo'),
    join(hosted.home, 'workspaces', 'repos', 'weaver'),
    join(hosted.home, 'workspaces', 'not-cloned-yet', 'checkout'),
    join(hosted.root, 'opt', 'weaver'),
    join(tmpdir(), 'weaver-scratch-clone'),
  ]) {
    assert.equal(workerDirectoryRefusal(directory), null, directory);
  }
  assert.doesNotThrow(() => assertWorkerDirectoriesAllowed([join(hosted.home, 'workspaces', 'erdo')]));
});

test('the default ~/.weaver/workspaces root and ~/work checkouts pass on an operator Mac', (t) => {
  const mac = hostLayout(t, (root) => ({
    home: join(root, 'Users', 'niall'),
    weaverHome: join(root, 'Users', 'niall', 'work', 'weaver', 'state'),
  }));
  mkdirSync(join(mac.home, '.weaver', 'workspaces', 'stream'), { recursive: true });
  assert.equal(workerDirectoryRefusal(join(mac.home, '.weaver', 'workspaces', 'stream')), null);
  assert.equal(workerDirectoryRefusal(join(mac.home, 'work', 'erdo', 'erdo')), null);
  assert.equal(workerDirectoryRefusal(join(mac.home, 'work', 'weaver-worktree')), null);
  // The checkout that holds the default ./state is itself refused: mount a
  // worktree or clone of it instead.
  assert.match(
    workerDirectoryRefusal(join(mac.home, 'work', 'weaver')) ?? '(allowed)',
    /^contains Weaver's state directory/,
  );
  assert.match(workerDirectoryRefusal(join(mac.home, '.weaver', 'scratch')) ?? '(allowed)', /^sits under/);
});

test('a workspace root placed inside WEAVER_HOME stays usable without exposing the rest of the state', (t) => {
  const railway = hostLayout(t, (root) => ({
    home: join(root, 'root'),
    weaverHome: join(root, 'var', 'lib', 'weaver'),
    workspaceRoot: join(root, 'var', 'lib', 'weaver', 'workspaces'),
  }));
  assert.equal(workerDirectoryRefusal(join(railway.weaverHome, 'workspaces', 'stream')), null);
  assert.equal(workerDirectoryRefusal(join(railway.weaverHome, 'workspaces')), null);
  assert.match(workerDirectoryRefusal(join(railway.weaverHome, 'stream')) ?? '(allowed)', /^sits under Weaver's state/);
  assert.match(workerDirectoryRefusal(railway.weaverHome) ?? '(allowed)', /^is Weaver's state/);
});

test('a symlink cannot smuggle a protected directory in under an innocent name', (t) => {
  const { home, weaverHome } = hostLayout(t, (root) => ({
    home: join(root, 'home', 'weaver'),
    weaverHome: join(root, 'home', 'weaver', 'state'),
    workspaceRoot: join(root, 'home', 'weaver', 'workspaces'),
  }));
  const workspaces = join(home, 'workspaces');
  symlinkSync(weaverHome, join(workspaces, 'innocent'));
  symlinkSync(join(weaverHome, 'not-created-yet'), join(workspaces, 'dangling'));
  symlinkSync(home, join(workspaces, 'up'));

  assert.match(
    workerDirectoryRefusal(join(workspaces, 'innocent')) ?? '(allowed)',
    new RegExp(`^is Weaver's state directory.*resolves to ${weaverHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(workerDirectoryRefusal(join(workspaces, 'innocent', 'sub')) ?? '(allowed)', /^sits under Weaver's state/);
  assert.match(workerDirectoryRefusal(join(workspaces, 'dangling')) ?? '(allowed)', /^sits under Weaver's state/);
  assert.match(workerDirectoryRefusal(join(workspaces, 'up')) ?? '(allowed)', /^is the runner user's home/);
  symlinkSync(join(workspaces, 'loop-b'), join(workspaces, 'loop-a'));
  symlinkSync(join(workspaces, 'loop-a'), join(workspaces, 'loop-b'));
  assert.match(workerDirectoryRefusal(join(workspaces, 'loop-a')) ?? '(allowed)', /symbolic link loop/);
  // The planners that hand paths to Docker refuse the same links.
  assert.throws(
    () => planWorkspaceMounts({ cwd: join(workspaces, 'innocent'), additionalDirectories: [], prompt: '' }),
    WorkerDirectoryRefusedError,
  );
  mkdirSync(join(workspaces, 'erdo'));
  assert.throws(
    () => planWorkspaceMounts({ cwd: join(workspaces, 'erdo'), additionalDirectories: [join(workspaces, 'innocent')], prompt: '' }),
    /is Weaver's state directory/,
  );
  assert.doesNotThrow(() => planWorkspaceMounts({ cwd: join(workspaces, 'erdo'), additionalDirectories: [], prompt: '' }));
});

test('CLAUDE_CONFIG_DIR, CODEX_HOME, and a rootless DOCKER_HOST socket are protected where they really live', (t) => {
  const { root } = hostLayout(t, (base) => ({
    home: join(base, 'home', 'weaver'),
    weaverHome: join(base, 'home', 'weaver', 'state'),
  }));
  process.env.CLAUDE_CONFIG_DIR = join(root, 'srv', 'claude-login');
  process.env.CODEX_HOME = join(root, 'srv', 'codex-login');
  process.env.DOCKER_HOST = `unix://${join(root, 'run', 'user', '1001', 'docker.sock')}`;
  assert.match(workerDirectoryRefusal(join(root, 'srv', 'claude-login')) ?? '(allowed)', /Claude Code login \(CLAUDE_CONFIG_DIR\)/);
  assert.match(workerDirectoryRefusal(join(root, 'srv', 'codex-login', 'sessions')) ?? '(allowed)', /Codex login \(CODEX_HOME\)/);
  assert.match(workerDirectoryRefusal(join(root, 'run', 'user', '1001')) ?? '(allowed)', /^contains the runner's Docker socket/);
  assert.equal(workerDirectoryRefusal(join(root, 'srv', 'application')), null);
});
