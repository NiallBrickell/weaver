/**
 * Plain support replies (src/plain.ts + the customer-reply class of the
 * egress gate). A reply is a send: it runs only as the exact engine command,
 * its approver is decided from the customer the engine reads back from Plain
 * (Pilot for a verified erdo.ai address, a person for everyone else, a person
 * whenever the read fails), and an unknown result is read back, never re-sent.
 * Plain, Pilot and the `weaver` binary are all stood in for locally.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyEgressCommand, egressGatedSupervisor, egressGateSeam, evaluateEgressGate, liveEgressDiffIO } from './egressGate.js';
import { tick, verifyAction } from './engine.js';
import { approveAction } from './humanActs.js';
import {
  actionSecretsForPlain,
  autoApprovableCustomer,
  emailDomain,
  livePlainIO,
  parsePlainReplyCommand,
  plainReplyCommand,
  plainReplySentCommand,
  plainSeam,
  plainSendOutsideReplyCommand,
  runPlainCli,
  type FetchLike,
  type PlainCustomerLookup,
} from './plain.js';
import { engineCommandEnv, removeExecutorSecret, selectNamedSecrets, setExecutorSecret, setSecret } from './secrets.js';
import { arrive, createWorkstream, load } from './store.js';
import { virtualNow } from './clock.js';
import { __resetGitHubAppForTests } from './githubApp.js';
import type { Assignment } from './types.js';

const THREAD = 'th_01H8H46YPB2S4MAJM382FG9423';
const TEXT = 'Hi Sam,\n\nThanks for flagging this. The chart now loads again; please refresh and let us know if it still looks wrong.';

let originalPath: string | undefined;

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-plain-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

/** A stand-in `weaver` on PATH that records what an approved reply would
 * have sent, so the engine's execution path runs end to end with no network. */
function fakeWeaverOnPath(home: string): string {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(home, 'sent.log');
  fs.writeFileSync(
    path.join(bin, 'weaver'),
    `#!/bin/sh\nif [ "$2" = reply ]; then printf '%s reply-key=%s worker-key=%s\\n' "$3" "\${PLAIN_REPLY_API_KEY:+set}" "\${PLAIN_API_KEY:+set}" >> "${log}"; cat >> "${log}"; exit 0; fi\n` +
      `if [ "$2" = reply-sent ]; then test -n "$PLAIN_REPLY_API_KEY" && test -f "${log}"; exit $?; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  return log;
}

function customers(map: Record<string, PlainCustomerLookup>): { threadCustomer: (id: string) => Promise<PlainCustomerLookup>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    threadCustomer: async (id: string) => {
      asked.push(id);
      return map[id] ?? { ok: false, error: 'no such thread' };
    },
  };
}

async function withPilot(decide: () => string, fn: (asked: string[]) => Promise<void>): Promise<void> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      asked.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ decision: decide(), reason: 'stub', source: 'test' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.WEAVER_PILOT_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(asked);
  } finally {
    server.close();
  }
}

async function makeSupportStream(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: 'Support help request',
    objective: 'answer one help request',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    origin: 'untrusted',
  });
}

async function addReply(slug: string, overrides: Partial<NonNullable<Assignment['exec']>> = {}, state: Assignment['state'] = 'gated'): Promise<void> {
  await arrive(slug, (d) => {
    d.assignments.push({
      id: 'asg_reply',
      objective: 'send the first response',
      briefing: 'n/a',
      kind: 'action',
      exec: {
        cwd: process.env.WEAVER_HOME!,
        run: plainReplyCommand(THREAD, TEXT),
        verify: plainReplySentCommand(THREAD, TEXT),
        approvalMode: 'pilot-or-human',
        ask: 'Send the first response to the customer.',
        ...overrides,
      },
      acceptanceCriteria: ['the customer has the reply'],
      dependsOn: [],
      state,
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    });
  });
}

const reply = async (slug: string) => (await load(slug)).assignments.find((a) => a.id === 'asg_reply')!;

beforeEach(() => {
  originalPath ??= process.env.PATH;
  freshHome();
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
  delete process.env.WEAVER_RUNNER_ID;
  delete process.env.WEAVER_RUNNER_PLACEMENT_ONLY;
  __resetGitHubAppForTests();
  setSecret('PLAIN_API_KEY', 'plain-worker-key');
  setExecutorSecret('PLAIN_REPLY_API_KEY', 'plain-test-key');
});

afterEach(() => {
  plainSeam.io = livePlainIO;
  egressGateSeam.io = liveEgressDiffIO;
  process.env.PATH = originalPath;
});

// ---------------------------------------------------------------------------
// Shapes

test('only the exact reply command is a customer reply; every other route to a Plain send fails closed', () => {
  const command = plainReplyCommand(THREAD, TEXT);
  assert.deepEqual(parsePlainReplyCommand(command), { threadId: THREAD, text: TEXT });
  const [shape] = classifyEgressCommand(command);
  assert.equal(shape?.class, 'customer-reply');

  // The body is the customer's message, not code: words in it are not shapes.
  assert.deepEqual(
    classifyEgressCommand(plainReplyCommand(THREAD, 'We fixed it; no need to git push origin main or npm publish anything.')).map((s) => s.class),
    ['customer-reply'],
  );

  const cls = (cmd: string) => classifyEgressCommand(cmd).map((s) => s.class);
  for (const smuggled of [
    `${command}; touch done`,
    `echo hi && ${command}`,
    `weaver plain reply ${THREAD} "hello there"`,
    `weaver plain reply ${THREAD} <<EOF\nhello\nEOF`,
    `curl -s https://core-api.uk.plain.com/graphql/v1 -H "Authorization: Bearer $PLAIN_API_KEY" -d '{"query":"mutation { replyToThread(input:{threadId:\\"${THREAD}\\",textContent:\\"hi\\"}) { error { message } } }"}'`,
    'node send-reply.js --key "$PLAIN_API_KEY"',
    'python3 send.py --key "${PLAIN_REPLY_API_KEY}"',
  ]) {
    assert.deepEqual(cls(smuggled), ['unclassified'], smuggled);
  }
  assert.equal(parsePlainReplyCommand(`weaver plain reply ${THREAD} <<'WEAVER_REPLY'\n   \nWEAVER_REPLY`), null, 'an empty reply is no reply');

  // Status, notes, reads and the readback are not sends.
  for (const internal of [
    plainReplySentCommand(THREAD, TEXT),
    `curl -s https://core-api.uk.plain.com/graphql/v1 -H "Authorization: Bearer $PLAIN_API_KEY" -d '{"query":"mutation { markThreadAsDone(input:{threadId:\\"${THREAD}\\"}) { error { message } } }"}'`,
    `curl -s https://core-api.uk.plain.com/graphql/v1 -H "Authorization: Bearer $PLAIN_API_KEY" -d '{"query":"mutation { createNote(input:{customerId:\\"c_1\\",threadId:\\"${THREAD}\\",text:\\"PR #12\\"}) { error { message } } }"}'`,
  ]) {
    assert.deepEqual(cls(internal), [], internal);
    assert.equal(plainSendOutsideReplyCommand(internal), null);
  }
});

