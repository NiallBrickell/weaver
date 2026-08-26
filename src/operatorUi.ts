/**
 * `weaver ui` — a private, live browser adapter over durable Workstream state.
 *
 * This process owns no agent loop and no organizational truth. It stores team
 * intake deterministically, records follow-up messages as untrusted
 * Observations, and server-renders the same typed projections as the static
 * inspector. A resident `weaver run` process remains responsible for moving
 * work forward.
 *
 * The UI intentionally has no steering, approval, adoption, merge, deploy, or
 * send route. A teammate can ask Weaver to own work and can supply evidence;
 * they cannot acquire the operator's authority by reaching this server.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { userInfo } from 'node:os';

import { capacityPresentation } from './capacity.js';
import { virtualNow } from './clock.js';
import { createOrGetWorkstream, recordObservation } from './ingress.js';
import { ManagedWorkstreamError } from './managedWorkstreams.js';
import { deriveFallback, loadHouse } from './onboard.js';
import { loadPolicies } from './policies.js';
import { liveRunnerPid, runnerLoopHealthy, runnerSourceStale } from './runner.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import {
  listWorkstreams,
  load,
  readArtifact,
  sha256,
  verifyArtifact,
} from './store.js';
import type { WorkstreamDoc } from './types.js';
import {
  fleetBoard,
  workstreamPage,
  type FleetBoardView,
  type ManagedWorkstreamLink,
  type WorkstreamCardView,
} from './ui/inspect/model.js';
import {
  renderOperatorBoardHtml,
  renderOperatorNewHtml,
  renderOperatorWorkspaceHtml,
  type OperatorFleetView,
} from './ui/operator/render.js';

export interface OperatorUiOptions {
  host?: string;
  port?: number;
  /** Shared password for HTTP Basic auth. The username is a caller-supplied provenance label. */
  token?: string;
}

