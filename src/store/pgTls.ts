/**
 * Transport security for the Postgres store, decided from the URL's host.
 *
 * A hosted fleet reaches its store across the public internet (Railway's TCP
 * proxy, `*.proxy.rlwy.net`) with a credential that can rewrite every
 * Workstream, decision and policy. node-postgres defaults to plaintext when
 * neither the config nor the URL asks for TLS, so until this module the shared
 * fleet's password and every document crossed the internet unencrypted. The
 * rule now:
 *
 *   - An explicit TLS parameter in the URL (`sslmode`, `ssl`, `sslrootcert`,
 *     `uselibpqcompat`, …) always wins, interpreted by node-postgres itself.
 *     Note node-postgres v8 treats `prefer`/`require`/`verify-ca` as aliases
 *     for `verify-full`; `uselibpqcompat=true` opts into libpq's meanings.
 *   - A private host (unix socket, loopback, RFC 1918 / ULA / link-local
 *     address, `localhost`, a single-label Docker/compose service name,
 *     `host.docker.internal`, `*.railway.internal`) keeps the previous
 *     behaviour: no TLS unless the environment (PGSSLMODE) asks for it.
 *   - Any other host REQUIRES TLS and verifies the certificate against the
 *     public CA store and the hostname (verify-full).
 *   - Railway's TCP proxy is the one measured exception: its Postgres image
 *     presents a certificate signed by a per-volume self-generated `root-ca`
 *     whose SANs are `localhost` and the private domain, never the proxy host
 *     (probed 2026-09-29). There verify-full cannot succeed, so the default is
 *     encrypted WITHOUT verification — an interim state logged on every
 *     process start. Pinning that CA in the URL
 *     (`?sslmode=verify-ca&sslrootcert=<root.crt>&uselibpqcompat=true`) upgrades
 *     it to a verified channel; see docs-public/railway.md.
 *
 * `WEAVER_STORE_TLS=off` exists only for local test databases: it forces
 * plaintext and refuses any non-private host, so a stray env var cannot quietly
 * put a public store back on the wire in clear.
 */

import { isIP } from 'node:net';

/** URL parameters node-postgres reads as an explicit TLS decision. */
const EXPLICIT_TLS_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat', 'sslnegotiation'];

export type StoreTlsMode =
  /** The URL states its own TLS parameters; node-postgres interprets them. */
  | 'url'
  /** Private host: unchanged node-postgres default (plaintext unless PGSSLMODE). */
  | 'private-default'
  /** WEAVER_STORE_TLS=off on a private host. */
  | 'off'
  /** TLS required, certificate chain and hostname verified. */
  | 'verify-full'
  /** TLS required, certificate NOT verified (Railway proxy interim). */
  | 'encrypted-unverified';

export interface StoreTls {
  mode: StoreTlsMode;
  host: string;
  /** Passed as pg's `ssl` option; undefined leaves the decision to pg (URL / PGSSLMODE). */
  ssl: undefined | false | { rejectUnauthorized: boolean };
  /** One line for the operator when the channel is weaker than verify-full on a public host. */
  warning?: string;
}

/**
 * The host a postgres URL dials, as node-postgres would: a `host` query
 * parameter overrides the authority, and an empty host or a path means a unix
 * socket. Returns '' for a socket. An unparseable URL returns undefined, which
 * callers treat as public (fail closed toward TLS).
 */
export function storeUrlHost(connectionString: string): string | undefined {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }
  const queryHost = url.searchParams.get('host');
  const raw = queryHost ?? decodeURIComponent(url.hostname);
  if (raw === '' || raw.startsWith('/')) return '';
  return raw.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function isPrivateIPv4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return /^f[cd][0-9a-f]{0,2}:/.test(lower) || /^fe[89ab][0-9a-f]?:/.test(lower);
}

/**
 * True when the host is reachable only on a private network, where the
 * provider's network (not TLS) is what keeps the traffic off the internet.
 */
export function isPrivateStoreHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  if (host === '') return true; // unix socket
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIPv4(host);
  if (ipVersion === 6) return isPrivateIPv6(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.railway.internal') || host === 'host.docker.internal') return true;
  // A single-label name (compose's `postgres`, a Docker network alias)
  // resolves only on the local network; a public name always has a dot.
  return !host.includes('.');
}

/** Railway's public TCP proxy, whose certificate cannot verify for the proxy host. */
export function isRailwayProxyHost(host: string | undefined): boolean {
  return host !== undefined && (host === 'rlwy.net' || host.endsWith('.rlwy.net'));
}

function hasExplicitTls(connectionString: string): boolean {
  try {
    const params = new URL(connectionString).searchParams;
    return EXPLICIT_TLS_PARAMS.some((name) => params.has(name));
  } catch {
    return false;
  }
}

/**
 * Decide the store's TLS from its URL and environment. Throws — the store
 * refuses to start — when WEAVER_STORE_TLS is unrecognised or is `off` against
 * a non-private host.
 */
export function storeTls(connectionString: string, env: NodeJS.ProcessEnv = process.env): StoreTls {
  const host = storeUrlHost(connectionString);
  const hostLabel = host === undefined ? '<unparseable>' : host === '' ? '<unix socket>' : host;
  const isPrivate = isPrivateStoreHost(host);
  const override = env.WEAVER_STORE_TLS?.trim();
  if (override !== undefined && override !== '' && override !== 'off') {
    throw new Error(`WEAVER_STORE_TLS=${override} is not recognised; the only accepted value is "off" (private test databases only)`);
  }
  if (override === 'off' && !isPrivate) {
    throw new Error(
      `WEAVER_STORE_TLS=off refused: the store host ${hostLabel} is not on a private network. ` +
        'Plaintext is only for local test databases; unset WEAVER_STORE_TLS for a hosted store.',
    );
  }
  if (hasExplicitTls(connectionString)) {
    const params = new URL(connectionString).searchParams;
    const disabled = params.get('sslmode') === 'disable' || params.get('ssl') === 'false' || params.get('ssl') === '0';
    return {
      mode: 'url',
      host: hostLabel,
      ssl: undefined,
      ...(disabled && !isPrivate
        ? { warning: `[store] the store URL disables TLS to ${hostLabel}, a public host: the credential and every document cross the network in clear.` }
        : {}),
    };
  }
  if (override === 'off') return { mode: 'off', host: hostLabel, ssl: false };
  if (isPrivate) return { mode: 'private-default', host: hostLabel, ssl: undefined };
  if (isRailwayProxyHost(host)) {
    return {
      mode: 'encrypted-unverified',
      host: hostLabel,
      ssl: { rejectUnauthorized: false },
      warning:
        `[store] TLS to ${hostLabel} is encrypted but the server certificate is NOT verified ` +
        "(Railway's proxy presents a self-signed per-database CA). Pin it with " +
        '?sslmode=verify-ca&sslrootcert=<root.crt>&uselibpqcompat=true — see docs-public/railway.md.',
    };
  }
  return { mode: 'verify-full', host: hostLabel, ssl: { rejectUnauthorized: true } };
}

/** The pg client-config fragment for a decision: nothing when pg decides itself. */
export function pgSslOption(tls: StoreTls): { ssl?: false | { rejectUnauthorized: boolean } } {
  return tls.ssl === undefined ? {} : { ssl: tls.ssl };
}
