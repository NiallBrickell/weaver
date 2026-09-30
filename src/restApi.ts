/**
 * The bearer-authenticated JSON API under `/api/v1/` on `weaver ui`.
 *
 * `weaver serve` stays private on the execution host, so machine clients (a
 * team page, a native app) read the fleet from the public browser-workspace
 * process instead. These routes own their auth completely and never see the
 * Clerk/Basic session that guards the browser pages:
 *
 *  - `WEAVER_READ_TOKEN` may GET every resource.
 *  - `WEAVER_RESPOND_TOKEN` may GET, and may also answer an open card.
 *
 * A token whose variable is unset is disabled; with neither set, every call is
 * 401. There is no same-origin check because nothing here rides a cookie.
 *
 * The API adds no authority. Answering a card is the same untrusted
 * Observation the browser form records (src/needResponses.ts) — it wakes the
 * Workstream, and the coordinator still decides what the answer means.
 *
 * Egress: a hosted store bills every document body it sends, and a full-fleet
 * `load()` per request is exactly the pattern that twice became the dominant
 * Railway charge (see AGENTS.md, "Never loop load() over the fleet"). The
 * workstream list therefore reads the narrow `listWorkstreamHeads()` and loads
 * a body only for a slug whose revision changed since this process last saw
 * it (the same head-validated pattern as the runner's `RunnerWorkstreamCache`),
 * and even that head read is shared by every caller for LIST_TTL_MS.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { virtualNow } from './clock.js';
import { dispositionOf } from './conclusion.js';
import { liveRunnerIds } from './coordinatorRunner.js';
import { NeedResponseError, needVersion, recordNeedResponse } from './needResponses.js';
import { loadAllSecrets, redactSecrets } from './secrets.js';
import {
  listRunnerPresence,
  listWorkstreamHeads,
  load,
  workstreamExists,
  type RunnerPresence,
  type WorkstreamHead,
} from './store.js';
import { workstreamTimeline, type TimelineAssignment, type TimelineEntry } from './timeline.js';
import type { Assignment, Wake, WorkstreamDoc } from './types.js';
import { displayText, presentNeed, workstreamNeeds } from './ui/inspect/model.js';

export const API_PREFIX = '/api/v1/';
/** How long one workstream listing is shared by every caller. */
export const LIST_TTL_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;
const DEFAULT_ASSIGNMENT_LIMIT = 50;
const MAX_ASSIGNMENT_LIMIT = 500;
const RECENT_DECISIONS = 10;
const API_ACTOR = 'api:team';

export interface RestApiTokens {
  /** Bearer token that may only read. Unset disables it. */
  read?: string;
  /** Bearer token that may read and answer open cards. Unset disables it. */
  respond?: string;
}

export function restApiTokensFromEnv(env: NodeJS.ProcessEnv = process.env): RestApiTokens {
  const read = env.WEAVER_READ_TOKEN?.trim();
  const respond = env.WEAVER_RESPOND_TOKEN?.trim();
  return { ...(read ? { read } : {}), ...(respond ? { respond } : {}) };
}

// ---------------------------------------------------------------------------
// Resource shapes (snake_case on the wire)

export interface ApiWait {
  kind: 'scheduled' | 'watching' | 'due_now' | 'provider_limit' | 'rate_limit';
  summary: string;
  until?: string;
}

export interface ApiNeed {
  workstream: string;
  source_type: 'attention' | 'assignment' | 'interaction';
  source_id: string;
  version: string;
  kind: string;
  title: string;
  text: string;
  choices: Array<{ label: string; text: string }>;
  created_at: string | null;
}

export interface ApiWorkstreamSummary {
  slug: string;
  title: string;
  status: WorkstreamDoc['workstream']['status'];
  tags: string[];
  objective_excerpt: string;
  current_assignment: { id: string; title: string; status: Assignment['state']; started_at: string | null } | null;
  waiting: ApiWait[];
  needs_count: number;
  runner_id: string | null;
  updated_at: string;
  revision: number;
  source_key: string | null;
}

export interface ApiEvent {
  id: string;
  ts: string;
  kind: string;
  message: string;
}