export interface RunningOperatorUi {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export interface TeamIntakeRequest {
  message: string;
  done?: string;
  requestId: string;
  actor: string;
  /** Optional parent slug: create under an existing active Workstream. */
  under?: string;
}

export interface TeamIntakeResult {
  slug: string;
  created: boolean;
}

interface LoadedFleet {
  docs: WorkstreamDoc[];
  unreadable: string[];
  managed: Map<string, ManagedWorkstreamLink[]>;
  view: OperatorFleetView;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGE_LENGTH = 50_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function safeActor(value: string): string {
  const actor = value.replace(/[\r\n\0]/g, '').trim().slice(0, 80);
  return actor || 'teammate';
}

function sourceKeyFor(message: string, requestId: string): string {
  // A source URL names intended work across browser retries. Hash it so a URL
  // containing a private query token never becomes fleet metadata. Without a
  // URL, the form's stable request id makes an accidental resubmit idempotent.
  const sourceUrl = message.match(/https?:\/\/[^\s<>()\]"']+/i)?.[0];
  if (sourceUrl) return `ui:url:${sha256(sourceUrl).slice(0, 32)}`;
  return `ui:request:${sha256(requestId).slice(0, 32)}`;
}

/**
 * Store one team request without any model dependency. Refinement is a later
 * coordinator concern; provider exhaustion can never lose or delay intake.
 */
export async function createTeamWorkstream(req: TeamIntakeRequest): Promise<TeamIntakeResult> {
  const message = req.message.trim();
  const done = req.done?.trim();
  const requestId = req.requestId.trim();
  if (!message) throw new Error('What needs doing is required');
  if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`What needs doing must be at most ${MAX_MESSAGE_LENGTH} characters`);
  if (!requestId || requestId.length > 200) throw new Error('request_id is required');

  const slugs = await listWorkstreams();
  const derived = deriveFallback(message, new Set(slugs), done);
  const house = loadHouse();
  // Browser intake cannot depend on a model pass, but a terse report still
  // needs the execution host's existing repository map to survive the wait.
  // Keep the reporter's words intact and append the operator-owned machine
  // context deterministically; the coordinator may then name only directories
  // that durable intended work actually contains.
  const objective = house.repoMap.trim()
    ? `${derived.objective}\n\nRepository context for this execution host:\n${house.repoMap.trim()}`
    : derived.objective;
  const sourceKey = sourceKeyFor(message, requestId);
  const under = req.under?.trim() || undefined;
  const result = await createOrGetWorkstream({
    sourceKey,
    slug: derived.slug,
    title: derived.title,
    objective,
    tags: house.tags,
    successCriteria: derived.successCriteria,
    constraints: house.constraints,
    ...(under ? { under } : {}),
  });

  // The Workstream owns the requested outcome. This separately preserves who
  // supplied the input as an Observation, not Steering, so it cannot silently
  // widen authority. The content hash makes a retry an exact no-op.
  await recordObservation(result.slug, {
    source: `operator-ui:${safeActor(req.actor)}`,
    summary: message,
    ingressKey: `${sourceKey}:request:${sha256(`${message}\n${done ?? ''}`).slice(0, 24)}`,
  });
  return { slug: result.slug, created: result.created };
}

function managedIndex(docs: WorkstreamDoc[]): Map<string, ManagedWorkstreamLink[]> {
  const index = new Map<string, ManagedWorkstreamLink[]>();
  for (const doc of docs) {
    const manager = doc.workstream.managedBy?.slug;
    if (!manager) continue;
    const children = index.get(manager) ?? [];
    children.push({ slug: doc.workstream.slug, status: doc.workstream.status });
    index.set(manager, children);
  }
  for (const children of index.values()) children.sort((a, b) => a.slug.localeCompare(b.slug));
  return index;
}

function fleetGroups(board: FleetBoardView): OperatorFleetView['groups'] {
  const definitions: Array<[string, WorkstreamCardView[]]> = [
    ['Needs you', board.lanes['needs-you']],
    ['Working', board.lanes.moving],
    ['Waiting', board.lanes.waiting],
    ['Ready', board.lanes.ready],
  ];
  return definitions.map(([label, cards]) => ({ label, cards }));
}

function fleetScope(): OperatorFleetView['scope'] {
  if (/^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '')) {
    return {
      label: 'Shared fleet · execution on another host',
      detail: 'Jobs, decisions, results, and shared knowledge come from the shared database. Runner processes and workspaces stay on the execution host.',
    };
  }
  return {
    label: 'Local fleet · this machine',
    detail: 'Jobs and results come from this machine\'s local Weaver store.',
  };
}

function fleetHealth(docs: WorkstreamDoc[], board: FleetBoardView, unreadable: string[]): OperatorFleetView['health'] {
  const pid = liveRunnerPid();
  // Runner locks and heartbeats are intentionally machine-local. A stateless
  // UI reading the shared Postgres fleet cannot inspect a runner on another
  // execution host, so absence of a local pid is unknown rather than offline.
  const remoteRunnerUnobservable = pid === null && /^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '');
  const staleRunner = pid !== null && runnerSourceStale();
  const healthyRunner = pid !== null && runnerLoopHealthy() && !staleRunner;
  const stalledRunner = pid !== null && !healthyRunner;
  const pilotAffected = docs.filter((doc) => doc.assignments.some(
    (assignment) => assignment.state === 'gated' && assignment.exec?.pilotUnavailableSince,
  ));
  const now = virtualNow().toISOString();
  const capacityBlocked = docs.filter((doc) => {
    const position = capacityPresentation(doc, now);
    return !!position.blocking || !!position.executorUnavailable;
  });
  const degraded = docs.filter((doc) => {
    const position = capacityPresentation(doc, now);
    return !position.blocking && !position.executorUnavailable && position.details.length > 0;
  });

  const details: string[] = [];
  if (unreadable.length) details.push(`${unreadable.length} unreadable Workstream${unreadable.length === 1 ? '' : 's'}`);
  if (pilotAffected.length) details.push(`approval service affects ${pilotAffected.length} outcome${pilotAffected.length === 1 ? '' : 's'}`);
  if (capacityBlocked.length) details.push(`execution capacity blocks ${capacityBlocked.length} outcome${capacityBlocked.length === 1 ? '' : 's'}`);
  if (degraded.length) details.push(`${degraded.length} outcome${degraded.length === 1 ? '' : 's'} using fallbacks`);
  details.push(`${Object.values(board.lanes).flat().length} live · ${board.done.length} done`);

  if (unreadable.length || stalledRunner) {
    return {
      tone: 'critical',
      headline: unreadable.length ? 'Some durable state is unreadable' : 'Runner is stalled',
      detail: `${details.join(' · ')}. Stored work is retained; execution needs operator attention.`,
    };
  }
  if (remoteRunnerUnobservable) {
    return {
      tone: 'healthy',
      headline: 'Shared fleet is connected',
      detail: `${details.join(' · ')}. Runner activity happens on another host and is not measured by this page.`,
    };
  }
  if (!healthyRunner) {
    return {
      tone: 'warning',
      headline: 'Runner is offline',
      detail: `${details.join(' · ')}. New requests are stored safely and will advance when a runner starts.`,
    };
  }
  if (pilotAffected.length || capacityBlocked.length || degraded.length) {
    return {
      tone: 'warning',
      headline: pilotAffected.length || capacityBlocked.length ? 'Weaver is running with blocked dependencies' : 'Weaver is running on fallback capacity',
      detail: `${details.join(' · ')}. Intended work remains durable; no gated external effect is assumed to have happened.`,
    };
  }
  return {
    tone: 'healthy',
    headline: 'Weaver is running',
    detail: details.join(' · '),
  };
}

