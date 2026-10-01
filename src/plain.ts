/**
 * Plain (app.plain.com) — the support tool erdo mirrors its Help Requests
 * into. Weaver has no channel adapter for it: support workers keep a thread's
 * status and internal notes in sync themselves (reversible tracker sync,
 * kernel rule 7, with the worker credential PLAIN_API_KEY). What lives here is
 * only what the engine needs for the one irreversible act, a customer-facing
 * reply:
 *
 * - the exact command shape a reply must take (`weaver plain reply`), so the
 *   egress gate can recognise it and refuse every other route to a send;
 * - the deterministic readback (`weaver plain reply-sent`) an action's verify
 *   uses, so an unknown result is read back and never re-sent;
 * - the customer readback the gate uses to decide who must approve, read
 *   from Plain at approval and again immediately before egress, never from
 *   model-written text.
 *
 * See docs-public/plain.md for the operator's view.
 */

import { createHash } from 'node:crypto';

export const PLAIN_API_URL = 'https://core-api.uk.plain.com/graphql/v1';
export const PLAIN_API_KEY_NAME = 'PLAIN_API_KEY';
/** A reply to a verified customer at exactly this domain may go to Pilot;
 * every other reply needs a person. */
export const PLAIN_AUTO_REPLY_DOMAIN = 'erdo.ai';
export const PLAIN_REPLY_DELIMITER = 'WEAVER_REPLY';

const THREAD_ID = /^th_[0-9A-Za-z]{6,64}$/;

// ---------------------------------------------------------------------------
// The command shapes

export interface PlainReplyCommand {
  threadId: string;
  text: string;
}

const CANONICAL_REPLY = new RegExp(
  `^\\s*weaver plain reply (th_[0-9A-Za-z]{6,64}) <<'${PLAIN_REPLY_DELIMITER}'\\n([\\s\\S]*?)\\n${PLAIN_REPLY_DELIMITER}\\s*$`,
);

/**
 * The one shape a customer reply may take as an engine command: the whole
 * command is `weaver plain reply <thread> <<'WEAVER_REPLY'`, the reply text,
 * and the closing delimiter — nothing chained before or after it. Anything
 * else returns null; the gate then treats a Plain send it can see as
 * unclassifiable and routes it to a person.
 */
export function parsePlainReplyCommand(cmd: string | undefined): PlainReplyCommand | null {
  if (!cmd) return null;
  const match = CANONICAL_REPLY.exec(cmd);
  if (!match) return null;
  const text = match[2]!;
  if (!text.trim()) return null;
  return { threadId: match[1]!, text };
}

/** Render the exact reply command (the form coordinators put in exec_run). */
export function plainReplyCommand(threadId: string, text: string): string {
  return `weaver plain reply ${threadId} <<'${PLAIN_REPLY_DELIMITER}'\n${text}\n${PLAIN_REPLY_DELIMITER}`;
}

/** Render the matching readback (the form coordinators put in verify). */
export function plainReplySentCommand(threadId: string, text: string): string {
  return `weaver plain reply-sent ${threadId} <<'${PLAIN_REPLY_DELIMITER}'\n${text}\n${PLAIN_REPLY_DELIMITER}`;
}

export function plainReplyTextHash(text: string): string {
  return createHash('sha256').update(normalizeReplyText(text)).digest('hex').slice(0, 16);
}

/** Plain's customer-facing message mutations. Notes and status changes are
 * internal and absent on purpose. */
