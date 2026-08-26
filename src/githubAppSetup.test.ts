import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { startGitHubAppSetup } from './githubAppSetup.js';
import { loadExecutorSecrets } from './secrets.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const permissions = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
  statuses: 'read',
  workflows: 'write',
};

function freshHome(): void {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-github-setup-'));
}

function decodeHtml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

function manifestFrom(html: string): Record<string, unknown> {
  const match = /name="manifest" value='([^']+)'/.exec(html);
  assert.ok(match);
  return JSON.parse(decodeHtml(match[1]!)) as Record<string, unknown>;
}

function fixedRandomHex(bytes: number): string {
  if (bytes === 32) return 'a'.repeat(64);
  if (bytes === 3) return 'b'.repeat(6);
  throw new Error('unexpected entropy request');
}

test('loopback manifest callback verifies an all-repositories organization App and stores its identity', async () => {
  freshHome();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const diagnostics: string[] = [];
  const setup = await startGitHubAppSetup('octo-org', {
    localGitHubToken: () => 'local-registration-token',
    randomHex: fixedRandomHex,
    onDiagnostic: (message) => diagnostics.push(message),
    fetch: (async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/app-manifests/one-time-code/conversions')) {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer local-registration-token');
        return Response.json({
          id: 12345,
          pem: privateKeyPem,
          slug: 'weaver-fleet-production-bbbbbb',
          owner: { login: 'octo-org', type: 'Organization' },
          permissions,
          events: [],
        }, { status: 201 });
      }
      if (url.endsWith('/app/installations/67890')) {
        return Response.json({
          account: { login: 'octo-org' },
          target_type: 'Organization',
          repository_selection: 'all',
          suspended_at: null,
          permissions,
        });
      }
      if (url.endsWith('/app/installations/67890/access_tokens')) {
        assert.deepEqual(JSON.parse(String(init.body)), {
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
        return Response.json({ token: 'installation-read-token' }, { status: 201 });
      }
      if (url.endsWith('/installation/repositories?per_page=1')) {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer installation-read-token');
        return Response.json({ total_count: 12, repositories: [{ full_name: 'octo-org/one' }] });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof globalThis.fetch,
  });

  assert.match(setup.url, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/$/);
  const landing = await fetch(setup.url);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /Choose <strong>All repositories<\/strong>/);
  assert.doesNotMatch(landingHtml, /local-registration-token|PRIVATE KEY/);
  const manifest = manifestFrom(landingHtml);
  assert.deepEqual(manifest.default_permissions, permissions);
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.hook_attributes, {
    url: 'https://github.com/NiallBrickell/weaver',
    active: false,
  });
  assert.match(String(manifest.redirect_url), new RegExp(`^${setup.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}callback$`));
  assert.equal(manifest.setup_url, `${setup.url}setup?state=${'a'.repeat(64)}`);

  const callback = await fetch(`${setup.url}callback?code=one-time-code&state=${'a'.repeat(64)}`, {
    redirect: 'manual',
  });
  assert.equal(callback.status, 302);
  assert.equal(
    callback.headers.get('location'),
    'https://github.com/apps/weaver-fleet-production-bbbbbb/installations/new',
  );

  const installed = await fetch(`${setup.url}setup?installation_id=67890&setup_action=install&state=${'a'.repeat(64)}`);
  assert.equal(installed.status, 200);
  assert.match(await installed.text(), /verified and stored/);
  await setup.completion;
  assert.deepEqual(loadExecutorSecrets(), {
    WEAVER_GITHUB_APP_ID: '12345',
    WEAVER_GITHUB_APP_INSTALLATION_ID: '67890',
    WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(privateKeyPem).toString('base64'),
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(requests.length, 4);

  const authorization = new Headers(requests[1]?.init.headers).get('authorization');
  if (!authorization?.startsWith('Bearer ')) assert.fail('expected App JWT authorization');
  const jwt = authorization.slice('Bearer '.length);
  assert.doesNotMatch(jwt, /local-registration-token|PRIVATE KEY/);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(parts[2]!, 'base64url')), true);
});

test('setup rejects broader callback spoofing and a selected-repository installation without storing credentials', async () => {
  freshHome();
  const diagnostics: string[] = [];
  const setup = await startGitHubAppSetup('octo-org', {
    localGitHubToken: () => 'local-token',
    randomHex: fixedRandomHex,
    onDiagnostic: (message) => diagnostics.push(message),
    fetch: (async (input) => {
      const url = String(input);
      if (url.includes('/app-manifests/')) {
        return Response.json({
          id: 12345,
          pem: privateKeyPem,
          slug: 'weaver-fleet-production-bbbbbb',
          owner: { login: 'octo-org', type: 'Organization' },
          permissions,
          events: [],
        }, { status: 201 });
      }
      if (url.endsWith('/app/installations/67890')) {
        return Response.json({
          account: { login: 'octo-org' },
          target_type: 'Organization',
          repository_selection: 'selected',
          suspended_at: null,
          permissions,
        });
      }
      throw new Error('must stop before token mint');
    }) as typeof globalThis.fetch,
  });

  let response = await fetch(`${setup.url}callback?code=one-time-code&state=${'c'.repeat(64)}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /registration state did not match/);
  assert.deepEqual(loadExecutorSecrets(), {});

  response = await fetch(`${setup.url}callback?code=one-time-code&state=${'a'.repeat(64)}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  response = await fetch(`${setup.url}setup?installation_id=67890&state=${'a'.repeat(64)}`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /must be an active all-repositories installation/);
  assert.deepEqual(loadExecutorSecrets(), {});
  assert.deepEqual(diagnostics, [
    'GitHub App registration state did not match',
    'GitHub App must be an active all-repositories installation on the expected organization',
  ]);
  await setup.close();
  await assert.rejects(setup.completion, /closed before installation completed/);
});

test('setup validates the exact organization before starting any server or GitHub request', async () => {
  let tokenRead = false;
  await assert.rejects(
    startGitHubAppSetup('../other', { localGitHubToken: () => { tokenRead = true; return 'token'; } }),
    /exact organization login/,
  );
  assert.equal(tokenRead, false);
});
