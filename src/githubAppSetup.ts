/**
 * Loopback-only GitHub App manifest setup.
 *
 * GitHub must receive the organization owner's browser confirmation, but the
 * operator should never have to copy an App ID, installation ID, or private
 * key. The one-time manifest response lands here, is verified against the
 * reviewed contract, and goes directly into the executor-only secret store.
 */

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createSign, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  loadExecutorSecrets,
  removeExecutorSecret,
  setExecutorSecret,
} from './secrets.js';

const API_VERSION = '2026-03-10';
const APP_ID = 'WEAVER_GITHUB_APP_ID';
const INSTALLATION_ID = 'WEAVER_GITHUB_APP_INSTALLATION_ID';
const PRIVATE_KEY = 'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64';
const SETUP_TIMEOUT_MS = 55 * 60 * 1_000;
const ORGANIZATION_RE = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;

const EXPECTED_PERMISSIONS: Record<string, string> = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
  statuses: 'read',
  workflows: 'write',
};

const READ_PERMISSIONS: Record<string, string> = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'read',
  metadata: 'read',
  pull_requests: 'read',
  statuses: 'read',
};

interface SetupApp {
  id: number;
  pem: string;
  slug: string;
  owner: { login: string; type: string };
  permissions: Record<string, string>;
  events: string[];
}

export interface GitHubAppSetup {
  url: string;
  completion: Promise<void>;
  close(): Promise<void>;
}

export interface GitHubAppSetupDependencies {
  fetch?: typeof globalThis.fetch;
  localGitHubToken?: () => string;
  randomHex?: (bytes: number) => string;
  timeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

function localGitHubToken(): string {
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (token) return token;
  } catch {
    // Render one stable, secret-free setup diagnosis below.
  }
  throw new Error('local GitHub CLI authentication is required to register the App');
}

function html(response: ServerResponse, status: number, title: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;max-width:720px;margin:12vh auto;padding:0 24px;line-height:1.5}button{font:inherit;padding:12px 18px}</style>
<h1>${title}</h1>${body}`);
}

function htmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('<', '&lt;');
}

function activePermissions(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, access]) => access !== 'none' && typeof access === 'string'),
  );
}

function assertPermissions(value: unknown): void {
  const actual = Object.entries(activePermissions(value)).sort(([a], [b]) => a.localeCompare(b));
  const expected = Object.entries(EXPECTED_PERMISSIONS).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('GitHub App permissions did not match the reviewed manifest');
  }
}

function parseApp(value: unknown, organization: string): SetupApp {
  if (typeof value !== 'object' || value === null) {
    throw new Error('GitHub App manifest response was invalid');
  }
  const candidate = value as Partial<SetupApp>;
  if (!Number.isSafeInteger(candidate.id)
      || typeof candidate.pem !== 'string'
      || typeof candidate.slug !== 'string'
      || !candidate.slug
      || typeof candidate.owner !== 'object'
      || candidate.owner === null
      || typeof candidate.owner.login !== 'string'
      || candidate.owner.type !== 'Organization'
      || candidate.owner.login.toLowerCase() !== organization.toLowerCase()
      || !Array.isArray(candidate.events)
      || candidate.events.length !== 0) {
    throw new Error('created GitHub App did not belong to the expected organization');
  }
  try {
    const key = createPrivateKey(candidate.pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new Error('GitHub App manifest response did not contain a valid RSA private key');
  }
  assertPermissions(candidate.permissions);
  return candidate as SetupApp;
}

function appJwt(app: SetupApp): string {
  const encode = (value: string | Buffer): string => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1_000);
  const header = encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encode(JSON.stringify({ iat: now - 60, exp: now + 600, iss: String(app.id) }));
  const input = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${encode(signer.sign(app.pem))}`;
}

async function github(
  fetchImpl: typeof globalThis.fetch,
  path: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(20_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new Error(`${operation} could not reach GitHub`);
  }
  if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status})`);
  return response;
}

async function json(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} response was invalid`);
  }
}

async function verifyOrganizationInstallation(
  fetchImpl: typeof globalThis.fetch,
  app: SetupApp,
  installationId: string,
  organization: string,
): Promise<void> {
  const authorization = { Authorization: `Bearer ${appJwt(app)}` };
  const installation = await json(await github(
    fetchImpl,
    `/app/installations/${installationId}`,
    { method: 'GET', headers: authorization },
    'GitHub App installation verification',
  ), 'GitHub App installation verification');
  if (typeof installation !== 'object' || installation === null) {
    throw new Error('GitHub App installation verification response was invalid');
  }
  const value = installation as {
    account?: { login?: unknown };
    target_type?: unknown;
    repository_selection?: unknown;
    suspended_at?: unknown;
    permissions?: unknown;
  };
  if (typeof value.account?.login !== 'string'
      || value.account.login.toLowerCase() !== organization.toLowerCase()
      || value.target_type !== 'Organization'
      || value.repository_selection !== 'all'
      || value.suspended_at !== null) {
    throw new Error('GitHub App must be an active all-repositories installation on the expected organization');
  }
  assertPermissions(value.permissions);

  const token = await json(await github(
    fetchImpl,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: READ_PERMISSIONS }),
    },
    'GitHub App installation token verification',
  ), 'GitHub App installation token verification');
  const installationToken = typeof token === 'object' && token !== null && 'token' in token
    ? (token as { token?: unknown }).token
    : undefined;
  if (typeof installationToken !== 'string' || !installationToken) {
    throw new Error('GitHub App installation token verification response was invalid');
  }
  await github(
    fetchImpl,
    '/installation/repositories?per_page=1',
    { method: 'GET', headers: { Authorization: `Bearer ${installationToken}` } },
    'GitHub App repository verification',
  );
}

