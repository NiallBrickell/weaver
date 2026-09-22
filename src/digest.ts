/**
 * `weaver digest` — the daily needs-you digest, pushed to the operator.
 *
 * A sibling of the printout, not a new source of truth: it renders the same
 * typed projections the operator workspace shows (the fleet Needs-you queue,
 * runner presence, fleet incidents, pending wakes) with no model anywhere in
 * the loop (kernel rules 4 and 10). Every item carries the exact CLI command
 * that answers it, so the founder can clear the queue without first opening a
 * dashboard — the queue only ever moved when someone pulled it.
 *
 * Delivery is operator notification, not an outbound action (kernel rule 7):
 * the destination is fixed by the operator in the executor-only secret store,
 * outside Workstream state; no model chooses the recipient or the content; it
 * acts on no one's behalf. It is a printout delivered by push. Posting to a
 * team channel or to another person remains an `action`. See docs/harness.md.
 *
 * Idempotency follows the kernel's unknown-result rule: every message carries
 * a `[weaver-digest YYYY-MM-DD]` marker (London date); the channel history is
 * read for today's marker before posting, and a post that errors or times out
 * is read back — never sent a second time.
 */

import { compactAge } from './activity.js';
import { operatorPublicOrigin } from './clerkOperatorAuth.js';
import { virtualNow } from './clock.js';
import { fleetIncidents } from './fleetHealth.js';
import { FLEET_HEALTH_STALE_SECONDS, fleetHealthSnapshot } from './operatorUi.js';
import { loadAllSecrets, loadExecutorSecrets, loadSecrets, redactSecrets } from './secrets.js';
import { listRunnerPresence, listWorkstreams, load, type RunnerPresence } from './store.js';
import type { WorkstreamDoc } from './types.js';
import { fleetNeeds, firstLine, firstSentence, presentNeed, type FleetNeed } from './ui/inspect/model.js';

const HOUR_MS = 60 * 60_000;
const WINDOW_MS = 24 * HOUR_MS;
/** A need older than this is flagged: it has outlived three daily digests. */
export const DIGEST_STALE_NEED_MS = 72 * HOUR_MS;
export const DIGEST_MAX_NEEDS = 15;
export const DIGEST_MAX_CLOSED_LINES = 10;
export const DIGEST_MAX_WAKE_LINES = 10;
/**
 * Per-field ceilings keep the whole message far below Slack's 40,000-character
 * truncation point. The link beside every item leads to the full card.
 */
const MAX_HEADLINE_CHARS = 500;
const MAX_OPTIONS_CHARS = 600;
const MAX_REASON_CHARS = 300;

export interface DigestInput {
  docs: WorkstreamDoc[];
  unreadable: string[];
  presences: readonly RunnerPresence[];
  wallNow: Date;
  /** Virtual organizational time; wakes and conclusions are stamped in it. */
  organizationalNow: Date;
  /** Operator workspace origin for links; absent means no links, commands only. */
  publicOrigin?: string;
  /** Every stored secret value, used only to redact the rendered text. */
  secrets: Record<string, string>;
}

export interface Digest {
  /** London calendar date the digest is for (YYYY-MM-DD). */
  date: string;
  /** Readback key: exactly one message per London date carries it. */
  marker: string;
  /** Slack mrkdwn, redacted, carrying the marker. */
  text: string;
  needCount: number;
  closedCount: number;
  /** Nothing needs the operator and nothing closed: there is nothing to push. */
  skip: boolean;
}

/** The London calendar date: the operator's day, whatever the host's zone. */
export function londonDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function digestMarker(date: string): string {
  return `[weaver-digest ${date}]`;
}

function londonHeading(now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
}

/** Slack treats &, < and > as control characters in every text field. */
function slackEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function within(at: string | undefined, now: Date, windowMs: number): boolean {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms <= now.getTime() && now.getTime() - ms <= windowMs;
}

