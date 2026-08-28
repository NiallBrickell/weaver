import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  __resetGitHubAppForTests,
  __setGitHubAppTestDependencies,
  actionUsesGitHub,
  checkGitHubAppAuthentication,
  cloneGitHubRepository,
  GitHubAppPreparationError,
  githubAppConfigured,
  githubAppEnvironment,
  githubRepositoryFromCwd,
  mintGitHubAppToken,
  parseGitHubRepositoryRemote,
} from './githubApp.js';
import { setExecutorSecret } from './secrets.js';
import type { Assignment } from './types.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const privateKeyBase64 = Buffer.from(privateKeyPem).toString('base64');
const fixedNow = Date.parse('2026-08-26T08:00:00.000Z');

function freshHome(): void {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-app-'));
}

function configure(overrides: Partial<Record<
  'WEAVER_GITHUB_APP_ID' | 'WEAVER_GITHUB_APP_INSTALLATION_ID' | 'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64',
  string
>> = {}): void {
  const values = {
    WEAVER_GITHUB_APP_ID: '12345',
    WEAVER_GITHUB_APP_INSTALLATION_ID: '67890',
    WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) setExecutorSecret(name, value);
}

function tokenResponse(token: string, now = fixedNow, repository?: string): Response {
  return Response.json({
    token,
    expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
    ...(repository ? { repositories: [{ full_name: repository }] } : {}),
  }, { status: 201 });
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function gitRepo(remote: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-origin-'));
  execFileSync('git', ['init', '--quiet'], { cwd });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd });
  return cwd;
}

function action(run = '', verify = ''): Assignment {
  return {
    id: 'asg_github',
    objective: 'exercise GitHub',
    briefing: 'n/a',
    kind: 'action',
    exec: { cwd: '/tmp', run, verify },
    acceptanceCriteria: [],
    dependsOn: [],
    state: 'queued',
    attempts: [],
    adoption: { state: 'none' },
    createdAtVirtual: '2026-08-26T00:00:00.000Z',
  };
}

beforeEach(() => {
  freshHome();
  __resetGitHubAppForTests();
  __setGitHubAppTestDependencies({ now: () => fixedNow });
});

test('absent App credentials are an environment no-op without resolving cwd or fetching', async () => {
  let fetched = false;
  __setGitHubAppTestDependencies({
    fetch: (async () => {
      fetched = true;
      throw new Error('must not fetch');
    }) as typeof globalThis.fetch,
  });

  assert.equal(githubAppConfigured(), false);
  assert.deepEqual(await githubAppEnvironment('/definitely/not/a/repository'), {});
  assert.equal(fetched, false);
});

test('partial credentials, non-numeric IDs, and invalid base64 PEM fail closed', async () => {
  setExecutorSecret('WEAVER_GITHUB_APP_ID', '12345');
  await assert.rejects(
    githubAppEnvironment('/not/a/repo'),
    GitHubAppPreparationError,
  );

  freshHome();
  configure({ WEAVER_GITHUB_APP_ID: '12.3' });
  await assert.rejects(mintGitHubAppToken(), /APP_ID must be a positive numeric ID/);

  freshHome();
  configure({ WEAVER_GITHUB_APP_INSTALLATION_ID: '0' });
  await assert.rejects(mintGitHubAppToken(), /INSTALLATION_ID must be a positive numeric ID/);

  freshHome();
  configure({ WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64: 'not+canonical==' });
  await assert.rejects(mintGitHubAppToken(), /base64-encoded RSA private key PEM/);

  freshHome();
  const privateValue = Buffer.from('-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----')
    .toString('base64');
  configure({ WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64: privateValue });
  const error = await mintGitHubAppToken().catch((caught: unknown) => caught);
  assert.ok(error instanceof Error);
  assert.match(error.message, /base64-encoded RSA private key PEM/);
  assert.doesNotMatch(error.message, new RegExp(privateValue));
});