const PLAIN_SEND_MUTATION = /\b(replyToThread|replyToEmail|sendNewEmail|sendChat|sendCustomerChat|sendSlackMessage|replyToSlackMessage|sendMSTeamsMessage|replyToMSTeamsMessage|sendDiscordMessage|replyToDiscordMessage)\b/;
const PLAIN_REFERENCE = /plain\.com|\$\{?PLAIN_API_KEY\b|@team-plain/i;
const SCRIPT_RUNNER = /(^|[\s;&|(`])(node|python3?|ruby|perl|deno|bun|php|pwsh|npx|tsx)(\s|$)/;

/**
 * A customer-facing Plain send this command could perform OUTSIDE the one
 * recognised shape, as a short reason; null when there is none. Over-matching
 * is intended: it only ever routes an act to a person. Reading a thread or
 * writing a note or status is not a send and returns null.
 */
export function plainSendOutsideReplyCommand(cmd: string): string | null {
  if (!cmd?.trim() || parsePlainReplyCommand(cmd)) return null;
  // `weaver plain reply` in any other form (chained, a different heredoc, an
  // argument instead of stdin) — the gate cannot see what it sends.
  if (/\bweaver\s+plain\s+reply(\s|$)/.test(cmd)) return 'a `weaver plain reply` command in a shape the engine does not recognise';
  if (PLAIN_REFERENCE.test(cmd) && PLAIN_SEND_MUTATION.test(cmd)) return 'a Plain customer message sent outside `weaver plain reply`';
  // A script holding the key can send anything, and its text is not here.
  if (/\$\{?PLAIN_API_KEY\b/.test(cmd) && SCRIPT_RUNNER.test(cmd)) return 'a script using PLAIN_API_KEY, whose requests the engine cannot see';
  return null;
}

/**
 * The applicable secrets an ACTION may hold. PLAIN_API_KEY can send to a
 * customer, so an action receives it only when its literal command is the
 * recognised reply the egress gate judged — the structural backstop that
 * makes a script or a model-driven action unable to reach a send the gate
 * never saw. Ordinary work still selects it by name for status and notes.
 */
export function actionSecretsWithoutPlainSend(
  secrets: Record<string, string>,
  run: string | undefined,
): Record<string, string> {
  if (!(PLAIN_API_KEY_NAME in secrets) || parsePlainReplyCommand(run)) return secrets;
  const { [PLAIN_API_KEY_NAME]: _withheld, ...rest } = secrets;
  return rest;
}

// ---------------------------------------------------------------------------
// Who the customer is

export type PlainCustomerLookup =
  | { ok: true; email: string; verified: boolean }
  | { ok: false; error: string };

/** The domain of an email address, lower-cased; null when it is not one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

/** May a reply to this customer go to Pilot rather than a person? Only a
 * verified address at exactly erdo.ai — no subdomain, no lookalike. */
export function autoApprovableCustomer(lookup: PlainCustomerLookup): boolean {
  return lookup.ok && lookup.verified && emailDomain(lookup.email) === PLAIN_AUTO_REPLY_DOMAIN;
}

// ---------------------------------------------------------------------------
// GraphQL (IO)

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class PlainRequestError extends Error {
  /** True when the request may have reached Plain and its outcome is unknown. */
  constructor(message: string, readonly unknown: boolean) {
    super(message);
  }
}

async function plainGraphql(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  let res;
  try {
    res = await fetchImpl(PLAIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new PlainRequestError(`Plain request failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // A 5xx may have applied; a 4xx (auth, permission, bad input) did not.
    throw new PlainRequestError(`Plain HTTP ${res.status}: ${text.slice(0, 300)}`, res.status >= 500);
  }
  let body: { data?: Record<string, unknown>; errors?: Array<{ message?: string }> };
  try {
    body = JSON.parse(text);
  } catch {
    throw new PlainRequestError('Plain returned a body that is not JSON', true);
  }
  if (body.errors?.length) {
    throw new PlainRequestError(`Plain GraphQL error: ${body.errors.map((e) => e.message ?? '?').join('; ').slice(0, 300)}`, false);
  }
  return body.data ?? {};
}

const THREAD_CUSTOMER_QUERY = `query WeaverThreadCustomer($threadId: ID!) {
  thread(threadId: $threadId) { id customer { id email { email isVerified } } }
}`;

export async function readThreadCustomer(threadId: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<PlainCustomerLookup> {
  if (!THREAD_ID.test(threadId)) return { ok: false, error: `not a Plain thread id: ${threadId.slice(0, 40)}` };
  try {
    const data = await plainGraphql(apiKey, THREAD_CUSTOMER_QUERY, { threadId }, fetchImpl);
    const thread = data.thread as { customer?: { email?: { email?: string; isVerified?: boolean } } } | null | undefined;
    if (!thread) return { ok: false, error: `Plain has no thread ${threadId}` };
    const email = thread.customer?.email?.email;
    if (!email) return { ok: false, error: `thread ${threadId} has no customer email` };
    return { ok: true, email, verified: thread.customer?.email?.isVerified === true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The injectable seam the egress gate reads the customer through. */
export interface PlainIO {
  threadCustomer(threadId: string, apiKey: string): Promise<PlainCustomerLookup>;
}

export const livePlainIO: PlainIO = { threadCustomer: (threadId, apiKey) => readThreadCustomer(threadId, apiKey) };
export const plainSeam: { io: PlainIO } = { io: livePlainIO };

const REPLY_MUTATION = `mutation WeaverReplyToThread($input: ReplyToThreadInput!) {
  replyToThread(input: $input) { error { message type code } }
}`;

/** Send one reply as the machine user. Throws PlainRequestError; `unknown`
 * on it says whether the reply may have landed (read back, never re-send). */
export async function sendPlainReply(threadId: string, text: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const body = text.trim();
  const data = await plainGraphql(
    apiKey,
    REPLY_MUTATION,
    { input: { threadId, textContent: body, markdownContent: body } },
    fetchImpl,
  );
  const error = (data.replyToThread as { error?: { message?: string; code?: string } | null } | undefined)?.error;
  if (error) throw new PlainRequestError(`Plain refused the reply: ${error.message ?? error.code ?? 'unknown error'}`, false);
}

const TIMELINE_QUERY = `query WeaverThreadTimeline($threadId: ID!, $after: String) {
  thread(threadId: $threadId) {
    timelineEntries(first: 50, after: $after) {
      edges { node {
        actor { __typename }
        entry {
          __typename
          ... on ChatEntry { text }
          ... on EmailEntry { textContent markdownContent }
        }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function normalizeReplyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Readback: does the thread already carry this reply from a machine user?
 * The text is compared whitespace-normalised, and an email's rendering may
 * add a quote or signature around it, so containment counts. Throws when
 * Plain cannot be read — an unreadable thread is unknown, not absent.
 */
export async function plainReplyExists(threadId: string, text: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const wanted = normalizeReplyText(text);
  if (!wanted) return false;
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data = await plainGraphql(apiKey, TIMELINE_QUERY, { threadId, after }, fetchImpl);
    const thread = data.thread as {
      timelineEntries?: {
        edges?: Array<{ node?: { actor?: { __typename?: string }; entry?: { __typename?: string; text?: string | null; textContent?: string | null; markdownContent?: string | null } } }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } | null | undefined;
    if (!thread?.timelineEntries) throw new PlainRequestError(`Plain has no thread ${threadId}`, false);
    for (const edge of thread.timelineEntries.edges ?? []) {
      const node = edge.node;
      if (node?.actor?.__typename !== 'MachineUserActor') continue;
      const candidates = [node.entry?.text, node.entry?.textContent, node.entry?.markdownContent];
      if (candidates.some((c) => typeof c === 'string' && normalizeReplyText(c).includes(wanted))) return true;
    }
    const info = thread.timelineEntries.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return false;
    after = info.endCursor;
  }
  throw new PlainRequestError(`thread ${threadId} timeline is longer than the readback reads`, false);
}

// ---------------------------------------------------------------------------
// `weaver plain` — what an approved action and its verify run

export interface PlainCliIO {
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: FetchLike;
}

/** Strip the one trailing newline a heredoc adds; keep everything else. */
function heredocText(raw: string): string {
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

/**
 * `weaver plain reply <thread>` (reply text on stdin) and
 * `weaver plain reply-sent <thread>` (readback). Returns the exit code:
 * 0 sent / found; 1 a known outcome with no effect (refused, absent);
 * 2 unknown — the reply may have landed, so the engine reads it back and
 * never sends again.
 */
export async function runPlainCli(argv: string[], io: PlainCliIO): Promise<number> {
  const [sub, threadId, ...extra] = argv;
  if ((sub !== 'reply' && sub !== 'reply-sent') || !threadId || extra.length) {
    io.err('usage: weaver plain reply <thread_id> | weaver plain reply-sent <thread_id>   (reply text on stdin)\n');
    return 1;
  }
  if (!THREAD_ID.test(threadId)) {
    io.err(`not a Plain thread id: ${threadId}\n`);
    return 1;
  }
  const apiKey = io.env[PLAIN_API_KEY_NAME]?.trim();
  if (!apiKey) {
    io.err(`${PLAIN_API_KEY_NAME} is not set for this command\n`);
    return sub === 'reply' ? 1 : 2;
  }
  const text = heredocText(await io.stdin());
  if (!text.trim()) {
    io.err('the reply text on stdin is empty\n');
    return 1;
  }
  const fetchImpl = io.fetch ?? fetch;
  if (sub === 'reply-sent') {
    try {
      const found = await plainReplyExists(threadId, text, apiKey, fetchImpl);
      io.out(found ? `reply found on ${threadId}\n` : `no matching reply on ${threadId}\n`);
      return found ? 0 : 1;
    } catch (error) {
      io.err(`readback could not read ${threadId}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  try {
    await sendPlainReply(threadId, text, apiKey, fetchImpl);
    io.out(`replied on ${threadId}\n`);
    return 0;
  } catch (error) {
    const unknown = error instanceof PlainRequestError ? error.unknown : true;
    io.err(`${error instanceof Error ? error.message : String(error)}${unknown ? ' — result UNKNOWN: read back, never re-send' : ''}\n`);
    return unknown ? 2 : 1;
  }
}
