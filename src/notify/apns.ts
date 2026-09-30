/**
 * Apple Push Notification service delivery for `weaver ui`.
 *
 * Token-based provider authentication: one ES256 JWT signed with the team's
 * .p8 key authorizes every push. Apple rejects a provider token older than an
 * hour and answers TooManyProviderTokenUpdates when a provider mints them more
 * often than every twenty minutes, so one token is reused for 50 minutes.
 *
 * Pushes go over HTTP/2 to the gateway matching the device's environment: a
 * sandbox token (a development build) only works against the sandbox host, a
 * production token only against production. The transport is injectable so
 * tests never reach Apple.
 *
 * Nothing here logs. Callers log outcomes through `redactApns`, which removes
 * device tokens, provider tokens and the key from any line.
 */

import { createPrivateKey, createHash, sign, type KeyObject } from 'node:crypto';
import * as http2 from 'node:http2';

import type { Device } from '../store.js';

export const APNS_HOSTS: Record<Device['environment'], string> = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
};
export const DEFAULT_APNS_TOPIC = 'ai.erdo.team';
/** Reuse window for one provider token: under Apple's one-hour expiry, over
 * its twenty-minute refresh throttle. */
export const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ApnsConfig {
  /** The .p8 key's PEM text. */
  key: string;
  keyId: string;
  teamId: string;
  /** The app bundle id every push is addressed to. */
  topic: string;
}

export type ApnsConfigResult = { enabled: true; config: ApnsConfig } | { enabled: false; reason: string };

/**
 * Read APNs settings from the environment. Every one of WEAVER_APNS_KEY,
 * WEAVER_APNS_KEY_ID and WEAVER_APNS_TEAM_ID is required; WEAVER_APNS_TOPIC
 * defaults to the Weaver team app. Railway stores multi-line values fine, but
 * a key pasted as one line with literal `\n` escapes is accepted too.
 */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfigResult {
  const missing = ['WEAVER_APNS_KEY', 'WEAVER_APNS_KEY_ID', 'WEAVER_APNS_TEAM_ID'].filter((name) => !env[name]?.trim());
  if (missing.length) return { enabled: false, reason: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set` };
  const key = env.WEAVER_APNS_KEY!.trim().replace(/\\n/g, '\n');
  let parsed: KeyObject;
  try {
    parsed = createPrivateKey(key);
  } catch {
    return { enabled: false, reason: 'WEAVER_APNS_KEY is not a PEM private key (paste the whole .p8 file)' };
  }
  if (parsed.asymmetricKeyType !== 'ec') {
    return { enabled: false, reason: 'WEAVER_APNS_KEY is not an elliptic-curve key (APNs keys are P-256 .p8 files)' };
  }
  return {
    enabled: true,
    config: {
      key,
      keyId: env.WEAVER_APNS_KEY_ID!.trim(),
      teamId: env.WEAVER_APNS_TEAM_ID!.trim(),
      topic: env.WEAVER_APNS_TOPIC?.trim() || DEFAULT_APNS_TOPIC,
    },
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** One provider authentication token: `{alg: ES256, kid}` / `{iss: team, iat}`,
 * signed as a raw 64-byte r||s (JOSE form, not DER). */
export function providerToken(config: Pick<ApnsConfig, 'key' | 'keyId' | 'teamId'>, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: config.key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

/** Remove every credential this module handles from a log line: the key, a
 * JWT, and anything shaped like a device token. */
export function redactApns(line: string, config?: Pick<ApnsConfig, 'key'>): string {
  let out = line;
  if (config?.key) {
    out = out.split(config.key).join('[apns key]');
    const body = config.key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (body.length >= 16) out = out.split(body).join('[apns key]');
  }
  return out
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[provider token]')
    .replace(/\b[0-9a-fA-F]{64,}\b/g, '[device token]');
}

/** A short stable id for one need, so a re-delivered push replaces the one
 * already on screen rather than stacking beside it. */
export function collapseId(needKey: string): string {
  return createHash('sha256').update(needKey).digest('hex').slice(0, 32);
}

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse>;
  close?(): void;
}

/**
 * HTTP/2 to Apple, one reused session per gateway host. A session that
 * errors, closes or receives GOAWAY is dropped and the next push reconnects.
 * Sessions are unref'd so an idle connection never holds the process open.
 */
export function http2Transport(): ApnsTransport {
  const sessions = new Map<string, http2.ClientHttp2Session>();
  const session = (host: string): http2.ClientHttp2Session => {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const created = http2.connect(`https://${host}`);
    const drop = () => {
      if (sessions.get(host) === created) sessions.delete(host);
    };
    created.on('error', drop);
    created.on('close', drop);
    created.on('goaway', () => {
      drop();
      created.close();
    });
    created.unref();
    sessions.set(host, created);
    return created;
  };
  return {
    send(request) {
      return new Promise<ApnsResponse>((resolve, reject) => {
        let stream: http2.ClientHttp2Stream;
        try {
          stream = session(request.host).request({
            ':method': 'POST',
            ':path': request.path,
            'content-type': 'application/json',
            ...request.headers,
          });
        } catch (error) {
          reject(error);
          return;
        }
        let status = 0;
        const chunks: Buffer[] = [];
        stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close(http2.constants.NGHTTP2_CANCEL));
        stream.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0);
        });
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', reject);
        stream.on('close', () => {
          if (!status) reject(new Error('APNs request closed without a response'));
        });
        stream.end(request.body);
      });
    },
    close() {
      for (const open of sessions.values()) open.close();
      sessions.clear();
    },
  };
}