test('read and write mints send exact scopes and an RS256 App JWT without private data', async () => {
  configure();
  const requests: { url: string; init: RequestInit }[] = [];
  __setGitHubAppTestDependencies({
    fetch: (async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return tokenResponse(`installation-token-${requests.length}`, fixedNow, 'octo/widget');
    }) as typeof globalThis.fetch,
  });

  assert.equal(await mintGitHubAppToken('octo/widget', 'read'), 'installation-token-1');
  assert.equal(await mintGitHubAppToken('octo/widget', 'write'), 'installation-token-2');
  assert.equal(requests.length, 2);

  for (const request of requests) {
    assert.equal(
      request.url,
      'https://api.github.com/app/installations/67890/access_tokens',
    );
    assert.equal(request.init.method, 'POST');
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get('accept'), 'application/vnd.github+json');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('x-github-api-version'), '2026-03-10');
  }
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    permissions: {
      actions: 'read',
      checks: 'read',
      contents: 'read',
      issues: 'read',
      metadata: 'read',
      pull_requests: 'read',
      statuses: 'read',
    },
    repositories: ['widget'],
  });
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), {
    permissions: {
      actions: 'read',
      checks: 'read',
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      statuses: 'read',
      workflows: 'write',
    },
    repositories: ['widget'],
  });

  const authorization = new Headers(requests[0]?.init.headers).get('authorization');
  assert.ok(authorization);
  assert.ok(authorization.startsWith('Bearer '));
  const jwt = authorization.slice('Bearer '.length);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  assert.deepEqual(decodeJwtPart(parts[0]!), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodeJwtPart(parts[1]!), {
    iat: fixedNow / 1_000 - 60,
    exp: fixedNow / 1_000 + 600,
    iss: '12345',
  });
  assert.doesNotMatch(jwt, new RegExp(privateKeyBase64));
  assert.doesNotMatch(jwt, /PRIVATE KEY/);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(parts[2]!, 'base64url')), true);
});

test('token cache is isolated by exact owner/repo and access and refreshes at the five-minute margin', async () => {
  configure();
  let now = fixedNow;
  let calls = 0;
  __setGitHubAppTestDependencies({
    now: () => now,
    fetch: (async (_input, init = {}) => {
      const body = JSON.parse(String(init.body)) as { repositories?: string[] };
      const repository = body.repositories?.[0];
      const owner = ['first', 'second', 'first', 'first'][calls] ?? 'first';
      return tokenResponse(`token-${++calls}`, now, repository ? `${owner}/${repository}` : undefined);
    }) as typeof globalThis.fetch,
  });

  assert.equal(await mintGitHubAppToken('first/shared-name', 'read'), 'token-1');
  assert.equal(await mintGitHubAppToken('first/shared-name', 'read'), 'token-1');
  assert.equal(await mintGitHubAppToken('second/shared-name', 'read'), 'token-2');
  assert.equal(await mintGitHubAppToken('first/shared-name', 'write'), 'token-3');
  assert.equal(calls, 3);

  now = fixedNow + 55 * 60 * 1_000 - 1;
  assert.equal(await mintGitHubAppToken('first/shared-name', 'read'), 'token-1');
  now += 1;
  assert.equal(await mintGitHubAppToken('first/shared-name', 'read'), 'token-4');
  assert.equal(calls, 4);
});

test('origin parsing accepts exact github.com HTTPS and SSH repositories only', () => {
  assert.equal(parseGitHubRepositoryRemote('https://github.com/octo/widget.git'), 'octo/widget');
  assert.equal(parseGitHubRepositoryRemote('git@github.com:octo/widget.git'), 'octo/widget');
  assert.equal(parseGitHubRepositoryRemote('ssh://git@github.com/octo/widget.git'), 'octo/widget');
  assert.equal(parseGitHubRepositoryRemote('http://github.com/octo/widget.git'), null);
  assert.equal(parseGitHubRepositoryRemote('https://github.com.evil/octo/widget.git'), null);
  assert.equal(parseGitHubRepositoryRemote('https://github.com/octo/widget/extra'), null);
  assert.equal(parseGitHubRepositoryRemote('git@gitlab.com:octo/widget.git'), null);

  assert.equal(githubRepositoryFromCwd(gitRepo('https://github.com/octo/https-repo.git')), 'octo/https-repo');
  assert.equal(githubRepositoryFromCwd(gitRepo('git@github.com:octo/ssh-repo.git')), 'octo/ssh-repo');
  assert.throws(
    () => githubRepositoryFromCwd(gitRepo('https://gitlab.com/octo/widget.git')),
    /requires cwd origin to be an exact github.com repository/,
  );
  assert.throws(
    () => githubRepositoryFromCwd('/not/a/git/repository'),
    /could not resolve cwd origin/,
  );
});

