import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

import { checkPilotAuthentication, pilotFetch, readPilotVerdict } from './pilot.js';
import { setExecutorSecret } from './secrets.js';

let home = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-pilot-client-'));
  process.env.WEAVER_HOME = home;
  delete process.env.WEAVER_PILOT_URL;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  delete process.env.WEAVER_PILOT_URL;
  fs.rmSync(home, { recursive: true, force: true });
});

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function runAuthCheckCli(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'pilot-auth-check'],
    { cwd: repo, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

test('tokenless loopback Pilot remains compatible and receives no Authorization header', async () => {
  let authorization: string | undefined;
  const { server, url } = await listen((req, res) => {
    authorization = req.headers.authorization;
    res.end('ok');
  });
  process.env.WEAVER_PILOT_URL = `${url}/`;
  try {
    const response = await pilotFetch('/status');
    assert.equal(response.status, 200);
    assert.equal(authorization, undefined);
  } finally {
    server.close();
  }
});

test('registered token replaces caller Authorization and redirects fail closed', async () => {
  const token = 'pilot-redirect-bearer-value-7291';
  setExecutorSecret('WEAVER_PILOT_TOKEN', token);
  const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
  const { server, url } = await listen((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.statusCode = 302;
    res.setHeader('Location', '/redirect-target');
    res.end();
  });
  process.env.WEAVER_PILOT_URL = url;
  try {
    await assert.rejects(
      pilotFetch('/status', { headers: { Authorization: 'Bearer caller-controlled' } }),
      /fetch failed/,
    );
    assert.deepEqual(requests, [{
      path: '/status',
      authorization: `Bearer ${token}`,
    }]);
  } finally {
    server.close();
  }
});

test('verdict scrubbing follows the bearer used for that request across token rotation', async () => {
  const oldToken = 'pilot-old-bearer-value-3294';
  setExecutorSecret('WEAVER_PILOT_TOKEN', oldToken);
  const { server, url } = await listen((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ decision: 'deny', reason: `reflected ${oldToken}` }));
  });
  process.env.WEAVER_PILOT_URL = url;
  try {
    const response = await pilotFetch('/internal/evaluate');
    setExecutorSecret('WEAVER_PILOT_TOKEN', 'pilot-new-bearer-value-8165');
    const verdict = await readPilotVerdict(response);
    assert.equal(verdict.reason, 'reflected «secret:WEAVER_PILOT_TOKEN»');
  } finally {
    server.close();
  }
});

test('remote and malformed Pilot URLs fail before any credential can leave the process', async () => {
  setExecutorSecret('WEAVER_PILOT_TOKEN', 'pilot-url-validation-value-8372');

  process.env.WEAVER_PILOT_URL = 'http://pilot.example.test';
  await assert.rejects(pilotFetch('/status'), /HTTPS, or HTTP on loopback/);

  process.env.WEAVER_PILOT_URL = 'https://user:password@pilot.example.test';
  await assert.rejects(pilotFetch('/status'), /must not contain credentials/);

  process.env.WEAVER_PILOT_URL = 'https://pilot.example.test?target=elsewhere';
  await assert.rejects(pilotFetch('/status'), /query, or a fragment/);
});

test('a remote Pilot and the production auth check both require a registered token', async () => {
  process.env.WEAVER_PILOT_URL = 'https://pilot.example.test';
  await assert.rejects(pilotFetch('/status'), /requires WEAVER_PILOT_TOKEN/);

  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
  await assert.rejects(checkPilotAuthentication(), /requires WEAVER_PILOT_TOKEN/);
});

test('pilot-auth-check exercises the shared bearer client and accepts only HTTP 204', async () => {
  const token = 'pilot-cli-bearer-value-6408';
  setExecutorSecret('WEAVER_PILOT_TOKEN', token);
  const requests: Array<{ path: string | undefined; method: string | undefined; authorization: string | undefined }> = [];
  const { server, url } = await listen((req, res) => {
    requests.push({
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization,
    });
    if (requests.length === 1) {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end(token);
  });
  process.env.WEAVER_PILOT_URL = url;
  try {
    const accepted = await runAuthCheckCli();
    assert.equal(accepted.code, 0);
    assert.equal(accepted.stdout, 'Pilot authentication verified\n');
    assert.equal(accepted.stderr, '');

    const refused = await runAuthCheckCli();
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Pilot authentication check failed \(HTTP 200\)/);
    assert.doesNotMatch(refused.stderr, new RegExp(token));
    assert.equal(refused.stdout, '');

    assert.deepEqual(requests, [
      { path: '/internal/auth-check', method: 'GET', authorization: `Bearer ${token}` },
      { path: '/internal/auth-check', method: 'GET', authorization: `Bearer ${token}` },
    ]);
  } finally {
    server.close();
  }
});
