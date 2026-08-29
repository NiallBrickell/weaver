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
import type {
  ClerkBrowserAssets,
  ClerkOperatorAuthenticator,
} from './clerkOperatorAuth.js';
import { virtualNow } from './clock.js';
import { liveRunnerIds } from './coordinatorRunner.js';
import { FLEET_ATTENTION_STEWARD_SOURCE_KEY, fleetIncidents } from './fleetHealth.js';
import { createOrGetWorkstream, recordObservation } from './ingress.js';
import { ManagedWorkstreamError } from './managedWorkstreams.js';
import { deriveFallback, loadHouse } from './onboard.js';
import { loadPolicies } from './policies.js';
import { liveRunnerPid, runnerLoopHealthy, runnerSourceStale } from './runner.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import {
  listWorkstreams,
  listRunnerPresence,
  load,
  readArtifact,
  sha256,
  verifyArtifact,
} from './store.js';
import type { WorkstreamDoc } from './types.js';
import {
  fleetBoard,
  fleetNeeds,
  presentNeed,
  workstreamPage,
  type FleetBoardView,
  type FleetNeed,
  type ManagedWorkstreamLink,
  type WorkstreamCardView,
} from './ui/inspect/model.js';
import {
  renderOperatorBoardHtml,
  renderOperatorClerkAuthHtml,
  renderOperatorFleetHtml,
  renderOperatorNewHtml,
  renderOperatorWorkspaceHtml,
  type OperatorFleetView,
  type WorkspaceTab,
} from './ui/operator/render.js';

export interface OperatorUiOptions {
  host?: string;
  port?: number;
  /** Shared password for HTTP Basic auth. The username is a caller-supplied provenance label. */
  token?: string;
  /** Exclusive hosted auth mode. When present, the Basic token is ignored. */
  clerk?: ClerkOperatorAuthenticator;
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
export { FLEET_ATTENTION_STEWARD_SOURCE_KEY } from './fleetHealth.js';

class OperatorUiHttpError extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
  }
}

function safeActor(value: string): string {
  const actor = value.replace(/[\r\n\0]/g, '').trim().slice(0, 80);
  return actor || 'teammate';
}

function workspaceTab(value: string | null): WorkspaceTab {
  return value === 'work' || value === 'activity' || value === 'details' ? value : 'overview';
}