/**
 * The exact CLI commands that answer one need. Actions and sends have their
 * own approve/reject verbs; every other card is answered by resolving it with
 * a note, which is also what wakes the Workstream.
 */
export function answerCommands(need: FleetNeed, doc: WorkstreamDoc | undefined): string[] {
  const slug = need.slug;
  const refId = need.source.type === 'attention'
    ? doc?.attention.find((attention) => attention.id === need.source.id)?.refId
    : need.source.id;
  if (need.kind === 'action' && refId) {
    return [`weaver approve-action ${slug} ${refId}`, `weaver reject-action ${slug} ${refId} "why"`];
  }
  if (need.kind === 'send' && refId) {
    return [`weaver approve ${slug} ${refId}`, `weaver reject-send ${slug} ${refId}`];
  }
  if (need.source.type === 'attention') {
    return [`weaver resolve ${slug} ${need.source.id} "your answer"`];
  }
  return [];
}

/**
 * The fleet verdict is /healthz/fleet's own (`fleetHealthSnapshot`): derived
 * from committed output, never heartbeat liveness alone — a runner can beat
 * every five seconds while dispatching nothing. The digest adds only the
 * detail a person acts on: which runner, how stale, why it is degraded.
 */
function healthLine(input: DigestInput, clean: (value: string) => string): string {
  const nowMs = input.wallNow.getTime();
  const snapshot = fleetHealthSnapshot(input.presences, nowMs);
  const ago = (seconds: number) => compactAge(new Date(nowMs - seconds * 1_000).toISOString(), input.wallNow);
  const current = snapshot.runners.filter((runner) => runner.heartbeat_age_seconds <= FLEET_HEALTH_STALE_SECONDS);
  const healthy = current.filter((runner) => runner.degraded === null);
  const parts: string[] = [];
  if (snapshot.ok) {
    const lastPass = snapshot.last_completed_pass_age_seconds !== null
      ? ` · last pass completed ${ago(snapshot.last_completed_pass_age_seconds)} ago`
      : '';
    parts.push(`:large_green_circle: fleet healthy — runner${healthy.length === 1 ? '' : 's'} ${healthy.map((runner) => `\`${clean(runner.id)}\``).join(', ')} live${lastPass}`);
  } else {
    parts.push(`:red_circle: *fleet unhealthy* — ${snapshot.problems.map(clean).join('; ')}`);
    if (!healthy.length) {
      const newest = [...snapshot.runners].sort((a, b) => a.heartbeat_age_seconds - b.heartbeat_age_seconds)[0];
      parts.push(newest
        ? `last heartbeat ${ago(newest.heartbeat_age_seconds)} ago from \`${clean(newest.id)}\``
        : 'no runner has ever published a heartbeat');
    }
  }
  for (const runner of current) {
    if (runner.degraded) parts.push(`:warning: runner \`${clean(runner.id)}\` is *degraded* and dispatches nothing: ${clean(firstLine(runner.degraded, MAX_REASON_CHARS))}`);
  }
  const incidents = fleetIncidents(input.docs);
  for (const incident of incidents) parts.push(`:warning: *${clean(incident.title)}* — ${clean(firstLine(incident.detail, MAX_REASON_CHARS))}`);
  if (input.unreadable.length) {
    const shown = input.unreadable.slice(0, 5).map((slug) => `\`${clean(slug)}\``).join(', ');
    const more = input.unreadable.length > 5 ? ` and ${input.unreadable.length - 5} more` : '';
    parts.push(`:red_circle: ${plural(input.unreadable.length, 'unreadable workstream')}: ${shown}${more}`);
  }
  if (!incidents.length && !input.unreadable.length) parts.push('no fleet incidents');
  return `*Health* — ${parts.join(' · ')}`;
}

interface ClosedItem {
  at: string;
  line: string;
}