function excerpt(text: string, max: number): string {
  const line = displayText(text);
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${cut.slice(0, boundary > max * 0.65 ? boundary : cut.length).trimEnd()}…`;
}

/** The last time anything was written: the newest event, else creation. */
function updatedAt(doc: WorkstreamDoc): string {
  let latest = Date.parse(doc.workstream.createdAt);
  for (const event of doc.events) {
    const at = Date.parse(event.at);
    if (Number.isFinite(at) && (!Number.isFinite(latest) || at > latest)) latest = at;
  }
  return Number.isFinite(latest) ? new Date(latest).toISOString() : doc.workstream.createdAt;
}

/** Running work first, then the newest work still on its way. */
function currentAssignment(doc: WorkstreamDoc): ApiWorkstreamSummary['current_assignment'] {
  const pick = (states: Assignment['state'][]) =>
    [...doc.assignments].reverse().find((assignment) => states.includes(assignment.state));
  const current = pick(['running']) ?? pick(['gated', 'awaiting_review', 'queued']);
  if (!current) return null;
  return {
    id: current.id,
    title: excerpt(current.objective, 160),
    status: current.state,
    started_at: current.attempts.at(-1)?.startedAt ?? null,
  };
}

function waitOf(wake: Wake): ApiWait {
  if (wake.infrastructure) {
    const model = wake.infrastructure.model ? ` (${wake.infrastructure.model})` : '';
    return {
      kind: 'provider_limit',
      summary: `Waiting for the AI model${model} to become available again`,
      until: wake.infrastructure.retryAt,
    };
  }
  if (wake.executionSafety) {
    return {
      kind: 'rate_limit',
      summary: 'Pausing briefly because it started a lot of runs in a short time',
      until: wake.executionSafety.blockedUntil,
    };
  }
  const summary = excerpt(wake.reason, 200);
  switch (wake.condition.type) {
    case 'time': return { kind: 'scheduled', summary, until: wake.condition.dueAtVirtual };
    case 'wall_time': return { kind: 'scheduled', summary, until: wake.condition.dueAt };
    case 'probe': return { kind: wake.condition.satisfiedBy ? 'due_now' : 'watching', summary };
    // Immediate wakes carry harness bookkeeping as their reason ("new
    // observation from …"); a teammate only needs to know it is due.
    case 'immediate': return { kind: 'due_now', summary: 'Ready to continue' };
  }
}

function waitsOf(doc: WorkstreamDoc): ApiWait[] {
  return doc.wakes.filter((wake) => wake.status === 'pending').map(waitOf);
}

export function needsOf(doc: WorkstreamDoc): ApiNeed[] {
  return workstreamNeeds(doc).map((need) => {
    const presentation = presentNeed(need.summary);
    return {
      workstream: need.slug,
      source_type: need.source.type,
      source_id: need.source.id,
      version: needVersion(need),
      kind: need.kind,
      title: presentation.headline,
      text: presentation.full,
      choices: presentation.choices,
      created_at: need.at ?? null,
    };
  });
}

export function workstreamSummary(doc: WorkstreamDoc): ApiWorkstreamSummary {
  const ws = doc.workstream;
  return {
    slug: ws.slug,
    title: ws.title,
    status: ws.status,
    tags: [...ws.tags],
    objective_excerpt: excerpt(ws.objective, 200),
    current_assignment: currentAssignment(doc),
    waiting: waitsOf(doc),
    needs_count: workstreamNeeds(doc).length,
    runner_id: ws.assignmentRunnerId ?? ws.executionPolicy?.coordinatorRunnerOrder[0] ?? null,
    updated_at: updatedAt(doc),
    revision: doc.revision,
    source_key: ws.sourceKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// The cheap fleet index

interface IndexedWorkstream {
  summary: ApiWorkstreamSummary;
  needs: ApiNeed[];
}

export interface WorkstreamIndexDeps {
  heads?: () => Promise<WorkstreamHead[]>;
  load?: (slug: string) => Promise<WorkstreamDoc>;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Every workstream's summary and open cards, derived only from documents
 * whose revision changed. Each refresh reads `listWorkstreamHeads()` — slug
 * and revision, no bodies — and calls `load()` only for a head that is new or
 * whose revision differs from the one this entry was derived from; an
 * unchanged workstream costs nothing beyond its head row. Only the small
 * derived entry is kept, never the document, so a fleet of multi-megabyte
 * routine documents does not stay resident in the UI process. On Postgres the
 * load of a changed head is itself validated by the row's change token.
 * Deleted or unreadable heads drop out, exactly as the runner's scan does.
 */
export class WorkstreamIndex {
  private readonly heads: () => Promise<WorkstreamHead[]>;
  private readonly loadDoc: (slug: string) => Promise<WorkstreamDoc>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private entries = new Map<string, IndexedWorkstream & { revision: number }>();
  private snapshot: { at: number; rows: IndexedWorkstream[] } | undefined;
  private inflight: Promise<IndexedWorkstream[]> | undefined;

  constructor(deps: WorkstreamIndexDeps = {}) {
    this.heads = deps.heads ?? listWorkstreamHeads;
    this.loadDoc = deps.load ?? load;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? LIST_TTL_MS;
  }

  async rows(): Promise<IndexedWorkstream[]> {
    if (this.snapshot && this.now() - this.snapshot.at < this.ttlMs) return this.snapshot.rows;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<IndexedWorkstream[]> {
    const heads = await this.heads();
    const next = new Map<string, IndexedWorkstream & { revision: number }>();
    for (const head of heads) {
      const cached = this.entries.get(head.slug);
      if (cached?.revision === head.revision) {
        next.set(head.slug, cached);
        continue;
      }
      try {
        const doc = await this.loadDoc(head.slug);
        if (doc.workstream.slug !== head.slug || !Number.isInteger(doc.revision)) continue;
        next.set(head.slug, { revision: head.revision, summary: workstreamSummary(doc), needs: needsOf(doc) });
      } catch {
        // Deleted between the head read and the load, or unreadable now.
        // Never keep an old entry merely because its replacement failed.
      }
    }
    this.entries = next;
    const rows = [...next.values()].map(({ summary, needs }) => ({ summary, needs }));
    this.snapshot = { at: this.now(), rows };
    return rows;
  }
}

// ---------------------------------------------------------------------------
// Plain-English events from the typed timeline

const SYSTEM_ACTORS = new Set(['coordinator', 'worker', 'fleet-capacity', 'capacity-probe', 'system']);

function actorName(by: string | undefined): string {
  if (!by || by === 'human') return 'A person';
  if (by.startsWith('engine:') || SYSTEM_ACTORS.has(by)) return 'Weaver';
  if (by === 'pilot') return 'Pilot';
  return by;
}

function assignmentPrefix(a: TimelineAssignment): string {
  const action = a.kind === 'action';
  if (a.adoption === 'accepted') return action ? 'Done' : 'Finished and accepted';
  if (a.adoption === 'rejected') return 'Result not accepted';
  if (a.adoption === 'superseded') return 'Replaced by newer work';
  if (a.adoption === 'proposed') return 'Finished, waiting for review';
  switch (a.state) {
    case 'gated': return 'Waiting for approval';
    case 'queued': return action ? 'Planned an action' : 'Queued work';
    case 'running': return 'Working on';
    case 'awaiting_review': return 'Finished, waiting for review';
    case 'completed': return 'Done';
    case 'failed': return 'Work failed';
    case 'cancelled': return 'Cancelled';
  }
}

function conclusionPrefix(entry: Extract<TimelineEntry, { type: 'conclusion' }>, doc: WorkstreamDoc): string {
  switch (entry.disposition) {
    case 'delivered': return 'Finished and delivered';
    case 'no_change_needed': return 'Finished: no change was needed';
    case 'not_worth_doing': return 'Closed as not worth doing';
    case 'duplicate': return `Closed as a duplicate of ${doc.workstream.conclusion?.duplicateOf ?? 'another job'}`;
    case 'directed_closed': return 'Closed at a person’s request';
    case 'unclassified': return 'Finished';
  }
}

function withNote(text: string, note: string | undefined): string {
  return note ? `${text} — ${excerpt(note, 200)}` : text;
}

/** One sentence a teammate reads without knowing Weaver. Null for rows that
 * are not events (an ongoing wait is a state, not something that happened). */
function eventOf(entry: TimelineEntry, doc: WorkstreamDoc): ApiEvent | null {
  const base = { id: entry.key, ts: entry.at };
  switch (entry.type) {
    case 'assignment': {
      const a = entry.assignment;
      const tries = a.attempts > 1 ? ` (${a.attempts} tries)` : '';
      return { ...base, kind: a.kind === 'action' ? 'action' : 'work', message: `${assignmentPrefix(a)}: ${excerpt(a.objective, 200)}${tries}` };
    }
    case 'retries': {
      const last = entry.steps.at(-1)!;
      return {
        ...base,
        kind: entry.kind === 'action' ? 'action' : 'work',
        message: `Tried ${entry.steps.length} times: ${excerpt(last.objective, 200)} — latest: ${assignmentPrefix(last).toLowerCase()}`,
      };
    }
    case 'decision': {
      const who = entry.madeBy === 'human' ? 'A person decided' : 'Decided';
      const replaces = entry.supersedes ? ` (replacing “${excerpt(entry.supersedes.title, 120)}”)` : '';
      return { ...base, kind: 'decision', message: `${who}: ${excerpt(entry.title, 200)}${replaces}` };
    }
    case 'cycle':
      return { ...base, kind: 'cycle', message: `Started round ${entry.cycle}: ${excerpt(entry.label, 200)}` };
    case 'steer':
      return {
        ...base,
        kind: 'direction',
        message: `${actorName(entry.by)} gave direction: ${excerpt(entry.body, 200)}${entry.withdrawn ? ' (later withdrawn)' : ''}`,
      };
    case 'verdict': {
      const who = actorName(entry.by);
      const subject = excerpt(entry.subject, 200);
      const text = entry.on === 'result'
        ? `${who} ${entry.verdict === 'rejected' ? 'turned down' : 'accepted'} the result of: ${subject}`
        : entry.on === 'send'
          ? `${who} ${entry.verdict === 'rejected' ? 'turned down sending' : 'approved sending'}: ${subject}`
          : `${who} ${entry.verdict === 'rejected' ? 'turned down' : 'approved'}: ${subject}`;
      return { ...base, kind: 'approval', message: withNote(text, entry.note) };
    }
    case 'attention':
      if (entry.phase === 'asked') return { ...base, kind: 'question', message: `Asked for help: ${excerpt(entry.summary, 200)}` };
      return {
        ...base,
        kind: 'question',
        message: entry.by && !entry.by.startsWith('engine:') && !SYSTEM_ACTORS.has(entry.by)
          ? `${actorName(entry.by)} answered: ${excerpt(entry.summary, 200)}`
          : `No longer needed: ${excerpt(entry.summary, 200)}`,
      };
    case 'conclusion':
      return { ...base, kind: 'finished', message: `${conclusionPrefix(entry, doc)}: ${excerpt(entry.summary, 200)}` };
    case 'gap':
      if (entry.ongoing) return null;
      return { ...base, kind: 'wait', message: `Waited ${entry.label}${entry.reason ? `: ${excerpt(entry.reason, 200)}` : ''}` };
  }
}

export function workstreamEvents(doc: WorkstreamDoc, now = virtualNow()): ApiEvent[] {
  return workstreamTimeline(doc, { now, limit: 'all' }).entries
    .map((entry) => eventOf(entry, doc))
    .filter((event): event is ApiEvent => event !== null);
}

function eventCursor(event: ApiEvent): string {
  return Buffer.from(JSON.stringify([event.ts, event.id])).toString('base64url');
}

function parseCursor(value: string): { ts: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    const ts = Date.parse(parsed[0]);
    return Number.isFinite(ts) ? { ts, id: parsed[1] } : null;
  } catch {
    return null;
  }
}

/** Oldest first. Without `after`, the newest `limit` events; with it, the
 * next `limit` after that cursor. The cursor names the last event returned
 * (or echoes `after` when nothing is newer). A cursor whose event has since
 * been folded into another row resumes from its timestamp. */
export function pageEvents(events: ApiEvent[], after: string | null, limit: number): { events: ApiEvent[]; cursor: string | null } {
  let page: ApiEvent[];
  if (after === null) {
    page = events.slice(Math.max(0, events.length - limit));
  } else {
    const cursor = parseCursor(after);
    if (!cursor) throw new ApiError(400, 'after must be a cursor returned by this endpoint');
    const index = events.findIndex((event) => event.id === cursor.id && Date.parse(event.ts) === cursor.ts);
    const rest = index >= 0 ? events.slice(index + 1) : events.filter((event) => Date.parse(event.ts) > cursor.ts);
    page = rest.slice(0, limit);
  }
  const last = page.at(-1);
  return { events: page, cursor: last ? eventCursor(last) : after };
}

// ---------------------------------------------------------------------------
// HTTP

class ApiError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 405 | 409, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = redactSecrets(JSON.stringify(value), loadAllSecrets());
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000',
    ...extra,
  });
  res.end(body);
}

function tokenMatches(presented: Buffer, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

type Role = 'read' | 'respond';

function roleOf(req: IncomingMessage, tokens: RestApiTokens): Role | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const presented = Buffer.from(header.slice('Bearer '.length));
  if (!presented.length) return null;
  // Compare against both so timing does not reveal which token exists.
  const respond = tokenMatches(presented, tokens.respond);
  const read = tokenMatches(presented, tokens.read);
  return respond ? 'respond' : read ? 'read' : null;
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new ApiError(400, `${name} must be a positive integer`);
  return Math.min(value, max);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(400, 'Content-Type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(400, 'request body too large');
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'request body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'request body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, `${key} must be a string`);
  return value;
}

async function loadExisting(slug: string): Promise<WorkstreamDoc> {
  if (!(await workstreamExists(slug))) throw new ApiError(404, 'Workstream not found');
  try {
    return await load(slug);
  } catch {
    throw new ApiError(404, 'Workstream not found');
  }
}

function assignmentView(a: Assignment) {
  const last = a.attempts.at(-1);
  const cost = a.attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
  return {
    id: a.id,
    title: excerpt(a.objective, 160),
    objective: a.objective,
    kind: a.kind === 'action' ? 'action' : 'work',
    status: a.state,
    review: a.adoption.state,
    acceptance_criteria: [...a.acceptanceCriteria],
    created_at: a.createdAtVirtual,
    result_summary: a.submission?.summary ?? null,
    attempts: {
      count: a.attempts.length,
      total_cost_usd: Math.round(cost * 10_000) / 10_000,
      last: last ? {
        started_at: last.startedAt,
        ended_at: last.endedAt ?? null,
        executor: last.executor ?? null,
        provider: last.provider ?? null,
        model: last.model ?? null,
        ended_because: last.terminalReason ?? null,
      } : null,
    },
  };
}

function workstreamDetail(doc: WorkstreamDoc) {
  const decisions = [...doc.decisions]
    .sort((a, b) => Date.parse(b.decidedAtVirtual) - Date.parse(a.decidedAtVirtual))
    .slice(0, RECENT_DECISIONS)
    .map((decision) => ({
      id: decision.id,
      title: decision.title,
      rationale: decision.rationale,
      status: decision.status,
      made_by: decision.madeBy === 'human' ? 'person' : 'weaver',
      decided_at: decision.decidedAtVirtual,
      progress: decision.progress ? { label: decision.progress.label, next: decision.progress.next ?? null, at: decision.progress.atVirtual } : null,
    }));
  const conclusion = doc.workstream.conclusion;
  return {
    ...workstreamSummary(doc),
    objective: doc.workstream.objective,
    success_criteria: [...doc.workstream.successCriteria],
    created_at: doc.workstream.createdAt,
    decisions,
    deliverables: doc.deliverables.map((deliverable) => ({
      id: deliverable.id,
      title: deliverable.title,
      kind: deliverable.kind,
      created_at: deliverable.createdAtVirtual,
      accepted: !!deliverable.adopted,
      accepted_at: deliverable.adopted?.atVirtual ?? null,
    })),
    waits: doc.wakes.filter((wake) => wake.status === 'pending').map((wake) => ({ id: wake.id, created_at: wake.createdAt, ...waitOf(wake) })),
    needs: needsOf(doc),
    conclusion: conclusion ? { outcome: dispositionOf(conclusion), summary: conclusion.summary, at: conclusion.atVirtual } : null,
  };
}

function runnerView(presence: RunnerPresence, live: Set<string>, nowMs: number) {
  const seat = ({ executor, provider, model }: { executor: string; provider: string; model: string }) => ({ executor, provider, model });
  return {
    id: presence.runnerId,
    heartbeat_at: presence.heartbeatAt,
    age_seconds: Math.max(0, Math.round((nowMs - Date.parse(presence.heartbeatAt)) / 1000)),
    live: live.has(presence.runnerId),
    coordinator_seats: presence.coordinatorSeats?.map(seat) ?? null,
    worker_seats: presence.workerSeats?.map(seat) ?? null,
    degraded: presence.degraded ?? null,
  };
}

export interface RestApiOptions {
  tokens: RestApiTokens;
  index?: WorkstreamIndex;
  presences?: () => Promise<RunnerPresence[]>;
  now?: () => number;
}

export type RestApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRestApi(opts: RestApiOptions): RestApiHandler {
  const index = opts.index ?? new WorkstreamIndex();
  const presences = opts.presences ?? listRunnerPresence;
  const now = opts.now ?? Date.now;

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, role: Role): Promise<void> {
    const method = req.method ?? 'GET';
    let parts: string[];
    try {
      parts = url.pathname.slice(API_PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new ApiError(400, 'malformed path');
    }

    if (method === 'POST') {
      if (role !== 'respond') throw new ApiError(403, 'This token can only read');
      if (parts.length !== 6 || parts[0] !== 'workstreams' || parts[2] !== 'needs' || parts[5] !== 'responses') {
        throw new ApiError(404, 'Not found');
      }
      const slug = parts[1]!;
      await loadExisting(slug);
      const body = await readJsonBody(req);
      const version = optionalString(body, 'version');
      const responseId = optionalString(body, 'response_id');
      const choice = optionalString(body, 'choice')?.trim();
      const custom = optionalString(body, 'custom')?.trim();
      const note = optionalString(body, 'note');
      if (!version || !responseId) throw new ApiError(400, 'version and response_id are required');
      if (choice && custom && choice !== 'custom') throw new ApiError(400, 'Send either choice or custom, not both');
      if (!choice && !custom) throw new ApiError(400, 'choice or custom is required');
      const result = await recordNeedResponse(slug, {
        sourceType: parts[3]!,
        sourceId: parts[4]!,
        version,
        responseId,
        choice: choice && choice !== 'custom' ? choice : 'custom',
        ...(custom ? { custom } : {}),
        ...(note !== undefined ? { note } : {}),
      }, API_ACTOR);
      return sendJson(res, 201, { recorded: true, duplicate: result.duplicate, observation_id: result.observationId, workstream: slug });
    }

    if (method !== 'GET') throw new ApiError(405, 'Method not allowed');

    if (parts.length === 1 && parts[0] === 'workstreams') {
      const status = url.searchParams.get('status');
      const tag = url.searchParams.get('tag');
      const sinceRaw = url.searchParams.get('updated_since');
      const since = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
      if (sinceRaw && !Number.isFinite(since)) throw new ApiError(400, 'updated_since must be an ISO timestamp');
      if (status && !['active', 'paused', 'done'].includes(status)) throw new ApiError(400, 'status must be active, paused, or done');
      const limit = intParam(url, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const rows = (await index.rows())
        .map((row) => row.summary)
        .filter((summary) => !status || summary.status === status)
        .filter((summary) => !tag || summary.tags.includes(tag))
        .filter((summary) => !sinceRaw || Date.parse(summary.updated_at) >= since)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.slug.localeCompare(b.slug))
        .slice(0, limit);
      return sendJson(res, 200, { workstreams: rows });
    }

    if (parts.length === 2 && parts[0] === 'workstreams') {
      return sendJson(res, 200, workstreamDetail(await loadExisting(parts[1]!)));
    }

    if (parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'assignments') {
      const doc = await loadExisting(parts[1]!);
      const limit = intParam(url, 'limit', DEFAULT_ASSIGNMENT_LIMIT, MAX_ASSIGNMENT_LIMIT);
      const assignments = [...doc.assignments].reverse().slice(0, limit).map(assignmentView);
      return sendJson(res, 200, { assignments, total: doc.assignments.length });
    }

    if (parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'events') {
      const doc = await loadExisting(parts[1]!);
      const limit = intParam(url, 'limit', DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
      const after = url.searchParams.get('after');
      return sendJson(res, 200, pageEvents(workstreamEvents(doc), after || null, limit));
    }

    if (parts.length === 1 && parts[0] === 'needs') {
      const workstream = url.searchParams.get('workstream');
      // Open cards are derived at the same changed-revision boundary as the
      // listing, so this reads no document the listing has not already seen.
      const needs = (await index.rows())
        .filter((row) => row.summary.needs_count > 0 && (!workstream || row.summary.slug === workstream))
        .flatMap((row) => row.needs)
        .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.workstream.localeCompare(b.workstream));
      return sendJson(res, 200, { needs });
    }

    if (parts.length === 1 && parts[0] === 'runners') {
      const all = await presences();
      const nowMs = now();
      const live = new Set(liveRunnerIds(all, nowMs));
      const runners = [...all]
        .sort((a, b) => a.runnerId.localeCompare(b.runnerId))
        .map((presence) => runnerView(presence, live, nowMs));
      return sendJson(res, 200, { runners });
    }

    throw new ApiError(404, 'Not found');
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = roleOf(req, opts.tokens);
    if (!role) {
      return sendJson(res, 401, { error: 'A valid bearer token is required' }, { 'www-authenticate': 'Bearer realm="Weaver"' });
    }
    try {
      await route(req, res, url, role);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof ApiError || error instanceof NeedResponseError) {
        return sendJson(res, error.status, { error: error.message });
      }
      return sendJson(res, 500, { error: 'Weaver could not answer this request' });
    }
  };
}