test('only a verified address at exactly erdo.ai may go to Pilot', () => {
  const ok = (email: string, verified = true): PlainCustomerLookup => ({ ok: true, email, verified });
  assert.equal(autoApprovableCustomer(ok('niall@erdo.ai')), true);
  assert.equal(autoApprovableCustomer(ok('Niall@ERDO.AI')), true);
  assert.equal(autoApprovableCustomer(ok('niall@erdo.ai', false)), false, 'unverified');
  assert.equal(autoApprovableCustomer(ok('sam@customer.com')), false);
  assert.equal(autoApprovableCustomer(ok('sam@mail.erdo.ai')), false, 'no subdomains');
  assert.equal(autoApprovableCustomer(ok('sam@erdo.ai.evil.com')), false, 'no lookalikes');
  assert.equal(autoApprovableCustomer(ok('erdo.ai@evil.com')), false);
  assert.equal(autoApprovableCustomer({ ok: false, error: 'boom' }), false);
  assert.equal(emailDomain('a@erdo.ai@evil.com'), 'evil.com');
});

test('the gate decides the approver from the customer it read back, and a missing read is a person\'s act', () => {
  const command = plainReplyCommand(THREAD, TEXT);
  const gate = (lookup?: PlainCustomerLookup) => evaluateEgressGate({
    origin: 'untrusted',
    command,
    cwd: '/tmp',
    ...(lookup ? { plainCustomers: new Map([[THREAD, lookup]]) } : {}),
  });
  const internal = gate({ ok: true, email: 'niall@erdo.ai', verified: true });
  assert.equal(internal.egress, true);
  assert.equal(internal.humanOnly, false, 'an untrusted support stream may reply to erdo.ai through Pilot');
  const external = gate({ ok: true, email: 'sam@customer.com', verified: true });
  assert.equal(external.humanOnly, true);
  assert.deepEqual(external.reasons, [{ kind: 'customer-reply-external', domain: 'customer.com' }]);
  assert.ok(!JSON.stringify(external.reasons).includes('sam@'), 'only the domain is stored');
  const unread = gate({ ok: false, error: 'Plain HTTP 503' });
  assert.equal(unread.humanOnly, true);
  assert.equal(unread.reasons[0]?.kind, 'customer-reply-unverified');
  assert.equal(gate().humanOnly, true, 'no read back at all fails closed');
  // The fingerprint pins text and recipient: either changing is a new act.
  assert.notEqual(gate({ ok: true, email: 'sam@customer.com', verified: true }).fingerprint, gate({ ok: true, email: 'alex@customer.com', verified: true }).fingerprint);
  assert.notEqual(
    external.fingerprint,
    evaluateEgressGate({ origin: 'untrusted', command: plainReplyCommand(THREAD, `${TEXT} More.`), cwd: '/tmp', plainCustomers: new Map([[THREAD, { ok: true, email: 'sam@customer.com', verified: true }]]) }).fingerprint,
  );
});

