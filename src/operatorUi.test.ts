/**
 * The operator workspace is an adapter contract: intake survives without a
 * model, teammate follow-ups remain Observations, rendered pages expose typed
 * truth, and no authority route exists.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createTeamWorkstream, startOperatorUi, type RunningOperatorUi } from './operatorUi.js';
import { arrive, listWorkstreams, load, newId, writeArtifact } from './store.js';

let home: string;
let running: RunningOperatorUi | undefined;
let base: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-operator-ui-'));
  process.env.WEAVER_HOME = home;
  running = await startOperatorUi();
  base = `http://127.0.0.1:${running.port}`;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  delete process.env.WEAVER_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function form(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers },
    body: new URLSearchParams(fields),
  };
}

function slugFrom(response: Response): string {
  const location = response.headers.get('location');
  assert.ok(location);
  const match = location.match(/^\/workstreams\/([^?]+)/);
  assert.ok(match);
  return decodeURIComponent(match[1]!);
}

test('New work stores a durable request immediately and an exact retry is idempotent', async () => {
  const message = 'The customer-facing carousel is blank; diagnose it and get the mixed video and images rendering together.';
  const first = await fetch(`${base}/workstreams`, form({
    message,
    done: 'The carousel visibly renders its video and images and the fix is verified.',
    request_id: 'browser-request-1',
  }));
  assert.equal(first.status, 303);
  assert.match(first.headers.get('location') ?? '', /created=1$/);
  const slug = slugFrom(first);

  const doc = await load(slug);
  assert.equal(doc.workstream.objective, message);
  assert.deepEqual(doc.workstream.successCriteria, ['The carousel visibly renders its video and images and the fix is verified.']);
  assert.ok(doc.workstream.constraints.length > 0, 'the machine house pack is applied');
  assert.ok(doc.wakes.some((wake) => wake.status === 'pending' && wake.condition.type === 'immediate'));
  assert.equal(doc.observations.length, 1);
  assert.match(doc.observations[0]!.source, /^operator-ui:/);
  assert.equal(doc.observations[0]!.summary, message);

  const second = await fetch(`${base}/workstreams`, form({
    message,
    done: 'The carousel visibly renders its video and images and the fix is verified.',
    request_id: 'browser-request-1',
  }));
  assert.equal(second.status, 303);
  assert.match(second.headers.get('location') ?? '', /existing=1$/);
  assert.equal(slugFrom(second), slug);
  assert.deepEqual(await listWorkstreams(), [slug]);
  assert.equal((await load(slug)).observations.length, 1, 'the original request observation also deduplicates');
});

test('model-independent intake preserves the execution hosts repository map in intended work', async () => {
  fs.writeFileSync(path.join(home, 'house.json'), JSON.stringify({
    constraints: ['Use a fresh worktree.'],
    repoMap: 'Primary application: /srv/workspaces/application',
    tags: ['application'],
  }));
  const message = 'The customer-facing carousel is blank; investigate and fix it.';
  const created = await createTeamWorkstream({
    message,
    done: 'The carousel is verified in the affected path.',
    requestId: 'repo-context-request',
    actor: 'sales-alice',
  });

  const doc = await load(created.slug);
  assert.match(doc.workstream.objective, new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(doc.workstream.objective, /Primary application: \/srv\/workspaces\/application/);
  assert.deepEqual(doc.workstream.constraints, ['Use a fresh worktree.']);
  assert.deepEqual(doc.workstream.tags, ['application']);
  assert.equal(doc.observations[0]!.summary, message, 'the reporter observation remains exactly what they supplied');
});

test('a source URL owns one Workstream even when a browser generates a fresh request id', async () => {
  const message = 'Please handle the report at https://support.example.test/tickets/300 and explain the outcome.';
  const first = await createTeamWorkstream({ message, requestId: 'request-a', actor: 'alice' });
  const second = await createTeamWorkstream({ message, requestId: 'request-b', actor: 'alice' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.slug, first.slug);
  assert.doesNotMatch((await load(first.slug)).workstream.sourceKey ?? '', /support\.example/);
});

test('a teammate follow-up is an Observation, never Steering or authority', async () => {
  const created = await createTeamWorkstream({
    message: 'Investigate the empty amenities section.', requestId: 'follow-up-request', actor: 'alice',
  });
  const response = await fetch(`${base}/workstreams/${created.slug}/observations`, form({
    message: 'It reproduces only when the first carousel item is a video.',
  }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') ?? '', /added=1$/);

  const doc = await load(created.slug);
  assert.equal(doc.steering.length, 0);
  assert.equal(doc.spend.humanInterventions, 0);
  assert.equal(doc.observations.at(-1)!.summary, 'It reproduces only when the first carousel item is a video.');
  assert.ok(doc.wakes.at(-1)?.reason.includes('new observation'));

  for (const route of ['steer', 'approve', 'adopt']) {
    const denied = await fetch(`${base}/workstreams/${created.slug}/${route}`, form({ message: 'do it' }));
    assert.equal(denied.status, 404, `${route} must not be an operator-ui route`);
  }
});

test('authenticated browser mutations require a matching Origin before reading or storing input', async () => {
  await running!.close();
  running = await startOperatorUi({ token: 'shared-secret' });
  base = `http://127.0.0.1:${running.port}`;
  const authorization = `Basic ${Buffer.from('sales-alice:shared-secret').toString('base64')}`;
  const request = {
    message: 'Store this only for a same-origin request.',
    request_id: 'same-origin-boundary',
  };

  const unauthenticated = await fetch(`${base}/workstreams`, form(request, {
    origin: 'https://attacker.example',
  }));
  assert.equal(unauthenticated.status, 401, 'authentication runs before the origin gate');

  for (const [label, origin] of [
    ['cross-origin', 'https://attacker.example'],
    ['missing Origin', undefined],
    ['malformed Origin', 'not an origin'],
  ] as const) {
    const headers: Record<string, string> = { authorization };
    if (origin !== undefined) headers.origin = origin;
    const attempted = await fetch(`${base}/workstreams`, {
      ...form(request, headers),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
    });
    assert.equal(attempted.status, 403, `${label} must fail closed`);
    assert.deepEqual(await listWorkstreams(), [], `${label} must not mutate durable state`);
  }

  const accepted = await fetch(`${base}/workstreams`, form(request, {
    authorization,
    origin: base.replace(/^http:/, 'https:'),
  }));
  assert.equal(accepted.status, 303);
  const slug = slugFrom(accepted);
  assert.equal((await load(slug)).observations[0]!.source, 'operator-ui:sales-alice');

  const crossOriginFollowUp = await fetch(`${base}/workstreams/${slug}/observations`, form({
    message: 'This cross-site follow-up must not be recorded.',
  }, { authorization, origin: 'https://attacker.example' }));
  assert.equal(crossOriginFollowUp.status, 403);
  assert.equal((await load(slug)).observations.length, 1, 'cross-site follow-up must not mutate durable state');
});

test('board, new-work, and workspace pages are live typed views with secure headers', async () => {
  const created = await createTeamWorkstream({
    message: 'Find and fix the broken customer carousel.', requestId: 'render-request', actor: 'alice',
  });
  await arrive(created.slug, (doc, event) => {
    doc.decisions.push({
      id: newId('dec'), title: 'Repair the carousel producer', rationale: 'The durable evidence points to the producer.',
      madeBy: 'coordinator', status: 'standing', decidedAtVirtual: new Date().toISOString(),
    });
    doc.passes.push({
      id: 'pass_disposable',
      startedAt: new Date().toISOString(),
      baseRevision: doc.revision,
      wakeReasons: [],
      summary: 'DISPOSABLE_PASS_SUMMARY_MUST_NOT_RENDER',
      sessionId: 'DISPOSABLE_SESSION_MUST_NOT_RENDER',
      changes: [],
      outcome: 'completed',
    });
    event('decision.recorded', 'repair course recorded');
  });

  const board = await fetch(`${base}/board`);
  assert.equal(board.status, 200);
  assert.match(board.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
  assert.equal(board.headers.get('strict-transport-security'), 'max-age=31536000');
  const boardHtml = await board.text();
  assert.match(boardHtml, /New job/);
  assert.match(boardHtml, /Local fleet · this machine/);
  assert.match(boardHtml, /Find and fix the broken customer carousel/);

  const newWork = await fetch(`${base}/new`);
  assert.equal(newWork.status, 200);
  const newHtml = await newWork.text();
  assert.match(newHtml, /What needs doing\?/);
  assert.match(newHtml, /name="request_id"/);

  const workspace = await fetch(`${base}/workstreams/${created.slug}`);
  assert.equal(workspace.status, 200);
  const html = await workspace.text();
  assert.match(html, /Repair the carousel producer/);
  assert.match(html, /Add context or answer a question/);
  assert.match(html, /Recent updates/);
  assert.match(html, /Technical details and full history/);
  assert.doesNotMatch(html, /Work and deliverables|workspace-inspector|five-question-position/);
  assert.doesNotMatch(html, /WEAVER_SERVE_TOKEN|WEAVER_UI_TOKEN/);
  assert.doesNotMatch(html, /DISPOSABLE_PASS_SUMMARY|DISPOSABLE_SESSION/);

  const revision = await fetch(`${base}/api/workstreams/${created.slug}/revision`);
  assert.deepEqual(await revision.json(), { revision: String((await load(created.slug)).revision) });
});

test('the evidenced answer and integrity-checked artifacts are prominent and downloadable', async () => {
  const created = await createTeamWorkstream({
    message: 'Produce a verified answer.', requestId: 'answer-request', actor: 'alice',
  });
  const artifact = await writeArtifact(created.slug, 'answer.md', '# Answer\n\nThe mixed-media carousel now renders.');
  let deliverableId = '';
  await arrive(created.slug, (doc, event) => {
    deliverableId = newId('del');
    doc.deliverables.push({
      id: deliverableId,
      title: 'Verified customer answer',
      kind: 'report',
      path: artifact.relPath,
      contentHash: artifact.hash,
      createdAtVirtual: new Date().toISOString(),
      adopted: { contentHash: artifact.hash, passId: 'pass_test', atVirtual: new Date().toISOString() },
    });
    doc.workstream.status = 'done';
    doc.workstream.conclusion = {
      summary: 'The mixed-media carousel was repaired and verified.',
      evidenceIds: [deliverableId],
      atVirtual: new Date().toISOString(),
      passId: 'pass_test',
    };
    event('workstream.concluded', 'verified answer concluded', [deliverableId]);
  });

  const workspace = await fetch(`${base}/workstreams/${created.slug}`);
  const html = await workspace.text();
  assert.match(html, /The mixed-media carousel was repaired and verified/);
  assert.match(html, /Verified customer answer/);
  assert.match(html, new RegExp(`/workstreams/${created.slug}/artifacts/${deliverableId}`));

  const download = await fetch(`${base}/workstreams/${created.slug}/artifacts/${deliverableId}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(await download.text(), /mixed-media carousel now renders/);

  fs.writeFileSync(path.join(home, created.slug, 'artifacts', artifact.relPath), 'tampered');
  const tampered = await fetch(`${base}/workstreams/${created.slug}/artifacts/${deliverableId}`);
  assert.equal(tampered.status, 409);
});

test('one long attention item becomes one concise decision card instead of repeated status walls', async () => {
  const created = await createTeamWorkstream({
    message: 'Resolve the release blocker safely.', requestId: 'decision-card-request', actor: 'alice',
  });
  const summary = [
    'DECISION NEEDED: Choose how this release should proceed.',
    'Reply with one of:',
    '(A) Continue on the existing test evidence.',
    '(B) Ask a named reviewer to inspect it first.',
    '(C) Add the missing automated review and wait for it.',
    'WHY IT IS STUCK. This exact sentence belongs only in the collapsed full context.',
  ].join(' ');
  await arrive(created.slug, (doc, event) => {
    const now = new Date().toISOString();
    doc.attention.push({
      id: newId('att'), kind: 'blocker', summary, status: 'open', createdAt: now,
    });
    doc.wakes.push({
      id: newId('wake'), condition: { type: 'immediate' }, status: 'pending',
      reason: summary, createdAt: now,
    });
    doc.assignments.push({
      id: newId('asg'), objective: 'Fix the release blocker at its producer', briefing: 'Use deterministic evidence.',
      kind: 'work', acceptanceCriteria: ['The blocker is fixed'], dependsOn: [], state: 'completed',
      attempts: [{ runId: newId('run'), startedAt: now, endedAt: now }],
      submission: { summary: 'The producer now selects the correct route.' },
      adoption: { state: 'accepted', passId: 'pass_test', at: now }, createdAtVirtual: now,
    });
    event('attention.opened', 'release decision requested');
  });

  const workspace = await fetch(`${base}/workstreams/${created.slug}`);
  const html = await workspace.text();
  assert.equal((html.match(/data-testid="decision-needed"/g) ?? []).length, 1);
  assert.match(html, /Choose how this release should proceed/);
  assert.match(html, /data-testid="decision-choices"/);
  assert.match(html, />A<.*Continue on the existing test evidence/s);
  assert.match(html, />B<.*Ask a named reviewer/s);
  assert.match(html, />C<.*Add the missing automated review/s);
  assert.match(html, /Results.*Accepted work.*The producer now selects the correct route/s);
  assert.equal((html.match(/This exact sentence belongs only in the collapsed full context/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-testid="current-state"|five-question-position|workspace-inspector/);

  const board = await fetch(`${base}/board`);
  const boardHtml = await board.text();
  assert.match(boardHtml, /Needs you/);
  assert.match(boardHtml, /1 job/);
});

test('non-loopback binding requires Basic auth and attributes requests to its username', async () => {
  await assert.rejects(startOperatorUi({ host: '0.0.0.0' }), /WEAVER_UI_TOKEN is required/);
  await running!.close();
  running = await startOperatorUi({ token: 'shared-secret' });
  base = `http://127.0.0.1:${running.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200, 'the content-free infrastructure probe bypasses UI auth');
  assert.equal(health.headers.get('content-length'), '0');
  assert.equal(await health.text(), '', 'health must never disclose fleet facts');
  assert.equal((await fetch(`${base}/board`)).status, 401);
  const authorization = `Basic ${Buffer.from('sales-alice:shared-secret').toString('base64')}`;
  assert.equal((await fetch(`${base}/board`, { headers: { authorization } })).status, 200);
  const created = await fetch(`${base}/workstreams`, form({
    message: 'Please investigate this customer report.', request_id: 'authenticated-request',
  }, { authorization }));
  const doc = await load(slugFrom(created));
  assert.equal(doc.observations[0]!.source, 'operator-ui:sales-alice');
});

test('a shared-Postgres UI labels remote execution as normal deployment context', async () => {
  // Pin this test server to the already-selected temporary fs store, then
  // present the deployment shape to the view logic. Runner heartbeat is a
  // machine-local fact even though Workstream state is shared in Postgres.
  await listWorkstreams();
  const previous = process.env.WEAVER_STORE;
  process.env.WEAVER_STORE = 'postgres://shared.example.test/weaver';
  try {
    const response = await fetch(`${base}/board`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Shared fleet · execution on another host/);
    assert.match(html, /Shared fleet is connected/);
    assert.match(html, /Runner activity happens on another host and is not measured by this page/);
    assert.doesNotMatch(html, /Runner is offline/);
  } finally {
    if (previous === undefined) delete process.env.WEAVER_STORE;
    else process.env.WEAVER_STORE = previous;
  }
});

test('a directly opened older completed job stays visible above the folded sidebar history', async () => {
  const slugs: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    const created = await createTeamWorkstream({
      message: `Complete archived outcome ${index}.`, requestId: `done-sidebar-${index}`, actor: 'alice',
    });
    slugs.push(created.slug);
    await arrive(created.slug, (doc, event) => {
      const at = `2026-01-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`;
      doc.workstream.status = 'done';
      doc.workstream.conclusion = { summary: `Archived outcome ${index} completed.`, evidenceIds: [], atVirtual: at, passId: `pass_done_${index}` };
      event('workstream.concluded', `archived outcome ${index} concluded`);
    });
  }

  const response = await fetch(`${base}/workstreams/${slugs[0]}`);
  const html = await response.text();
  const selected = html.indexOf(`data-testid="workstream-sidebar-item-${slugs[0]}"`);
  const folded = html.indexOf('<details class="mt-1 rounded-lg border border-zinc-900', selected);
  assert.ok(selected >= 0, 'the selected completed job is rendered');
  assert.ok(folded > selected, 'the selected job is visible before the folded older list');
});

test('intake with a parent creates under it through the shared path, and a bad parent is a clean error', async () => {
  // A parent to create under (created through the same model-independent intake).
  await createTeamWorkstream({ message: 'Own the migration program end to end', requestId: 'parent-1', actor: 'alice' });
  const all = await listWorkstreams();
  assert.equal(all.length, 1);
  const parent = all[0]!;

  const child = await createTeamWorkstream({
    message: 'Ship the account-settings migration safely',
    requestId: 'child-1',
    actor: 'bob',
    under: parent,
  });
  const doc = await load(child.slug);
  assert.equal(doc.workstream.managedBy?.slug, parent);
  assert.ok(doc.wakes.some((w) => w.status === 'pending'), 'child got its first wake exactly from the shared managed path');

  // Idempotent retry resolves to the same stream, still under the parent.
  const retry = await createTeamWorkstream({
    message: 'Ship the account-settings migration safely',
    requestId: 'child-1',
    actor: 'bob',
    under: parent,
  });
  assert.equal(retry.slug, child.slug);
  assert.equal(retry.created, false);

  // A parent that does not exist is a clean intake error, not a stack trace.
  await assert.rejects(
    createTeamWorkstream({ message: 'Another outcome entirely', requestId: 'child-2', actor: 'bob', under: 'no-such-parent' }),
    /no workstream 'no-such-parent'/,
  );
});

test('the live view renders composition relationships, parent selection, and assignment detail', async () => {
  const parent = await createTeamWorkstream({
    message: 'Own the payments program end to end', requestId: 'rel-parent', actor: 'alice',
  });
  const child = await createTeamWorkstream({
    message: 'Ship the refunds migration safely', requestId: 'rel-child', actor: 'alice',
    under: parent.slug,
  });
  // A real assignment on the child, with acceptance criteria and an attempt.
  await arrive(child.slug, (doc, event) => {
    doc.assignments.push({
      id: 'asg_rel_1', objective: 'Implement the refunds table migration',
      briefing: 'brief', kind: 'work',
      acceptanceCriteria: ['zero-downtime cutover', 'rollback tested'],
      dependsOn: [], state: 'queued',
      attempts: [{ runId: 'run_rel_1', startedAt: new Date().toISOString() }],
      adoption: { state: 'none' }, createdAtVirtual: new Date().toISOString(),
    });
    event('assignment.created', 'queued refunds migration work');
  });

  const workspace = await fetch(`${base}/workstreams/${child.slug}`);
  const childHtml = await workspace.text();
  assert.match(childHtml, /workspace-managed-by/);
  assert.match(childHtml, new RegExp(`part of.*${parent.slug}`));
  assert.match(childHtml, /zero-downtime cutover/);
  assert.match(childHtml, /1 disposable attempt/);

  const parentPage = await fetch(`${base}/workstreams/${parent.slug}`);
  const parentHtml = await parentPage.text();
  assert.match(parentHtml, new RegExp(`workspace-manages-${child.slug}`));

  const board = await fetch(`${base}/board`);
  const boardHtml = await board.text();
  assert.match(boardHtml, new RegExp(`under ${parent.slug}`));

  const newWork = await fetch(`${base}/new`);
  const newHtml = await newWork.text();
  assert.match(newHtml, /new-work-under/);
  assert.match(newHtml, new RegExp(`${parent.slug} — `));
});
