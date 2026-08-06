/**
 * Deterministic tail-contract tests: the tail is observability that can
 * never hurt — writes are redacted, failures are swallowed, growth is
 * bounded. No model, no network. The follow loop is not tested here (it is
 * an interactive poll over the same file format these tests pin down).
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { emitTail, tailMessage, tailPath, type TailEvent } from './tail.js';
import { setSecret } from './secrets.js';
import { createWorkstream } from './store.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-tail-'));
  // Hermetic: never let tests reach a REAL pilot daemon on this machine.
  process.env.WEAVER_PILOT_URL = 'http://127.0.0.1:1';
});

const SLUG = 'tail-ws';

async function makeWs(): Promise<void> {
  await createWorkstream({
    slug: SLUG,
    title: 'Tail test',
    objective: 'test the tail',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

function readEvents(): TailEvent[] {
  return fs
    .readFileSync(tailPath(SLUG), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TailEvent);
}

test('emit appends valid single-line JSONL with the full event shape', async () => {
  await makeWs();
  emitTail(SLUG, 'worker', 'asg_1', 'tool', 'Bash git status');
  emitTail(SLUG, 'coordinator', 'pass_1', 'text', 'reviewing the submission');
  const events = readEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.source, e.ref, e.kind, e.detail]),
    [
      ['worker', 'asg_1', 'tool', 'Bash git status'],
      ['coordinator', 'pass_1', 'text', 'reviewing the submission'],
    ],
  );
  for (const e of events) assert.ok(!Number.isNaN(Date.parse(e.at)));
});

test('a write failure is swallowed — tailing must never break a pass', async () => {
  await makeWs();
  // Occupy the tail path with a directory: append fails with EISDIR.
  fs.mkdirSync(tailPath(SLUG));
  assert.doesNotThrow(() => emitTail(SLUG, 'worker', 'asg_1', 'tool', 'Bash true'));
});

test('a detail carrying a stored secret VALUE never reaches disk', async () => {
  await makeWs();
  setSecret('GLOBAL_TOKEN', 'global-secret-value-1');
  setSecret('WS_TOKEN', 'ws-secret-value-2', SLUG);
  emitTail(SLUG, 'worker', 'asg_1', 'tool', 'Bash curl -H "Auth: global-secret-value-1" -d ws-secret-value-2');
  const raw = fs.readFileSync(tailPath(SLUG), 'utf8');
  assert.ok(!raw.includes('global-secret-value-1'), 'tail leaked a global secret value');
  assert.ok(!raw.includes('ws-secret-value-2'), 'tail leaked a workstream secret value');
  assert.ok(raw.includes('«secret:GLOBAL_TOKEN»'));
  assert.ok(raw.includes('«secret:WS_TOKEN»'));
});

test('an executor-relayed MCP credential is redacted without entering the secret store', async () => {
  await makeWs();
  const transient = 'synthetic-mcp-header-value';
  tailMessage(
    SLUG,
    'worker',
    'asg_mcp',
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: `bad remote output ${transient}` }] },
    } as never,
    { WEAVER_INTERNAL_MCP_HEADER_1: transient },
  );
  const raw = fs.readFileSync(tailPath(SLUG), 'utf8');
  assert.doesNotMatch(raw, /synthetic-mcp-header-value/);
  assert.match(raw, /«secret:WEAVER_INTERNAL_MCP_HEADER_1»/);
});

test('past the size threshold the file rotates to .1, overwriting any previous generation', async () => {
  await makeWs();
  const p = tailPath(SLUG);
  fs.writeFileSync(`${p}.1`, 'stale generation\n');
  fs.writeFileSync(p, 'x'.repeat(5 * 1024 * 1024 + 1));
  emitTail(SLUG, 'worker', 'asg_1', 'tool', 'Bash echo after-rotation');
  const rotated = fs.readFileSync(`${p}.1`, 'utf8');
  assert.ok(rotated.startsWith('xxx'), 'the oversized file did not become .1');
  assert.ok(!rotated.includes('stale generation'), 'previous .1 generation survived rotation');
  const events = readEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.detail, 'Bash echo after-rotation');
});

test('tailMessage summarizes tool calls, prose snippets, and the result — nothing else', async () => {
  await makeWs();
  const longCmd = `git log ${'-'.repeat(200)}`;
  tailMessage(SLUG, 'worker', 'asg_1', {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: `let me look at the history\n${'a'.repeat(300)}` },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: longCmd } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/tmp/x.ts' } },
      ],
    },
  } as never);
  tailMessage(SLUG, 'worker', 'asg_1', { type: 'system', subtype: 'init' } as never);
  tailMessage(SLUG, 'worker', 'asg_1', {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 7,
    total_cost_usd: 0.123,
  } as never);
  const events = readEvents();
  assert.deepEqual(
    events.map((e) => e.kind),
    ['text', 'tool', 'tool', 'result'],
  );
  assert.ok(events[0]!.detail.startsWith('let me look at the history'));
  assert.ok(events[0]!.detail.length <= 200);
  assert.ok(events[1]!.detail.startsWith('Bash git log'));
  assert.ok(events[1]!.detail.length <= 'Bash '.length + 120);
  assert.equal(events[2]!.detail, 'Read /tmp/x.ts');
  assert.equal(events[3]!.detail, 'done in 7 turns ($0.123)');
});
