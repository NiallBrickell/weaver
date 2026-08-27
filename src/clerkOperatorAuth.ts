import { createClerkClient } from '@clerk/backend';
import {
  clerkJSScriptUrl,
  clerkUIScriptUrl,
} from '@clerk/shared/loadClerkJsScript';
import type { IncomingMessage } from 'node:http';

const CLERK_JS_MAJOR = '6';
const CLERK_UI_MAJOR = '1';

export interface ClerkOperatorAuthConfig {
  publishableKey: string;
  secretKey: string;
  allowedEmailDomains: string[];
  publicOrigin: string;
}

export interface ClerkBrowserAssets {
  publishableKey: string;
  frontendOrigin: string;
  scriptUrl: string;
  uiScriptUrl: string;
}

export type ClerkOperatorAuthResult =
  | { kind: 'authenticated'; actor: string; headers: Headers }
  | { kind: 'signed-out'; headers: Headers }
  | { kind: 'forbidden'; headers: Headers }
  | { kind: 'redirect'; location: string; headers: Headers }
  | { kind: 'unavailable'; headers: Headers };

export interface ClerkOperatorAuthenticator {
  readonly browser: ClerkBrowserAssets;
  authenticate(req: IncomingMessage): Promise<ClerkOperatorAuthResult>;
}

interface ClerkRequestState {
  status: 'signed-in' | 'signed-out' | 'handshake';
  headers: Headers;
  toAuth(): { userId?: string | null } | null;
}

interface ClerkUser {
  primaryEmailAddressId?: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification?: { status?: string | null } | null;
  }>;
}

interface ClerkBackend {
  authenticateRequest(request: Request, options: {
    acceptsToken: 'session_token';
    authorizedParties: string[];
  }): Promise<ClerkRequestState>;
  users: { getUser(userId: string): Promise<ClerkUser> };
}

function normalizedDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^@/, '');
  if (!domain || domain.length > 253 || !domain.includes('.')) return null;
  const labels = domain.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return domain;
}

export function parseAllowedEmailDomains(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    throw new Error('WEAVER_UI_ALLOWED_EMAIL_DOMAINS is required when Clerk authentication is configured');
  }
  const domains = [...new Set(raw.split(',').map(normalizedDomain))];
  if (domains.some((domain) => domain === null)) {
    throw new Error('WEAVER_UI_ALLOWED_EMAIL_DOMAINS must contain valid comma-separated email domains');
  }
  return domains as string[];
}

/**
 * Clerk is an exclusive hosted-auth mode. A single key never falls through to
 * Basic auth: partial configuration is a deployment error and fails closed.
 */
export function clerkOperatorAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClerkOperatorAuthConfig | undefined {
  const publishableKey = env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  const allowedEmailDomains = env.WEAVER_UI_ALLOWED_EMAIL_DOMAINS?.trim();
  const publicOrigin = env.WEAVER_UI_PUBLIC_ORIGIN?.trim();
  if (!publishableKey && !secretKey && !allowedEmailDomains && !publicOrigin) return undefined;
  if (!publishableKey || !secretKey) {
    throw new Error('Clerk authentication requires both NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY');
  }
  return {
    publishableKey,
    secretKey,
    allowedEmailDomains: parseAllowedEmailDomains(allowedEmailDomains),
    publicOrigin: parsePublicOrigin(publicOrigin),
  };
}

function parsePublicOrigin(raw: string | undefined): string {
  if (!raw) throw new Error('WEAVER_UI_PUBLIC_ORIGIN is required when Clerk authentication is configured');
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error('WEAVER_UI_PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin');
  }
  const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '::1';
  if ((origin.protocol !== 'https:' && !(loopback && origin.protocol === 'http:'))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('WEAVER_UI_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only for loopback)');
  }
  return origin.origin;
}