async function loadFleet(): Promise<LoadedFleet> {
  const docs: WorkstreamDoc[] = [];
  const unreadable: string[] = [];
  for (const slug of await listWorkstreams()) {
    try {
      docs.push(await load(slug));
    } catch {
      unreadable.push(slug);
    }
  }
  const managed = managedIndex(docs);
  const policies = (await loadPolicies()).policies;
  const board = fleetBoard(docs, policies, managed, unreadable);
  const revision = sha256(JSON.stringify(
    docs.map((doc) => [doc.workstream.slug, doc.revision]).sort(([a], [b]) => String(a).localeCompare(String(b))),
  )).slice(0, 20);
  return {
    docs,
    unreadable,
    managed,
    view: {
      board,
      groups: fleetGroups(board),
      scope: fleetScope(),
      health: fleetHealth(docs, board, unreadable),
      intakeParents: docs
        .filter((doc) => doc.workstream.status === 'active')
        .map((doc) => ({ slug: doc.workstream.slug, title: doc.workstream.title }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      revision,
    },
  };
}

function secureHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=31536000',
    'cache-control': 'no-store',
  };
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = redactSecrets(html, loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('text/html; charset=utf-8'), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = redactSecrets(JSON.stringify(value), loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('application/json; charset=utf-8'), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, value: string): void {
  const body = redactSecrets(value, loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('text/plain; charset=utf-8'), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/**
 * Railway and similar supervisors need a probe that cannot become a fleet
 * read API. Reaching this response means the configured StateStore completed
 * a real operation; the empty body deliberately reveals no fleet facts.
 */
function sendHealth(res: ServerResponse, status: 200 | 503): void {
  res.writeHead(status, {
    ...secureHeaders('text/plain; charset=utf-8'),
    'content-length': '0',
  });
  res.end();
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...secureHeaders('text/plain; charset=utf-8'), location });
  res.end('See Other');
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    ...secureHeaders('text/plain; charset=utf-8'),
    'www-authenticate': 'Basic realm="Weaver", charset="UTF-8"',
  });
  res.end('Authentication required');
}

function forbidden(res: ServerResponse): void {
  res.writeHead(403, secureHeaders('text/plain; charset=utf-8'));
  res.end('Same-origin request required');
}