function storeApp(app: SetupApp, installationId: string): void {
  const previous = loadExecutorSecrets();
  const values: Record<string, string> = {
    [APP_ID]: String(app.id),
    [INSTALLATION_ID]: installationId,
    [PRIVATE_KEY]: Buffer.from(app.pem).toString('base64'),
  };
  try {
    for (const [name, value] of Object.entries(values)) setExecutorSecret(name, value);
  } catch {
    for (const name of Object.keys(values)) {
      if (previous[name] === undefined) removeExecutorSecret(name);
      else setExecutorSecret(name, previous[name]!);
    }
    throw new Error('GitHub App identity could not be registered in the executor-only store');
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Start one bounded setup handshake on 127.0.0.1 and return immediately. */
export async function startGitHubAppSetup(
  organization: string,
  dependencies: GitHubAppSetupDependencies = {},
): Promise<GitHubAppSetup> {
  if (!ORGANIZATION_RE.test(organization)) {
    throw new Error('GitHub organization must be an exact organization login');
  }
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const registrationToken = dependencies.localGitHubToken ?? localGitHubToken;
  const randomHex = dependencies.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'));
  const state = randomHex(32);
  const suffix = randomHex(3);
  if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{6}$/.test(suffix)) {
    throw new Error('GitHub App setup entropy source was invalid');
  }

  let app: SetupApp | undefined;
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = createServer(async (request, response) => {
    try {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const url = new URL(request.url ?? '/', origin);
      if (settled) {
        html(response, 410, 'Setup has ended', '<p>Start a fresh setup command.</p>');
        return;
      }
      if (request.method !== 'GET') {
        html(response, 405, 'Method not allowed', '<p>Use the setup link.</p>');
        return;
      }

      if (url.pathname === '/') {
        const manifest = {
          name: `Weaver Fleet Production ${suffix}`,
          url: 'https://github.com/NiallBrickell/weaver',
          description: 'Private machine identity for the hosted Weaver execution fleet.',
          hook_attributes: { url: 'https://github.com/NiallBrickell/weaver', active: false },
          redirect_url: `${origin}/callback`,
          setup_url: `${origin}/setup?state=${state}`,
          setup_on_update: false,
          public: false,
          request_oauth_on_install: false,
          default_events: [],
          default_permissions: EXPECTED_PERMISSIONS,
        };
        const action = `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
        html(response, 200, 'Create the dedicated Weaver GitHub App', `
<p>This creates one private organization-owned App with no webhook. Choose <strong>All repositories</strong>; every runtime token is still narrowed to one exact repository.</p>
<form method="post" action="${action}">
  <input type="hidden" name="state" value="${state}">
  <input type="hidden" name="manifest" value='${formValue(JSON.stringify(manifest))}'>
  <button type="submit">Continue securely on GitHub</button>
</form>`);
        return;
      }

      if (url.pathname === '/callback') {
        if (url.searchParams.get('state') !== state) throw new Error('GitHub App registration state did not match');
        const code = url.searchParams.get('code');
        if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('GitHub App registration code was invalid');
        const candidate = parseApp(await json(await github(
          fetchImpl,
          `/app-manifests/${encodeURIComponent(code)}/conversions`,
          { method: 'POST', headers: { Authorization: `Bearer ${registrationToken()}` } },
          'GitHub App manifest conversion',
        ), 'GitHub App manifest conversion'), organization);
        if (settled) throw new Error('GitHub App setup ended before registration completed');
        app = candidate;
        response.writeHead(302, {
          Location: `https://github.com/apps/${encodeURIComponent(candidate.slug)}/installations/new`,
          'Cache-Control': 'no-store',
        });
        response.end();
        return;
      }

      if (url.pathname === '/setup') {
        if (url.searchParams.get('state') !== state || !app) {
          throw new Error('GitHub App installation state did not match');
        }
        const installationId = url.searchParams.get('installation_id');
        if (!installationId || !/^[1-9][0-9]*$/.test(installationId)) {
          throw new Error('GitHub App installation ID was invalid');
        }
        await verifyOrganizationInstallation(fetchImpl, app, installationId, organization);
        if (settled) throw new Error('GitHub App setup ended before installation completed');
        storeApp(app, installationId);
        html(response, 200, 'Weaver GitHub App installed', '<p>The organization-wide installation, App permissions, token path, and machine credentials are verified and stored. You can close this tab.</p>');
        settled = true;
        resolveCompletion();
        setImmediate(() => { void closeServer(server); });
        return;
      }

      html(response, 404, 'Not found', '<p>Use the setup link.</p>');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub App setup failed safely';
      dependencies.onDiagnostic?.(message);
      html(response, 400, 'Setup stopped safely', `<p>${htmlText(message)}. Nothing was stored; correct the GitHub selection and retry this page.</p>`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCompletion(new Error('GitHub App setup expired before installation completed'));
      void closeServer(server);
    }
  }, dependencies.timeoutMs ?? SETUP_TIMEOUT_MS);
  timeout.unref();
  completion.finally(() => clearTimeout(timeout)).catch(() => {});

  return {
    url: `http://127.0.0.1:${address.port}/`,
    completion,
    async close(): Promise<void> {
      if (!settled) {
        settled = true;
        rejectCompletion(new Error('GitHub App setup was closed before installation completed'));
      }
      await closeServer(server);
    },
  };
}