function needVersion(need: FleetNeed): string {
  return sha256(JSON.stringify([need.source.type, need.source.id, need.kind, need.summary])).slice(0, 32);
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

/**
 * Install the operator delegate's useful doctrine as ordinary durable work —
 * root-cause shared incidents, repair reversible causes, and interrupt only for
 * genuine judgment. The routine receives no approval authority: every external
 * effect still follows its original Workstream's action lifecycle.
 */
export async function createFleetAttentionSteward(actor: string): Promise<TeamIntakeResult> {
  const house = loadHouse();
  const result = await createOrGetWorkstream({
    sourceKey: FLEET_ATTENTION_STEWARD_SOURCE_KEY,
    slug: 'fleet-attention-steward',
    title: 'Fleet attention steward',
    objective: [
      'Own a recurring fleet-wide attention triage loop. Each cycle, inspect the harness-provided typed attention evidence — never transcripts — for open human asks and approval-service incidents.',
      'Group symptoms that share one dependency, challenge requests that do not genuinely require founder judgment, and create a bounded managed repair Workstream when a reversible root cause has its own outcome. Surface one concise question only when a specific judgment genuinely requires a person.',
      'When the fleet is quiet, schedule the next check about two hours out. While an operational incident is active, re-check in about fifteen minutes. Report deltas only.',
      ...(house.repoMap.trim() ? [`Repository context for this execution host:\n${house.repoMap.trim()}`] : []),
    ].join('\n\n'),
    tags: [...new Set([...house.tags, 'routine', 'fleet-operations'])],
    successCriteria: [
      'Each cycle produces one adopted attention report that groups shared causes and cites affected Workstream revisions and entity ids.',
      'Reversible operational causes are repaired or delegated to a bounded managed Workstream with verification.',
      'Only unresolved human judgment is surfaced; routine dependency noise never becomes one request per affected action.',
      'A future wake is scheduled after every completed cycle.',
    ],
    constraints: [...house.constraints,
      'Never approve or resolve a human-only action, send, merge, deploy, push, spend, or other external effect; preserve the originating Workstream authority gate.',
      'Worker output is a proposal, never permission. Read provider state back after an unknown result and never retry an external mutation blindly.',
      'Use typed fleet state as truth. A generated report may group evidence but cannot change another Workstream\'s decision, completion, attention, or authority.',
    ],
  });
  if (result.created) {
    await recordObservation(result.slug, {
      source: `operator-ui:${safeActor(actor)}`,
      summary: 'Start the standing fleet attention steward using its recorded safety constraints.',
      ingressKey: `${FLEET_ATTENTION_STEWARD_SOURCE_KEY}:enabled`,
    });
  }
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

interface RunnerObservation {
  pid: number | null;
  stale: boolean;
  healthy: boolean;
  sharedLiveRunnerIds: string[];
}

function observeRunner(sharedLiveRunnerIds: string[]): RunnerObservation {
  const pid = liveRunnerPid();
  const stale = pid !== null && runnerSourceStale();
  return { pid, stale, healthy: pid !== null && runnerLoopHealthy() && !stale, sharedLiveRunnerIds };
}

function fleetScope(): OperatorFleetView['scope'] {
  if (/^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '')) {
    return {
      label: 'Shared fleet',
      detail: 'This workspace reads the shared team database. Fleet details report only the execution state this web service can actually observe.',
    };
  }
  return {
    label: 'Local fleet',
    detail: 'This workspace reads this machine\'s local Weaver store and can measure its local runner.',
  };
}

function fleetHealth(docs: WorkstreamDoc[], board: FleetBoardView, unreadable: string[], runner: RunnerObservation): OperatorFleetView['health'] {
  const { pid, stale: staleRunner, healthy: healthyRunner } = runner;
  const sharedRunnerHealthy = /^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '') &&
    runner.sharedLiveRunnerIds.length > 0;
  const stalledRunner = pid !== null && !healthyRunner;
  const incidents = fleetIncidents(docs);
  const pilotIncident = incidents.find((incident) => incident.key === 'approval-service-unavailable');
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
  if (pilotIncident) details.push(`approval service affects ${pilotIncident.affectedWorkstreams.length} outcome${pilotIncident.affectedWorkstreams.length === 1 ? '' : 's'}`);
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
  if (pilotIncident || capacityBlocked.length || degraded.length) {
    return {
      tone: 'warning',
      headline: pilotIncident || capacityBlocked.length ? 'Fleet has blocked dependencies' : 'Fleet is using fallback capacity',
      detail: `${details.join(' · ')}. Intended work remains durable; no gated external effect is assumed to have happened.`,
    };
  }
  if (sharedRunnerHealthy) {
    return {
      tone: 'healthy',
      headline: 'Weaver is running',
      detail: `${details.join(' · ')}. Fresh shared runner heartbeat${runner.sharedLiveRunnerIds.length === 1 ? '' : 's'}: ${runner.sharedLiveRunnerIds.join(', ')}.`,
    };
  }
  if (!healthyRunner) {
    return {
      tone: 'warning',
      headline: 'Runner is offline',
      detail: `${details.join(' · ')}. New requests are stored safely and will advance when a runner starts.`,
    };
  }
  return {
    tone: 'healthy',
    headline: 'Weaver is running',
    detail: details.join(' · '),
  };
}

