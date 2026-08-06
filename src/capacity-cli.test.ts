import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { virtualNow } from './clock.js';
import { arrive, createWorkstream, load } from './store.js';
import type { InfrastructureWait } from './types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-capacity-cli-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

test('capacity retry makes a real stored wait due without changing billing or authority', async () => {
  await createWorkstream({
    slug: 'capacity-cli',
    title: 'Capacity CLI',
    objective: 'resume durable work',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  const wait: InfrastructureWait = {
    kind: 'usage_limit',
    recovery: 'wait_or_enable_usage_credits',
    source: 'worker',
    sourceId: 'run_wait',
    model: 'sonnet',
    detectedAt: virtualNow().toISOString(),
    retryAt: new Date(virtualNow().getTime() + 60_000).toISOString(),
  };
  await arrive('capacity-cli', (doc) => {
    doc.wakes.push({
      id: 'wake_wait',
      reason: 'typed provider wait',
      condition: { type: 'time', dueAtVirtual: wait.retryAt },
      status: 'pending',
      createdAt: new Date().toISOString(),
      infrastructure: wait,
    });
    doc.capacity = {
      state: 'backoff',
      byModel: {
        sonnet: {
          wait,
          consecutiveBackoffs: 1,
          firstBackoffAtVirtual: wait.detectedAt,
          lastBackoffAtVirtual: wait.detectedAt,
        },
      },
    };
  });

  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'capacity', 'retry', 'capacity-cli'],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );

  const doc = await load('capacity-cli');
  assert.match(output, /changed no billing or identity/);
  assert.ok(doc.capacity!.byModel.sonnet!.wait.retryAt <= virtualNow().toISOString());
  assert.equal(doc.capacity!.state, 'backoff');
  assert.equal(doc.spend.humanInterventions, 0);
  assert.equal(doc.events.at(-1)!.type, 'capacity.retry_requested');
  assert.match(doc.events.at(-1)!.summary, /recovery remains unconfirmed/);
});