function requestAuthority(req: IncomingMessage): string | null {
  const value = req.headers.host;
  if (typeof value !== 'string' || !value || /[\s\\/@?#]/.test(value)) return null;
  try {
    return new URL(`http://${value}/`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Basic-auth credentials are replayed automatically by browsers, including
 * on cross-site form submissions. Require the browser's serialized Origin to
 * name this request's Host before any POST body is read. Scheme is deliberately
 * ignored because a trusted reverse proxy may terminate HTTPS in front of this
 * HTTP server; host and explicit port remain part of the authority comparison.
 */
function isSameOriginPost(req: IncomingMessage): boolean {
  const value = req.headers.origin;
  const authority = requestAuthority(req);
  if (typeof value !== 'string' || !authority) return false;
  try {
    const origin = new URL(value);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    return origin.host.toLowerCase() === authority;
  } catch {
    return false;
  }
}

function actorFor(req: IncomingMessage, token?: string): string | null {
  if (!token) return safeActor(userInfo().username);
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  const username = decoded.slice(0, separator);
  const presented = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(token);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return safeActor(username);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = req.headers['content-type']?.split(';')[0]?.trim();
  if (type !== 'application/x-www-form-urlencoded') throw new Error('form content type required');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function noticeFrom(url: URL): string | undefined {
  if (url.searchParams.get('created') === '1') return 'Request stored. Weaver can pick it up as soon as execution is available.';
  if (url.searchParams.get('existing') === '1') return 'This source already has a Workstream. Your request was added there.';
  if (url.searchParams.get('added') === '1') return 'Information added. Weaver will reconcile it on the next pass.';
  return undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse, token?: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? 'GET';

  // Health is the one unauthenticated route. It exposes no status or counts,
  // and succeeds only after the selected backend answers a real read.
  if (method === 'GET' && url.pathname === '/healthz') {
    try {
      await listWorkstreams();
      return sendHealth(res, 200);
    } catch {
      return sendHealth(res, 503);
    }
  }

  const actor = actorFor(req, token);
  if (!actor) return unauthorized(res);
  if (method === 'POST' && !isSameOriginPost(req)) return forbidden(res);

  if (method === 'GET' && url.pathname === '/') return redirect(res, '/board');

  if (method === 'GET' && url.pathname === '/api/fleet-revision') {
    const fleet = await loadFleet();
    return sendJson(res, 200, { revision: fleet.view.revision });
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'workstreams' && parts[3] === 'revision') {
    try {
      const doc = await load(parts[2]!);
      return sendJson(res, 200, { revision: String(doc.revision) });
    } catch {
      return sendJson(res, 404, { error: 'Workstream not found' });
    }
  }

  if (method === 'GET' && url.pathname === '/board') {
    const fleet = await loadFleet();
    return sendHtml(res, 200, renderOperatorBoardHtml({ fleet: fleet.view, actor, notice: noticeFrom(url) }));
  }

  if (method === 'GET' && url.pathname === '/new') {
    const fleet = await loadFleet();
    return sendHtml(res, 200, renderOperatorNewHtml({
      fleet: fleet.view,
      actor,
      requestId: randomUUID(),
      notice: noticeFrom(url),
    }));
  }

  if (method === 'POST' && url.pathname === '/workstreams') {
    const form = await readForm(req);
    const result = await createTeamWorkstream({
      message: form.get('message') ?? '',
      done: form.get('done') ?? undefined,
      requestId: form.get('request_id') ?? '',
      actor,
      under: form.get('under') ?? undefined,
    });
    return redirect(res, `/workstreams/${encodeURIComponent(result.slug)}?${result.created ? 'created' : 'existing'}=1`);
  }

  if (method === 'POST' && parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'observations') {
    const slug = parts[1]!;
    await load(slug);
    const form = await readForm(req);
    const message = (form.get('message') ?? '').trim();
    if (!message) throw new Error('Information is required');
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`Information must be at most ${MAX_MESSAGE_LENGTH} characters`);
    await recordObservation(slug, { source: `operator-ui:${actor}`, summary: message });
    return redirect(res, `/workstreams/${encodeURIComponent(slug)}?added=1`);
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'workstreams' && parts[2] === 'artifacts') {
    const slug = parts[1]!;
    const doc = await load(slug);
    const deliverable = doc.deliverables.find((candidate) => candidate.id === parts[3]);
    if (!deliverable) return sendHtml(res, 404, '<h1>Artifact not found</h1>');
    if (deliverable.adopted && deliverable.adopted.contentHash !== deliverable.contentHash) {
      return sendHtml(res, 409, '<h1>Artifact pin does not match its recorded revision</h1>');
    }
    if (!(await verifyArtifact(slug, deliverable.path, deliverable.contentHash))) {
      return sendHtml(res, 409, '<h1>Artifact integrity check failed</h1>');
    }
    const content = redactSecrets(await readArtifact(slug, deliverable.path), loadAllSecrets());
    const fileName = deliverable.path.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.writeHead(200, {
      ...secureHeaders('text/plain; charset=utf-8'),
      'content-disposition': `attachment; filename="${fileName}"`,
      'content-length': String(Buffer.byteLength(content)),
    });
    res.end(content);
    return;
  }

  if (method === 'GET' && parts.length === 2 && parts[0] === 'workstreams') {
    const slug = parts[1]!;
    const fleet = await loadFleet();
    const doc = fleet.docs.find((candidate) => candidate.workstream.slug === slug);
    if (!doc) return sendHtml(res, 404, '<h1>Workstream not found</h1>');
    const policies = (await loadPolicies()).policies;
    return sendHtml(res, 200, renderOperatorWorkspaceHtml({
      fleet: fleet.view,
      actor,
      notice: noticeFrom(url),
      view: workstreamPage(doc, policies, fleet.managed.get(slug) ?? []),
    }));
  }

  return sendHtml(res, 404, '<h1>Not found</h1>');
}

export async function startOperatorUi(opts: OperatorUiOptions = {}): Promise<RunningOperatorUi> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && !opts.token) {
    throw new Error('WEAVER_UI_TOKEN is required when weaver ui binds beyond loopback');
  }
  const server = createServer((req, res) => {
    handle(req, res, opts.token).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const userError = error instanceof ManagedWorkstreamError || /required|too large|at most|content type/i.test(message);
      const status = userError ? 400 : 500;
      sendText(res, status, `${status === 400 ? 'Request could not be stored' : 'Weaver UI failed'}\n\n${message}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('unexpected server address'));
      resolve({
        server,
        port: address.port,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}