function fleetStatus(docs: WorkstreamDoc[], board: FleetBoardView, runner: RunnerObservation): OperatorFleetView['status'] {
  const shared = /^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '');
  const { pid, stale, healthy } = runner;
  const incidents = fleetIncidents(docs);
  const affected = incidents.reduce((sum, incident) => sum + incident.affectedActions, 0);
  const needJobs = new Set(board.needs.map((need) => need.slug)).size;
  return {
    storage: {
      label: 'Shared data',
      value: shared ? 'Shared team database · Connected' : 'Local store · Connected',
      detail: shared ? 'Jobs, decisions, results, and shared knowledge come from one team database.' : 'This browser and the runner use this machine\'s local state.',
      tone: 'healthy',
    },
    execution: shared && pid === null ? {
      label: 'Agent execution',
      value: runner.sharedLiveRunnerIds.length
        ? `Running · ${runner.sharedLiveRunnerIds.join(', ')}`
        : 'Offline · no fresh runner heartbeat',
      detail: runner.sharedLiveRunnerIds.length
        ? 'Shared TTL heartbeats prove which execution hosts are currently available.'
        : 'Stored work is safe; no execution host has published a fresh shared heartbeat.',
      tone: runner.sharedLiveRunnerIds.length ? 'healthy' : 'warning',
    } : {
      label: 'Agent execution',
      value: healthy ? 'Running' : pid === null ? 'Offline' : 'Stalled',
      detail: healthy ? 'The local runner heartbeat is current.' : pid === null ? 'Stored work is safe and advances when a runner starts.' : 'A runner process exists, but its loop heartbeat is not healthy.',
      tone: healthy ? 'healthy' : stale || pid !== null ? 'critical' : 'warning',
    },
    attention: {
      label: 'Attention',
      value: board.needs.length ? `${board.needs.length} open ask${board.needs.length === 1 ? '' : 's'} across ${needJobs} job${needJobs === 1 ? '' : 's'}` : 'No human asks waiting',
      detail: affected ? `${affected} routine approval${affected === 1 ? ' is' : 's are'} grouped below as shared operational state.` : 'Shared dependency failures are grouped as incidents instead of repeated per job.',
      tone: board.needs.length ? 'warning' : 'healthy',
    },
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
  const incidents = fleetIncidents(docs);
  const stewardDoc = docs.find((doc) => doc.workstream.sourceKey === FLEET_ATTENTION_STEWARD_SOURCE_KEY);
  const stewardCard = stewardDoc
    ? Object.values(board.lanes).flat().find((card) => card.slug === stewardDoc.workstream.slug)
    : undefined;
  const runner = observeRunner(liveRunnerIds(await listRunnerPresence()));
  const revision = sha256(JSON.stringify(
    {
      docs: docs.map((doc) => [doc.workstream.slug, doc.revision]).sort(([a], [b]) => String(a).localeCompare(String(b))),
      runner,
    },
  )).slice(0, 20);
  return {
    docs,
    unreadable,
    managed,
    view: {
      board,
      groups: fleetGroups(board),
      scope: fleetScope(),
      health: fleetHealth(docs, board, unreadable, runner),
      status: fleetStatus(docs, board, runner),
      incidents,
      steward: stewardDoc ? {
        state: stewardDoc.workstream.status,
        title: 'Attention steward',
        detail: stewardCard?.next ?? stewardDoc.workstream.conclusion?.summary ?? 'Its durable position is available in the steward job.',
        slug: stewardDoc.workstream.slug,
      } : {
        state: 'not-configured',
        title: 'Attention steward',
        detail: 'A recurring Workstream can audit grouped incidents, repair reversible causes, and surface only the judgment that genuinely needs a person.',
      },
      intakeParents: docs
        .filter((doc) => doc.workstream.status === 'active')
        .map((doc) => ({ slug: doc.workstream.slug, title: doc.workstream.title }))
        .sort((a, b) => a.slug.localeCompare(b.slug)),
      revision,
    },
  };
}

const clerkBrowserByResponse = new WeakMap<ServerResponse, ClerkBrowserAssets>();

