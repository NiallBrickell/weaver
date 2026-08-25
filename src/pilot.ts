/**
 * Authenticated access to the operator's Pilot daemon.
 *
 * WEAVER_PILOT_TOKEN is an executor-only secret: it is reloaded for every
 * request so rotation does not require a resident runner restart, and it must
 * never enter process.env, a worker environment, or durable Workstream state.
 * A missing token preserves the unauthenticated loopback Pilot contract used
 * by existing local installations; a remote Pilot always requires one.
 */

import { loadExecutorSecrets } from './secrets.js';

const bearerByResponse = new WeakMap<Response, string>();

function configuredPilotBase(): { url: URL; loopback: boolean } {
  let url: URL;
  try {
    url = new URL(process.env.WEAVER_PILOT_URL ?? 'http://127.0.0.1:9721');
  } catch {
    throw new Error('WEAVER_PILOT_URL must be a valid absolute URL');
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('WEAVER_PILOT_URL must use HTTPS, or HTTP on loopback');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('WEAVER_PILOT_URL must not contain credentials, a query, or a fragment');
  }
  return { url, loopback };
}

export async function pilotFetch(
  path: `/${string}`,
  init: RequestInit = {},
  options: { requireToken?: boolean } = {},
): Promise<Response> {
  const { url, loopback } = configuredPilotBase();
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  const headers = new Headers(init.headers);
  headers.delete('Authorization');
  const token = loadExecutorSecrets().WEAVER_PILOT_TOKEN;
  if (!token && (options.requireToken || !loopback)) {
    throw new Error('Pilot authentication requires WEAVER_PILOT_TOKEN in the executor-only secret store');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers, redirect: 'error' });
  if (token) bearerByResponse.set(response, token);
  return response;
}

export interface PilotVerdict {
  decision?: string;
  reason?: string;
  source?: string;
}

/** A Pilot response is external input; never let it reflect its bearer onward. */
export async function readPilotVerdict(response: Response): Promise<PilotVerdict> {
  const body = (await response.json()) as PilotVerdict;
  const token = bearerByResponse.get(response);
  const scrub = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    return token ? value.split(token).join('«secret:WEAVER_PILOT_TOKEN»') : value;
  };
  return {
    decision: scrub(body.decision),
    reason: scrub(body.reason),
    source: scrub(body.source),
  };
}

/** Production preflight: prove the installed client sent a registered bearer. */
export async function checkPilotAuthentication(): Promise<void> {
  const response = await pilotFetch(
    '/internal/auth-check',
    { method: 'GET', signal: AbortSignal.timeout(5_000) },
    { requireToken: true },
  );
  if (response.status !== 204) {
    throw new Error(`Pilot authentication check failed (HTTP ${response.status})`);
  }
}
