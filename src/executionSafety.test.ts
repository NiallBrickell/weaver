import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  assertExecutionStartAllowed,
  executionPosition,
  isWakeDue,
  newExecutionSafety,
  retireLegacyDollarBudgetCard,
} from './executionSafety.js';
import { runWorker } from './worker.js';
import { runCoordinatorPass } from './coordinator.js';
import { tick } from './engine.js';
import { arrive, createWorkstream, load } from './store.js';
import type { WorkerExecutor } from './executor/types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-execution-safety-'));
  process.env.WEAVER_HOME = home;
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function make(slug: string, maxModelStarts = 3): Promise<void> {
  await createWorkstream({
    slug, title: slug, objective: 'exercise rolling safety', tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true },
    executionSafety: { maxModelStarts, windowSeconds: 60 },
  });
}

test('new execution safety configuration rejects invalid explicit limits', () => {
  assert.throws(() => newExecutionSafety({ maxModelStarts: 0 }), /must be a positive integer/);
  assert.throws(() => newExecutionSafety({ maxModelStarts: 1.5 }), /must be a positive integer/);
  assert.throws(() => newExecutionSafety({ windowSeconds: Number.NaN }), /must be a positive integer/);
});

test('rolling position counts durable model starts, excludes engine actions, and expires at the exact boundary', async () => {
  await make('rolling');
  const now = new Date('2026-08-13T10:00:00.000Z');
  await arrive('rolling', (doc) => {
    doc.passes.push(
      { id: 'pass_recent', startedAt: '2026-08-13T09:59:01.000Z', baseRevision: 0, wakeReasons: [], changes: [], outcome: 'error' },
      { id: 'pass_boundary', startedAt: '2026-08-13T09:59:00.000Z', baseRevision: 0, wakeReasons: [], changes: [], outcome: 'completed' },
    );
    doc.assignments.push({
      id: 'asg_history', objective: 'history', briefing: 'history', kind: 'work', acceptanceCriteria: [], dependsOn: [],
      state: 'completed', adoption: { state: 'accepted' }, createdAtVirtual: now.toISOString(),
      attempts: [
        { runId: 'run_legacy', startedAt: '2026-08-13T09:59:30.000Z' },
        { runId: 'run_engine', model: 'engine', startedAt: '2026-08-13T09:59:40.000Z' },
      ],
    });
  });
  const position = executionPosition(await load('rolling'), now);
  assert.equal(position.count, 2);
  assert.equal(position.blocked, false);
});

test('over-limit recovery waits until enough starts expire to allow one new claim', async () => {
  await make('over-limit');
  const now = new Date('2026-08-13T10:00:00.000Z');
  await arrive('over-limit', (doc) => {
    for (const [index, second] of [10, 20, 30, 40].entries()) {
      doc.passes.push({
        id: `pass_${index}`, startedAt: `2026-08-13T09:59:${second}.000Z`, baseRevision: 0,
        wakeReasons: [], changes: [], outcome: 'completed',
      });
    }
  });
  const position = executionPosition(await load('over-limit'), now);
  assert.equal(position.count, 4);
  assert.equal(position.blocked, true);
  assert.equal(position.retryAt, '2026-08-13T10:00:20.000Z');
});

test('worker claim cannot cross the guard and parks one physical-time wake without invoking the executor', async () => {
  await make('claim', 1);
  await arrive('claim', (doc) => {
    doc.passes.push({
      id: 'pass_recent', startedAt: new Date(Date.now() - 10_000).toISOString(), baseRevision: 0,
      wakeReasons: [], changes: [], outcome: 'completed',
    });
    doc.assignments.push({
      id: 'asg_claim', objective: 'do not launch', briefing: 'do not launch', kind: 'work',
      acceptanceCriteria: [], dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' },
      createdAtVirtual: new Date().toISOString(),
    });
  });
  let invoked = false;
  const executor: WorkerExecutor = {
    async execute() { invoked = true; return { costUsd: 0, sessionId: 'should-not-exist' }; },
  };
  assert.equal(await runWorker('claim', 'asg_claim', executor), false);
  assert.equal(await runWorker('claim', 'asg_claim', executor), false);
  const doc = await load('claim');
  assert.equal(invoked, false);
  assert.equal(doc.assignments[0]!.state, 'queued');
  const wakes = doc.wakes.filter((wake) => wake.status === 'pending' && wake.executionSafety);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.condition.type, 'wall_time');
  assert.equal(isWakeDue(wakes[0]!.condition, new Date(0), new Date('2100-01-01')), false,
    'advancing the virtual clock cannot bypass a physical runaway pause');
});

test('coordinator claim cannot cross the guard and engine leaves the original wake pending', async () => {
  await make('coordinator-claim', 1);
  await arrive('coordinator-claim', (doc) => {
    doc.passes.push({
      id: 'pass_recent', startedAt: new Date(Date.now() - 10_000).toISOString(), baseRevision: 0,
      wakeReasons: [], changes: [], outcome: 'completed',
    });
    doc.wakes.push({
      id: 'wake_business', reason: 'review business evidence', condition: { type: 'immediate' },
      status: 'pending', createdAt: new Date().toISOString(),
    });
  });
  await assert.rejects(runCoordinatorPass('coordinator-claim', ['manual']), /execution safety pause/);
  let doc = await load('coordinator-claim');
  assert.equal(doc.passes.length, 1);
  assert.equal(doc.wakes.find((wake) => wake.id === 'wake_business')!.status, 'pending');
  assert.equal(doc.wakes.filter((wake) => wake.executionSafety && wake.status === 'pending').length, 1);

  const report = await tick('coordinator-claim', { maxPasses: 1 });
  assert.equal(report.passes.length, 0);
  doc = await load('coordinator-claim');
  assert.equal(doc.wakes.find((wake) => wake.id === 'wake_business')!.status, 'pending');
});

test('legacy dollar/pass caps are diagnostic history only and their generated card retires without a human act', async () => {
  await createWorkstream({
    slug: 'legacy', title: 'legacy', objective: 'continue indefinitely', tags: [], successCriteria: [], constraints: [],
    autonomy: { sendsRequireApproval: true }, budget: { maxCoordinatorPasses: 1, maxCostUsd: 1 },
  });
  await arrive('legacy', (doc) => {
    doc.spend.coordinatorPasses = 500;
    doc.spend.totalCostUsd = 1000;
    doc.attention.push({
      id: 'att_budget', kind: 'budget', summary: 'Budget exhausted ($1000.00 of $1) — nothing more will run.',
      status: 'open', createdAt: new Date().toISOString(),
    });
  });
  const legacyBefore = await load('legacy');
  assert.doesNotThrow(() => assertExecutionStartAllowed(legacyBefore));
  await retireLegacyDollarBudgetCard('legacy');
  const doc = await load('legacy');
  assert.equal(doc.attention[0]!.status, 'resolved');
  assert.equal(doc.attention[0]!.resolvedBy, 'execution-safety-migration');
  assert.equal(doc.spend.humanInterventions, 0);
  assert.ok(doc.wakes.some((wake) => wake.status === 'pending'));
});

test('CLI configures rolling safety and rejects the old top-up command explicitly', async () => {
  await make('cli-safety');
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'execution-safety', 'cli-safety', '--window', '2h', '--max-starts', '40'],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.match(output, /execution safety guard updated/);
  assert.deepEqual((await load('cli-safety')).workstream.executionSafety, { windowSeconds: 7200, maxModelStarts: 40 });

  const legacy = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'budget', 'cli-safety', '--max-cost', '100'],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  );
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /lifetime dollar\/pass caps were removed.*provider billing controls/);
});