test('an unexpected cwd-origin probe error remains infrastructure, never typed action configuration', async () => {
  configure();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-probe-programming-'));
  __setGitHubAppTestDependencies({
    execFileSync: (() => {
      throw new TypeError('injected programming failure');
    }) as typeof execFileSync,
  });
  await assert.rejects(
    githubAppEnvironment(cwd),
    (error: unknown) => error instanceof TypeError
      && !(error instanceof GitHubAppPreparationError)
      && error.message === 'injected programming failure',
  );
});

test('action GitHub use is literal, includes gh and Git network commands, and keeps reads distinct from writes', () => {
  assert.equal(actionUsesGitHub(action('gh api repos/octo/widget')), true);
  assert.equal(actionUsesGitHub(action('if false; then /usr/bin/gh pr view 42; fi')), true);
  assert.equal(actionUsesGitHub(action('test "$(gh pr list --json number)" = "[]"')), true);
  assert.equal(actionUsesGitHub(action('git -C /workspace/widget fetch origin')), true);
  assert.equal(actionUsesGitHub(action('command git ls-remote origin', 'git remote update')), true);
  assert.equal(actionUsesGitHub(action('git -C /workspace/widget remote update')), true);
  assert.equal(actionUsesGitHub(action('echo "gh api"; echo "git fetch"')), false);
  assert.equal(actionUsesGitHub(action('git status', 'test -f result.json')), false);
});

test('configured environment fails closed on a non-GitHub origin and authenticates gh and Git without persisting the token', async () => {
  configure();
  let calls = 0;
  __setGitHubAppTestDependencies({
    fetch: (async () => {
      calls += 1;
      return tokenResponse('repo-token', fixedNow, 'octo/widget');
    }) as typeof globalThis.fetch,
  });

  await assert.rejects(
    githubAppEnvironment(gitRepo('https://example.com/octo/widget.git')),
    /requires cwd origin to be an exact github.com repository/,
  );
  assert.equal(calls, 0);
  const environment = await githubAppEnvironment(gitRepo('https://github.com/octo/widget.git'), 'write');
  assert.equal(environment.GH_TOKEN, 'repo-token');
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GIT_CONFIG_KEY_1, 'credential.https://github.com.helper');
  assert.equal(environment.GIT_CONFIG_KEY_3, 'credential.https://github.com.useHttpPath');
  for (const [name, value] of Object.entries(environment)) {
    if (name === 'GH_TOKEN') continue;
    assert.equal(value.includes('repo-token'), false, `${name} must reference GH_TOKEN, never contain the token`);
  }

  const credential = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\npath=octo/widget.git\n\n',
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.match(credential, /^protocol=https$/m);
  assert.match(credential, /^host=github\.com$/m);
  assert.match(credential, /^username=x-access-token$/m);
  assert.match(credential, /^password=repo-token$/m);

  assert.throws(
    () => execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=gitlab.com\npath=octo/widget.git\n\n',
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    /Command failed/,
    'the helper must not offer the GitHub token to another host',
  );
});