function closedItems(input: DigestInput, clean: (value: string) => string, link: (slug: string) => string) {
  const conclusions: ClosedItem[] = [];
  const verified: (ClosedItem & { merge: boolean })[] = [];
  const resolved: ClosedItem[] = [];
  for (const doc of input.docs) {
    const slug = doc.workstream.slug;
    const conclusion = doc.workstream.conclusion;
    if (doc.workstream.status === 'done' && conclusion && within(conclusion.atVirtual, input.organizationalNow, WINDOW_MS)) {
      conclusions.push({
        at: conclusion.atVirtual,
        line: `• :checkered_flag: concluded ${link(slug)} — ${clean(firstLine(conclusion.summary, 160))}`,
      });
    }
    for (const assignment of doc.assignments) {
      const readback = assignment.exec?.verified;
      if (assignment.kind !== 'action' || !readback?.ok || !within(readback.at, input.wallNow, WINDOW_MS)) continue;
      const merge = /\bgh\s+pr\s+merge\b/.test(assignment.exec?.run ?? '');
      verified.push({
        at: readback.at,
        merge,
        line: `• :white_check_mark: verified ${merge ? 'merge' : 'action'} in ${link(slug)} — ${clean(firstLine(assignment.objective, 160))}`,
      });
    }
    for (const attention of doc.attention) {
      if (attention.status !== 'resolved' || !within(attention.resolvedAt, input.wallNow, WINDOW_MS)) continue;
      resolved.push({
        at: attention.resolvedAt!,
        line: `• :ballot_box_with_check: resolved in ${link(slug)} — ${clean(firstSentence(attention.summary, 140))}${attention.resolvedBy ? ` (by ${clean(attention.resolvedBy)})` : ''}`,
      });
    }
  }
  const newestFirst = (a: ClosedItem, b: ClosedItem) => b.at.localeCompare(a.at);
  return {
    conclusions: conclusions.sort(newestFirst),
    verified: verified.sort(newestFirst),
    resolved: resolved.sort(newestFirst),
  };
}

