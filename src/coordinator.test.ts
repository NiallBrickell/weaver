import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearCoordinatorCapacityBackoff,
  pickCoordinatorModel,
  recordCoordinatorCapacityBackoff,
} from './coordinator.js';
import { arrive, createWorkstream, load } from './store.js';
import { virtualNow } from './clock.js';
import type { CapacityCategory, InfrastructureWait } from './types.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-coordinator-capacity-'));
  process.env.WEAVER_HOME = home;
  createWorkstream({
    slug: 'coordinator-capacity',
    title: 'Coordinator capacity',
    objective: 'test deterministic pass finalization state',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 20, maxCostUsd: 20 },
  });
});

afterEach(() => {
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function wait(category: CapacityCategory, index: number): InfrastructureWait {
  return {
    kind: category,
    recovery: category === 'sdk_credit_exhausted'
      ? 'claim_sdk_credit_or_enable_usage_credits'
      : category === 'auth'
        ? 'reauthenticate'
        : 'automatic_retry',
    source: 'coordinator',
    sourceId: `pass_${index}`,
    model: 'claude-fable-5',
    detectedAt: virtualNow().toISOString(),
    retryAt: new Date(virtualNow().getTime() + 15 * 60_000).toISOString(),
  };
}

function backoff(category: CapacityCategory, count: number): void {
  for (let index = 1; index <= count; index++) {
    arrive('coordinator-capacity', (doc) => {
      recordCoordinatorCapacityBackoff(doc, wait(category, index), `wake_${index}`);
    });
  }
}

test('credit capacity state raises one explicit recovery card after three backoffs', () => {
  backoff('sdk_credit_exhausted', 3);
  let doc = load('coordinator-capacity');
  assert.equal(doc.capacity!.byModel['claude-fable-5']!.consecutiveBackoffs, 3);
  assert.equal(doc.attention.filter((item) => item.kind === 'capacity').length, 1);
  assert.match(doc.attention[0]!.summary, /\/usage-credits/);
  assert.match(doc.attention[0]!.summary, /support\.claude\.com\/en\/articles\/15036540/);
  assert.match(doc.attention[0]!.summary, /support\.claude\.com\/en\/articles\/12429409/);

  backoff('sdk_credit_exhausted', 1);
  doc = load('coordinator-capacity');
  assert.equal(doc.attention.filter((item) => item.kind === 'capacity').length, 1);
  assert.match(doc.attention[0]!.summary, /blocked work 4 times/);
});

test('session limits wait quietly until the twelfth consecutive backoff', () => {
  backoff('session_limit', 11);
  assert.equal(load('coordinator-capacity').attention.length, 0);
  backoff('session_limit', 1);
  assert.equal(load('coordinator-capacity').attention.filter((item) => item.kind === 'capacity').length, 1);
});

test('a recovered coordinator model clears typed state and resolves its card', () => {
  backoff('auth', 3);
  arrive('coordinator-capacity', (doc) => {
    clearCoordinatorCapacityBackoff(doc, 'claude-fable-5');
  });
  const doc = load('coordinator-capacity');
  assert.equal(doc.capacity, null);
  assert.equal(doc.attention[0]!.status, 'resolved');
  assert.equal(doc.attention[0]!.resolvedBy, 'coordinator');
});

test('a limited primary model degrades the pass to the fallback, and only then', () => {
  const now = virtualNow().toISOString();
  const future = new Date(virtualNow().getTime() + 60 * 60_000).toISOString();
  const past = new Date(virtualNow().getTime() - 60_000).toISOString();
  const wait = (model: string, retryAt: string): InfrastructureWait => ({
    kind: 'rate_limit', recovery: 'automatic_retry', source: 'coordinator',
    sourceId: 'pass_x', model, detectedAt: now, retryAt,
  });
  const doc = load('coordinator-capacity');

  // No capacity state at all → primary.
  assert.equal(pickCoordinatorModel(doc, now), 'claude-fable-5');

  // Primary limited, fallback clear → fallback.
  const capacity = { state: 'backoff' as const, byModel: { 'claude-fable-5': { wait: wait('claude-fable-5', future), consecutiveBackoffs: 1, firstBackoffAtVirtual: now, lastBackoffAtVirtual: now } } };
  doc.capacity = capacity;
  assert.equal(pickCoordinatorModel(doc, now), 'claude-opus-5');

  // Primary limited but its retryAt has passed → primary again (probe/retry).
  capacity.byModel['claude-fable-5']!.wait = wait('claude-fable-5', past);
  assert.equal(pickCoordinatorModel(doc, now), 'claude-fable-5');

  // Both pools limited → primary (normal backoff machinery owns it).
  capacity.byModel['claude-fable-5']!.wait = wait('claude-fable-5', future);
  (capacity.byModel as Record<string, unknown>)['claude-opus-5'] = { wait: wait('claude-opus-5', future), consecutiveBackoffs: 1, firstBackoffAtVirtual: now, lastBackoffAtVirtual: now };
  assert.equal(pickCoordinatorModel(doc, now), 'claude-fable-5');
});
