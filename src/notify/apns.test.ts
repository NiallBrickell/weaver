/**
 * The APNs sender's rails: the provider token is a verifiable ES256 JWT that
 * is reused inside its window, requests carry the documented headers to the
 * device's own gateway, only Apple's "this token is dead" answers mark a
 * device unregistered, credentials never survive redaction, and missing
 * settings disable the notifier with one stated reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';

import {
  APNS_HOSTS,
  ApnsSender,
  DEFAULT_APNS_TOPIC,
  PROVIDER_TOKEN_TTL_MS,
  apnsConfigFromEnv,
  collapseId,
  providerToken,
  redactApns,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from './apns.js';
import { needNotifierFromEnv } from './notifier.js';

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

class FakeTransport implements ApnsTransport {
  requests: ApnsRequest[] = [];
  constructor(private readonly answer: (request: ApnsRequest) => ApnsResponse = () => ({ status: 200, body: '' })) {}
  async send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    return this.answer(request);
  }
}

test('the provider token is an ES256 JWT with kid/iss/iat that the public key verifies', () => {
  const key = p256();
  const now = Date.parse('2026-09-30T10:00:00.000Z');
  const jwt = providerToken({ key: key.pem, keyId: 'KEY1234567', teamId: 'TEAM123456' }, now);
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(decode(claims), { iss: 'TEAM123456', iat: now / 1000 });
  const raw = Buffer.from(signature, 'base64url');
  assert.equal(raw.length, 64, 'JOSE ES256 signatures are raw r||s, not DER');
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, raw), true);
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}x`), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, raw), false);
});

test('one provider token serves 50 minutes, then a fresh one is minted', async () => {
  const key = p256();
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const transport = new FakeTransport();
  const sender = new ApnsSender({ config: { key: key.pem, keyId: 'K', teamId: 'T', topic: 'ai.erdo.team' }, transport, now: () => clock });
  const device = { token: 'ab'.repeat(32), environment: 'production' as const };
  await sender.send(device, {}, 'c');
  clock += PROVIDER_TOKEN_TTL_MS - 1;
  await sender.send(device, {}, 'c');
  clock += 1;
  await sender.send(device, {}, 'c');
  const auth = transport.requests.map((request) => request.headers.authorization);
  assert.equal(auth[0], auth[1], 'reused inside the window (Apple throttles refreshes under 20 minutes)');
  assert.notEqual(auth[1], auth[2], 'replaced at 50 minutes (Apple rejects tokens over an hour old)');
  assert.match(auth[0]!, /^bearer eyJ/);
});

test('a push goes to the device environment gateway with the documented headers', async () => {
  const key = p256();
  const transport = new FakeTransport();
  const sender = new ApnsSender({ config: { key: key.pem, keyId: 'K', teamId: 'T', topic: 'ai.erdo.team' }, transport });
  const token = 'ab'.repeat(32);
  assert.deepEqual(await sender.send({ token, environment: 'sandbox' }, { aps: { alert: 'x' } }, collapseId('k')), { ok: true });
  await sender.send({ token, environment: 'production' }, {}, 'c');
  const [sandbox, production] = transport.requests as [ApnsRequest, ApnsRequest];
  assert.equal(sandbox.host, APNS_HOSTS.sandbox);
  assert.equal(sandbox.host, 'api.sandbox.push.apple.com');
  assert.equal(production.host, 'api.push.apple.com');
  assert.equal(sandbox.path, `/3/device/${token}`);
  assert.equal(sandbox.headers['apns-topic'], 'ai.erdo.team');
  assert.equal(sandbox.headers['apns-push-type'], 'alert');
  assert.equal(sandbox.headers['apns-priority'], '10');
  assert.equal(sandbox.headers['apns-collapse-id'], collapseId('k'));
  assert.ok(collapseId('k').length <= 64);
  assert.equal(collapseId('k'), collapseId('k'));
  assert.deepEqual(JSON.parse(sandbox.body), { aps: { alert: 'x' } });
});

test('only 410 and dead-token 400s mark a device unregistered', async () => {
  const key = p256();
  const answers: ApnsResponse[] = [
    { status: 410, body: '{"reason":"Unregistered"}' },
    { status: 400, body: '{"reason":"BadDeviceToken"}' },
    { status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' },
    { status: 400, body: '{"reason":"PayloadTooLarge"}' },
    { status: 429, body: '{"reason":"TooManyRequests"}' },
    { status: 500, body: 'not json' },
  ];
  let i = 0;
  const sender = new ApnsSender({ config: { key: key.pem, keyId: 'K', teamId: 'T', topic: 't' }, transport: new FakeTransport(() => answers[i++]!) });
  const device = { token: 'ab'.repeat(32), environment: 'production' as const };
  const results = [];
  for (let n = 0; n < answers.length; n += 1) results.push(await sender.send(device, {}, 'c'));
  assert.deepEqual(results.map((r) => !r.ok && r.unregistered), [true, true, true, false, false, false]);
  assert.deepEqual(results.map((r) => !r.ok && r.reason), ['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic', 'PayloadTooLarge', 'TooManyRequests', 'HTTP 500']);
});

test('redaction removes the key, provider tokens and device tokens', () => {
  const key = p256();
  const jwt = providerToken({ key: key.pem, keyId: 'K', teamId: 'T' }, Date.now());
  const token = 'ab'.repeat(32);
  const body = key.pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const line = redactApns(`key=${key.pem} body=${body} auth=bearer ${jwt} path=/3/device/${token}`, { key: key.pem });
  assert.ok(!line.includes(token));
  assert.ok(!line.includes(jwt));
  assert.ok(!line.includes(body));
  assert.ok(!line.includes('PRIVATE KEY'));
  assert.match(line, /\[device token\]/);
  assert.match(line, /\[provider token\]/);
});

test('missing or unusable APNs settings disable the notifier with one stated reason', () => {
  const key = p256();
  assert.deepEqual(apnsConfigFromEnv({}), { enabled: false, reason: 'WEAVER_APNS_KEY, WEAVER_APNS_KEY_ID, WEAVER_APNS_TEAM_ID are not set' });
  assert.deepEqual(apnsConfigFromEnv({ WEAVER_APNS_KEY: key.pem, WEAVER_APNS_KEY_ID: 'K' }), { enabled: false, reason: 'WEAVER_APNS_TEAM_ID is not set' });
  const bad = apnsConfigFromEnv({ WEAVER_APNS_KEY: 'not a key', WEAVER_APNS_KEY_ID: 'K', WEAVER_APNS_TEAM_ID: 'T' });
  assert.equal(bad.enabled, false);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.match((apnsConfigFromEnv({ WEAVER_APNS_KEY: rsa, WEAVER_APNS_KEY_ID: 'K', WEAVER_APNS_TEAM_ID: 'T' }) as { reason: string }).reason, /elliptic-curve/);

  // A one-line value with literal \n escapes is the same key.
  const escaped = apnsConfigFromEnv({ WEAVER_APNS_KEY: key.pem.trim().replace(/\n/g, '\\n'), WEAVER_APNS_KEY_ID: ' K ', WEAVER_APNS_TEAM_ID: 'T' });
  assert.equal(escaped.enabled, true);
  if (escaped.enabled) {
    assert.equal(escaped.config.key, key.pem.trim());
    assert.equal(escaped.config.keyId, 'K');
    assert.equal(escaped.config.topic, DEFAULT_APNS_TOPIC);
  }

  const lines: string[] = [];
  const index = { rows: async () => { throw new Error('a disabled notifier must never read the fleet'); } };
  assert.equal(needNotifierFromEnv(index, { env: {}, log: (line) => lines.push(line) }), null);
  assert.deepEqual(lines, ['[notify] push notifications disabled: WEAVER_APNS_KEY, WEAVER_APNS_KEY_ID, WEAVER_APNS_TEAM_ID are not set']);

  const enabledLines: string[] = [];
  const notifier = needNotifierFromEnv(index, {
    env: { WEAVER_APNS_KEY: key.pem, WEAVER_APNS_KEY_ID: 'K', WEAVER_APNS_TEAM_ID: 'T', WEAVER_APNS_TOPIC: 'ai.example.app' },
    log: (line) => enabledLines.push(line),
    transport: new FakeTransport(),
  });
  assert.ok(notifier);
  assert.deepEqual(enabledLines, ['[notify] push notifications enabled for ai.example.app (key K)']);
});
