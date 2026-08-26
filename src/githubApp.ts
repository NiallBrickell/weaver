/**
 * Machine-scoped GitHub authentication for hosted Weaver actions.
 *
 * Credentials live only in the executor secret store. A local installation
 * with no GitHub App configured keeps its existing ambient `gh` behaviour;
 * once any App credential is present, however, authentication fails closed.
 * Personal tokens and the operator's `gh` login are never fallbacks.
 */

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadExecutorSecrets } from './secrets.js';

export type GitHubAppAccess = 'read' | 'write';

interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: KeyObject;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const APP_ID = 'WEAVER_GITHUB_APP_ID';
const INSTALLATION_ID = 'WEAVER_GITHUB_APP_INSTALLATION_ID';
const PRIVATE_KEY = 'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64';
const API_VERSION = '2026-03-10';
const TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
const CACHE_MARGIN_MS = 5 * 60 * 1_000;

const tokenCache = new Map<string, CachedToken>();
let nowImpl = Date.now;
let fetchImpl: typeof globalThis.fetch = globalThis.fetch;
let execFileSyncImpl: typeof execFileSync = execFileSync;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function numericId(value: string | undefined, name: string): string {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive numeric ID in the executor-only secret store`);
  }
  return value;
}

function decodePrivateKey(encoded: string | undefined): KeyObject {
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${PRIVATE_KEY} must be a base64-encoded RSA private key PEM`);
  }

  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded || !decoded.toString('utf8').includes('PRIVATE KEY-----')) {
    throw new Error(`${PRIVATE_KEY} must be a base64-encoded RSA private key PEM`);
  }

  try {
    const key = createPrivateKey(decoded);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
    return key;
  } catch {
    throw new Error(`${PRIVATE_KEY} must be a base64-encoded RSA private key PEM`);
  }
}

/**
 * Load and validate the complete App identity. No configured keys means local
 * no-op; a partial identity is never allowed to fall back to personal auth.
 */
function credentials(): GitHubAppCredentials | null {
  const secrets = loadExecutorSecrets();
  const values = [secrets[APP_ID], secrets[INSTALLATION_ID], secrets[PRIVATE_KEY]];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined)) {
    throw new Error('GitHub App credentials are incomplete in the executor-only secret store');
  }
  return {
    appId: numericId(secrets[APP_ID], APP_ID),
    installationId: numericId(secrets[INSTALLATION_ID], INSTALLATION_ID),
    privateKey: decodePrivateKey(secrets[PRIVATE_KEY]),
  };
}

/** True only for a complete, valid executor-only GitHub App identity. */
export function githubAppConfigured(): boolean {
  return credentials() !== null;
}