function dueLabel(milliseconds: number): string {
  if (milliseconds <= 0) return 'due now';
  const minutes = Math.ceil(milliseconds / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}

function upcomingWakes(input: DigestInput): { slug: string; count: number; soonest: number }[] {
  const bySlug = new Map<string, { slug: string; count: number; soonest: number }>();
  for (const doc of input.docs) {
    // Paused and concluded Workstreams do not wake; their stored waits are not "next".
    if (doc.workstream.status !== 'active') continue;
    for (const wake of doc.wakes) {
      if (wake.status !== 'pending') continue;
      const remaining = wake.condition.type === 'time'
        ? Date.parse(wake.condition.dueAtVirtual) - input.organizationalNow.getTime()
        : wake.condition.type === 'wall_time'
          ? Date.parse(wake.condition.dueAt) - input.wallNow.getTime()
          : 0;
      if (!Number.isFinite(remaining) || remaining > WINDOW_MS) continue;
      const slug = doc.workstream.slug;
      const entry = bySlug.get(slug) ?? { slug, count: 0, soonest: Number.POSITIVE_INFINITY };
      entry.count += 1;
      entry.soonest = Math.min(entry.soonest, remaining);
      bySlug.set(slug, entry);
    }
  }
  return [...bySlug.values()].sort((a, b) => a.soonest - b.soonest || a.slug.localeCompare(b.slug));
}

/** Pure: typed fleet state in, one redacted Slack mrkdwn message out. */
export function renderDigest(input: DigestInput): Digest {
  const date = londonDate(input.wallNow);
  const marker = digestMarker(date);
  const clean = (value: string) => slackEscape(redactSecrets(value, input.secrets));
  const origin = input.publicOrigin?.replace(/\/$/, '');
  const link = (slug: string) => origin
    ? `<${origin}/workstreams/${encodeURIComponent(slug)}|${clean(slug)}>`
    : `\`${clean(slug)}\``;
  const docs = new Map(input.docs.map((doc) => [doc.workstream.slug, doc]));

  const lines: string[] = [
    healthLine(input, clean),
    '',
  ];

  // Needs you: the exact set and order of the workspace's fleet queue, which
  // already excludes deliberately paused Workstreams.
  const needs = fleetNeeds(input.docs);
  const isStale = (need: FleetNeed) =>
    !!need.at && Number.isFinite(Date.parse(need.at)) && input.wallNow.getTime() - Date.parse(need.at) > DIGEST_STALE_NEED_MS;
  if (needs.length) {
    const stale = needs.filter(isStale).length;
    const oldest = needs.map((need) => need.at).filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort()[0];
    lines.push(
      `*Needs you — ${plural(needs.length, 'item')} across ${plural(new Set(needs.map((need) => need.slug)).size, 'workstream')}*`
      + `${stale ? ` · ${stale} older than 72h` : ''}${oldest ? ` · oldest ${compactAge(oldest, input.wallNow)}` : ''}`,
    );
    needs.slice(0, DIGEST_MAX_NEEDS).forEach((need, index) => {
      const presentation = presentNeed(need.summary);
      const age = need.at && Number.isFinite(Date.parse(need.at)) ? `${compactAge(need.at, input.wallNow)} old` : 'age unknown';
      lines.push(`${index + 1}. ${isStale(need) ? ':warning: ' : ''}*${need.kind}* · ${age} · ${link(need.slug)} — ${clean(firstLine(presentation.headline, MAX_HEADLINE_CHARS))}`);
      if (presentation.choices.length) {
        const options = presentation.choices.map((choice) => `(${choice.label}) ${firstLine(choice.text, 120)}`).join(' · ');
        lines.push(`      Options: ${clean(firstLine(options, MAX_OPTIONS_CHARS))}`);
      } else {
        // The headline is one sentence; a Pilot escalation puts the action
        // being approved after it. Whoever answers from the command line
        // must see what they are approving without opening the workspace.
        const at = presentation.full.indexOf(presentation.headline);
        const detail = at >= 0 ? presentation.full.slice(at + presentation.headline.length).trim() : '';
        if (detail) lines.push(`      Detail: ${clean(firstLine(detail, 240))}`);
      }
      const commands = answerCommands(need, docs.get(need.slug));
      if (commands.length) {
        lines.push(`      Answer: \`${clean(commands[0]!)}\`${commands[1] ? ` · or \`${clean(commands[1])}\`` : ''}`);
      }
    });
    if (needs.length > DIGEST_MAX_NEEDS) {
      const omitted = needs.length - DIGEST_MAX_NEEDS;
      lines.push(`_${omitted} more not shown — ${origin ? `<${origin}/board|the workspace board>` : '`weaver watch`'} lists every item._`);
    }
  } else {
    lines.push('*Needs you* — nothing is waiting on you.');
  }

  // Closed: typed facts only — a conclusion, a readback-confirmed action, a
  // resolved card. Worker prose saying "merged" never lands here.
  const closed = closedItems(input, clean, link);
  const closedCount = closed.conclusions.length + closed.verified.length + closed.resolved.length;
  lines.push('');
  if (closedCount) {
    const merges = closed.verified.filter((item) => item.merge).length;
    const summary = [
      closed.conclusions.length ? `${closed.conclusions.length} concluded` : '',
      closed.verified.length ? `${closed.verified.length} verified${merges ? ` (${plural(merges, 'merge')})` : ''}` : '',
      closed.resolved.length ? `${plural(closed.resolved.length, 'card')} resolved` : '',
    ].filter(Boolean).join(' · ');
    lines.push(`*Closed in the last 24h* — ${summary}`);
    const all = [...closed.conclusions, ...closed.verified, ...closed.resolved];
    lines.push(...all.slice(0, DIGEST_MAX_CLOSED_LINES).map((item) => item.line));
    if (all.length > DIGEST_MAX_CLOSED_LINES) lines.push(`_${all.length - DIGEST_MAX_CLOSED_LINES} more not shown._`);
  } else {
    lines.push('*Closed in the last 24h* — nothing.');
  }

  const wakes = upcomingWakes(input);
  lines.push('');
  if (wakes.length) {
    const total = wakes.reduce((sum, entry) => sum + entry.count, 0);
    lines.push(`*Next 24h* — ${plural(total, 'wake')} across ${plural(wakes.length, 'workstream')}`);
    lines.push(...wakes.slice(0, DIGEST_MAX_WAKE_LINES).map((entry) =>
      `• ${link(entry.slug)} — ${plural(entry.count, 'wake')}, first ${dueLabel(entry.soonest)}`));
    if (wakes.length > DIGEST_MAX_WAKE_LINES) lines.push(`_${plural(wakes.length - DIGEST_MAX_WAKE_LINES, 'more workstream')} not shown._`);
  } else {
    lines.push('*Next 24h* — no scheduled wakes.');
  }

  // Per-field redaction above handles values Slack escaping would alter; this
  // final pass is the output invariant. The marker leads the message, outside
  // redaction, so neither a stored value nor Slack's truncation of an
  // oversized message can ever remove the readback key.
  const body = redactSecrets(lines.join('\n'), input.secrets);
  return {
    date,
    marker,
    text: `*Weaver daily digest — ${londonHeading(input.wallNow)}* _${marker}_\n${body}\n\n_Rendered from typed state; no model wrote this._`,
    needCount: needs.length,
    closedCount,
    skip: needs.length === 0 && closedCount === 0,
  };
}

/** Load the fleet once — this runs daily, not on a hot path. */
export async function loadDigestInput(): Promise<DigestInput> {
  const docs: WorkstreamDoc[] = [];
  const unreadable: string[] = [];
  for (const slug of await listWorkstreams()) {
    try {
      docs.push(await load(slug));
    } catch {
      unreadable.push(slug);
    }
  }
  let publicOrigin: string | undefined;
  try {
    publicOrigin = operatorPublicOrigin();
  } catch (error) {
    // A malformed origin must not cost the operator the whole digest; the
    // answering commands still work without links.
    process.stderr.write(`warning: workspace links omitted — ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return {
    docs,
    unreadable,
    presences: await listRunnerPresence(),
    wallNow: new Date(),
    organizationalNow: virtualNow(),
    ...(publicOrigin ? { publicOrigin } : {}),
    secrets: loadAllSecrets(),
  };
}

// ---------------------------------------------------------------------------
// Delivery

export interface DigestSlackConfig {
  token: string;
  channel: string;
}

/**
 * The operator-fixed destination, reloaded per run like WEAVER_PILOT_TOKEN —
 * never process.env, a worker environment, or Workstream state. The channel is
 * set once per fleet in the executor-only store (`WEAVER_DIGEST_SLACK_CHANNEL`).
 * The token defaults to the fleet's existing Slack bot (`SLACK_BOT_TOKEN` in
 * the global store): a fleet that already posts to Slack must not be asked for
 * a second credential to post one more message. `WEAVER_DIGEST_SLACK_TOKEN`
 * (executor-only) overrides it. No channel means the digest is not set up here.
 */
export function digestSlackConfig(
  executorSecrets: Record<string, string> = loadExecutorSecrets(),
  globalSecrets: Record<string, string> = loadSecrets(),
): DigestSlackConfig | undefined {
  const override = executorSecrets.WEAVER_DIGEST_SLACK_TOKEN?.trim();
  const channel = executorSecrets.WEAVER_DIGEST_SLACK_CHANNEL?.trim();
  if (!channel) {
    if (override) {
      throw new Error('WEAVER_DIGEST_SLACK_TOKEN is set but WEAVER_DIGEST_SLACK_CHANNEL is not (weaver secret set WEAVER_DIGEST_SLACK_CHANNEL --executor)');
    }
    return undefined;
  }
  if (!/^[CDG][A-Z0-9]{2,}$/.test(channel)) {
    throw new Error('WEAVER_DIGEST_SLACK_CHANNEL must be a Slack channel or DM id (C…, G… or D…), not a #name');
  }
  const token = override || globalSecrets.SLACK_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("the daily digest needs a Slack bot token: the fleet's SLACK_BOT_TOKEN (weaver secret set SLACK_BOT_TOKEN), or WEAVER_DIGEST_SLACK_TOKEN --executor");
  }
  return { token, channel };
}

export type DigestFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DeliverOptions {
  fetch?: DigestFetch;
  timeoutMs?: number;
  now?: Date;
  /** Read back only; never post. */
  dryRun?: boolean;
}

export type DigestDelivery =
  | { outcome: 'skipped' }
  | { outcome: 'already-posted'; ts?: string }
  | { outcome: 'would-post' }
  | { outcome: 'posted'; ts?: string }
  /** The post errored or timed out, and readback found the message: it landed. */
  | { outcome: 'confirmed-after-error'; ts?: string; error: string }
  /** The post errored or timed out and readback could not find it. Not re-sent. */
  | { outcome: 'unconfirmed'; error: string };

const SLACK_API = 'https://slack.com/api';
/** conversations.history pages read before refusing to call the digest absent. */
const MAX_HISTORY_PAGES = 5;
/** Readback reaches back further than any London day is long (DST days are 25h). */
const READBACK_WINDOW_MS = 26 * HOUR_MS;

interface SlackMessage {
  text?: unknown;
  ts?: unknown;
}

interface SlackBody {
  ok?: unknown;
  error?: unknown;
  ts?: unknown;
  messages?: SlackMessage[];
  has_more?: unknown;
  response_metadata?: { next_cursor?: unknown };
}

async function slackCall(
  config: DigestSlackConfig,
  method: string,
  init: RequestInit,
  options: DeliverOptions,
): Promise<SlackBody> {
  const fetchImpl = options.fetch ?? ((url, request) => fetch(url, request));
  try {
    const response = await fetchImpl(`${SLACK_API}/${method}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(init.body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as SlackBody;
    if (body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : 'response was not ok');
    return body;
  } catch (error) {
    // Slack errors are short codes, but a transport error must never be able
    // to carry the bearer onward into a journal line.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Slack ${method.split('?')[0]} failed: ${message.split(config.token).join('«secret:slack-bot-token»')}`);
  }
}

/** Read the channel back for today's marker. Throws when absence cannot be proved. */
export async function findPostedDigest(
  config: DigestSlackConfig,
  marker: string,
  options: DeliverOptions = {},
): Promise<{ found: boolean; ts?: string }> {
  const now = options.now ?? new Date();
  const oldest = String(Math.floor((now.getTime() - READBACK_WINDOW_MS) / 1_000));
  let cursor: string | undefined;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const params = new URLSearchParams({ channel: config.channel, oldest, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const body = await slackCall(config, `conversations.history?${params}`, { method: 'GET' }, options);
    const hit = (body.messages ?? []).find((message) => typeof message.text === 'string' && message.text.includes(marker));
    if (hit) return { found: true, ...(typeof hit.ts === 'string' ? { ts: hit.ts } : {}) };
    const next = body.response_metadata?.next_cursor;
    if (body.has_more !== true || typeof next !== 'string' || !next) return { found: false };
    cursor = next;
  }
  throw new Error(`Slack conversations.history returned more than ${MAX_HISTORY_PAGES} pages since yesterday; cannot prove today's digest is absent`);
}

/**
 * Readback-idempotent delivery. One post at most per run, and none at all when
 * today's marker is already in the channel. An error or timeout on the post is
 * an unknown result: read back, never send again.
 */
export async function deliverDigest(
  digest: Digest,
  config: DigestSlackConfig,
  options: DeliverOptions = {},
): Promise<DigestDelivery> {
  if (digest.skip) return { outcome: 'skipped' };
  const before = await findPostedDigest(config, digest.marker, options);
  if (before.found) return { outcome: 'already-posted', ...(before.ts ? { ts: before.ts } : {}) };
  if (options.dryRun) return { outcome: 'would-post' };
  try {
    const body = await slackCall(config, 'chat.postMessage', {
      method: 'POST',
      body: JSON.stringify({ channel: config.channel, text: digest.text, unfurl_links: false, unfurl_media: false }),
    }, options);
    return { outcome: 'posted', ...(typeof body.ts === 'string' ? { ts: body.ts } : {}) };
  } catch (postError) {
    const error = postError instanceof Error ? postError.message : String(postError);
    try {
      const after = await findPostedDigest(config, digest.marker, options);
      if (after.found) return { outcome: 'confirmed-after-error', error, ...(after.ts ? { ts: after.ts } : {}) };
      return { outcome: 'unconfirmed', error };
    } catch (readbackError) {
      const detail = readbackError instanceof Error ? readbackError.message : String(readbackError);
      return { outcome: 'unconfirmed', error: `${error}; readback also failed: ${detail}` };
    }
  }
}

export interface DigestCommandOptions {
  post: boolean;
  dryRun: boolean;
}

/** `weaver digest [--post] [--dry-run]`. Returns what to print, or the failure. */
export async function digestCommand(
  options: DigestCommandOptions,
  deps: {
    input?: DigestInput;
    secrets?: Record<string, string>;
    globalSecrets?: Record<string, string>;
    fetch?: DigestFetch;
  } = {},
): Promise<{ ok: boolean; message: string }> {
  const digest = renderDigest(deps.input ?? await loadDigestInput());
  // --dry-run walks the --post path read-only: configuration, skip rule, and
  // readback all run; chat.postMessage never does.
  if (!options.post && !options.dryRun) return { ok: true, message: digest.text };
  if (digest.skip) {
    return { ok: true, message: `digest ${digest.date} skipped: nothing needs you and nothing closed in the last 24h` };
  }
  let config: DigestSlackConfig | undefined;
  try {
    config = digestSlackConfig(deps.secrets, deps.globalSecrets);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!config) {
    return {
      ok: true,
      message: `digest ${digest.date} not sent: no destination configured (set the channel once: weaver secret set WEAVER_DIGEST_SLACK_CHANNEL --executor; it posts with the fleet's SLACK_BOT_TOKEN)`,
    };
  }
  let delivery: DigestDelivery;
  try {
    delivery = await deliverDigest(digest, config, { dryRun: options.dryRun, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  } catch (error) {
    // Only the pre-post readback can throw here: nothing was sent.
    return {
      ok: false,
      message: `digest ${digest.date} not sent: ${error instanceof Error ? error.message : String(error)} — refusing to post without proving today's digest is absent`,
    };
  }
  switch (delivery.outcome) {
    case 'skipped':
      return { ok: true, message: `digest ${digest.date} skipped: nothing needs you and nothing closed in the last 24h` };
    case 'already-posted':
      return { ok: true, message: `digest ${digest.date} already posted${delivery.ts ? ` (ts ${delivery.ts})` : ''}; nothing sent` };
    case 'would-post':
      return { ok: true, message: `${digest.text}\n\n(dry run) digest ${digest.date} is not in ${config.channel} yet; --post would send it once` };
    case 'posted':
      return { ok: true, message: `digest ${digest.date} posted to ${config.channel}${delivery.ts ? ` (ts ${delivery.ts})` : ''}: ${plural(digest.needCount, 'need')}, ${digest.closedCount} closed` };
    case 'confirmed-after-error':
      return { ok: true, message: `digest ${digest.date} post reported an error (${delivery.error}) but readback found it${delivery.ts ? ` (ts ${delivery.ts})` : ''}; not re-sent` };
    case 'unconfirmed':
      return {
        ok: false,
        message: `digest ${digest.date} post failed or timed out (${delivery.error}) and readback did not find it; not re-sent. A later \`weaver digest --post\` reads back first and posts only if it is still absent.`,
      };
  }
}
