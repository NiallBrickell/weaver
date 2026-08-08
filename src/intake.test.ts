/**
 * Intake contract: a workstream may watch an outside system and open work for
 * what it finds there. Two rails make that safe, and neither may depend on a
 * model behaving well:
 *
 *   1. Looking is at-least-once — the same issue is seen on every pass — so
 *      "does this already have a workstream?" is answered from typed state
 *      (sourceKey), never from a coordinator's recollection.
 *   2. Looking is read-only. The same deterministic gate that gives workers
 *      the operator's MCP servers gives them to the coordinator, and it
 *      refuses every write verb without consulting a model.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeStore, createWorkstream, findBySourceKey, listWorkstreams, workstreamDir } from './store.js';
import { readOnlyMcpSupervisor } from './coordinator.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-intake-'));
  process.env.WEAVER_HOME = home;
});

afterEach(async () => {
  await closeStore();
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function make(slug: string, sourceKey?: string): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'o',
    tags: [],
    successCriteria: [],
    constraints: [],
    ...(sourceKey ? { sourceKey } : {}),
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
}

test('a workstream standing for an external thing is findable by its source key', async () => {
  await make('erdo-425-sms-consent', 'linear:a90143e8');
  await make('unrelated-stream');
  assert.equal(await findBySourceKey('linear:a90143e8'), 'erdo-425-sms-consent');
});

test('an external thing with no workstream yet returns null', async () => {
  await make('erdo-425-sms-consent', 'linear:a90143e8');
  assert.equal(await findBySourceKey('linear:deadbeef'), null);
});

test('seeing the same issue on a later pass finds the first workstream, never a second', async () => {
  // The exact sequence a repeating intake stream runs: look, dedupe, spawn.
  // Pass one has nothing and creates; pass two must find what pass one made.
  const key = 'linear:a90143e8';
  assert.equal(await findBySourceKey(key), null);
  await make('erdo-425-sms-consent', key);

  assert.equal(await findBySourceKey(key), 'erdo-425-sms-consent');
  assert.deepEqual(await listWorkstreams(), ['erdo-425-sms-consent']);
});

test('an unreadable document does not hide a sibling source key', async () => {
  // A corrupt doc must not make an existing workstream invisible to the
  // dedupe — that would silently duplicate the work it stands for.
  await make('broken-stream', 'linear:broken');
  await make('erdo-425-sms-consent', 'linear:a90143e8');
  fs.writeFileSync(path.join(workstreamDir('broken-stream'), 'workstream.json'), '{ not json');

  assert.equal(await findBySourceKey('linear:a90143e8'), 'erdo-425-sms-consent');
});

test('creating a managed workstream twice for one external thing is refused at the helper', async () => {
  // The backstop under the tool's own check: whatever a coordinator believes
  // it has already done, the create path itself cannot open the same work
  // twice. Pinned here so the tool-level check can never become the only one.
  const { createManagedWorkstream } = await import('./managedWorkstreams.js');
  await make('linear-intake');
  await createManagedWorkstream('linear-intake', {
    slug: 'erdo-425-connectivity',
    title: 'ERDO-425',
    objective: 'close the issue out',
    successCriteria: [],
    constraints: [],
    tags: ['linear'],
    sourceKey: 'linear:ERDO-425',
  });

  await assert.rejects(
    () =>
      createManagedWorkstream('linear-intake', {
        slug: 'erdo-425-connectivity-again',
        title: 'ERDO-425',
        objective: 'close the issue out',
        successCriteria: [],
        constraints: [],
        tags: ['linear'],
        sourceKey: 'linear:ERDO-425',
      }),
    /already stands for linear:ERDO-425/,
  );
  assert.deepEqual((await listWorkstreams()).sort(), ['erdo-425-connectivity', 'linear-intake']);
});

test("the coordinator's read-only gate allows retrieval and refuses every write verb", async () => {
  const gate = readOnlyMcpSupervisor();
  for (const name of [
    'mcp__linear__list_issues',
    'mcp__linear__get_issue',
    'mcp__linear__list_comments',
    'mcp__linear__search_documentation',
  ]) {
    assert.equal((await gate(name, {})).behavior, 'allow', name);
  }
  for (const name of [
    'mcp__linear__save_issue',
    'mcp__linear__save_comment',
    'mcp__linear__create_issue_label',
    'mcp__linear__delete_comment',
    'mcp__linear__merge_diff',
  ]) {
    assert.equal((await gate(name, {})).behavior, 'deny', name);
  }
});

test('the gate is deny-by-default: nothing but a read reaches the world', async () => {
  const gate = readOnlyMcpSupervisor();
  // The coordinator runs with tools: [], so a non-MCP tool arriving here would
  // already be a bug — deny-by-default is what makes it a harmless one. The
  // write path an intake stream would most like to cheat past is a shell that
  // forges workstream state directly.
  assert.equal((await gate('Bash', { command: 'weaver create --slug x' })).behavior, 'deny');
  assert.equal((await gate('Bash', { command: 'git log -5' })).behavior, 'deny');
  assert.equal((await gate('Write', { file_path: '/x', content: 'y' })).behavior, 'deny');
  // A read verb that is only a prefix of a longer word is not a read verb.
  assert.equal((await gate('mcp__x__gettysburg', {})).behavior, 'deny');
  assert.equal((await gate('mcp__x__getAddress', {})).behavior, 'allow');
});