test('only the recognised reply action holds the send key, and no action holds the worker key', () => {
  const secrets = { PLAIN_API_KEY: 'w', PLAIN_REPLY_API_KEY: 'misplaced', SENTRY_AUTH_TOKEN: 's' };
  assert.deepEqual(
    actionSecretsForPlain(secrets, plainReplyCommand(THREAD, TEXT), 'r'),
    { SENTRY_AUTH_TOKEN: 's', PLAIN_REPLY_API_KEY: 'r' },
    'the executor-only key, never a worker-store copy',
  );
  assert.deepEqual(actionSecretsForPlain(secrets, plainReplyCommand(THREAD, TEXT), undefined), { SENTRY_AUTH_TOKEN: 's' });
  assert.deepEqual(actionSecretsForPlain(secrets, 'gh pr merge 12 --merge', 'r'), { SENTRY_AUTH_TOKEN: 's' });
  assert.deepEqual(actionSecretsForPlain(secrets, undefined, 'r'), { SENTRY_AUTH_TOKEN: 's' }, 'a model-driven action never holds it');
});

test('no assignment or probe can select the send key, and the worker store refuses it', () => {
  assert.throws(
    () => selectNamedSecrets({ PLAIN_REPLY_API_KEY: 'r', PLAIN_API_KEY: 'w' }, ['PLAIN_REPLY_API_KEY']),
    /PLAIN_REPLY_API_KEY' is executor-only/,
  );
  assert.deepEqual(selectNamedSecrets({ PLAIN_API_KEY: 'w' }, ['PLAIN_API_KEY']), { PLAIN_API_KEY: 'w' }, 'the worker key stays selectable');
  assert.throws(() => setSecret('PLAIN_REPLY_API_KEY', 'r'), /--executor/);
  assert.throws(() => setSecret('PLAIN_REPLY_API_KEY', 'r', 'some-stream'), /--executor/);
  // The engine passes it through to the one command that was handed it, and
  // strips it from every other engine command's ambient environment.
  const ambient = process.env.PLAIN_REPLY_API_KEY;
  process.env.PLAIN_REPLY_API_KEY = 'plain-test-key';
  try {
    assert.equal(engineCommandEnv({ PLAIN_REPLY_API_KEY: 'plain-test-key' }).PLAIN_REPLY_API_KEY, 'plain-test-key');
    assert.equal(engineCommandEnv({}).PLAIN_REPLY_API_KEY, undefined);
  } finally {
    if (ambient === undefined) delete process.env.PLAIN_REPLY_API_KEY;
    else process.env.PLAIN_REPLY_API_KEY = ambient;
  }
});

// ---------------------------------------------------------------------------
// The engine path

test('a reply to an erdo.ai customer goes through Pilot and runs once as the exact command', async () => {
  const log = fakeWeaverOnPath(process.env.WEAVER_HOME!);
  const plain = customers({ [THREAD]: { ok: true, email: 'niall@erdo.ai', verified: true } });
  plainSeam.io = plain;
  await withPilot(() => 'approve', async (asked) => {
    await makeSupportStream('reply-internal');
    await addReply('reply-internal');
    await tick('reply-internal', { maxPasses: 0 });
    const asg = await reply('reply-internal');
    assert.ok(asked.length >= 1, 'Pilot judged the literal reply');
    assert.ok(asked.some((body) => body.includes('weaver plain reply')));
    assert.deepEqual(asg.exec!.egressGate!.reasons, []);
    assert.equal(asg.exec!.approval?.by, 'pilot');
    assert.equal(asg.attempts.length, 1, 'sent exactly once');
    assert.ok(plain.asked.length >= 2, 'the customer was read back at gate time and again before egress');
  });
  const sent = fs.readFileSync(log, 'utf8');
  assert.match(sent, new RegExp(`^${THREAD} reply-key=set worker-key=\\n`), 'the approved reply held the send key and not the worker key');
  assert.equal(await verifyAction('reply-internal', 'asg_reply'), true, 'the reply-sent readback held the send key too');
  assert.ok(sent.includes('Thanks for flagging this.'));
});