function clerkRequest(req: IncomingMessage, publicOrigin: string): Request {
  const canonical = new URL(publicOrigin);
  const host = req.headers.host;
  if (typeof host !== 'string' || !host || /[\s\\/@?#]/.test(host)) {
    throw new Error('request host is invalid');
  }
  if (host.toLowerCase() !== canonical.host.toLowerCase()) throw new Error('request host is not the configured public origin');
  const target = req.url ?? '/';
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\r\n\0]/.test(target)) {
    throw new Error('request target is invalid');
  }
  const url = new URL(target, canonical);
  if (url.origin !== canonical.origin) throw new Error('request target escaped the configured public origin');
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined
      || name === 'content-length'
      || name === 'transfer-encoding'
      || name === 'x-forwarded-host'
      || name === 'x-forwarded-proto') continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }
  headers.set('host', canonical.host);
  headers.set('x-forwarded-host', canonical.host);
  headers.set('x-forwarded-proto', canonical.protocol.slice(0, -1));
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
  });
}

function emailDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0 || separator === normalized.length - 1) return null;
  return normalized.slice(separator + 1);
}

function allowedVerifiedEmail(user: ClerkUser, allowedDomains: ReadonlySet<string>): string | null {
  const verified = user.emailAddresses.filter((email) =>
    email.verification?.status === 'verified' && allowedDomains.has(emailDomain(email.emailAddress) ?? ''),
  );
  const selected = verified.find((email) => email.id === user.primaryEmailAddressId)
    ?? verified.sort((left, right) => left.emailAddress.localeCompare(right.emailAddress))[0];
  return selected?.emailAddress.trim().toLowerCase() ?? null;
}

export function createClerkOperatorAuthenticator(
  config: ClerkOperatorAuthConfig,
  backend: ClerkBackend = createClerkClient({
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
  }) as ClerkBackend,
): ClerkOperatorAuthenticator {
  const normalizedDomains = config.allowedEmailDomains.map((domain) => normalizedDomain(domain));
  if (normalizedDomains.some((domain) => domain === null)) {
    throw new Error('Clerk authentication requires valid allowed email domains');
  }
  const allowedDomains = new Set(normalizedDomains as string[]);
  if (!allowedDomains.size) throw new Error('Clerk authentication requires at least one allowed email domain');
  const publicOrigin = parsePublicOrigin(config.publicOrigin);
  const scriptUrl = clerkJSScriptUrl({
    publishableKey: config.publishableKey,
    __internal_clerkJSVersion: CLERK_JS_MAJOR,
  });
  const uiScriptUrl = clerkUIScriptUrl({
    publishableKey: config.publishableKey,
    __internal_clerkUIVersion: CLERK_UI_MAJOR,
  });
  const frontendOrigin = new URL(scriptUrl).origin;
  return {
    browser: {
      publishableKey: config.publishableKey,
      frontendOrigin,
      scriptUrl,
      uiScriptUrl,
    },
    async authenticate(req): Promise<ClerkOperatorAuthResult> {
      try {
        const state = await backend.authenticateRequest(clerkRequest(req, publicOrigin), {
          acceptsToken: 'session_token',
          authorizedParties: [publicOrigin],
        });
        const location = state.headers.get('location');
        if (location) return { kind: 'redirect', location, headers: state.headers };
        if (state.status === 'handshake') return { kind: 'unavailable', headers: state.headers };
        if (state.status !== 'signed-in') return { kind: 'signed-out', headers: state.headers };

        const userId = state.toAuth()?.userId;
        if (!userId) return { kind: 'signed-out', headers: state.headers };

        // Domain authorization is revalidated for every request. A failed
        // identity read is not durable state: fail this request closed so
        // email removal and verification changes take effect immediately.
        let user: ClerkUser;
        try {
          user = await backend.users.getUser(userId);
        } catch {
          return { kind: 'unavailable', headers: state.headers };
        }
        const actor = allowedVerifiedEmail(user, allowedDomains);
        return actor
          ? { kind: 'authenticated', actor, headers: state.headers }
          : { kind: 'forbidden', headers: state.headers };
      } catch {
        return { kind: 'unavailable', headers: new Headers() };
      }
    },
  };
}
