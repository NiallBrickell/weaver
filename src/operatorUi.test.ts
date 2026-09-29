/**
 * The operator workspace is an adapter contract: intake survives without a
 * model, teammate follow-ups remain Observations, rendered pages expose typed
 * truth, and no authority route exists — the one human act is a stop (close
 * as not worth doing), which narrows and can never deliver, approve, or send.
 */

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  createTeamWorkstream,
  createFleetAttentionSteward,
  currentFleetRevision,
  FLEET_ATTENTION_STEWARD_SOURCE_KEY,
  startOperatorUi,
  type RunningOperatorUi,
} from './operatorUi.js';
import type { ClerkOperatorAuthenticator } from './clerkOperatorAuth.js';
import { arrive, createWorkstream, heartbeatRunner, listWorkstreams, load, newId, writeArtifact, type RunnerOutput } from './store.js';
import { OPERATOR_SCRIPT } from './ui/operator/render.js';
import { recordCapacityBackoff } from './capacity.js';
import { viewOf } from './watch.js';
import { snapshot as terminalSnapshot } from './tui.js';

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

interface SseTestReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

async function nextSseRevision(stream: SseTestReader): Promise<string> {
  while (true) {
    const boundary = stream.buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const event = stream.buffer.slice(0, boundary);
      stream.buffer = stream.buffer.slice(boundary + 2);
      const data = event.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const parsed = JSON.parse(data.slice('data: '.length)) as { revision?: unknown };
      assert.equal(typeof parsed.revision, 'string');
      return parsed.revision as string;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      stream.reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for a live revision event')), 5_000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    assert.equal(read.done, false, 'the live revision stream remains open');
    stream.buffer += new TextDecoder().decode(read.value, { stream: true });
  }
}