export type ApnsResult =
  | { ok: true }
  /** `unregistered`: Apple says this token will never deliver again (410, or
   * BadDeviceToken / DeviceTokenNotForTopic) — the device should be removed. */
  | { ok: false; status: number; reason: string; unregistered: boolean };

export interface ApnsSenderOptions {
  config: ApnsConfig;
  transport?: ApnsTransport;
  now?: () => number;
}

/** Sends one push to one device, with a cached provider token. */
export class ApnsSender {
  readonly config: ApnsConfig;
  private readonly transport: ApnsTransport;
  private readonly now: () => number;
  private cached: { token: string; at: number } | undefined;

  constructor(opts: ApnsSenderOptions) {
    this.config = opts.config;
    this.transport = opts.transport ?? http2Transport();
    this.now = opts.now ?? Date.now;
  }

  /** The provider token, minted at most once per PROVIDER_TOKEN_TTL_MS. */
  authorization(): string {
    const now = this.now();
    if (!this.cached || now - this.cached.at >= PROVIDER_TOKEN_TTL_MS) {
      this.cached = { token: providerToken(this.config, now), at: now };
    }
    return this.cached.token;
  }

  async send(device: Pick<Device, 'token' | 'environment'>, payload: unknown, collapse: string): Promise<ApnsResult> {
    const response = await this.transport.send({
      host: APNS_HOSTS[device.environment],
      path: `/3/device/${device.token}`,
      headers: {
        authorization: `bearer ${this.authorization()}`,
        'apns-topic': this.config.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': collapse,
      },
      body: JSON.stringify(payload),
    });
    if (response.status === 200) return { ok: true };
    let reason = '';
    try {
      reason = String((JSON.parse(response.body) as { reason?: unknown }).reason ?? '');
    } catch {
      reason = '';
    }
    // Apple expired or rejected the token we hold: mint a fresh one next time.
    // (Only on this answer — refreshing on every failure trips the throttle.)
    if (response.status === 403 && reason === 'ExpiredProviderToken') this.cached = undefined;
    const unregistered = response.status === 410
      || (response.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'));
    return { ok: false, status: response.status, reason: reason || `HTTP ${response.status}`, unregistered };
  }

  close(): void {
    this.transport.close?.();
  }
}
