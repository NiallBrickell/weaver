/**
 * The operator workspace is an adapter contract: intake survives without a
 * model, teammate follow-ups remain Observations, rendered pages expose typed
 * truth, and no authority route exists.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createTeamWorkstream,
  createFleetAttentionSteward,
  currentFleetRevision,
  FLEET_ATTENTION_STEWARD_SOURCE_KEY,
  startOperatorUi,
  type RunningOperatorUi,
} from './operatorUi.js';
import type { ClerkOperatorAuthenticator } from './clerkOperatorAuth.js';
import { arrive, createWorkstream, heartbeatRunner, listWorkstreams, load, newId, writeArtifact } from './store.js';

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

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  assert.ok(match, `expected hidden field ${name}`);
  return match[1]!;
}

function rawFormPost(url: string, fields: Record<string, string>, headers: Record<string, string>): Promise<number> {
  const target = new URL(url);
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
        ...headers,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end(body);
  });
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

test('intake host placement is durable before the initial wake can be claimed', async () => {
  const created = await createTeamWorkstream({
    message: 'Scope the product Studio from the current thesis.',
    done: 'A concise evidenced scope is accepted.',
    requestId: 'remote-scope-request',
    actor: 'niall',
    runnerId: 'weaver-fleet',
  });

  const doc = await load(created.slug);
  assert.equal(doc.workstream.assignmentRunnerId, 'weaver-fleet');
  assert.deepEqual(doc.workstream.executionPolicy?.coordinatorRunnerOrder, ['weaver-fleet']);
  assert.ok(doc.wakes.some((wake) => wake.status === 'pending' && wake.condition.type === 'immediate'));
  assert.equal(doc.assignments.length, 0, 'placement is part of creation, not a later assignment repair');
});

test('intake refuses an invalid host before creating durable state', async () => {
  await assert.rejects(
    () => createTeamWorkstream({
      message: 'Do not create this.',
      requestId: 'invalid-host-request',
      actor: 'niall',
      runnerId: 'not a host',
    }),
    /runner id must be 1-128 characters matching/,
  );
  assert.deepEqual(await listWorkstreams(), []);
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

  const browserFormStatus = await rawFormPost(`${base}/workstreams`, {
    message: 'A native same-origin form navigation may omit Origin.',
    request_id: 'fetch-metadata-boundary',
  }, {
    authorization,
    origin: 'null',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  });
  assert.equal(browserFormStatus, 303, 'browser-controlled same-origin navigation metadata is accepted');

  const crossSiteMetadataStatus = await rawFormPost(`${base}/workstreams`, {
    message: 'Cross-site fetch metadata must not pass.',
    request_id: 'cross-site-fetch-metadata',
  }, {
    authorization,
    origin: 'null',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  });
  assert.equal(crossSiteMetadataStatus, 403);

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
  assert.match(boardHtml, /Local fleet/);
  assert.match(boardHtml, /Find and fix the broken customer carousel/);

  const newWork = await fetch(`${base}/new`);
  assert.equal(newWork.status, 200);
  const newHtml = await newWork.text();
  assert.match(newHtml, /What needs doing\?/);
  assert.match(newHtml, /name="request_id"/);
  assert.match(newHtml, /Automatic \(default\) — any capable live host/);
  assert.match(newHtml, /name="runner_id"/);

  const workspace = await fetch(`${base}/workstreams/${created.slug}`);
  assert.equal(workspace.status, 200);
  const html = await workspace.text();
  assert.match(html, /Repair the carousel producer/);
  assert.match(html, /data-testid="workspace-tabs"/);
  assert.match(html, /data-testid="workspace-tab-overview"[^>]*aria-current="page"/);
  assert.match(html, /data-testid="workspace-overview"/);
  assert.doesNotMatch(html, /data-testid="workspace-work"|data-testid="workspace-activity"|data-testid="job-details"/);
  assert.doesNotMatch(html, /Work and deliverables|workspace-inspector|five-question-position/);
  assert.doesNotMatch(html, /WEAVER_SERVE_TOKEN|WEAVER_UI_TOKEN/);
  assert.doesNotMatch(html, /DISPOSABLE_PASS_SUMMARY|DISPOSABLE_SESSION/);

  const activityHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=activity`)).text();
  assert.match(activityHtml, /data-testid="workspace-tab-activity"[^>]*aria-current="page"/);
  assert.match(activityHtml, /Add context or answer a question/);
  assert.match(activityHtml, /Recent updates/);
  assert.doesNotMatch(activityHtml, /data-testid="workspace-overview"|data-testid="workspace-work"|data-testid="job-details"/);

  const detailsHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=details`)).text();
  assert.match(detailsHtml, /data-testid="workspace-tab-details"[^>]*aria-current="page"/);
  assert.match(detailsHtml, /Technical details/);
  assert.doesNotMatch(detailsHtml, /data-testid="workspace-overview"|data-testid="workspace-work"|data-testid="workspace-activity"/);

  const unknownHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=unknown`)).text();
  assert.match(unknownHtml, /data-testid="workspace-tab-overview"[^>]*aria-current="page"/);

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

  const workspace = await fetch(`${base}/workstreams/${created.slug}?tab=work`);
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
      submission: { summary: 'The producer now selects the correct route. Rebased head, ancestry proof, full suite output, and remote-ref details stay available for agents.' },
      adoption: { state: 'accepted', passId: 'pass_test', at: now }, createdAtVirtual: now,
    });
    event('attention.opened', 'release decision requested');
  });

  const workspace = await fetch(`${base}/workstreams/${created.slug}`);
  const html = await workspace.text();
  assert.equal((html.match(/data-testid="decision-needed"/g) ?? []).length, 1);
  assert.match(html, /Choose how this release should proceed/);
  assert.match(html, /data-testid="decision-choices"/);
  assert.match(html, /type="radio"[^>]*name="choice"[^>]*value="A"/);
  assert.match(html, /type="radio"[^>]*name="choice"[^>]*value="custom"/);
  assert.match(html, /data-testid="decision-note"/);
  assert.match(html, />A<.*Continue on the existing test evidence/s);
  assert.match(html, />B<.*Ask a named reviewer/s);
  assert.match(html, />C<.*Add the missing automated review/s);
  assert.doesNotMatch(html, /data-testid="workspace-work"|data-testid="workspace-activity"|data-testid="job-details"/);
  assert.equal((html.match(/This exact sentence belongs only in the collapsed full context/g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-testid="current-state"|five-question-position|workspace-inspector/);

  const workHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=work`)).text();
  assert.match(workHtml, /Results.*Accepted work.*The producer now selects the correct route/s);
  assert.match(workHtml, /data-testid="human-result-summary"[^>]*>The producer now selects the correct route\.<\/p>/);
  assert.match(workHtml, /Full technical result/);
  assert.equal((workHtml.match(/Rebased head, ancestry proof/g) ?? []).length, 1, 'technical prose renders only inside its disclosure');

  const board = await fetch(`${base}/board`);
  const boardHtml = await board.text();
  assert.match(boardHtml, /Needs you/);
  assert.match(boardHtml, /1 job/);
});

test('a decision question and options wrap in full instead of losing deciding clauses to ellipses', async () => {
  const created = await createTeamWorkstream({
    message: 'Choose the release course safely.', requestId: 'complete-decision-copy', actor: 'alice',
  });
  const question = 'The change is ready on every measurable condition except the repository does not run its own automated reviewer, so waiting cannot produce the missing check and the release will remain blocked until a person chooses how that structural exception should be handled.';
  const optionA = 'Proceed on the exact green test evidence already recorded at the current head, while preserving the existing authority gate and requiring the normal provider readback after the merge so the exception applies only to this repository and only to this revision.';
  const optionB = 'Ask a named reviewer to inspect the current head first. Preserve their exact scope note as a condition before proceeding.';
  await arrive(created.slug, (doc, event) => {
    doc.attention.push({
      id: 'att_complete_copy',
      kind: 'blocker',
      summary: `DECISION NEEDED: ${question} (A) ${optionA} (B) ${optionB} DIAGNOSTIC DETAIL. This remains available only in full context.`,
      status: 'open',
      createdAt: new Date().toISOString(),
    });
    event('attention.opened', 'complete decision copy requested');
  });

  const html = await (await fetch(`${base}/workstreams/${created.slug}`)).text();
  assert.match(html, new RegExp(`data-testid="decision-question"[^>]*>${question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`));
  assert.match(html, new RegExp(optionA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(optionB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const renderedQuestion = html.match(/data-testid="decision-question"[^>]*>(.*?)<\/h[1-6]>/)?.[1] ?? '';
  assert.doesNotMatch(renderedQuestion, /…/);
  assert.doesNotMatch(html.slice(html.indexOf(optionA), html.indexOf(optionA) + optionA.length + 1), /…/);
  assert.equal((html.match(/This remains available only in full context/g) ?? []).length, 1);
});

test('fleet page groups one unavailable approval service and can start a constrained steward', async () => {
  for (const [index, requestId] of ['fleet-incident-a', 'fleet-incident-b'].entries()) {
    const created = await createTeamWorkstream({
      message: `Own fleet outcome ${index}.`, requestId, actor: 'alice',
    });
    await arrive(created.slug, (doc, event) => {
      const assignmentId = `asg_pilot_${index}`;
      doc.assignments.push({
        id: assignmentId,
        objective: `Perform gated action ${index}`,
        briefing: 'Use the ordinary action lifecycle.',
        kind: 'action',
        exec: {
          cwd: home,
          verify: 'true',
          ask: `Approve action ${index}?`,
          approvalMode: 'pilot-or-human',
          pilotUnavailableSince: `2026-08-26T0${index}:00:00.000Z`,
        },
        acceptanceCriteria: ['The verified effect is recorded'],
        dependsOn: [],
        state: 'gated',
        attempts: [],
        adoption: { state: 'none' },
        createdAtVirtual: new Date().toISOString(),
      });
      doc.attention.push({
        id: `att_pilot_${index}`,
        kind: 'approval',
        refId: assignmentId,
        summary: 'Legacy per-action timeout card from the unavailable approval service.',
        status: 'open',
        createdAt: new Date().toISOString(),
      });
      event('action.pilot_unavailable', `${assignmentId} remains gated`);
    });
  }

  const boardHtml = await (await fetch(`${base}/board`)).text();
  assert.doesNotMatch(boardHtml, /2 separate asks|Legacy per-action timeout card/);
  const response = await fetch(`${base}/fleet`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-testid="operator-fleet-page"/);
  assert.match(html, /data-testid="fleet-status-claims"/);
  assert.match(html, /2 gated actions across 2 jobs remain safe and waiting/);
  assert.equal((html.match(/data-testid="fleet-incident-approval-service-unavailable"/g) ?? []).length, 1);
  assert.match(html, /Agent execution.*Offline/s);
  assert.match(html, /href="\/fleet" aria-current="page"/);
  assert.doesNotMatch(html, /another host/);

  const enabled = await fetch(`${base}/fleet/attention-steward`, form({}));
  assert.equal(enabled.status, 303);
  assert.equal(enabled.headers.get('location'), '/fleet?steward=created');
  const steward = (await Promise.all((await listWorkstreams()).map((slug) => load(slug))))
    .find((doc) => doc.workstream.sourceKey === FLEET_ATTENTION_STEWARD_SOURCE_KEY);
  assert.ok(steward);
  assert.ok(steward.workstream.tags.includes('routine'));
  assert.match(steward.workstream.constraints.join('\n'), /Never approve or resolve a human-only action/);
  assert.match(steward.workstream.constraints.join('\n'), /Worker output is a proposal, never permission/);

  const retry = await fetch(`${base}/fleet/attention-steward`, form({}));
  assert.equal(retry.headers.get('location'), '/fleet?steward=existing');
  assert.equal((await Promise.all((await listWorkstreams()).map((slug) => load(slug))))
    .filter((doc) => doc.workstream.sourceKey === FLEET_ATTENTION_STEWARD_SOURCE_KEY).length, 1);
});

test('starting an existing built-in steward refreshes known legacy doctrine without overwriting later operator edits', async () => {
  const legacyObjective = [
    'Own a recurring fleet-wide operational triage loop. Each cycle, inspect the shared fleet\'s typed Workstream state — never transcripts — for approval-service incidents, capacity backoff, overdue wakes, dormant routines, missed deliverables, and results awaiting review.',
    'Group symptoms that share one dependency.',
  ].join('\n\n');
  await createWorkstream({
    slug: 'fleet-attention-steward', title: 'Fleet attention steward', objective: legacyObjective,
    sourceKey: FLEET_ATTENTION_STEWARD_SOURCE_KEY, tags: ['routine'],
    successCriteria: ['legacy criterion'], constraints: ['legacy constraint'],
    autonomy: { sendsRequireApproval: true },
  });

  const refreshed = await createFleetAttentionSteward('test');
  assert.equal(refreshed.created, false);
  const migrated = await load(refreshed.slug);
  assert.match(migrated.workstream.objective, /Unchanged counts are not evidence of health/);
  assert.ok(migrated.workstream.successCriteria.some((criterion) => /explicitly deferred/.test(criterion)));
  assert.ok(migrated.workstream.constraints.some((constraint) => /non-deferred operational item/.test(constraint)));

  await arrive(refreshed.slug, (doc) => { doc.workstream.objective = 'Operator-authored custom steward direction.'; });
  await createFleetAttentionSteward('test');
  assert.equal((await load(refreshed.slug)).workstream.objective, 'Operator-authored custom steward direction.');
});

test('fleet health reports dormant routines without waiting for a model-generated card', async () => {
  await createWorkstream({
    slug: 'dormant-routine', title: 'Dormant routine', objective: 'Run on a durable cadence.',
    tags: ['routine'], successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
  });

  const html = await (await fetch(`${base}/board`)).text();
  assert.match(html, /Fleet has stalled routines/);
  assert.match(html, /routine health gaps affect 1 outcome/);
});

test('fleet polling revision changes when observable runner state changes without a Workstream write', async () => {
  const before = await (await fetch(`${base}/api/fleet-revision`)).json() as { revision: string };
  const initialBoard = await (await fetch(`${base}/board`)).text();
  assert.match(initialBoard, new RegExp(`data-revision="${before.revision}"`), 'cheap and full paths use the identical hash shape');
  const lock = path.join(home, '.runner.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(home, '.runner.heartbeat'), 'alive');

  const after = await (await fetch(`${base}/api/fleet-revision`)).json() as { revision: string };
  assert.notEqual(after.revision, before.revision);
  const html = await (await fetch(`${base}/fleet`)).text();
  assert.match(html, /Agent execution[\s\S]*Running/);
});

test('fleet polling revision is computed from cheap heads without a document-load dependency', async () => {
  let headReads = 0;
  let presenceReads = 0;
  const heads = [
    { slug: 'beta', revision: 8 },
    { slug: 'alpha', revision: 3 },
  ];
  const first = await currentFleetRevision(
    async () => { headReads++; return heads; },
    async () => { presenceReads++; return []; },
  );
  const reordered = await currentFleetRevision(
    async () => [...heads].reverse(),
    async () => [],
  );
  const changed = await currentFleetRevision(
    async () => heads.map((head) => head.slug === 'alpha' ? { ...head, revision: 4 } : head),
    async () => [],
  );

  assert.equal(first, reordered, 'head ordering does not create a false board refresh');
  assert.notEqual(first, changed, 'a durable revision change invalidates the poll hash');
  assert.equal(headReads, 1);
  assert.equal(presenceReads, 1);
});

test('decision responses accept an option with a condition or a custom answer without granting authority', async () => {
  const created = await createTeamWorkstream({
    message: 'Resolve the release choice.', requestId: 'response-request', actor: 'alice',
  });
  const summary = 'DECISION NEEDED: Choose the release course. (A) Continue on green tests. (B) Ask for another review.';
  await arrive(created.slug, (doc, event) => {
    doc.attention.push({ id: 'att_response', kind: 'blocker', summary, status: 'open', createdAt: new Date().toISOString() });
    event('attention.opened', 'release choice requested');
  });

  const html = await (await fetch(`${base}/workstreams/${created.slug}`)).text();
  const fields = {
    need_source_type: hiddenValue(html, 'need_source_type'),
    need_id: hiddenValue(html, 'need_id'),
    need_version: hiddenValue(html, 'need_version'),
    response_id: hiddenValue(html, 'response_id'),
    choice: 'A',
    note: 'Yes, but only after the smoke test passes.',
  };
  const [first, retry] = await Promise.all([
    fetch(`${base}/workstreams/${created.slug}/responses`, form(fields)),
    fetch(`${base}/workstreams/${created.slug}/responses`, form(fields)),
  ]);
  assert.equal(first.status, 303);
  assert.equal(retry.status, 303);
  assert.match(first.headers.get('location') ?? '', /tab=overview&responded=1$/);

  let doc = await load(created.slug);
  const responses = doc.observations.filter((observation) => observation.source.startsWith('operator-ui-response:'));
  assert.equal(responses.length, 1, 'an exact simultaneous form retry is one durable response');
  assert.equal(responses[0]!.summary, [
    'Response to blocker request: A — Continue on green tests.',
    'Condition or note: Yes, but only after the smoke test passes.',
  ].join('\n'));
  assert.equal(doc.wakes.filter((wake) => wake.reason.includes('operator-ui-response')).length, 1);
  assert.equal(doc.steering.length, 0);
  assert.equal(doc.spend.humanInterventions, 0);
  assert.equal(doc.attention[0]!.status, 'open', 'a response wakes reconciliation; it does not resolve attention itself');

  const refreshed = await (await fetch(`${base}/workstreams/${created.slug}`)).text();
  const custom = await fetch(`${base}/workstreams/${created.slug}/responses`, form({
    need_source_type: hiddenValue(refreshed, 'need_source_type'),
    need_id: hiddenValue(refreshed, 'need_id'),
    need_version: hiddenValue(refreshed, 'need_version'),
    response_id: hiddenValue(refreshed, 'response_id'),
    choice: 'custom',
    custom: 'Continue after the database owner confirms the backup.',
  }));
  assert.equal(custom.status, 303);
  doc = await load(created.slug);
  assert.match(doc.observations.at(-1)!.summary, /Other — Continue after the database owner confirms the backup/);
  assert.equal(doc.steering.length, 0);
});

test('decision response validation rejects tampered choices and stale needs without mutation', async () => {
  const created = await createTeamWorkstream({
    message: 'Choose a safe release route.', requestId: 'stale-response-request', actor: 'alice',
  });
  await arrive(created.slug, (doc, event) => {
    doc.attention.push({
      id: 'att_stale', kind: 'blocker', status: 'open', createdAt: new Date().toISOString(),
      summary: 'DECISION NEEDED: Choose now. (A) Wait for CI. (B) Stop the release.',
    });
    event('attention.opened', 'choice requested');
  });
  const html = await (await fetch(`${base}/workstreams/${created.slug}`)).text();
  const baseFields = {
    need_source_type: hiddenValue(html, 'need_source_type'),
    need_id: hiddenValue(html, 'need_id'),
    need_version: hiddenValue(html, 'need_version'),
    response_id: hiddenValue(html, 'response_id'),
  };
  const before = (await load(created.slug)).observations.length;
  const tampered = await fetch(`${base}/workstreams/${created.slug}/responses`, form({ ...baseFields, choice: 'Z' }));
  assert.equal(tampered.status, 400);
  assert.equal((await load(created.slug)).observations.length, before);

  await arrive(created.slug, (doc, event) => {
    doc.attention[0]!.summary = 'DECISION NEEDED: The available course changed. (A) Wait for the new evidence.';
    event('attention.updated', 'choice changed');
  });
  const stale = await fetch(`${base}/workstreams/${created.slug}/responses`, form({ ...baseFields, choice: 'A' }));
  assert.equal(stale.status, 409);
  assert.equal((await load(created.slug)).observations.length, before);

  const crossOrigin = await fetch(`${base}/workstreams/${created.slug}/responses`, form(
    { ...baseFields, choice: 'A' },
    { origin: 'https://attacker.example.test' },
  ));
  assert.equal(crossOrigin.status, 403);
  assert.equal((await load(created.slug)).observations.length, before);
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

test('Clerk mode replaces the browser password and keeps identity, domain denial, redirects, and writes server-enforced', async () => {
  await running!.close();
  let authCalls = 0;
  const responseHeaders = () => {
    const headers = new Headers();
    headers.append('set-cookie', '__session=one; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', '__client=two; Path=/; Secure; HttpOnly');
    return headers;
  };
  const clerk: ClerkOperatorAuthenticator = {
    publicOrigin: 'https://workspace.example',
    browser: {
      publishableKey: 'pk_test_browser-safe',
      frontendOrigin: 'https://example.clerk.accounts.dev',
      scriptUrl: 'https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js',
      uiScriptUrl: 'https://example.clerk.accounts.dev/npm/@clerk/ui@1/dist/ui.browser.js',
    },
    async authenticate(req) {
      authCalls += 1;
      const mode = req.headers['x-test-clerk'];
      if (mode === 'allowed') return { kind: 'authenticated', actor: 'sales@company.example', headers: responseHeaders() };
      if (mode === 'forbidden') return { kind: 'forbidden', headers: new Headers() };
      if (mode === 'unavailable') throw new Error('provider detail containing secret-value-must-not-escape');
      if (mode === 'handshake') {
        const headers = responseHeaders();
        headers.set('location', 'https://example.clerk.accounts.dev/handshake');
        headers.set('cache-control', 'private, no-store');
        return { kind: 'redirect', location: headers.get('location')!, headers };
      }
      return { kind: 'signed-out', headers: new Headers() };
    },
  };
  running = await startOperatorUi({ token: 'stale-basic-token', clerk });
  base = `http://127.0.0.1:${running.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(authCalls, 0, 'the content-free health probe never invokes Clerk');
  assert.doesNotMatch(health.headers.get('content-security-policy') ?? '', /clerk\.accounts/);

  const signedOut = await fetch(`${base}/board`, { redirect: 'manual' });
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.headers.get('location'), '/sign-in?return_to=%2Fboard');
  assert.equal((await fetch(`${base}/api/fleet-revision`)).status, 401, 'an API caller gets a status, not sign-in HTML');

  for (const unsafe of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/%5c%5cevil.example/steal',
    '/sign-in/..//evil.example/steal',
  ]) {
    const page = await fetch(`${base}/sign-in?return_to=${encodeURIComponent(unsafe)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, /evil\.example/);
    assert.match(html, /forceRedirectUrl: "\/board"/);
    assert.doesNotMatch(html, /secret-value-must-not-escape/);
  }
  const signIn = await fetch(`${base}/sign-in?return_to=%2Fnew`);
  const signInHtml = await signIn.text();
  assert.match(signInHtml, /data-clerk-publishable-key="pk_test_browser-safe"/);
  assert.match(signInHtml, /data-testid="clerk-sign-in-shell"/);
  assert.match(signInHtml, /maxWidth: '24rem'/);
  assert.match(signInHtml, /title: 'Sign in to Weaver'/);
  assert.match(signInHtml, /subtitle: 'Use your company account to continue'/);
  assert.doesNotMatch(signInHtml, /<h1[^>]*>Sign in<\/h1>/);
  assert.doesNotMatch(signInHtml, /Use your company account to open the shared workspace/);
  assert.match(signInHtml, /\.max-w-sm\{max-width:var\(--container-sm\)\}/);
  assert.match(signInHtml, /\.p-6\{padding:calc\(var\(--spacing\) \* 6\)\}/);
  const csp = signIn.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src[^;]*https:\/\/example\.clerk\.accounts\.dev/);
  assert.match(csp, /connect-src[^;]*https:\/\/example\.clerk\.accounts\.dev/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /frame-ancestors 'none'/);

  const deniedRedirect = await fetch(`${base}/board`, {
    headers: { 'x-test-clerk': 'forbidden' }, redirect: 'manual',
  });
  assert.equal(deniedRedirect.status, 303);
  assert.equal(deniedRedirect.headers.get('location'), '/access-denied');
  const denied = await fetch(`${base}/access-denied`, { headers: { 'x-test-clerk': 'forbidden' } });
  assert.equal(denied.status, 403);
  const deniedHtml = await denied.text();
  assert.match(deniedHtml, /Sign out and switch account/);
  assert.doesNotMatch(deniedHtml, /company\.example/);

  const unavailable = await fetch(`${base}/board`, { headers: { 'x-test-clerk': 'unavailable' } });
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), 'Authentication is temporarily unavailable. Please try again.');

  const allowed = await fetch(`${base}/board`, { headers: { 'x-test-clerk': 'allowed' } });
  assert.equal(allowed.status, 200, 'a stale Basic token cannot replace or bypass Clerk');
  assert.doesNotMatch(allowed.headers.get('content-security-policy') ?? '', /clerk\.accounts/, 'ordinary pages do not admit Clerk scripts');
  assert.deepEqual(allowed.headers.getSetCookie(), [
    '__session=one; Path=/; Secure; HttpOnly',
    '__client=two; Path=/; Secure; HttpOnly',
  ]);
  const allowedHtml = await allowed.text();
  assert.match(allowedHtml, /sales@company\.example/);
  assert.match(allowedHtml, /<form[^>]*action="\/sign-out"[^>]*method="post"|<form[^>]*method="post"[^>]*action="\/sign-out"/);
  assert.equal((await fetch(`${base}/board`, {
    headers: { authorization: `Basic ${Buffer.from('attacker:stale-basic-token').toString('base64')}` },
    redirect: 'manual',
  })).status, 303, 'Basic credentials are ignored entirely in Clerk mode');

  const downgrade = await fetch(`${base}/workstreams`, form({
    message: 'This plaintext-origin request must not mutate state.', request_id: 'clerk-http-downgrade',
  }, { 'x-test-clerk': 'allowed', origin: 'http://workspace.example' }));
  assert.equal(downgrade.status, 403);
  assert.deepEqual(await listWorkstreams(), [], 'an HTTP same-host origin cannot use an HTTPS Clerk session');

  const created = await fetch(`${base}/workstreams`, form({
    message: 'Investigate this authenticated team request.', request_id: 'clerk-actor-request',
  }, { 'x-test-clerk': 'allowed', origin: 'https://workspace.example' }));
  assert.equal(created.status, 303);
  assert.equal((await load(slugFrom(created))).observations[0]!.source, 'operator-ui:sales@company.example');

  const crossSiteSignOut = await fetch(`${base}/sign-out`, form({}, {
    'x-test-clerk': 'allowed', origin: 'https://attacker.example',
  }));
  assert.equal(crossSiteSignOut.status, 403, 'sign-out is not a cross-site GET side effect');
  const signOut = await fetch(`${base}/sign-out`, form({}, {
    'x-test-clerk': 'allowed', origin: 'https://workspace.example',
  }));
  assert.equal(signOut.status, 200);
  assert.match(await signOut.text(), /window\.Clerk\.signOut/);

  const handshake = await fetch(`${base}/board`, {
    headers: { 'x-test-clerk': 'handshake' }, redirect: 'manual',
  });
  assert.equal(handshake.status, 307);
  assert.equal(handshake.headers.get('location'), 'https://example.clerk.accounts.dev/handshake');
  assert.deepEqual(handshake.headers.getSetCookie(), [
    '__session=one; Path=/; Secure; HttpOnly',
    '__client=two; Path=/; Secure; HttpOnly',
  ]);

  const alreadySignedIn = await fetch(`${base}/sign-in?return_to=%2Fnew`, {
    headers: { 'x-test-clerk': 'allowed' }, redirect: 'manual',
  });
  assert.equal(alreadySignedIn.status, 303);
  assert.equal(alreadySignedIn.headers.get('location'), '/new');
});

test('a shared-Postgres UI reports execution only from fresh shared runner presence', async () => {
  // Pin this test server to the already-selected temporary fs store, then
  // present the deployment shape to the view logic. Runner heartbeat is a
  // machine-local fact even though Workstream state is shared in Postgres.
  await listWorkstreams();
  await heartbeatRunner('gcp-standby');
  const previous = process.env.WEAVER_STORE;
  process.env.WEAVER_STORE = 'postgres://shared.example.test/weaver';
  try {
    const response = await fetch(`${base}/board`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Shared fleet/);
    assert.match(html, /Weaver is running/);
    assert.match(html, /Fresh shared runner heartbeat: gcp-standby/);
    const fleet = await (await fetch(`${base}/fleet`)).text();
    assert.match(fleet, /Shared team database · Connected/);
    assert.match(fleet, /Running · gcp-standby/);
    assert.match(fleet, /Shared TTL heartbeats prove/);
    assert.doesNotMatch(html, /Runner is offline/);
    const intake = await (await fetch(`${base}/new`)).text();
    assert.match(intake, /<option value="gcp-standby">gcp-standby<\/option>/);
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

  const workspace = await fetch(`${base}/workstreams/${child.slug}?tab=details`);
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
