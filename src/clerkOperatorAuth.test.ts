import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';

import {
  clerkOperatorAuthConfigFromEnv,
  createClerkOperatorAuthenticator,
  parseAllowedEmailDomains,
} from './clerkOperatorAuth.js';

const publishableKey = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`;
const config = {
  publishableKey,
  secretKey: 'test-secret-never-render',
  allowedEmailDomains: ['company.example'],
  publicOrigin: 'https://workspace.example',
};

function request(
  url = '/board',
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'workspace.example', ...headers },
    socket: {},
  } as unknown as IncomingMessage;
}

function state(
  status: 'signed-in' | 'signed-out' | 'handshake',
  userId: string | null = null,
  headers = new Headers(),
) {
  return { status, headers, toAuth: () => userId ? { userId } : {} };
}

test('Clerk environment configuration is atomic and requires a canonical hosted origin', () => {
  assert.equal(clerkOperatorAuthConfigFromEnv({}), undefined);
  const complete = clerkOperatorAuthConfigFromEnv({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
    CLERK_SECRET_KEY: 'secret',
    WEAVER_UI_ALLOWED_EMAIL_DOMAINS: '@Company.Example, second.example',
    WEAVER_UI_PUBLIC_ORIGIN: 'https://workspace.example',
  });
  assert.deepEqual(complete?.allowedEmailDomains, ['company.example', 'second.example']);
  assert.equal(complete?.publicOrigin, 'https://workspace.example');

  for (const partial of [
    { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey },
    { CLERK_SECRET_KEY: 'secret' },
    { WEAVER_UI_ALLOWED_EMAIL_DOMAINS: 'company.example' },
    { WEAVER_UI_PUBLIC_ORIGIN: 'https://workspace.example' },
    {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
      CLERK_SECRET_KEY: 'secret',
      WEAVER_UI_ALLOWED_EMAIL_DOMAINS: 'company.example',
    },
  ]) {
    assert.throws(() => clerkOperatorAuthConfigFromEnv(partial), /Clerk|WEAVER_UI_PUBLIC_ORIGIN/);
  }
  assert.throws(() => clerkOperatorAuthConfigFromEnv({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
    CLERK_SECRET_KEY: 'secret',
    WEAVER_UI_ALLOWED_EMAIL_DOMAINS: 'company.example',
    WEAVER_UI_PUBLIC_ORIGIN: 'http://workspace.example',
  }), /HTTPS origin/);
  assert.equal(clerkOperatorAuthConfigFromEnv({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
    CLERK_SECRET_KEY: 'secret',
    WEAVER_UI_ALLOWED_EMAIL_DOMAINS: 'company.example',
    WEAVER_UI_PUBLIC_ORIGIN: 'http://127.0.0.1:9724',
  })?.publicOrigin, 'http://127.0.0.1:9724');
  assert.throws(() => parseAllowedEmailDomains('company.example, bad/domain'), /valid comma-separated/);
});

test('Clerk authenticates only for the configured origin and overwrites forwarded routing headers', async () => {
  let seenRequest: Request | undefined;
  let seenOptions: { acceptsToken: string; authorizedParties: string[] } | undefined;
  const backend = {
    async authenticateRequest(value: Request, options: { acceptsToken: string; authorizedParties: string[] }) {
      seenRequest = value;
      seenOptions = options;
      return state('signed-out');
    },
    users: { async getUser() { throw new Error('not reached'); } },
  };
  const auth = createClerkOperatorAuthenticator(config, backend);
  assert.equal((await auth.authenticate(request('/board?tab=work', {
    'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'http',
  }))).kind, 'signed-out');
  assert.equal(seenRequest?.url, 'https://workspace.example/board?tab=work');
  assert.equal(seenRequest?.headers.get('host'), 'workspace.example');
  assert.equal(seenRequest?.headers.get('x-forwarded-host'), 'workspace.example');
  assert.equal(seenRequest?.headers.get('x-forwarded-proto'), 'https');
  assert.deepEqual(seenOptions, {
    acceptsToken: 'session_token',
    authorizedParties: ['https://workspace.example'],
  });

  assert.equal((await auth.authenticate(request('/board', { host: 'attacker.example' }))).kind, 'unavailable');
  assert.equal((await auth.authenticate(request('//attacker.example/board'))).kind, 'unavailable');
});

test('only a currently verified exact-domain email becomes the actor', async () => {
  let userReads = 0;
  let verificationStatus = 'verified';
  const backend = {
    async authenticateRequest() { return state('signed-in', 'user_1'); },
    users: {
      async getUser() {
        userReads += 1;
        return {
          primaryEmailAddressId: 'unverified-primary',
          emailAddresses: [
            { id: 'later', emailAddress: 'Zulu@Company.Example', verification: { status: verificationStatus } },
            { id: 'unverified-primary', emailAddress: 'primary@company.example', verification: { status: 'unverified' } },
            { id: 'earlier', emailAddress: 'alpha@company.example', verification: { status: verificationStatus } },
          ],
        };
      },
    },
  };
  const auth = createClerkOperatorAuthenticator(config, backend);
  assert.deepEqual(await auth.authenticate(request()), {
    kind: 'authenticated', actor: 'alpha@company.example', headers: new Headers(),
  });
  verificationStatus = 'unverified';
  assert.equal((await auth.authenticate(request())).kind, 'forbidden');
  assert.equal(userReads, 2, 'domain authorization is revalidated so revocation is immediate');

  for (const email of [
    { emailAddress: 'person@company.example', status: 'unverified' },
    { emailAddress: 'person@sub.company.example', status: 'verified' },
    { emailAddress: 'person@notcompany.example', status: 'verified' },
  ]) {
    const denied = createClerkOperatorAuthenticator(config, {
      async authenticateRequest() { return state('signed-in', `user_${email.emailAddress}`); },
      users: { async getUser() {
        return { emailAddresses: [{ id: 'email', emailAddress: email.emailAddress, verification: { status: email.status } }] };
      } },
    });
    assert.equal((await denied.authenticate(request())).kind, 'forbidden', email.emailAddress);
  }
});

test('Clerk handshakes and refresh headers remain typed while provider failures stay generic', async () => {
  const headers = new Headers();
  headers.set('location', 'https://example.clerk.accounts.dev/handshake');
  headers.append('set-cookie', '__session=one; Path=/; Secure');
  headers.append('set-cookie', '__client=two; Path=/; Secure');
  const redirecting = createClerkOperatorAuthenticator(config, {
    async authenticateRequest() { return state('handshake', null, headers); },
    users: { async getUser() { throw new Error('not reached'); } },
  });
  const redirect = await redirecting.authenticate(request());
  assert.equal(redirect.kind, 'redirect');
  assert.deepEqual(redirect.headers.getSetCookie(), [
    '__session=one; Path=/; Secure',
    '__client=two; Path=/; Secure',
  ]);

  const failing = createClerkOperatorAuthenticator(config, {
    async authenticateRequest() { throw new Error(`SDK leaked ${config.secretKey}`); },
    users: { async getUser() { throw new Error(`API leaked ${config.secretKey}`); } },
  });
  assert.deepEqual(await failing.authenticate(request()), { kind: 'unavailable', headers: new Headers() });

  let reads = 0;
  const transient = createClerkOperatorAuthenticator(config, {
    async authenticateRequest() { return state('signed-in', 'transient_user'); },
    users: { async getUser() { reads += 1; throw new Error('temporary'); } },
  });
  assert.equal((await transient.authenticate(request())).kind, 'unavailable');
  assert.equal((await transient.authenticate(request())).kind, 'unavailable');
  assert.equal(reads, 2, 'transient API failures are not cached as domain verdicts');
});
