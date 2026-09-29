/**
 * The store's transport-security contract: a public host never gets a
 * plaintext connection by default, an explicit URL sslmode always wins, and
 * WEAVER_STORE_TLS=off cannot put a public store back in clear. The mapping
 * tests resolve the config through node-postgres itself (a Client that is
 * never connected), so they assert what pg will actually dial with.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { isPrivateStoreHost, isRailwayProxyHost, pgSslOption, storeTls, storeUrlHost } from './pgTls.js';

const NO_ENV: NodeJS.ProcessEnv = {};

/** What pg will use for TLS given the config PgStore builds for this URL. */
function resolvedSsl(connectionString: string, env: NodeJS.ProcessEnv = NO_ENV): unknown {
  const saved = process.env.PGSSLMODE;
  delete process.env.PGSSLMODE;
  try {
    const client = new pg.Client({ connectionString, ...pgSslOption(storeTls(connectionString, env)) });
    return (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
  } finally {
    if (saved !== undefined) process.env.PGSSLMODE = saved;
  }
}

test('store host is read the way node-postgres dials it', () => {
  assert.equal(storeUrlHost('postgres://u:p@Thomas.Proxy.Rlwy.Net:5432/railway'), 'thomas.proxy.rlwy.net');
  assert.equal(storeUrlHost('postgres://u:p@[::1]:5432/db'), '::1');
  assert.equal(storeUrlHost('postgres:///weaver'), '');
  assert.equal(storeUrlHost('postgres://u@public.example.com/db?host=/var/run/postgresql'), '');
  assert.equal(storeUrlHost('postgres://u@localhost/db?host=db.example.com'), 'db.example.com');
  assert.equal(storeUrlHost('not a url'), undefined);
});

test('private hosts are sockets, loopback, private ranges, local names and Railway private networking', () => {
  for (const host of [
    '', 'localhost', 'app.localhost', '127.0.0.1', '127.3.2.1', '::1', '10.1.2.3', '172.16.0.5', '172.31.255.1',
    '192.168.1.10', '169.254.1.1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', 'postgres', 'db',
    'host.docker.internal', 'postgres.railway.internal',
  ]) {
    assert.equal(isPrivateStoreHost(host), true, `${host} should be private`);
  }
  for (const host of [
    'thomas.proxy.rlwy.net', 'db.example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1',
    'railway.internal.evil.com', 'postgres.railway.internal.evil.com', undefined,
  ]) {
    assert.equal(isPrivateStoreHost(host), false, `${String(host)} should be public`);
  }
  assert.equal(isRailwayProxyHost('thomas.proxy.rlwy.net'), true);
  assert.equal(isRailwayProxyHost('rlwy.net.evil.com'), false);
});

test('a public host requires TLS and verifies the certificate by default', () => {
  const tls = storeTls('postgres://u:p@db.example.com:5432/weaver', NO_ENV);
  assert.equal(tls.mode, 'verify-full');
  assert.equal(tls.warning, undefined);
  assert.deepEqual(resolvedSsl('postgres://u:p@db.example.com:5432/weaver'), { rejectUnauthorized: true });
});

test("Railway's proxy is encrypted without verification, and says so", () => {
  const url = 'postgresql://postgres:secret-pw@thomas.proxy.rlwy.net:12345/railway';
  const tls = storeTls(url, NO_ENV);
  assert.equal(tls.mode, 'encrypted-unverified');
  assert.match(tls.warning ?? '', /NOT verified/);
  assert.ok(!(tls.warning ?? '').includes('secret-pw'), 'the warning must never carry the credential');
  assert.deepEqual(resolvedSsl(url), { rejectUnauthorized: false });
});

test('a private host keeps plaintext unless asked', () => {
  assert.equal(storeTls('postgres://weaver:pw@postgres:5432/weaver', NO_ENV).mode, 'private-default');
  assert.equal(resolvedSsl('postgres://weaver:pw@postgres.railway.internal:5432/railway'), false);
  assert.equal(resolvedSsl('postgres://weaver:pw@127.0.0.1:6543/weaver'), false);
});

test('an explicit URL sslmode always wins, with node-postgres semantics', () => {
  const pub = 'postgres://u:p@thomas.proxy.rlwy.net:5432/db';
  const priv = 'postgres://u:p@localhost:5432/db';
  // node-postgres v8: prefer/require/verify-ca are verify-full aliases (warned).
  const warn = process.emitWarning;
  process.emitWarning = () => {};
  try {
    assert.equal(resolvedSsl(`${pub}?sslmode=disable`), false);
    assert.equal(storeTls(`${pub}?sslmode=disable`, NO_ENV).mode, 'url');
    assert.match(storeTls(`${pub}?sslmode=disable`, NO_ENV).warning ?? '', /in clear/);
    assert.deepEqual(resolvedSsl(`${pub}?sslmode=require`), {});
    assert.deepEqual(resolvedSsl(`${pub}?sslmode=verify-full`), {});
    assert.deepEqual(resolvedSsl(`${pub}?sslmode=no-verify`), { rejectUnauthorized: false });
    assert.deepEqual(resolvedSsl(`${pub}?sslmode=require&uselibpqcompat=true`), { rejectUnauthorized: false });
    assert.deepEqual(resolvedSsl(`${priv}?sslmode=prefer&uselibpqcompat=true`), { rejectUnauthorized: false });
    assert.deepEqual(resolvedSsl(`${priv}?sslmode=require`), {});
  } finally {
    process.emitWarning = warn;
  }
  // The pinned-CA upgrade for Railway: chain verified against the pinned
  // root, hostname check skipped (the cert names only the private domain).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-tls-'));
  const ca = path.join(dir, 'root.crt');
  fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  try {
    const pinned = resolvedSsl(`${pub}?sslmode=verify-ca&sslrootcert=${ca}&uselibpqcompat=true`) as Record<string, unknown>;
    assert.equal(pinned.ca, fs.readFileSync(ca, 'utf8'));
    assert.notEqual(pinned.rejectUnauthorized, false);
    assert.equal(typeof pinned.checkServerIdentity, 'function');
    assert.throws(() => resolvedSsl(`${pub}?sslmode=verify-ca&uselibpqcompat=true`), /requires specifying a CA/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WEAVER_STORE_TLS=off is for private test databases only', () => {
  assert.throws(() => storeTls('postgres://u:p@thomas.proxy.rlwy.net:5432/db', { WEAVER_STORE_TLS: 'off' }), /WEAVER_STORE_TLS=off refused/);
  assert.throws(() => storeTls('postgres://u:p@db.example.com/db?sslmode=require', { WEAVER_STORE_TLS: 'off' }), /refused/);
  assert.throws(() => storeTls('not a url', { WEAVER_STORE_TLS: 'off' }), /refused/);
  assert.equal(storeTls('postgres://u:p@localhost:5432/db', { WEAVER_STORE_TLS: 'off' }).mode, 'off');
  assert.equal(resolvedSsl('postgres://u:p@localhost:5432/db', { WEAVER_STORE_TLS: 'off' }), false);
  assert.throws(() => storeTls('postgres://u:p@localhost/db', { WEAVER_STORE_TLS: 'disable' }), /not recognised/);
});

test('PgStore refuses to construct when TLS off targets a public host', async () => {
  const { PgStore } = await import('./pg.js');
  const saved = process.env.WEAVER_STORE_TLS;
  process.env.WEAVER_STORE_TLS = 'off';
  try {
    assert.throws(() => new PgStore('postgres://u:p@db.example.com:5432/weaver'), /WEAVER_STORE_TLS=off refused/);
  } finally {
    if (saved === undefined) delete process.env.WEAVER_STORE_TLS;
    else process.env.WEAVER_STORE_TLS = saved;
  }
});
