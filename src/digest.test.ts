/**
 * The daily digest is operator notification rendered from typed state and
 * delivered readback-idempotently. These tests pin the rendering contract and
 * the "unknown result → readback, never a second send" delivery rule against a
 * stubbed Slack; nothing here touches a network or a model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { operatorPublicOrigin } from './clerkOperatorAuth.js';
import {
  DIGEST_MAX_NEEDS,
  deliverDigest,
  digestCommand,
  digestMarker,
  digestSlackConfig,
  londonDate,
  renderDigest,
  type DigestFetch,
  type DigestInput,
} from './digest.js';
import type { Assignment, AttentionItem, WorkstreamDoc } from './types.js';

const NOW = new Date('2026-09-21T06:30:00.000Z'); // 07:30 in London (BST)
const HOUR = 60 * 60_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const ahead = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

function doc(slug: string, over: Partial<WorkstreamDoc['workstream']> = {}): WorkstreamDoc {
  return {
    schemaVersion: 1,
    revision: 1,
    workstream: {
      id: `ws_${slug}`, slug, title: `Title ${slug}`, objective: `Objective ${slug}`,
      tags: [], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
      status: 'active', createdAt: ago(500),
      ...over,
    },
    decisions: [], assignments: [], deliverables: [], interactions: [], observations: [], wakes: [],
    steering: [], attention: [], passes: [], events: [],
    spend: { coordinatorPasses: 0, totalCostUsd: 0, humanInterventions: 0 }, capacity: null, lease: null,
  };
}

function attention(id: string, kind: AttentionItem['kind'], summary: string, createdAt: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return { id, kind, summary, status: 'open', createdAt, ...over };
}

function gatedAction(id: string, ask: string, createdAtVirtual: string, over: Partial<Assignment> = {}): Assignment {
  return {
    id, objective: `Objective of ${id}`, briefing: 'b', kind: 'action', acceptanceCriteria: [], dependsOn: [],
    state: 'gated', attempts: [], adoption: { state: 'none' }, createdAtVirtual,
    exec: { cwd: '/tmp', verify: 'true', ask, approvalMode: 'human-only' },
    ...over,
  };
}

function input(docs: WorkstreamDoc[], over: Partial<DigestInput> = {}): DigestInput {
  return {
    docs,
    unreadable: [],
    presences: [{ runnerId: 'weaver-fleet', heartbeatAt: new Date(NOW.getTime() - 5_000).toISOString() }],
    wallNow: NOW,
    organizationalNow: NOW,
    publicOrigin: 'https://workspace.example',
    secrets: {},
    ...over,
  };
}

/** A doc with one open blocker card, so the digest has something to push. */
function busyFleet(): WorkstreamDoc[] {
  const ws = doc('busy');
  ws.attention.push(attention('att_busy', 'blocker', 'Decide which vendor to use.', ago(2)));
  return [ws];
}