test('a reply to any other customer is a person\'s act and Pilot is never asked', async () => {
  const log = fakeWeaverOnPath(process.env.WEAVER_HOME!);
  plainSeam.io = customers({ [THREAD]: { ok: true, email: 'sam@customer.com', verified: true } });
  await withPilot(() => 'approve', async (asked) => {
    await makeSupportStream('reply-external');
    await addReply('reply-external');
    await tick('reply-external', { maxPasses: 0 });
    const asg = await reply('reply-external');
    assert.equal(asked.length, 0, 'Pilot was never consulted');
    assert.equal(asg.state, 'gated');
    assert.equal(asg.exec!.approvalMode, 'human-only');
    const card = (await load('reply-external')).attention.find((a) => a.refId === 'asg_reply' && a.status === 'open')!;
    assert.match(card.summary, /customer replies need a person unless the customer is a verified erdo\.ai address \(this one is at customer\.com\)/);
  });
  assert.equal(fs.existsSync(log), false, 'nothing was sent');

  // The person approves what they were shown; the engine re-reads the
  // customer just before egress, finds the same act, and sends it.
  await approveAction('reply-external', 'asg_reply');
  await tick('reply-external', { maxPasses: 0 });
  const sent = await reply('reply-external');
  assert.equal(sent.attempts.length, 1);
  assert.ok(fs.readFileSync(log, 'utf8').includes('Thanks for flagging this.'));
});

test('a reply whose customer cannot be read back fails closed to a person', async () => {
  fakeWeaverOnPath(process.env.WEAVER_HOME!);
  plainSeam.io = customers({ [THREAD]: { ok: false, error: 'Plain HTTP 503: unavailable' } });
  await withPilot(() => 'approve', async (asked) => {
    await makeSupportStream('reply-unread');
    await addReply('reply-unread');
    await tick('reply-unread', { maxPasses: 0 });
    const asg = await reply('reply-unread');
    assert.equal(asked.length, 0);
    assert.equal(asg.exec!.approvalMode, 'human-only');
    assert.equal(asg.exec!.egressGate!.reasons[0]?.kind, 'customer-reply-unverified');
  });
});

test('a runner without the executor-only send key cannot verify the customer, so the reply is a person\'s act', async () => {
  fakeWeaverOnPath(process.env.WEAVER_HOME!);
  removeExecutorSecret('PLAIN_REPLY_API_KEY');
  plainSeam.io = customers({ [THREAD]: { ok: true, email: 'niall@erdo.ai', verified: true } });
  await withPilot(() => 'approve', async (asked) => {
    await makeSupportStream('reply-nokey');
    await addReply('reply-nokey');
    await tick('reply-nokey', { maxPasses: 0 });
    const asg = await reply('reply-nokey');
    assert.equal(asked.length, 0, 'the worker key is never used for the readback');
    assert.equal(asg.exec!.approvalMode, 'human-only');
    assert.equal(asg.exec!.egressGate!.reasons[0]?.kind, 'customer-reply-unverified');
  });
});

test('a Pilot approval does not cover a reply whose thread now belongs to an outside customer', async () => {
  const log = fakeWeaverOnPath(process.env.WEAVER_HOME!);
  await makeSupportStream('reply-moved');
  await addReply('reply-moved');
  await arrive('reply-moved', (d) => {
    const a = d.assignments[0]!;
    a.state = 'queued';
    a.exec!.approval = { by: 'pilot', at: new Date().toISOString() };
  });
  plainSeam.io = customers({ [THREAD]: { ok: true, email: 'sam@customer.com', verified: true } });
  await tick('reply-moved', { maxPasses: 0 });
  const asg = await reply('reply-moved');
  assert.equal(asg.state, 'gated', 'returned to the human gate just before egress');
  assert.equal(asg.attempts.length, 0);
  assert.ok((await load('reply-moved')).events.some((e) => e.type === 'action.egress_gate_revoked'));
  assert.equal(fs.existsSync(log), false);
});

