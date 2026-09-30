/**
 * The need notifier's rails, on the fs store with a fake APNs sender: one
 * push per device per need version however many UI processes race it, no
 * push for needs that were open before the feature ran, dead devices are
 * removed, failures are counted and redacted, ticks never overlap, the
 * yes/no category is only offered when the card really is yes/no, and the
 * fleet is read through the REST API's revision-validated index — never a
 * load per workstream per tick.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTeamWorkstream } from '../operatorUi.js';
import { WorkstreamIndex, type ApiNeed } from '../restApi.js';
import { arrive, closeStore, findNeedNotifications, listDevices, listWorkstreamHeads, load, registerDevice, type Device, type WorkstreamHead } from '../store.js';
import type { WorkstreamDoc } from '../types.js';
import type { ApnsResult } from './apns.js';
import { NeedNotifier, PREEXISTING_REASON, SEEDED_MARKER_KEY, type PushSender } from './notifier.js';
import { APPROVE_DECLINE_CATEGORY, NEED_CATEGORY, approveDeclineChoices, needBody, needKey, needPayload, type NeedPushPayload } from './payload.js';

let home: string;

beforeEach(async () => {
  await closeStore();
  delete process.env.WEAVER_STORE;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-notify-'));
  process.env.WEAVER_HOME = home;
});

afterEach(async () => {
  await closeStore();
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

interface Sent { token: string; payload: NeedPushPayload; collapse: string }

class FakeSender implements PushSender {
  sent: Sent[] = [];
  constructor(private readonly answer: (device: Pick<Device, 'token'>) => ApnsResult = () => ({ ok: true })) {}
  async send(device: Pick<Device, 'token' | 'environment'>, payload: NeedPushPayload, collapse: string): Promise<ApnsResult> {
    this.sent.push({ token: device.token, payload, collapse });
    return this.answer(device);
  }
}

const TOKEN_A = 'aa'.repeat(32);
const TOKEN_B = 'bb'.repeat(32);

async function device(token: string): Promise<Device> {
  return (await registerDevice({ token, platform: 'ios', environment: 'production', bundleId: 'ai.erdo.team', actor: 'api:team' })).device;
}

async function job(requestId: string): Promise<string> {
  return (await createTeamWorkstream({ message: `Handle request ${requestId}.`, requestId, actor: 'alice' })).slug;
}

async function openNeed(slug: string, id: string, summary: string): Promise<void> {
  await arrive(slug, (doc, event) => {
    doc.attention.push({ id, kind: 'blocker', summary, status: 'open', createdAt: new Date().toISOString() });
    event('attention.opened', 'need opened');
  });
}

function freshIndex(): WorkstreamIndex {
  return new WorkstreamIndex({ ttlMs: 0 });
}

function notifier(sender: PushSender, index = freshIndex(), log: string[] = []): NeedNotifier {
  return new NeedNotifier({ index, sender, log: (line) => log.push(line) });
}

test('needs open before the first start are recorded unsent; a later need is pushed once per device', async () => {
  const slug = await job('seed');
  await openNeed(slug, 'att_old', 'DECISION NEEDED: Pick a release date. (A) Friday. (B) Monday.');
  await device(TOKEN_A);
  await device(TOKEN_B);
  const sender = new FakeSender();
  const log: string[] = [];
  const n = notifier(sender, freshIndex(), log);

  const first = await n.tick();
  assert.equal(first.seeded, 1);
  assert.equal(sender.sent.length, 0, 'seeding never sends');
  const doc = await load(slug);
  const [old] = (await freshIndex().rows()).flatMap((row) => row.needs);
  const oldKey = needKey(old!);
  assert.deepEqual((await findNeedNotifications([oldKey]))[0], {
    key: oldKey, createdAt: (await findNeedNotifications([oldKey]))[0]!.createdAt, sentCount: 0, failedCount: 0, lastError: PREEXISTING_REASON,
  });
  assert.equal((await findNeedNotifications([SEEDED_MARKER_KEY])).length, 1);
  assert.equal(doc.revision, (await load(slug)).revision, 'the notifier writes no document');

  // A second tick, and a restarted process, still send nothing for it.
  await n.tick();
  await notifier(sender).tick();
  assert.equal(sender.sent.length, 0);

  await openNeed(slug, 'att_new', 'Approve the production deploy? (A) Approve and deploy now. (B) Decline and wait for Monday.');
  const next = await n.tick();
  assert.equal(next.claimed, 1);
  assert.equal(next.sent, 2);
  assert.deepEqual(sender.sent.map((s) => s.token).sort(), [TOKEN_A, TOKEN_B]);
  const payload = sender.sent[0]!.payload;
  assert.equal(payload.aps.category, APPROVE_DECLINE_CATEGORY);
  assert.equal(payload.aps['thread-id'], slug);
  assert.equal(payload.aps.sound, 'default');
  assert.equal(payload.aps.alert.title, (await load(slug)).workstream.title);
  assert.equal(payload.need.source_type, 'attention');
  assert.equal(payload.need.source_id, 'att_new');
  assert.equal(payload.need.approve_choice, 'A');
  assert.equal(payload.need.decline_choice, 'B');
  assert.ok(payload.aps.alert.body.length <= 180);
  assert.equal(sender.sent[0]!.collapse, sender.sent[1]!.collapse, 'one collapse id per need');
  const newKey = needKey({ workstream: slug, source_type: 'attention', source_id: 'att_new', version: payload.need.version });
  assert.deepEqual((await findNeedNotifications([newKey])).map((row) => [row.sentCount, row.failedCount, row.lastError]), [[2, 0, undefined]]);

  await n.tick();
  await notifier(sender).tick();
  assert.equal(sender.sent.length, 2, 'never re-sent, by this process or after a restart');
});

test('two notifier instances sharing one store send each need exactly once', async () => {
  const slug = await job('race');
  await device(TOKEN_A);
  const sender = new FakeSender();
  const a = notifier(sender);
  const b = notifier(sender);
  await a.tick();
  await b.tick();
  for (let i = 0; i < 3; i += 1) await openNeed(slug, `att_${i}`, `Question number ${i} needs an answer.`);
  const ticks = [a.tick(), b.tick(), a.tick(), b.tick()];
  assert.equal(ticks[0], ticks[2], 'each instance runs one tick at a time');
  const results = await Promise.all([ticks[0]!, ticks[1]!]);
  assert.equal(results.reduce((sum, r) => sum + r.claimed, 0), 3);
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(sender.sent.length, 3);
  assert.deepEqual(sender.sent.map((s) => s.payload.need.source_id).sort(), ['att_0', 'att_1', 'att_2']);
});

test('a 410 removes the device; other failures are counted with a redacted error', async () => {
  const slug = await job('dead');
  const dead = await device(TOKEN_A);
  const flaky = await device(TOKEN_B);
  const healthy = await device('cc'.repeat(32));
  const sender = new FakeSender((d) =>
    d.token === TOKEN_A ? { ok: false, status: 410, reason: 'Unregistered', unregistered: true }
    : d.token === TOKEN_B ? { ok: false, status: 500, reason: `InternalServerError for ${TOKEN_B}`, unregistered: false }
    : { ok: true });
  const log: string[] = [];
  const n = new NeedNotifier({
    index: freshIndex(),
    sender,
    log: (line) => log.push(line),
    redact: (line) => line.replace(/\b[0-9a-f]{64,}\b/g, '[device token]'),
  });
  await n.tick();
  await openNeed(slug, 'att_1', 'Please confirm the budget.');
  const result = await n.tick();
  assert.equal(result.removedDevices, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual((await listDevices()).map((d) => d.id).sort(), [flaky.id, healthy.id].sort());
  assert.ok(!(await listDevices()).some((d) => d.id === dead.id));
  const [row] = (await findNeedNotifications([needKey({ ...sender.sent[0]!.payload.need })]));
  assert.equal(row!.sentCount, 1);
  assert.equal(row!.failedCount, 1);
  assert.match(row!.lastError!, new RegExp(`device ${flaky.id}: APNs 500`));
  for (const line of [...log, row!.lastError!]) {
    assert.ok(!line.includes(TOKEN_A) && !line.includes(TOKEN_B), `token leaked: ${line}`);
  }
});

test('the notifier reads the fleet through the index and loads only changed documents', async () => {
  const slugs = [await job('idx-0'), await job('idx-1'), await job('idx-2')];
  const loads: string[] = [];
  const index = new WorkstreamIndex({
    heads: (): Promise<WorkstreamHead[]> => listWorkstreamHeads(),
    load: async (slug: string): Promise<WorkstreamDoc> => {
      loads.push(slug);
      return load(slug);
    },
    ttlMs: 0,
  });
  const sender = new FakeSender();
  await device(TOKEN_A);
  const n = notifier(sender, index);
  await n.tick();
  assert.equal(loads.length, 3, 'the first refresh derives each workstream once');
  loads.length = 0;
  for (let i = 0; i < 4; i += 1) await n.tick();
  assert.deepEqual(loads, [], 'unchanged revisions cost no body loads');
  await openNeed(slugs[1]!, 'att_x', 'Is the vendor list final?');
  await n.tick();
  assert.deepEqual(loads, [slugs[1]], 'only the changed workstream is loaded');
  assert.equal(sender.sent.length, 1);
});

test('ticks never overlap, and a failing tick is logged without throwing', async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const index = {
    rows: async () => {
      reads += 1;
      await gate;
      return [];
    },
  };
  const n = notifier(new FakeSender(), index as unknown as WorkstreamIndex);
  const first = n.tick();
  const second = n.tick();
  assert.equal(first, second, 'a tick requested mid-tick joins the running one');
  release();
  await first;
  assert.equal(reads, 1);

  const log: string[] = [];
  const broken = new NeedNotifier({
    index: { rows: async () => { throw new Error('store unreachable'); } },
    sender: new FakeSender(),
    log: (line) => log.push(line),
  });
  assert.deepEqual(await broken.tick(), { seeded: 0, claimed: 0, sent: 0, failed: 0, removedDevices: 0 });
  assert.deepEqual(log, ['[notify] tick failed: store unreachable']);
});

test('the approve/decline category needs exactly two clearly yes/no choices', () => {
  const choices = (...texts: string[]) => texts.map((text, i) => ({ label: String.fromCharCode(65 + i), text }));
  assert.deepEqual(approveDeclineChoices(choices('Approve the merge.', 'Decline for now.')), { approve: 'A', decline: 'B' });
  assert.deepEqual(approveDeclineChoices(choices('No, keep the old plan.', 'Yes, switch vendors.')), { approve: 'B', decline: 'A' });
  assert.deepEqual(approveDeclineChoices(choices('Go ahead and send it.', 'Stop and redraft.')), { approve: 'A', decline: 'B' });
  assert.deepEqual(approveDeclineChoices(choices('Proceed with the refund.', "Don't refund.")), { approve: 'A', decline: 'B' });
  assert.deepEqual(approveDeclineChoices(choices('"Yes" — ship it.', 'Hold off until Monday.')), { approve: 'A', decline: 'B' });
  // Two alternatives are a real choice, not yes/no.
  assert.equal(approveDeclineChoices(choices('Continue on green tests.', 'Ask for another review.')), null);
  assert.equal(approveDeclineChoices(choices('Friday.', 'Monday.')), null);
  // Two of the same meaning, one choice, three choices.
  assert.equal(approveDeclineChoices(choices('Approve now.', 'Yes, later.')), null);
  assert.equal(approveDeclineChoices(choices('Approve.')), null);
  assert.equal(approveDeclineChoices(choices('Approve.', 'Decline.', 'Ask me later.')), null);
  // "Nobody" and "Stopgap" only start with the letters.
  assert.equal(approveDeclineChoices(choices('Nobody should review it.', 'Approve it.')), null);
  assert.equal(approveDeclineChoices(choices('Approve it.', 'Stopgap fix first.')), null);
});

test('the payload uses the API copy and falls back to NEED', () => {
  const need: ApiNeed = {
    workstream: 'release-train',
    source_type: 'attention',
    source_id: 'att_1',
    version: 'v1',
    kind: 'blocker',
    title: 'Choose the release course.',
    text: `DECISION NEEDED: Choose the release course. (A) Continue on green tests. (B) Ask for another review. ${'More context. '.repeat(40)}`,
    choices: [{ label: 'A', text: 'Continue on green tests.' }, { label: 'B', text: 'Ask for another review.' }],
    created_at: null,
  };
  const payload = needPayload('Release train', need);
  assert.equal(payload.aps.alert.title, 'Release train');
  assert.equal(payload.aps.category, NEED_CATEGORY);
  assert.equal(payload.need.approve_choice, undefined);
  assert.deepEqual(Object.keys(payload.need), ['workstream', 'source_type', 'source_id', 'version']);
  assert.ok(payload.aps.alert.body.startsWith('Choose the release course. (A) Continue on green tests.'));
  assert.ok(payload.aps.alert.body.length <= 180);
  assert.ok(payload.aps.alert.body.endsWith('…'));
  assert.equal(needBody({ title: 'Is the vendor list final?', text: 'Is the vendor list final?' }), 'Is the vendor list final?');
  assert.equal(needKey(need), 'release-train|attention|att_1|v1');
});
