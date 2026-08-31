import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { FLEET_ATTENTION_STEWARD_SOURCE_KEY } from './fleetHealth.js';
import {
  createOrGetFleetAttentionStewardWorkstream,
  createOrGetWorkstream,
} from './ingress.js';
import { closeStore, createWorkstream, load } from './store.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-ingress-reserved-source-'));
  process.env.WEAVER_HOME = home;
});

afterEach(async () => {
  await closeStore();
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

test('public intake cannot claim or resolve the reserved steward source identity', async () => {
  const publicRequest = {
    sourceKey: FLEET_ATTENTION_STEWARD_SOURCE_KEY,
    slug: 'spoofed-steward',
    title: 'Spoofed steward',
    objective: 'Gain the built-in steward tool by copying its source key.',
  };
  await assert.rejects(createOrGetWorkstream(publicRequest), /reserved for Weaver's built-in fleet attention steward/);

  const created = await createOrGetFleetAttentionStewardWorkstream({
    title: 'Fleet attention steward',
    objective: 'Own typed fleet attention without inheriting human authority.',
    tags: ['routine', 'fleet-operations'],
    successCriteria: ['Every actionable group has an owner.'],
    constraints: ['External effects remain gated.'],
  });
  assert.equal(created.created, true);
  assert.equal((await load(created.slug)).workstream.sourceKey, FLEET_ATTENTION_STEWARD_SOURCE_KEY);

  const existing = await createOrGetFleetAttentionStewardWorkstream({
    title: 'Fleet attention steward',
    objective: 'The existing built-in remains the identity holder.',
  });
  assert.equal(existing.created, false);
  assert.equal(existing.slug, created.slug);

  await assert.rejects(createOrGetWorkstream(publicRequest), /reserved for Weaver's built-in fleet attention steward/);
});

test('the built-in constructor refuses a legacy source-key holder at the wrong slug', async () => {
  await createWorkstream({
    slug: 'legacy-spoof', title: 'Legacy spoof', objective: 'Claimed before the key became reserved.',
    sourceKey: FLEET_ATTENTION_STEWARD_SOURCE_KEY, tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
  });
  await assert.rejects(
    createOrGetFleetAttentionStewardWorkstream({
      title: 'Fleet attention steward', objective: 'Own typed fleet attention safely.',
    }),
    /held by unexpected Workstream 'legacy-spoof'; refusing to activate it/,
  );
});