test('a model-driven action cannot reach a Plain send by any call shape', async () => {
  const pilotCalls: string[] = [];
  const supervised = egressGatedSupervisor({ exec: { cwd: '/tmp', verify: 'true' } }, 'untrusted', async (_tool, input) => {
    pilotCalls.push(String(input.command));
    return { behavior: 'allow' as const, updatedInput: input };
  });
  for (const command of [
    plainReplyCommand(THREAD, TEXT),
    `curl https://core-api.uk.plain.com/graphql/v1 -H "Authorization: Bearer $PLAIN_API_KEY" -d '{"query":"mutation { replyToThread(input:{}) { error { message } } }"}'`,
  ]) {
    const verdict = await supervised('Bash', { command });
    assert.equal(verdict.behavior, 'deny', command);
  }
  assert.deepEqual(pilotCalls, []);
});

// ---------------------------------------------------------------------------
// `weaver plain` against a stand-in Plain

function plainServer(handler: (body: { query: string; variables: Record<string, unknown> }) => unknown): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    calls.push(body.query.match(/(query|mutation) (\w+)/)?.[2] ?? '?');
    assert.equal(init.headers.Authorization, 'Bearer plain-test-key');
    const result = handler(body);
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  }) as unknown as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function cli(argv: string[], stdin: string, fetchImpl: FetchLike, env: NodeJS.ProcessEnv = { PLAIN_REPLY_API_KEY: 'plain-test-key' }) {
  const out: string[] = [];
  const err: string[] = [];
  return runPlainCli(argv, { env, stdin: async () => stdin, out: (t) => out.push(t), err: (t) => err.push(t), fetch: fetchImpl })
    .then((code) => ({ code, out: out.join(''), err: err.join('') }));
}

test('weaver plain reply sends the stdin text once as the machine user and reports refusals and unknowns apart', async () => {
  const ok = plainServer(({ variables }) => {
    const input = variables.input as { threadId: string; textContent: string; impersonation?: unknown };
    assert.equal(input.threadId, THREAD);
    assert.equal(input.textContent, TEXT);
    assert.equal(input.impersonation, undefined, 'replies come from the machine user');
    return { data: { replyToThread: { error: null } } };
  });
  assert.equal((await cli(['reply', THREAD], `${TEXT}\n`, ok)).code, 0);
  assert.deepEqual(ok.calls, ['WeaverReplyToThread']);

  const refused = plainServer(() => ({ data: { replyToThread: { error: { message: 'cannot reply', code: 'cannot_reply_to_thread' } } } }));
  const r = await cli(['reply', THREAD], TEXT, refused);
  assert.equal(r.code, 1, 'a refusal is a known outcome with no effect');

  const dropped = plainServer(() => new Error('socket hang up'));
  const u = await cli(['reply', THREAD], TEXT, dropped);
  assert.equal(u.code, 2);
  assert.match(u.err, /UNKNOWN: read back, never re-send/);

  const noKey = await cli(['reply', THREAD], TEXT, ok, {});
  assert.equal(noKey.code, 1);
  const workerKeyOnly = await cli(['reply', THREAD], TEXT, ok, { PLAIN_API_KEY: 'plain-worker-key' });
  assert.equal(workerKeyOnly.code, 1, 'the worker key is never a send key');
  assert.match(workerKeyOnly.err, /PLAIN_REPLY_API_KEY is not set/);
  assert.equal((await cli(['reply', 'not-a-thread'], TEXT, ok)).code, 1);
});

test('weaver plain reply-sent finds the machine user\'s reply, ignores the customer\'s words, and an unreadable thread is unknown', async () => {
  const pages = [
    {
      edges: [
        { node: { actor: { __typename: 'CustomerActor' }, entry: { __typename: 'ChatEntry', text: TEXT } } },
        { node: { actor: { __typename: 'MachineUserActor' }, entry: { __typename: 'NoteEntry' } } },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
    },
    {
      edges: [{ node: { actor: { __typename: 'MachineUserActor' }, entry: { __typename: 'EmailEntry', textContent: `${TEXT.replace(/\n+/g, ' ')}\n\n-- Erdo Support`, markdownContent: null } } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  ];
  const found = plainServer(({ variables }) => ({ data: { thread: { timelineEntries: variables.after ? pages[1] : pages[0] } } }));
  assert.equal((await cli(['reply-sent', THREAD], `${TEXT}\n`, found)).code, 0);

  const onlyCustomer = plainServer(() => ({ data: { thread: { timelineEntries: { ...pages[0], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
  assert.equal((await cli(['reply-sent', THREAD], TEXT, onlyCustomer)).code, 1, 'the customer quoting the text is not our reply');

  const down = plainServer(() => new Error('ECONNRESET'));
  assert.equal((await cli(['reply-sent', THREAD], TEXT, down)).code, 2);
});