function appJwt(config: GitHubAppCredentials, now: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const nowSeconds = Math.floor(now / 1_000);
  const payload = base64url(JSON.stringify({
    iat: nowSeconds - 60,
    exp: nowSeconds + 600,
    iss: config.appId,
  }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64url(signer.sign(config.privateKey))}`;
}

function repositoryName(repository: string): string {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match || !match[1] || !match[2]) {
    throw new Error('GitHub repository must be an exact owner/name');
  }
  return match[2];
}

function requestBody(repository: string | undefined, access: GitHubAppAccess): Record<string, unknown> {
  const body: Record<string, unknown> = {
    permissions: access === 'read' ? {
      actions: 'read',
      checks: 'read',
      contents: 'read',
      issues: 'read',
      metadata: 'read',
      pull_requests: 'read',
      statuses: 'read',
    } : {
      actions: 'read',
      checks: 'read',
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      statuses: 'read',
      workflows: 'write',
    },
  };
  if (repository !== undefined) body.repositories = [repositoryName(repository)];
  return body;
}

async function githubFetch(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error' });
  } catch {
    throw new Error(`${operation} could not reach GitHub`);
  }
}

/**
 * Mint an installation token, cached independently by exact repository scope
 * and access level. Both lifecycles request an exact permission profile; an
 * omitted permission map would silently inherit every App installation grant.
 */
export async function mintGitHubAppToken(
  repository?: string,
  access: GitHubAppAccess = 'read',
): Promise<string> {
  if (access !== 'read' && access !== 'write') {
    throw new Error('GitHub App access must be read or write');
  }
  if (repository !== undefined) repositoryName(repository);

  const config = credentials();
  if (!config) {
    throw new Error('GitHub App authentication is not configured');
  }

  const cacheKey = `${access}\u0000${repository ?? ''}`;
  const now = nowImpl();
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.expiresAt - CACHE_MARGIN_MS) return cached.token;

  const jwt = appJwt(config, now);
  const response = await githubFetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': API_VERSION,
      },
      body: JSON.stringify(requestBody(repository, access)),
    },
    'GitHub App token request',
  );
  if (response.status !== 201) {
    throw new Error(`GitHub App token request failed (HTTP ${response.status})`);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('GitHub App token response was invalid');
  }
  const token = typeof result === 'object' && result !== null && 'token' in result
    ? (result as { token?: unknown }).token
    : undefined;
  const expiresAtValue = typeof result === 'object' && result !== null && 'expires_at' in result
    ? (result as { expires_at?: unknown }).expires_at
    : undefined;
  const repositories = typeof result === 'object' && result !== null && 'repositories' in result
    ? (result as { repositories?: unknown }).repositories
    : undefined;
  const providerExpiry = typeof expiresAtValue === 'string' ? Date.parse(expiresAtValue) : Number.NaN;
  if (typeof token !== 'string' || token.length === 0 || !Number.isFinite(providerExpiry) || providerExpiry <= now) {
    throw new Error('GitHub App token response was invalid');
  }
  if (repository !== undefined) {
    const exactRepository = Array.isArray(repositories) && repositories.length === 1
      && typeof repositories[0] === 'object' && repositories[0] !== null
      && 'full_name' in repositories[0]
      && typeof (repositories[0] as { full_name?: unknown }).full_name === 'string'
      && (repositories[0] as { full_name: string }).full_name.toLowerCase() === repository.toLowerCase();
    if (!exactRepository) {
      throw new Error('GitHub App token response did not confirm the exact requested repository');
    }
  }

  tokenCache.set(cacheKey, {
    token,
    expiresAt: Math.min(providerExpiry, now + TOKEN_LIFETIME_MS),
  });
  return token;
}

/** Parse an origin URL only when it names exactly one repository on github.com. */
export function parseGitHubRepositoryRemote(remote: string): string | null {
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(remote.trim());
  if (scp) {
    const repo = `${scp[1]!}/${scp[2]!.replace(/\.git$/, '')}`;
    try {
      repositoryName(repo);
      return repo;
    } catch {
      return null;
    }
  }

  let url: URL;
  try {
    url = new URL(remote.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'ssh:')
      || url.hostname !== 'github.com'
      || url.port
      || url.password
      || url.search
      || url.hash
      || (url.protocol === 'https:' && url.username)
      || (url.protocol === 'ssh:' && url.username !== 'git')) {
    return null;
  }
  const parts = url.pathname.replace(/^\//, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  try {
    repositoryName(repo);
    return repo;
  } catch {
    return null;
  }
}

/** Derive the exact github.com owner/name from cwd's origin, failing closed. */
export function githubRepositoryFromCwd(cwd: string): string {
  let remote: string;
  try {
    remote = execFileSyncImpl('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('GitHub App authentication could not resolve cwd origin');
  }
  const repository = parseGitHubRepositoryRemote(remote);
  if (!repository) {
    throw new Error('GitHub App authentication requires cwd origin to be an exact github.com repository');
  }
  return repository;
}

/**
 * Bootstrap one exact installation repository without persisting a credential.
 * The clean HTTPS origin is passed to git, while a short-lived installation
 * token reaches only Git's askpass child through its environment.
 */
export async function cloneGitHubRepository(repository: string, destination: string): Promise<void> {
  repositoryName(repository);
  if (!isAbsolute(destination) || destination === '/' || existsSync(destination)) {
    throw new Error('GitHub clone destination must be an absent absolute path');
  }

  const token = await mintGitHubAppToken(repository, 'read');
  const askpassDirectory = mkdtempSync(join(tmpdir(), 'weaver-github-askpass-'));
  const askpassPath = join(askpassDirectory, 'askpass.sh');
  try {
    writeFileSync(askpassPath, `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$WEAVER_GITHUB_GIT_TOKEN" ;;
esac
`, { mode: 0o700 });
    chmodSync(askpassPath, 0o700);
    execFileSyncImpl('git', [
      '-c', 'credential.helper=',
      '-c', `core.askPass=${askpassPath}`,
      'clone', `https://github.com/${repository}.git`, destination,
    ], {
      env: {
        ...process.env,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: '0',
        WEAVER_GITHUB_GIT_TOKEN: token,
      },
      stdio: 'inherit',
      timeout: 10 * 60 * 1_000,
    });
  } catch {
    throw new Error('GitHub App repository clone failed');
  } finally {
    rmSync(askpassDirectory, { recursive: true, force: true });
  }
}

/** Environment supplied to a GitHub action process. */
export async function githubAppEnvironment(
  cwd: string,
  access: GitHubAppAccess = 'read',
): Promise<Record<string, string>> {
  if (!githubAppConfigured()) return {};
  const repository = githubRepositoryFromCwd(cwd);
  return { GH_TOKEN: await mintGitHubAppToken(repository, access) };
}

/** Prove the App JWT, installation, token, and read permission all work. */
export async function checkGitHubAppAuthentication(): Promise<void> {
  const token = await mintGitHubAppToken(undefined, 'read');
  const response = await githubFetch(
    'https://api.github.com/installation/repositories?per_page=1',
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
    },
    'GitHub App authentication check',
  );
  if (response.status !== 200) {
    throw new Error(`GitHub App authentication check failed (HTTP ${response.status})`);
  }
}

/** Deterministic seams used only by this module's contract tests. */
export function __setGitHubAppTestDependencies(dependencies: {
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  execFileSync?: typeof execFileSync;
}): void {
  if (dependencies.now) nowImpl = dependencies.now;
  if (dependencies.fetch) fetchImpl = dependencies.fetch;
  if (dependencies.execFileSync) execFileSyncImpl = dependencies.execFileSync;
}

export function __resetGitHubAppForTests(): void {
  tokenCache.clear();
  nowImpl = Date.now;
  fetchImpl = globalThis.fetch;
  execFileSyncImpl = execFileSync;
}