function secureHeaders(contentType: string, res?: ServerResponse): Record<string, string> {
  const clerk = res ? clerkBrowserByResponse.get(res) : undefined;
  const contentSecurityPolicy = clerk
    ? [
      "default-src 'none'",
      `connect-src 'self' ${clerk.frontendOrigin} https://*.protect.clerk.com:*`,
      "style-src 'unsafe-inline'",
      `script-src 'unsafe-inline' ${clerk.frontendOrigin} https://challenges.cloudflare.com https://*.protect.clerk.com`,
      "img-src 'self' https://img.clerk.com",
      "worker-src 'self' blob:",
      "frame-src https://challenges.cloudflare.com https://*.protect.clerk.com",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
    : "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  return {
    'content-type': contentType,
    'content-security-policy': contentSecurityPolicy,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=31536000',
    'cache-control': 'no-store',
  };
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = redactSecrets(html, loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('text/html; charset=utf-8', res), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendClerkHtml(res: ServerResponse, status: number, html: string, browser: ClerkBrowserAssets): void {
  clerkBrowserByResponse.set(res, browser);
  sendHtml(res, status, html);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = redactSecrets(JSON.stringify(value), loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('application/json; charset=utf-8', res), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, value: string): void {
  const body = redactSecrets(value, loadAllSecrets());
  res.writeHead(status, { ...secureHeaders('text/plain; charset=utf-8', res), 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/**
 * Railway and similar supervisors need a probe that cannot become a fleet
 * read API. Reaching this response means the configured StateStore completed
 * a real operation; the empty body deliberately reveals no fleet facts.
 */
function sendHealth(res: ServerResponse, status: 200 | 503): void {
  res.writeHead(status, {
    ...secureHeaders('text/plain; charset=utf-8', res),
    'content-length': '0',
  });
  res.end();
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...secureHeaders('text/plain; charset=utf-8', res), location });
  res.end('See Other');
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    ...secureHeaders('text/plain; charset=utf-8', res),
    'www-authenticate': 'Basic realm="Weaver", charset="UTF-8"',
  });
  res.end('Authentication required');
}

function forbidden(res: ServerResponse): void {
  res.writeHead(403, secureHeaders('text/plain; charset=utf-8', res));
  res.end('Same-origin request required');
}

function copyClerkHeaders(res: ServerResponse, headers: Headers): void {
  const blocked = new Set([
    'connection',
    'content-length',
    'content-security-policy',
    'content-type',
    'location',
    'strict-transport-security',
    'transfer-encoding',
    'x-content-type-options',
    'x-frame-options',
  ]);
  headers.forEach((value, name) => {
    if (!blocked.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') res.setHeader(name, value);
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
}

function clerkRedirect(res: ServerResponse, location: string, headers: Headers): void {
  copyClerkHeaders(res, headers);
  res.writeHead(307, { ...secureHeaders('text/plain; charset=utf-8', res), location });
  res.end('Temporary Redirect');
}

function authenticationUnavailable(res: ServerResponse): void {
  sendText(res, 503, 'Authentication is temporarily unavailable. Please try again.');
}

function localReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/board';
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '/board';
  }
  if (decoded.startsWith('//') || /[\\\r\n\0]/.test(decoded)) return '/board';
  const target = new URL(value, 'https://weaver.invalid');
  if (target.origin !== 'https://weaver.invalid'
    || target.pathname.startsWith('//')
    || /[\\\r\n\0]/.test(target.pathname)
    || ['/sign-in', '/access-denied', '/sign-out'].includes(target.pathname)) return '/board';
  return `${target.pathname}${target.search}${target.hash}`;
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
 * Browser credentials are replayed automatically, including on cross-site
 * form submissions. Clerk mode compares the complete canonical HTTPS origin;
 * legacy Basic mode compares Origin to the request host because a private
 * reverse proxy may terminate HTTPS in front of this HTTP server.
 * The page's no-referrer policy makes Chromium serialize Origin as `null` on
 * an ordinary same-origin HTML form navigation. That path is accepted only
 * with browser-controlled Fetch Metadata proving a same-origin document
 * navigation. A non-browser request with neither signal still fails closed.
 */
function isSameOriginPost(req: IncomingMessage, exactOrigin?: string): boolean {
  const value = req.headers.origin;
  const authority = requestAuthority(req);
  if (!authority) return false;
  if (value === undefined || value === 'null') {
    return req.headers['sec-fetch-site'] === 'same-origin'
      && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document';
  }
  if (typeof value !== 'string') return false;
  try {
    const origin = new URL(value);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    if (exactOrigin) return origin.origin === exactOrigin;
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
  if (url.searchParams.get('steward') === 'created') return 'Attention steward started. It will audit grouped incidents without acquiring approval authority.';
  if (url.searchParams.get('steward') === 'existing') return 'The fleet already has an attention steward.';
  if (url.searchParams.get('created') === '1') return 'Request stored. Weaver can pick it up as soon as execution is available.';
  if (url.searchParams.get('existing') === '1') return 'This source already has a Workstream. Your request was added there.';
  if (url.searchParams.get('added') === '1') return 'Information added. Weaver will reconcile it on the next pass.';
  if (url.searchParams.get('responded') === '1') return 'Response added. Weaver has been woken.';
  return undefined;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token?: string,
  clerk?: ClerkOperatorAuthenticator,
): Promise<void> {
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

  let actor: string;
  if (clerk) {
    let result;
    try {
      result = await clerk.authenticate(req);
    } catch {
      return authenticationUnavailable(res);
    }
    if (result.kind === 'redirect') return clerkRedirect(res, result.location, result.headers);
    copyClerkHeaders(res, result.headers);
    if (result.kind === 'unavailable') return authenticationUnavailable(res);
    if (result.kind === 'signed-out') {
      if (url.pathname.startsWith('/api/')) return sendText(res, 401, 'Authentication required');
      if (method === 'GET' && url.pathname === '/sign-in') {
        const returnTo = localReturnTo(url.searchParams.get('return_to'));
        return sendClerkHtml(res, 200, renderOperatorClerkAuthHtml(clerk.browser, 'sign-in', returnTo), clerk.browser);
      }
      const returnTo = localReturnTo(`${url.pathname}${url.search}`);
      return redirect(res, `/sign-in?return_to=${encodeURIComponent(returnTo)}`);
    }
    if (result.kind === 'forbidden') {
      if (method === 'GET' && url.pathname === '/access-denied') {
        return sendClerkHtml(res, 403, renderOperatorClerkAuthHtml(clerk.browser, 'access-denied'), clerk.browser);
      }
      return redirect(res, '/access-denied');
    }
    actor = safeActor(result.actor);
    if (method === 'GET' && url.pathname === '/sign-in') {
      return redirect(res, localReturnTo(url.searchParams.get('return_to')));
    }
    if (method === 'GET' && url.pathname === '/access-denied') return redirect(res, '/board');
  } else {
    const basicActor = actorFor(req, token);
    if (!basicActor) return unauthorized(res);
    actor = basicActor;
  }
  if (method === 'POST' && !isSameOriginPost(req, clerk?.publicOrigin)) return forbidden(res);

  if (clerk && method === 'POST' && url.pathname === '/sign-out') {
    return sendClerkHtml(res, 200, renderOperatorClerkAuthHtml(clerk.browser, 'sign-out'), clerk.browser);
  }

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
    return sendHtml(res, 200, renderOperatorBoardHtml({
      fleet: fleet.view,
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'GET' && url.pathname === '/fleet') {
    const fleet = await loadFleet();
    return sendHtml(res, 200, renderOperatorFleetHtml({
      fleet: fleet.view,
      actor,
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
    }));
  }

  if (method === 'POST' && url.pathname === '/fleet/attention-steward') {
    const result = await createFleetAttentionSteward(actor);
    return redirect(res, `/fleet?steward=${result.created ? 'created' : 'existing'}`);
  }

  if (method === 'GET' && url.pathname === '/new') {
    const fleet = await loadFleet();
    return sendHtml(res, 200, renderOperatorNewHtml({
      fleet: fleet.view,
      actor,
      requestId: randomUUID(),
      notice: noticeFrom(url),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
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
    return redirect(res, `/workstreams/${encodeURIComponent(slug)}?tab=activity&added=1`);
  }

  if (method === 'POST' && parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'responses') {
    const slug = parts[1]!;
    const doc = await load(slug);
    const form = await readForm(req);
    const sourceType = (form.get('need_source_type') ?? '').trim();
    const sourceId = (form.get('need_id') ?? '').trim();
    const submittedVersion = (form.get('need_version') ?? '').trim();
    const responseId = (form.get('response_id') ?? '').trim();
    if (!['attention', 'assignment', 'interaction'].includes(sourceType) || !sourceId || !submittedVersion) {
      throw new OperatorUiHttpError(400, 'The decision response is malformed');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(responseId)) {
      throw new OperatorUiHttpError(400, 'The response id is malformed');
    }
    const need = fleetNeeds([doc]).find((candidate) =>
      candidate.source.type === sourceType && candidate.source.id === sourceId,
    );
    if (!need || needVersion(need) !== submittedVersion) {
      throw new OperatorUiHttpError(409, 'This decision changed or is no longer open. Reload the job before responding.');
    }

    const presentation = presentNeed(need.summary);
    const labels = presentation.choices.map((choice) => choice.label);
    if (new Set(labels).size !== labels.length) {
      throw new OperatorUiHttpError(409, 'This decision has ambiguous options and cannot be answered from the browser.');
    }
    const choice = (form.get('choice') ?? '').trim();
    const custom = (form.get('custom') ?? '').trim();
    const note = (form.get('note') ?? '').trim();
    if (custom.length > MAX_MESSAGE_LENGTH || note.length > MAX_MESSAGE_LENGTH) {
      throw new OperatorUiHttpError(400, `A response field must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
    let answer: string;
    if (choice === 'custom') {
      if (!custom) throw new OperatorUiHttpError(400, 'A custom response is required');
      answer = `Other — ${custom}`;
    } else {
      const selected = presentation.choices.find((candidate) => candidate.label === choice);
      if (!selected) throw new OperatorUiHttpError(400, 'Choose one of the current options or write a custom response');
      answer = `${selected.label} — ${selected.text}`;
    }
    const summary = `Response to ${need.kind} request: ${answer}${note ? `\nCondition or note: ${note}` : ''}`;
    if (summary.length > MAX_MESSAGE_LENGTH) {
      throw new OperatorUiHttpError(400, `The complete response must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
    await recordObservation(slug, {
      source: `operator-ui-response:${actor}`,
      summary,
      ingressKey: `ui-response:${submittedVersion}:${responseId}:${sha256(summary).slice(0, 24)}`,
    });
    return redirect(res, `/workstreams/${encodeURIComponent(slug)}?tab=overview&responded=1`);
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
      ...secureHeaders('text/plain; charset=utf-8', res),
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
    const view = workstreamPage(doc, policies, fleet.managed.get(slug) ?? []);
    const primaryNeed = view.needs[0];
    return sendHtml(res, 200, renderOperatorWorkspaceHtml({
      fleet: fleet.view,
      actor,
      notice: noticeFrom(url),
      view,
      tab: workspaceTab(url.searchParams.get('tab')),
      responseId: randomUUID(),
      ...(clerk ? { signOutAction: '/sign-out' } : {}),
      ...(primaryNeed ? { needVersion: needVersion(primaryNeed) } : {}),
    }));
  }

  return sendHtml(res, 404, '<h1>Not found</h1>');
}

export async function startOperatorUi(opts: OperatorUiOptions = {}): Promise<RunningOperatorUi> {
  const host = opts.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host) && !opts.token && !opts.clerk) {
    throw new Error('Clerk authentication or WEAVER_UI_TOKEN is required when weaver ui binds beyond loopback');
  }
  const server = createServer((req, res) => {
    handle(req, res, opts.token, opts.clerk).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof OperatorUiHttpError) {
        sendText(res, error.status, `Request could not be stored\n\n${message}\n`);
        return;
      }
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