test('needs keep the workspace queue order and cap at fifteen with an omitted count', () => {
  const docs: WorkstreamDoc[] = [];
  // 18 review cards of increasing age, one blocker, one human-only action.
  for (let i = 0; i < 18; i++) {
    const ws = doc(`review-${String(i).padStart(2, '0')}`);
    ws.attention.push(attention(`att_r${i}`, 'review', `Review item number ${i}.`, ago(i + 1)));
    docs.push(ws);
  }
  const blocked = doc('blocked');
  blocked.attention.push(attention('att_block', 'blocker', 'The deploy key expired.', ago(1)));
  const acting = doc('acting');
  acting.assignments.push(gatedAction('asg_merge', 'Merge PR #12 after the clean review.', ago(3)));
  docs.push(blocked, acting);

  const digest = renderDigest(input(docs));
  assert.equal(digest.needCount, 20);
  assert.match(digest.text, /\*Needs you — 20 items across 20 workstreams\*/);
  const numbered = digest.text.split('\n').filter((line) => /^\d+\. /.test(line));
  assert.equal(numbered.length, DIGEST_MAX_NEEDS);
  // Blocker first, then the action, then reviews oldest-first.
  assert.match(numbered[0]!, /^1\. \*blocker\* .*The deploy key expired\./);
  assert.match(numbered[1]!, /^2\. \*action\* .*Merge PR #12/);
  assert.match(numbered[2]!, /Review item number 17\./);
  assert.match(numbered[14]!, /Review item number 5\./);
  assert.doesNotMatch(digest.text, /Review item number 4\./);
  assert.match(digest.text, /_5 more not shown — <https:\/\/workspace\.example\/board\|the workspace board> lists every item\._/);
});

test('needs older than 72 hours are flagged and counted', () => {
  const ws = doc('stale');
  ws.attention.push(attention('att_old', 'review', 'Old question.', ago(100)));
  ws.attention.push(attention('att_new', 'review', 'Fresh question.', ago(10)));
  const digest = renderDigest(input([ws]));
  assert.match(digest.text, /1 older than 72h · oldest 4d/);
  assert.match(digest.text, /1\. :warning: \*review\* · 4d old · .*Old question\./);
  assert.match(digest.text, /2\. \*review\* · 10h old · .*Fresh question\./);
});

test('paused workstreams are excluded from needs and from the next-24h wakes', () => {
  const paused = doc('paused-work', { status: 'paused' });
  paused.attention.push(attention('att_paused', 'blocker', 'Paused blocker text.', ago(5)));
  paused.wakes.push({ id: 'wake_p', reason: 'check', condition: { type: 'wall_time', dueAt: ahead(2) }, status: 'pending', createdAt: ago(1) });
  const active = doc('active-work');
  active.attention.push(attention('att_active', 'review', 'Active review text.', ago(5)));
  active.wakes.push({ id: 'wake_a', reason: 'check', condition: { type: 'wall_time', dueAt: ahead(2) }, status: 'pending', createdAt: ago(1) });
  active.wakes.push({ id: 'wake_far', reason: 'later', condition: { type: 'time', dueAtVirtual: ahead(30) }, status: 'pending', createdAt: ago(1) });

  const digest = renderDigest(input([paused, active]));
  assert.equal(digest.needCount, 1);
  assert.doesNotMatch(digest.text, /Paused blocker text/);
  assert.doesNotMatch(digest.text, /paused-work/);
  assert.match(digest.text, /\*Next 24h\* — 1 wake across 1 workstream/);
  assert.match(digest.text, /active-work\|active-work> — 1 wake, first in 2h/);
});

test('every need links to its workstream and names the exact command that answers it', () => {
  const ws = doc('launch');
  ws.assignments.push(gatedAction('asg_deploy', 'Deploy the release to production.', ago(4), { exec: { cwd: '/tmp', verify: 'true', ask: 'Deploy the release to production.' } }));
  ws.attention.push(attention('att_deploy', 'approval', 'Approve the deploy.', ago(4), { refId: 'asg_deploy' }));
  ws.interactions.push({
    id: 'int_reply', kind: 'email_send', to: 'customer@example.com', subject: 'Your refund',
    deliverableId: 'del_draft', status: 'awaiting_approval', replies: [],
  });
  ws.attention.push(attention('att_pick', 'review', 'Pick a plan (A) ship now (B) wait a week', ago(2)));

  const digest = renderDigest(input([ws]));
  assert.match(digest.text, /<https:\/\/workspace\.example\/workstreams\/launch\|launch>/);
  assert.match(digest.text, /`weaver approve-action launch asg_deploy` · or `weaver reject-action launch asg_deploy "why"`/);
  assert.match(digest.text, /`weaver approve launch int_reply` · or `weaver reject-send launch int_reply`/);
  assert.match(digest.text, /`weaver resolve launch att_pick "your answer"`/);
  assert.match(digest.text, /Options: \(A\) ship now · \(B\) wait a week/);

  // A Pilot escalation's headline is its reason; the action itself follows.
  const escalated = doc('escalated');
  escalated.assignments.push(gatedAction('asg_merge', 'Merge PR #7 in the app repo.', ago(2), {
    exec: { cwd: '/tmp', verify: 'true', ask: 'Merge PR #7 in the app repo.', pilotVerdict: { decision: 'escalate', reason: 'no self-merge rule', at: ago(2) } },
  }));
  const judged = renderDigest(input([escalated]));
  assert.match(judged.text, /— Pilot requires your judgment: no self-merge rule\.\n {6}Detail: Decide whether to approve: "Merge PR #7 in the app repo\."/);
  assert.match(judged.text, /`weaver approve-action escalated asg_merge`/);

  const withoutOrigin = renderDigest(input([ws], { publicOrigin: undefined }));
  assert.doesNotMatch(withoutOrigin.text, /https?:\/\//);
  assert.match(withoutOrigin.text, /`launch` — /);
  assert.match(withoutOrigin.text, /`weaver resolve launch att_pick "your answer"`/);
});

test('stored secret values are redacted, Slack control characters escaped, and the marker left intact', () => {
  const ws = doc('leaky');
  ws.attention.push(attention('att_leak', 'blocker', 'The token sk-live-SECRETVALUE1234 was rejected <again> & again.', ago(1)));
  const digest = renderDigest(input([ws], { secrets: { STRIPE_KEY: 'sk-live-SECRETVALUE1234', WEAVER: 'weaver-digest' } }));
  assert.ok(!digest.text.includes('sk-live-SECRETVALUE1234'));
  assert.match(digest.text, /«secret:STRIPE_KEY»/);
  assert.match(digest.text, /&lt;again&gt; &amp; again/);
  assert.ok(digest.text.split('\n')[0]!.includes(digestMarker('2026-09-21')), 'a secret value can never disturb the readback key');
});

test('the marker leads the message and oversized fields are capped, so truncation cannot lose the readback key', () => {
  const ws = doc('verbose');
  ws.attention.push(attention('att_long', 'blocker', `Decide ${'very '.repeat(2_000)}carefully`, ago(1)));
  const digest = renderDigest(input([ws]));
  const [first] = digest.text.split('\n');
  assert.equal(first, '*Weaver daily digest — Monday 21 September* _[weaver-digest 2026-09-21]_');
  const line = digest.text.split('\n').find((candidate) => candidate.startsWith('1. '))!;
  assert.ok(line.length < 700, `headline line is ${line.length} characters`);
  assert.match(line, /…$/);
});

test('closed facts come from typed state inside the last 24 hours only', () => {
  const done = doc('shipped', { status: 'done', conclusion: { passId: 'pass_1', atVirtual: ago(3), summary: 'Shipped the onboarding fix.', evidenceIds: ['asg_m'] } });
  done.assignments.push(gatedAction('asg_m', 'x', ago(20), {
    objective: 'Merge PR #42', state: 'completed',
    exec: { cwd: '/tmp', verify: 'gh pr view 42', run: 'gh pr merge 42 --merge --repo o/r', verified: { ok: true, output: 'MERGED', at: ago(4) } },
  }));
  done.assignments.push(gatedAction('asg_failed_readback', 'x', ago(20), {
    objective: 'Unconfirmed push', state: 'failed',
    exec: { cwd: '/tmp', verify: 'false', verified: { ok: false, output: '', at: ago(2) } },
  }));
  const older = doc('older', { status: 'done', conclusion: { passId: 'pass_2', atVirtual: ago(30), summary: 'Concluded long ago.', evidenceIds: [] } });
  const cards = doc('cards');
  cards.attention.push(attention('att_done', 'review', 'Choose the pricing page copy.', ago(40), { status: 'resolved', resolvedAt: ago(1), resolvedBy: 'niall' }));
  cards.attention.push(attention('att_old', 'review', 'Ancient question.', ago(80), { status: 'resolved', resolvedAt: ago(50) }));

  const digest = renderDigest(input([done, older, cards]));
  assert.equal(digest.closedCount, 3);
  assert.equal(digest.skip, false);
  assert.match(digest.text, /\*Closed in the last 24h\* — 1 concluded · 1 verified \(1 merge\) · 1 card resolved/);
  assert.match(digest.text, /concluded <https:\/\/workspace\.example\/workstreams\/shipped\|shipped> — Shipped the onboarding fix\./);
  assert.match(digest.text, /verified merge in .*shipped.* — Merge PR #42/);
  assert.match(digest.text, /resolved in .*cards.* — Choose the pricing page copy\. \(by niall\)/);
  assert.doesNotMatch(digest.text, /Concluded long ago|Ancient question|Unconfirmed push/);
});

test('health uses the /healthz/fleet verdict and names a missing runner, a degraded runner, stalled output, and incidents', () => {
  const dark = renderDigest(input(busyFleet(), {
    presences: [{ runnerId: 'weaver-fleet', heartbeatAt: ago(3) }],
  }));
  assert.match(dark.text, /\*Health\* — :red_circle: \*fleet unhealthy\* — no runner has a healthy heartbeat · last heartbeat 3h ago from `weaver-fleet`/);

  // A fresh heartbeat is not health: the runner's own observed output decides.
  const stalled = renderDigest(input(busyFleet(), {
    presences: [{
      runnerId: 'weaver-fleet',
      heartbeatAt: NOW.toISOString(),
      output: { observedAt: NOW.toISOString(), oldestUnservedDueAt: ago(2), capacityBlocked: 0 },
    }],
  }));
  assert.match(stalled.text, /:red_circle: \*fleet unhealthy\* — due work has not been served for over an hour/);
  assert.doesNotMatch(stalled.text, /fleet healthy/);

  const pilotOut = doc('pilot-out');
  pilotOut.assignments.push(gatedAction('asg_p', 'x', ago(2), {
    exec: { cwd: '/tmp', verify: 'true', pilotUnavailableSince: ago(2), approvalMode: 'pilot-or-human' },
  }));
  const degraded = renderDigest(input([...busyFleet(), pilotOut], {
    presences: [{ runnerId: 'weaver-fleet', heartbeatAt: NOW.toISOString(), degraded: 'state directory has 0 bytes free' }],
  }));
  assert.match(degraded.text, /:red_circle: \*fleet unhealthy\* — no runner has a healthy heartbeat/);
  assert.match(degraded.text, /runner `weaver-fleet` is \*degraded\* and dispatches nothing: state directory has 0 bytes free/);
  assert.match(degraded.text, /:warning: \*Approval service unavailable\*/);

  const healthy = renderDigest(input(busyFleet(), {
    presences: [{
      runnerId: 'weaver-fleet',
      heartbeatAt: NOW.toISOString(),
      output: { observedAt: NOW.toISOString(), lastCompletedPassAt: ago(1), capacityBlocked: 0 },
    }],
  }));
  assert.match(healthy.text, /\*Health\* — :large_green_circle: fleet healthy — runner `weaver-fleet` live · last pass completed 1h ago · no fleet incidents/);
});

test('an empty needs list with nothing closed skips posting without contacting Slack', async () => {
  const quiet = doc('quiet');
  quiet.wakes.push({ id: 'wake_q', reason: 'poll', condition: { type: 'wall_time', dueAt: ahead(1) }, status: 'pending', createdAt: ago(1) });
  const digest = renderDigest(input([quiet]));
  assert.equal(digest.skip, true);
  const calls: string[] = [];
  const fetchStub: DigestFetch = async (url) => { calls.push(url); throw new Error('must not be called'); };
  assert.deepEqual(await deliverDigest(digest, { token: 'xoxb-test', channel: 'C0DIGEST' }, { fetch: fetchStub, now: NOW }), { outcome: 'skipped' });

  const command = await digestCommand(
    { post: true, dryRun: false },
    { input: input([quiet]), secrets: { WEAVER_DIGEST_SLACK_TOKEN: 'xoxb-test', WEAVER_DIGEST_SLACK_CHANNEL: 'C0DIGEST' }, fetch: fetchStub },
  );
  assert.equal(command.ok, true);
  assert.match(command.message, /skipped: nothing needs you and nothing closed/);
  assert.deepEqual(calls, []);

  const printed = await digestCommand({ post: false, dryRun: false }, { input: input([quiet]), fetch: fetchStub });
  assert.match(printed.message, /\*Needs you\* — nothing is waiting on you\./);
  assert.deepEqual(calls, []);
});

/** A scripted Slack: history responses in order, and a postMessage behaviour. */
function slack(history: Array<Array<{ text: string; ts: string }>>, post: 'ok' | 'timeout' | 'error') {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  let historyIndex = 0;
  const fetchStub: DigestFetch = async (url, init) => {
    const method = url.replace('https://slack.com/api/', '').split('?')[0]!;
    calls.push({ method, url, init });
    if (method === 'conversations.history') {
      const messages = history[Math.min(historyIndex++, history.length - 1)] ?? [];
      return new Response(JSON.stringify({ ok: true, messages, has_more: false }), { status: 200 });
    }
    if (method === 'chat.postMessage') {
      if (post === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (post === 'error') return new Response('upstream', { status: 502 });
      return new Response(JSON.stringify({ ok: true, ts: '1790000000.000100', channel: 'C0DIGEST' }), { status: 200 });
    }
    throw new Error(`unexpected Slack method ${method}`);
  };
  return { calls, fetch: fetchStub };
}

const CONFIG = { token: 'xoxb-digest-token', channel: 'C0DIGEST' };

test('today\'s marker already in the channel means no post at all', async () => {
  const digest = renderDigest(input(busyFleet()));
  const stub = slack([[{ text: `earlier digest _${digest.marker} · rendered_`, ts: '1790000000.000001' }]], 'ok');
  const delivery = await deliverDigest(digest, CONFIG, { fetch: stub.fetch, now: NOW });
  assert.deepEqual(delivery, { outcome: 'already-posted', ts: '1790000000.000001' });
  assert.deepEqual(stub.calls.map((call) => call.method), ['conversations.history']);
});

test('yesterday\'s marker does not count as today\'s digest', async () => {
  const digest = renderDigest(input(busyFleet()));
  const stub = slack([[{ text: digestMarker('2026-09-20'), ts: '1' }]], 'ok');
  const delivery = await deliverDigest(digest, CONFIG, { fetch: stub.fetch, now: NOW });
  assert.equal(delivery.outcome, 'posted');
});

test('a readback that finds nothing posts exactly once, authenticated, to the configured channel', async () => {
  const digest = renderDigest(input(busyFleet()));
  const stub = slack([[]], 'ok');
  const delivery = await deliverDigest(digest, CONFIG, { fetch: stub.fetch, now: NOW });
  assert.deepEqual(delivery, { outcome: 'posted', ts: '1790000000.000100' });
  assert.deepEqual(stub.calls.map((call) => call.method), ['conversations.history', 'chat.postMessage']);
  const history = new URL(stub.calls[0]!.url);
  assert.equal(history.searchParams.get('channel'), 'C0DIGEST');
  assert.equal(history.searchParams.get('oldest'), String(Math.floor((NOW.getTime() - 26 * HOUR) / 1_000)));
  const post = stub.calls[1]!;
  assert.equal((post.init.headers as Record<string, string>).Authorization, 'Bearer xoxb-digest-token');
  assert.equal(post.init.redirect, 'error');
  const body = JSON.parse(String(post.init.body)) as { channel: string; text: string };
  assert.equal(body.channel, 'C0DIGEST');
  assert.equal(body.text, digest.text);
  assert.ok(body.text.includes('[weaver-digest 2026-09-21]'));
  assert.ok(!post.url.includes('xoxb'), 'the bearer never travels in the URL');
});

test('a post that times out is read back and never re-posted', async () => {
  const digest = renderDigest(input(busyFleet()));

  const landed = slack([[], [{ text: digest.text, ts: '1790000000.000200' }]], 'timeout');
  const confirmed = await deliverDigest(digest, CONFIG, { fetch: landed.fetch, now: NOW });
  assert.equal(confirmed.outcome, 'confirmed-after-error');
  assert.deepEqual(landed.calls.map((call) => call.method), ['conversations.history', 'chat.postMessage', 'conversations.history']);

  const lost = slack([[], []], 'timeout');
  const unconfirmed = await deliverDigest(digest, CONFIG, { fetch: lost.fetch, now: NOW });
  assert.equal(unconfirmed.outcome, 'unconfirmed');
  assert.deepEqual(lost.calls.map((call) => call.method), ['conversations.history', 'chat.postMessage', 'conversations.history']);

  const failedCommand = await digestCommand(
    { post: true, dryRun: false },
    { input: input(busyFleet()), secrets: { WEAVER_DIGEST_SLACK_TOKEN: CONFIG.token, WEAVER_DIGEST_SLACK_CHANNEL: CONFIG.channel }, fetch: slack([[], []], 'error').fetch },
  );
  assert.equal(failedCommand.ok, false);
  assert.match(failedCommand.message, /readback did not find it; not re-sent/);
  assert.ok(!failedCommand.message.includes(CONFIG.token));
});

test('an unreadable history refuses to post blind, and a dry run never posts', async () => {
  const digest = renderDigest(input(busyFleet()));
  const calls: string[] = [];
  const broken: DigestFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), { status: 200 });
  };
  const refused = await digestCommand(
    { post: true, dryRun: false },
    { input: input(busyFleet()), secrets: { WEAVER_DIGEST_SLACK_TOKEN: CONFIG.token, WEAVER_DIGEST_SLACK_CHANNEL: CONFIG.channel }, fetch: broken },
  );
  assert.equal(refused.ok, false);
  assert.match(refused.message, /missing_scope — refusing to post without proving today's digest is absent/);
  assert.ok(calls.every((url) => url.includes('conversations.history')));

  const dry = slack([[]], 'ok');
  assert.deepEqual(await deliverDigest(digest, CONFIG, { fetch: dry.fetch, now: NOW, dryRun: true }), { outcome: 'would-post' });
  assert.deepEqual(dry.calls.map((call) => call.method), ['conversations.history']);

  // `weaver digest --dry-run` alone walks the --post path read-only.
  const dryCommand = slack([[]], 'ok');
  const result = await digestCommand(
    { post: false, dryRun: true },
    { input: input(busyFleet()), secrets: { WEAVER_DIGEST_SLACK_TOKEN: CONFIG.token, WEAVER_DIGEST_SLACK_CHANNEL: CONFIG.channel }, fetch: dryCommand.fetch },
  );
  assert.equal(result.ok, true);
  assert.match(result.message, /\(dry run\) digest 2026-09-21 is not in C0DIGEST yet; --post would send it once/);
  assert.deepEqual(dryCommand.calls.map((call) => call.method), ['conversations.history']);
});

test('the destination is operator configuration from the executor-only store', () => {
  assert.equal(digestSlackConfig({}, {}), undefined);
  // The fleet's Slack bot alone is not a destination: the channel is chosen once.
  assert.equal(digestSlackConfig({}, { SLACK_BOT_TOKEN: 'xoxb-fleet' }), undefined);
  assert.deepEqual(
    digestSlackConfig({ WEAVER_DIGEST_SLACK_TOKEN: ' xoxb-1 ', WEAVER_DIGEST_SLACK_CHANNEL: 'D0FOUNDER' }, {}),
    { token: 'xoxb-1', channel: 'D0FOUNDER' },
  );
  assert.throws(() => digestSlackConfig({ WEAVER_DIGEST_SLACK_TOKEN: 'xoxb-1' }, {}), /CHANNEL is not/);
  assert.throws(() => digestSlackConfig({ WEAVER_DIGEST_SLACK_TOKEN: 'xoxb-1', WEAVER_DIGEST_SLACK_CHANNEL: '#founders' }, {}), /channel or DM id/);
  assert.throws(() => digestSlackConfig({ WEAVER_DIGEST_SLACK_CHANNEL: 'C0TEAM' }, {}), /needs a Slack bot token/);
});

test("the digest reuses the fleet's existing Slack bot unless overridden", () => {
  assert.deepEqual(
    digestSlackConfig({ WEAVER_DIGEST_SLACK_CHANNEL: 'C0TEAM' }, { SLACK_BOT_TOKEN: ' xoxb-fleet ' }),
    { token: 'xoxb-fleet', channel: 'C0TEAM' },
  );
  assert.deepEqual(
    digestSlackConfig(
      { WEAVER_DIGEST_SLACK_CHANNEL: 'C0TEAM', WEAVER_DIGEST_SLACK_TOKEN: 'xoxb-own' },
      { SLACK_BOT_TOKEN: 'xoxb-fleet' },
    ),
    { token: 'xoxb-own', channel: 'C0TEAM' },
  );
});

test('the marker follows the London calendar across daylight saving', () => {
  assert.equal(londonDate(new Date('2026-01-15T23:30:00.000Z')), '2026-01-15');
  assert.equal(londonDate(new Date('2026-07-15T23:30:00.000Z')), '2026-07-16');
  assert.equal(digestMarker(londonDate(NOW)), '[weaver-digest 2026-09-21]');
});

test('workspace links use the same public origin derivation as the operator UI', () => {
  assert.equal(operatorPublicOrigin({ WEAVER_UI_PUBLIC_ORIGIN: 'https://workspace.example/' }), 'https://workspace.example');
  assert.equal(operatorPublicOrigin({ RAILWAY_PUBLIC_DOMAIN: 'ui.up.railway.app' }), 'https://ui.up.railway.app');
  assert.equal(operatorPublicOrigin({}), undefined);
  assert.throws(() => operatorPublicOrigin({ WEAVER_UI_PUBLIC_ORIGIN: 'http://workspace.example' }), /HTTPS/);
});