test('repository clone uses a clean exact URL and keeps its token only in askpass environment', async () => {
  configure();
  __setGitHubAppTestDependencies({
    fetch: (async () => tokenResponse('clone-token-that-must-not-persist', fixedNow, 'octo/widget')) as typeof globalThis.fetch,
  });
  const destination = path.join(os.tmpdir(), `weaver-clone-target-${process.pid}-${Date.now()}`);
  let observedAskpass = '';
  let observedArgs: readonly string[] = [];
  __setGitHubAppTestDependencies({
    execFileSync: ((_file: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      observedArgs = args ?? [];
      assert.equal(options?.env?.WEAVER_GITHUB_GIT_TOKEN, 'clone-token-that-must-not-persist');
      assert.equal(options?.env?.GIT_TERMINAL_PROMPT, '0');
      const askpass = options?.env?.GIT_ASKPASS;
      assert.ok(askpass);
      assert.equal(fs.statSync(askpass).mode & 0o777, 0o700);
      observedAskpass = askpass;
      assert.doesNotMatch(fs.readFileSync(askpass, 'utf8'), /clone-token-that-must-not-persist/);
      return Buffer.alloc(0);
    }) as typeof execFileSync,
  });

  await cloneGitHubRepository('octo/widget', destination);
  assert.deepEqual(observedArgs, [
    '-c', 'credential.helper=',
    '-c', `core.askPass=${observedAskpass}`,
    'clone', 'https://github.com/octo/widget.git', destination,
  ]);
  assert.equal(observedArgs.join(' ').includes('clone-token-that-must-not-persist'), false);
  assert.equal(fs.existsSync(observedAskpass), false);

  await assert.rejects(
    cloneGitHubRepository('not-an-exact-repository', destination),
    /exact owner\/name/,
  );
  await assert.rejects(cloneGitHubRepository('octo/widget', 'relative'), /absent absolute path/);
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-existing-clone-'));
  await assert.rejects(cloneGitHubRepository('octo/widget', existing), /absent absolute path/);
});

test('authentication check mints an unscoped read token and requires repository-list HTTP 200', async () => {
  configure();
  const requests: { url: string; init: RequestInit }[] = [];
  __setGitHubAppTestDependencies({
    fetch: (async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) return tokenResponse('auth-check-token');
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch,
  });

  await checkGitHubAppAuthentication();
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    permissions: {
      actions: 'read',
      checks: 'read',
      contents: 'read',
      issues: 'read',
      metadata: 'read',
      pull_requests: 'read',
      statuses: 'read',
    },
  });
  assert.equal(requests[1]?.url, 'https://api.github.com/installation/repositories?per_page=1');
  assert.equal(requests[1]?.init.method, 'GET');
  assert.equal(
    new Headers(requests[1]?.init.headers).get('authorization'),
    'Bearer auth-check-token',
  );

  __resetGitHubAppForTests();
  __setGitHubAppTestDependencies({
    now: () => fixedNow,
    fetch: (async (input) => String(input).includes('/access_tokens')
      ? tokenResponse('second-auth-token')
      : new Response(null, { status: 204 })) as typeof globalThis.fetch,
  });
  await assert.rejects(checkGitHubAppAuthentication(), /failed \(HTTP 204\)/);
});

test('network, provider, and response errors never include JWTs, tokens, keys, or response bodies', async () => {
  configure();
  let capturedJwt = '';
  __setGitHubAppTestDependencies({
    fetch: (async (_input, init) => {
      capturedJwt = new Headers(init?.headers).get('authorization') ?? '';
      throw new Error(`provider leaked ${capturedJwt} ${privateKeyBase64}`);
    }) as typeof globalThis.fetch,
  });
  let error = await mintGitHubAppToken().catch((caught: unknown) => caught);
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'GitHub App token request could not reach GitHub');
  assert.ok(capturedJwt.length > 20);
  assert.doesNotMatch(error.message, new RegExp(privateKeyBase64));
  assert.doesNotMatch(error.message, /Bearer /);

  __resetGitHubAppForTests();
  __setGitHubAppTestDependencies({
    now: () => fixedNow,
    fetch: (async () => new Response(
      `secret response ${privateKeyBase64}`,
      { status: 401 },
    )) as typeof globalThis.fetch,
  });
  error = await mintGitHubAppToken().catch((caught: unknown) => caught);
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'GitHub App token request failed (HTTP 401)');
  assert.doesNotMatch(error.message, /secret response/);
  assert.doesNotMatch(error.message, new RegExp(privateKeyBase64));

  __resetGitHubAppForTests();
  __setGitHubAppTestDependencies({
    now: () => fixedNow,
    fetch: (async (input) => String(input).includes('/access_tokens')
      ? tokenResponse('must-not-leak-token')
      : new Response('must-not-leak-token body', { status: 403 })) as typeof globalThis.fetch,
  });
  error = await checkGitHubAppAuthentication().catch((caught: unknown) => caught);
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'GitHub App authentication check failed (HTTP 403)');
  assert.doesNotMatch(error.message, /must-not-leak-token/);
});
