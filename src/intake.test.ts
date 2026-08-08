/**
 * Intake contract: a workstream may watch an outside system and open work for
 * what it finds there. Two rails make that safe, and neither may depend on a
 * model behaving well:
 *
 *   1. Looking is at-least-once — the same issue is seen on every pass — so
 *      "does this already have a workstream?" is answered from typed state
 *      (sourceKey), never from a coordinator's recollection.
 *   2. A manager's capacity to take on more is read from its children's live
 *      status in the projection, never reconstructed from a notice tail or
 *      from what a pass believes it started.
 *
 * The looking itself is ordinary worker work — the coordinator has no tools
 * onto the outside world and needs none.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeStore, createWorkstream, findBySourceKey, listManagedBy, listWorkstreams, load, workstreamDir } from './store.js';
import { createManagedWorkstream } from './managedWorkstreams.js';
import { buildProjection } from './projection.js';

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

test('a manager reads its live child count from the projection, not from notices', async () => {
  await make('intake');
  const doc = await load('intake');

  // No children yet: the section is present and says so, so a pass can never
  // read absence as "I have not looked".
  assert.match(buildProjection(doc, [], [], []), /Workstreams you manage \(0 of 0 still running/);

  // Two running, one concluded — the count that governs "how many more may I
  // take on?" must be the ACTIVE one, not the total ever created.
  const p = buildProjection(doc, [], [], [
    { slug: 'erdo-410', status: 'active' },
    { slug: 'erdo-411', status: 'active' },
    { slug: 'erdo-412', status: 'done' },
  ]);
  assert.match(p, /Workstreams you manage \(2 of 3 still running/);
  assert.match(p, /- erdo-410 \[active\]/);
  assert.match(p, /- erdo-412 \[done\]/);
});

test('listManagedBy gives the projection exactly the children it manages, one level deep', async () => {
  await make('intake');
  await createManagedWorkstream('intake', { slug: 'child-a', title: 'a', objective: 'o', successCriteria: [], constraints: [], tags: [] });
  await createManagedWorkstream('intake', { slug: 'child-b', title: 'b', objective: 'o', successCriteria: [], constraints: [], tags: [] });
  // A grandchild must never reach the manager's own count.
  await createManagedWorkstream('child-a', { slug: 'grandchild', title: 'g', objective: 'o', successCriteria: [], constraints: [], tags: [] });

  const managed = await listManagedBy('intake');
  assert.deepEqual(managed.map((m) => m.slug).sort(), ['child-a', 'child-b']);
  assert.match(buildProjection(await load('intake'), [], [], managed), /you manage \(2 of 2 still running/);
});