test('the client swaps a fresh coherent snapshot in place when a live revision arrives', async () => {
  class FakeElement {
    dataset: Record<string, string> = {};
    hidden = true;
    scrollTop = 0;
    replacedWith: FakeElement | undefined;

    querySelectorAll(): FakeElement[] { return []; }
    querySelector(): FakeElement | null { return null; }
    addEventListener(): void {}
    contains(): boolean { return true; }
    replaceWith(next: FakeElement): void { this.replacedWith = next; }
  }

  class FakeEventSource {
    static instance: FakeEventSource | undefined;
    readonly listeners = new Map<string, (event: { data: string }) => void>();

    constructor(readonly url: string) { FakeEventSource.instance = this; }
    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      this.listeners.set(type, listener);
    }
  }

  const currentRoot = new FakeElement();
  currentRoot.dataset = {
    revision: 'revision-before',
    revisionEndpoint: '/api/fleet-revision',
    revisionEventsEndpoint: '/api/fleet-events',
  };
  const nextRoot = new FakeElement();
  nextRoot.dataset = { ...currentRoot.dataset, revision: 'revision-after' };
  class FakeAnchor extends FakeElement {
    constructor(readonly href: string) { super(); }
  }
  class FakeTarget {
    constructor(readonly anchor: FakeAnchor | null) {}
    closest(): FakeAnchor | null { return this.anchor; }
  }
  const documentListeners = new Map<string, (event: unknown) => void>();
  const fakeDocument = {
    title: 'Before',
    hidden: false,
    activeElement: { matches: () => true },
    querySelector: () => currentRoot,
    addEventListener: (type: string, listener: (event: unknown) => void) => { documentListeners.set(type, listener); },
  };
  const replaced: string[] = [];
  const fetched: string[] = [];
  const fakeWindow = {
    EventSource: FakeEventSource,
    location: { href: 'http://workspace.test/overview', origin: 'http://workspace.test', pathname: '/overview', search: '', assign: () => { throw new Error('an in-place tab must not navigate'); } },
    history: { replaceState: (_state: unknown, _title: string, href: string) => { replaced.push(href); } },
    scrollY: 0,
    scrollTo: () => {},
    setTimeout,
    clearTimeout,
  };
  runInNewContext(OPERATOR_SCRIPT, {
    window: fakeWindow,
    document: fakeDocument,
    EventSource: FakeEventSource,
    HTMLElement: FakeElement,
    HTMLAnchorElement: FakeAnchor,
    Element: FakeTarget,
    URL,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    DOMParser: class {
      parseFromString(): { title: string; querySelector(): FakeElement } {
        return { title: 'After', querySelector: () => nextRoot };
      }
    },
    fetch: async (href: string) => { fetched.push(href); return { ok: true, text: async () => '<html></html>' }; },
    AbortController,
    JSON,
  });

  assert.equal(FakeEventSource.instance?.url, '/api/fleet-events');
  FakeEventSource.instance?.listeners.get('message')?.({ data: JSON.stringify({ revision: 'revision-after' }) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(currentRoot.replacedWith, nextRoot);
  assert.equal(fakeDocument.title, 'After');

  // A tab marked data-inplace swaps the page without navigating: the address
  // changes (so the live refresh renders the same tab) and nothing reloads.
  let prevented = false;
  documentListeners.get('click')?.({
    defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    target: new FakeTarget(new FakeAnchor('http://workspace.test/overview?example=investigated')),
    preventDefault: () => { prevented = true; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.deepEqual(replaced, ['/overview?example=investigated']);
  assert.equal(fetched.at(-1), '/overview?example=investigated');
});

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

test('a teammate can close a job as not worth doing — revision-checked, attributed, and never delivery', async () => {
  const created = await createTeamWorkstream({
    message: 'Rewrite the cache layer.', requestId: 'close-request', actor: 'alice',
  });
  const page = await fetch(`${base}/workstreams/${created.slug}?tab=activity`);
  const html = await page.text();
  assert.match(html, /data-testid="close-form"/);
  const revision = hiddenValue(html, 'revision');

  // A stale page cannot close: an arrival since it rendered moves the revision.
  await arrive(created.slug, (doc) => { doc.workstream.tags.push('arrived-later'); });
  const stale = await fetch(`${base}/workstreams/${created.slug}/close`, form({ reason: 'not worth it', revision }));
  assert.equal(stale.status, 409);
  assert.equal((await load(created.slug)).workstream.status, 'active');

  const missing = await fetch(`${base}/workstreams/${created.slug}/close`, form({ reason: ' ', revision: String((await load(created.slug)).revision) }));
  assert.equal(missing.status, 400);

  const current = (await load(created.slug)).revision;
  const closed = await fetch(`${base}/workstreams/${created.slug}/close`, form({ reason: 'the measured gain is 3ms', revision: String(current) }));
  assert.equal(closed.status, 303);
  assert.match(closed.headers.get('location') ?? '', /closed=1$/);
  const doc = await load(created.slug);
  assert.equal(doc.workstream.status, 'done');
  assert.equal(doc.workstream.conclusion!.disposition, 'not_worth_doing');
  const steer = doc.steering.find((s) => s.id === doc.workstream.conclusion!.directedBy)!;
  assert.ok(steer);
  assert.ok(steer.by && !['coordinator', 'worker'].includes(steer.by), 'attributed to the signed-in operator');

  const again = await fetch(`${base}/workstreams/${created.slug}/close`, form({ reason: 'again', revision: String(doc.revision) }));
  assert.equal(again.status, 409, 'an already-concluded job is refused');
  const donePage = await (await fetch(`${base}/workstreams/${created.slug}?tab=activity`)).text();
  assert.doesNotMatch(donePage, /data-testid="close-form"/, 'a concluded job offers no close control');
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
  // A workstream link without ?tab= opens the Timeline: the decision is a
  // timeline row, and the next move closes it.
  assert.match(html, /data-testid="workspace-tab-timeline"[^>]*aria-current="page"/);
  assert.match(html, /data-testid="workspace-timeline"/);
  assert.match(html, /data-testid="timeline-decision"/);
  assert.match(html, /data-testid="timeline-next"/);
  assert.match(html, /data-testid="timeline-caption"/);
  assert.doesNotMatch(html, /data-testid="workspace-overview"|data-testid="workspace-work"|data-testid="workspace-activity"|data-testid="job-details"/);
  assert.doesNotMatch(html, /Work and deliverables|workspace-inspector|five-question-position/);
  assert.doesNotMatch(html, /WEAVER_SERVE_TOKEN|WEAVER_UI_TOKEN/);
  assert.doesNotMatch(html, /DISPOSABLE_PASS_SUMMARY|DISPOSABLE_SESSION/);
  assert.match(html, /data-revision-endpoint="\/api\/fleet-revision"/);
  assert.match(html, /data-revision-events-endpoint="\/api\/fleet-events"/);
  assert.match(html, /new EventSource\(root\.dataset\.revisionEventsEndpoint\)/);
  assert.match(html, /root\.replaceWith\(nextRoot\)/);
  assert.doesNotMatch(html, /window\.location\.reload/);

  const overviewHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=overview`)).text();
  assert.match(overviewHtml, /data-testid="workspace-tab-overview"[^>]*aria-current="page"/);
  assert.match(overviewHtml, /data-testid="workspace-overview"/);
  assert.doesNotMatch(overviewHtml, /data-testid="workspace-timeline"/);

  const allHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=timeline&all=1`)).text();
  assert.match(allHtml, /data-testid="workspace-tab-timeline"[^>]*aria-current="page"/);
  assert.match(allHtml, /data-testid="timeline-decision"/);

  const activityHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=activity`)).text();
  assert.match(activityHtml, /data-testid="workspace-tab-activity"[^>]*aria-current="page"/);
  assert.match(activityHtml, /Add context or answer a question/);
  assert.match(activityHtml, /Recent updates/);
  assert.doesNotMatch(activityHtml, /data-testid="workspace-overview"|data-testid="workspace-work"|data-testid="job-details"|data-testid="workspace-timeline"/);

  const detailsHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=details`)).text();
  assert.match(detailsHtml, /data-testid="workspace-tab-details"[^>]*aria-current="page"/);
  assert.match(detailsHtml, /Technical details/);
  assert.doesNotMatch(detailsHtml, /data-testid="workspace-overview"|data-testid="workspace-work"|data-testid="workspace-activity"/);

  const unknownHtml = await (await fetch(`${base}/workstreams/${created.slug}?tab=unknown`)).text();
  assert.match(unknownHtml, /data-testid="workspace-tab-timeline"[^>]*aria-current="page"/);

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
  assert.match(html, /2 actions in 2 jobs are waiting for the approval service, which isn(&#x27;|')t responding/);
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
    'Own a recurring fleet-wide operational triage loop. Each cycle, inspect the harness-provided typed fleet-health evidence — never transcripts — for open human asks, approval-service incidents, active capacity backoff, overdue wakes, dormant routines, and results awaiting review.',
    'Group symptoms by root cause. For every actionable group, identify an existing live owner or create one source-keyed bounded managed repair Workstream; verify apparently stale asks so their owning Workstreams can reconcile them. Surface one concise request only when a specific judgment, credential, spend, or external-effect authority genuinely requires a person.',
    'The fleet is quiet only when no actionable operational cause is unowned and no stale ask remains untriaged. Unchanged counts are not evidence of health. When genuinely quiet, schedule the next check about two hours out; while actionable operational work remains, re-check in about fifteen minutes. Report deltas only.',
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
  assert.match(migrated.workstream.objective, /open card never proves an externally changeable premise is still true/);
  assert.ok(migrated.workstream.successCriteria.some((criterion) => /explicitly deferred/.test(criterion)));
  assert.ok(migrated.workstream.successCriteria.some((criterion) => /managed read-only verification/.test(criterion)));
  assert.ok(migrated.workstream.constraints.some((constraint) => /non-deferred operational item/.test(constraint)));
  assert.ok(migrated.workstream.constraints.some((constraint) => /newer source revision prove only missing reconciliation/.test(constraint)));

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
  const strip = html.match(/data-testid="fleet-status-strip"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(strip, /1 routine is behind schedule\./);
  // The status strip speaks in jobs and plain words, never harness vocabulary.
  assert.doesNotMatch(strip, /routine health gap|outcome|durable|gated external effect|execution capacity/i);
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

test('the live revision stream fans durable fleet changes out without a browser poll', async () => {
  const controller = new AbortController();
  const joiningController = new AbortController();
  let joiningStream: SseTestReader | undefined;
  const response = await fetch(`${base}/api/fleet-events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.body);
  const stream: SseTestReader = { reader: response.body.getReader(), buffer: '' };
  try {
    const before = await nextSseRevision(stream);
    await createTeamWorkstream({
      message: 'Make this new job appear in every open workspace.',
      requestId: 'live-event-request',
      actor: 'alice',
    });
    const joiningResponse = await fetch(`${base}/api/fleet-events`, {
      headers: { Accept: 'text/event-stream' },
      signal: joiningController.signal,
    });
    assert.ok(joiningResponse.body);
    joiningStream = { reader: joiningResponse.body.getReader(), buffer: '' };
    const [after, joiningRevision] = await Promise.all([
      nextSseRevision(stream),
      nextSseRevision(joiningStream),
    ]);
    assert.notEqual(after, before);
    assert.equal(joiningRevision, after, 'a joining tab cannot consume a new revision without notifying existing tabs');
    const board = await (await fetch(`${base}/board`)).text();
    assert.match(board, new RegExp(`data-revision="${after}"`));
    assert.match(board, /Make this new job appear in every open workspace/);
  } finally {
    controller.abort();
    joiningController.abort();
    await stream.reader.cancel().catch(() => undefined);
    await joiningStream?.reader.cancel().catch(() => undefined);
  }
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

test('fleet revision advances on the bounded presentation clock without a durable write', async () => {
  const heads = async () => [{ slug: 'alpha', revision: 3 }];
  const presences = async () => [];
  const before = await currentFleetRevision(
    heads,
    presences,
    new Date('2026-08-31T12:00:30.000Z'),
    new Date('2026-08-31T12:00:30.000Z'),
  );
  const after = await currentFleetRevision(
    heads,
    presences,
    new Date('2026-08-31T12:01:00.000Z'),
    new Date('2026-08-31T12:01:00.000Z'),
  );
  assert.notEqual(after, before, 'due labels, lease expiry, and routine readiness cannot remain stale forever');
});

test('published coordinator seat changes invalidate the browser without heartbeat-only churn', async () => {
  const now = new Date('2026-09-10T12:00:10.000Z');
  const heads = async () => [{ slug: 'alpha', revision: 3 }];
  const seat = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
  const presence = { runnerId: 'gcp', heartbeatAt: now.toISOString(), coordinatorSeats: [seat] };
  const first = await currentFleetRevision(heads, async () => [presence], now, now);
  const heartbeat = await currentFleetRevision(heads, async () => [{ ...presence, heartbeatAt: new Date(now.getTime() + 1000).toISOString() }], now, now);
  const changed = await currentFleetRevision(heads, async () => [{ ...presence, coordinatorSeats: [{ ...seat, model: 'new-reviewed-model' }] }], now, now);
  assert.equal(first, heartbeat);
  assert.notEqual(first, changed);
  const nearlyStale = { ...presence, heartbeatAt: new Date(now.getTime() - 119_000).toISOString() };
  const fresh = await currentFleetRevision(heads, async () => [nearlyStale], now, now);
  const expired = await currentFleetRevision(heads, async () => [nearlyStale], new Date(now.getTime() + 2000), now);
  assert.notEqual(fresh, expired, 'TTL expiry refreshes the view even within one presentation minute');
});

test('live browser and terminal watch use the hosted chain and preserve scheduled provider retries', async () => {
  const created = await createTeamWorkstream({ message: 'Reconcile hosted capacity.', requestId: 'hosted-capacity', actor: 'alice' });
  const now = new Date().toISOString();
  const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const seat = { executor: 'local-sdk', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
  await heartbeatRunner('gcp', now, [seat]);
  await arrive(created.slug, (doc) => {
    doc.workstream.executionPolicy = { coordinatorRunnerOrder: ['gcp'] };
    const wait = { ...seat, kind: 'usage_limit' as const, recovery: 'wait_or_enable_usage_credits' as const, source: 'coordinator' as const, sourceId: 'pass_hosted', detectedAt: now, retryAt };
    recordCapacityBackoff(doc, wait);
    doc.wakes = [{ id: 'wake_hosted', reason: 'RAW PROVIDER ERROR', condition: { type: 'time', dueAtVirtual: retryAt }, status: 'pending', createdAt: now, infrastructure: wait }];
  });
  const page = await (await fetch(`${base}/workstreams/${created.slug}`)).text();
  assert.match(page, /OpenRouter/);
  assert.doesNotMatch(page, /fallback .* available|No next move scheduled/);
  const board = await (await fetch(base)).text();
  assert.match(board, /OpenRouter/);
  const terminal = await viewOf(created.slug);
  assert.equal(terminal.bucket, 2);
  assert.match(terminal.details.join('\n'), /next wake .*provider retry/);
  assert.doesNotMatch(terminal.details.join('\n'), /RAW PROVIDER ERROR|fallback .* available/);
  const tui = await terminalSnapshot();
  const row = tui.streams.find((stream) => stream.slug === created.slug)!;
  assert.equal(row.bucket, 2);
  assert.equal(row.nextRun, retryAt);
  assert.match(row.details.join('\n'), /OpenRouter/);
  assert.doesNotMatch(row.nextReason!, /RAW PROVIDER ERROR/);
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

interface FleetHealthProbeBody {
  ok: boolean;
  runners?: Array<{ id: string; heartbeat_age_seconds: number; degraded: string | null }>;
  freshest_heartbeat_age_seconds?: number | null;
  healthy_runners?: number;
  last_completed_pass_age_seconds?: number | null;
  oldest_unserved_due_seconds?: number | null;
  capacity_blocked_workstreams?: number;
  problems?: string[];
  unhealthy: number;
  error?: string;
}

test('healthz/fleet reports runner freshness to an external monitor, unauthenticated, while other routes stay gated', async () => {
  await running!.close();
  running = await startOperatorUi({ token: 'shared-secret' });
  base = `http://127.0.0.1:${running.port}`;

  // No runner has ever published presence: an external monitor must not read
  // silence as green — a dead fleet with nobody home is unhealthy too.
  let response = await fetch(`${base}/healthz/fleet`);
  assert.equal(response.status, 200, 'the probe never requires a credential');
  let body = await response.json() as FleetHealthProbeBody;
  assert.deepEqual(body.runners, []);
  assert.equal(body.freshest_heartbeat_age_seconds, null);
  assert.equal(body.healthy_runners, 0);
  assert.equal(body.unhealthy, 1);
  assert.equal(body.ok, false);

  // A fresh heartbeat makes the fleet healthy.
  await heartbeatRunner('gcp');
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.unhealthy, 0);
  assert.equal(body.healthy_runners, 1);
  assert.equal(body.runners?.length, 1);
  assert.equal(body.runners?.[0]!.id, 'gcp');
  assert.equal(body.runners?.[0]!.degraded, null);
  assert.ok((body.freshest_heartbeat_age_seconds ?? Infinity) <= 2);

  // A heartbeat older than the 300s staleness threshold is unhealthy again —
  // the runner is not "degraded", it simply stopped publishing.
  await heartbeatRunner('gcp', new Date(Date.now() - 301_000).toISOString());
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 1);
  assert.equal(body.healthy_runners, 0);
  assert.ok((body.freshest_heartbeat_age_seconds ?? 0) >= 300);
  assert.equal(body.runners?.[0]!.degraded, null);

  // A degraded runner (its state directory can't commit — see runner.ts)
  // dispatches nothing even with a heartbeat published seconds ago, so it
  // counts as unhealthy and is excluded from freshest_heartbeat_age_seconds.
  await heartbeatRunner('gcp', new Date().toISOString(), undefined, 'state directory below free-space floor');
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 1);
  assert.equal(body.healthy_runners, 0);
  assert.equal(body.freshest_heartbeat_age_seconds, null);
  assert.equal(body.runners?.[0]!.degraded, 'state directory below free-space floor');

  // A store read failure never 500s: it reports the same shape at 503, with
  // no path or connection detail in the body.
  const previousHome = process.env.WEAVER_HOME;
  const notADirectory = `${fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-healthz-'))}-blocker`;
  fs.writeFileSync(notADirectory, 'a file, not the state directory');
  process.env.WEAVER_HOME = notADirectory;
  try {
    response = await fetch(`${base}/healthz/fleet`);
    assert.equal(response.status, 503);
    body = await response.json() as FleetHealthProbeBody;
    assert.equal(body.ok, false);
    assert.equal(body.unhealthy, 1);
    assert.equal(body.error, 'store unreachable');
    assert.doesNotMatch(JSON.stringify(body), /weaver-healthz-|ENOTDIR|no such file/i);
  } finally {
    fs.rmSync(notADirectory, { force: true });
    if (previousHome === undefined) delete process.env.WEAVER_HOME;
    else process.env.WEAVER_HOME = previousHome;
  }

  // The auth gate still protects every other route on this same server.
  assert.equal((await fetch(`${base}/board`)).status, 401);
  assert.equal((await fetch(`${base}/fleet`)).status, 401);
});

test('healthz/fleet also pages on OUTPUT, not just liveness: unserved due work and a stalled fleet under capacity backoff', async () => {
  const freshOutput = (overrides: Partial<RunnerOutput> = {}): RunnerOutput => ({
    observedAt: new Date().toISOString(),
    capacityBlocked: 0,
    ...overrides,
  });

  // A healthy heartbeat with unremarkable output stays healthy.
  await heartbeatRunner('gcp', new Date().toISOString(), undefined, undefined, freshOutput());
  let response = await fetch(`${base}/healthz/fleet`);
  let body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 0);
  assert.deepEqual(body.problems, []);
  assert.equal(body.oldest_unserved_due_seconds, null);
  assert.equal(body.last_completed_pass_age_seconds, null);
  assert.equal(body.capacity_blocked_workstreams, 0);

  // Due work unserved for just under the one-hour limit is not yet a problem.
  await heartbeatRunner('gcp', new Date().toISOString(), undefined, undefined, freshOutput({
    oldestUnservedDueAt: new Date(Date.now() - 3500_000).toISOString(),
  }));
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 0);
  assert.deepEqual(body.problems, []);

  // Past the one-hour limit trips condition (b) even with a perfectly fresh
  // heartbeat — a runner can tick every 5s while dispatching nothing.
  await heartbeatRunner('gcp', new Date().toISOString(), undefined, undefined, freshOutput({
    oldestUnservedDueAt: new Date(Date.now() - 3700_000).toISOString(),
  }));
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 1);
  assert.deepEqual(body.problems, ['due work has not been served for over an hour']);
  assert.ok((body.oldest_unserved_due_seconds ?? 0) > 3600);

  // 12h with no completed pass but NO live capacity backoff is a quiet fleet,
  // not a stalled one — condition (c) needs both facts together.
  await heartbeatRunner('gcp', new Date().toISOString(), undefined, undefined, freshOutput({
    lastCompletedPassAt: new Date(Date.now() - 13 * 3600_000).toISOString(),
  }));
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 0);
  assert.deepEqual(body.problems, []);

  // 12h with no completed pass WHILE capacity is blocked trips condition (c).
  await heartbeatRunner('gcp', new Date().toISOString(), undefined, undefined, freshOutput({
    lastCompletedPassAt: new Date(Date.now() - 13 * 3600_000).toISOString(),
    capacityBlocked: 2,
  }));
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 1);
  assert.deepEqual(body.problems, ['no coordinator pass has completed in 12h while work is waiting on provider capacity']);
  assert.equal(body.capacity_blocked_workstreams, 2);

  // A degraded runner's cached output is never read as current fleet state —
  // its own heartbeat clears output, and this monitor falls back to "no
  // healthy runner" rather than reporting stale facts as current.
  await heartbeatRunner('gcp', new Date().toISOString(), [], 'state directory below free-space floor');
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 1);
  assert.deepEqual(body.problems, ['no runner has a healthy heartbeat']);
  assert.equal(body.oldest_unserved_due_seconds, null);
  assert.equal(body.last_completed_pass_age_seconds, null);
  assert.equal(body.capacity_blocked_workstreams, 0);

  // An older runner that never publishes output at all only ever trips
  // condition (a) — the endpoint degrades gracefully, it never 500s on it.
  await heartbeatRunner('legacy', new Date().toISOString());
  response = await fetch(`${base}/healthz/fleet`);
  body = await response.json() as FleetHealthProbeBody;
  assert.equal(body.unhealthy, 0);
  assert.deepEqual(body.problems, []);
  assert.equal(body.oldest_unserved_due_seconds, null);
  assert.equal(body.last_completed_pass_age_seconds, null);
  assert.equal(body.capacity_blocked_workstreams, 0);
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
  assert.equal((await fetch(`${base}/api/fleet-events`)).status, 401, 'the live stream has the same authentication boundary');

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
  const signedInHtml = await allowed.clone().text();
  // The signed-in page renews its session through a hidden same-origin frame,
  // so Clerk's SDK never runs beside workstream content.
  assert.match(signedInHtml, /<iframe src="\/session-keepalive"[^>]*hidden=""/);
  assert.doesNotMatch(signedInHtml, /data-clerk-js-script/);
  assert.match(allowed.headers.get('content-security-policy') ?? '', /frame-src 'self'/);
  assert.match(allowed.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(allowed.headers.get('x-frame-options'), 'DENY');
  const keepAlive = await fetch(`${base}/session-keepalive`, { headers: { 'x-test-clerk': 'allowed' } });
  assert.equal(keepAlive.status, 200);
  const keepAliveHtml = await keepAlive.text();
  assert.match(keepAliveHtml, /data-clerk-publishable-key="pk_test_browser-safe"/);
  assert.match(keepAliveHtml, /window\.Clerk\?\.load\(\)/);
  assert.doesNotMatch(keepAliveHtml, /data-operator-root|<iframe/);
  assert.match(keepAlive.headers.get('content-security-policy') ?? '', /script-src[^;]*https:\/\/example\.clerk\.accounts\.dev/);
  assert.match(keepAlive.headers.get('content-security-policy') ?? '', /frame-ancestors 'self'/);
  assert.equal(keepAlive.headers.get('x-frame-options'), 'SAMEORIGIN');
  const keepAliveSignedOut = await fetch(`${base}/session-keepalive`, { redirect: 'manual' });
  assert.equal(keepAliveSignedOut.status, 303, 'a lapsed session gets no keep-alive page, only the sign-in redirect');
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
    assert.match(html, /data-testid="fleet-status-headline"[^>]*>All clear</);
    assert.match(html, /1 runner online: gcp-standby/);
    const fleet = await (await fetch(`${base}/fleet`)).text();
    assert.match(fleet, /Shared team database · Connected/);
    assert.match(fleet, /Running · gcp-standby/);
    assert.match(fleet, /Runners check in every few seconds/);
    assert.doesNotMatch(html, /No runner is running|No runner online/);
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

test('the team overview is a read-only typed view linked from the nav, recomputed when the fleet revision moves', async () => {
  await createTeamWorkstream({ message: 'Sweep new production errors into repairs', requestId: 'overview-parent', actor: 'alice' });
  const parent = (await listWorkstreams())[0]!;
  const child = await createTeamWorkstream({ message: 'Repair the lead-capture 500', requestId: 'overview-child', actor: 'alice', under: parent });

  const response = await fetch(`${base}/overview`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const html = await response.text();
  assert.match(html, /data-testid="operator-overview-page"/);
  assert.match(html, /href="\/overview" aria-current="page"/);
  // Each section leads with computed takeaway sentences, in plain English.
  assert.match(html, /data-testid="overview-insights"/);
  assert.match(html, /Half the jobs were started by other jobs and half directly by people: 1 each\./);
  assert.match(html, /2 jobs are active\./);
  assert.match(html, /This counts merges, not whether the code was good\./);
  assert.doesNotMatch(html, /What this page cannot tell you yet/);
  assert.match(html, /No examples yet/);
  assert.match(html, /0 paused\./);
  // None of the internal vocabulary reaches a newcomer. Scripts and
  // slug-shaped tokens are dropped first: a job's name is data, not copy.
  const page = html.slice(html.indexOf('data-testid="operator-overview-page"'));
  const copy = page
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g, ' ');
  for (const phrase of [/typed record/i, /readback/i, /gated external effect/i, /durable/i, /\boutcomes\b/i]) {
    assert.doesNotMatch(copy, phrase);
  }

  assert.match(await (await fetch(`${base}/board`)).text(), /data-testid="team-overview-link" href="\/overview"/);

  // "What it is doing now" is one tab per parent; the chosen tab is a plain
  // link, so it survives the shell's live refresh of the current URL.
  assert.match(html, /data-testid="overview-now-tab-top-level"/);
  // Tabs swap in place (no navigation, so no scroll jump), and each section
  // carries a real id for its anchor.
  assert.match(html, /data-inplace=""[^>]*data-testid="overview-now-tab-top-level"/);
  assert.match(html, /<section id="now"/);
  assert.doesNotMatch(html, /session-keepalive/, 'without Clerk there is no keep-alive frame');
  assert.match(html, new RegExp(`data-testid="overview-now-tab-${parent}"`));
  const underParent = await (await fetch(`${base}/overview?now=${encodeURIComponent(parent)}`)).text();
  assert.match(underParent, new RegExp(`data-testid="overview-now-tab-${parent}"[^>]*aria-current="page"`));
  const items = underParent.slice(underParent.indexOf('data-testid="overview-now-items"'));
  assert.match(items.slice(0, items.indexOf('</div>')), new RegExp(`/workstreams/${child.slug}`));
  const topLevel = await (await fetch(`${base}/overview?now=top-level`)).text();
  const topItems = topLevel.slice(topLevel.indexOf('data-testid="overview-now-items"'));
  assert.doesNotMatch(topItems.slice(0, topItems.indexOf('</div>')), new RegExp(`/workstreams/${child.slug}"`));

  // A durable write moves the fleet revision, so the memo cannot serve a stale view.
  await arrive(child.slug, (doc) => {
    doc.workstream.status = 'paused';
  });
  assert.match(await (await fetch(`${base}/overview`)).text(), /1 paused\./);

  // The worked example renders the same timeline component the workstream
  // page defaults to, retries folded and the conclusion's disposition shown.
  await arrive(child.slug, (doc) => {
    const at = (h: number) => new Date(Date.parse('2026-09-02T00:00:00Z') + h * 3_600_000).toISOString();
    doc.assignments = Array.from({ length: 5 }, (_, i) => ({
      id: `a_example_${i}`, objective: `Attempt the repair ${i}`, briefing: 'b', kind: 'work' as const,
      acceptanceCriteria: [], dependsOn: [], state: 'completed' as const, attempts: [],
      adoption: { state: i < 3 ? 'rejected' as const : 'accepted' as const }, createdAtVirtual: at(i),
    }));
    doc.workstream.status = 'done';
    doc.workstream.conclusion = { passId: 'p_example', atVirtual: at(30), summary: 'Repaired the 500', evidenceIds: [], disposition: 'delivered' };
  });
  const exampleHtml = await (await fetch(`${base}/overview`)).text();
  assert.match(exampleHtml, /data-testid="overview-example"[\s\S]*data-testid="workstream-timeline"/);
  assert.match(exampleHtml, /data-testid="timeline-retries"/);
  assert.match(exampleHtml, /4 attempts · 3 rejected · then accepted/);
  assert.match(exampleHtml, /data-testid="timeline-gap"/);
  assert.match(exampleHtml, /Disposition: <span[^>]*>delivered<\/span>/);

  // A read surface only: no write route exists under it.
  assert.equal((await fetch(`${base}/overview`, form({}))).status, 404);
});
