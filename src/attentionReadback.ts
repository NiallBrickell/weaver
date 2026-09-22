/**
 * Needs-you cards that close themselves from facts.
 *
 * The founder is the fleet's bottleneck, and the queue drifted from reality:
 * cards asking about a PR stayed open for days after the PR merged, and
 * capacity cards outlived the outage that raised them by dozens of passes.
 * Nothing wrong was asked — the world simply moved and no one told the card.
 *
 * Two typed paths close a card here, both from the runner and both without a
 * model:
 *
 * - **External readback.** A card may declare `resolvesWhen` facts at raise
 *   time (a PR reaching MERGED/CLOSED, a Sentry issue reaching resolved/
 *   ignored). The runner reads each fact back from its provider on the HOST —
 *   the GitHub App READ token and the executor-only `WEAVER_SENTRY_READ_TOKEN`
 *   never reach a worker — and closes the card only on an exact typed answer.
 *   An error, a missing credential, or an unknown answer writes nothing: the
 *   card stays open (fail open, like the deconflict gate).
 * - **Capacity recovered.** A capacity card's ask is moot once its exact
 *   target has succeeded again (rule i: the fleet recovery ledger or a
 *   recorded pass/attempt), or once the card's own workstream has completed
 *   coordinator work / submitted worker work on ANY target since the card was
 *   raised (rule ii: the work is flowing again). Pure typed state, no API
 *   calls. Backoff records for routing are left exactly as they are.
 *
 * Prose never binds a card: a summary that mentions a PR is not a declared
 * fact (most such mentions are background to a still-live ask), so legacy
 * cards only ever get a hint Observation for the coordinator to judge
 * (attentionHints.ts), never an automatic close.
 *
 * A readback close is a system act: `resolvedBy` is `engine:*`, it never
 * increments `spend.humanInterventions`, and it wakes the workstream (active
 * streams only) so the coordinator reconciles the new fact. Everything reads
 * the runner's revision-validated document cache — including paused and idle
 * streams, which are never ticked — so the sweep never loops `load()` over the
 * fleet; one `load()` happens only for a card whose write lost a revision race.
 */

import { CAPACITY_RECOVERED_ACTOR, capacityCardFact, capacityTargetKey } from './capacity.js';
import { readFleetCapacity, type FleetCapacityLedger } from './fleetCapacity.js';
import { githubAppConfigured, mintGitHubAppToken } from './githubApp.js';
import { loadExecutorSecrets } from './secrets.js';
import { arrive, load, mutate, newId, RevisionConflictError } from './store.js';
import type {
  AttentionItem,
  ExternalFact,
  ExternalFactEvidence,
  WorkstreamDoc,
} from './types.js';

/** `resolvedBy` for a card closed by an external-fact readback. */
export const READBACK_ACTOR = 'engine:readback';
export { CAPACITY_RECOVERED_ACTOR };

/** At most this many facts per card: a card that needs more is not one ask. */
export const MAX_RESOLVES_WHEN_FACTS = 5;

export type GitHubPrStateFact = Extract<ExternalFact, { kind: 'github_pr_state' }>;
export type SentryIssueStatusFact = Extract<ExternalFact, { kind: 'sentry_issue_status' }>;
export type CapacityTargetUnblockedFact = Extract<ExternalFact, { kind: 'capacity_target_unblocked' }>;

// ---------------------------------------------------------------------------
// Declaration: validation of coordinator-declared facts

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SENTRY_ORG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Sentry short ids are the project's short name, a dash, and a base-32-ish
// sequence (GO-ZX, ERDO-BACKEND-1A2). Case-insensitive on input, stored upper.
const SENTRY_SHORT_ID = /^[A-Z0-9][A-Z0-9_.]*(?:-[A-Z0-9_.]+)*-[A-Z0-9]+$/;
const PR_STATES = new Set(['MERGED', 'CLOSED']);
const SENTRY_STATUSES = new Set(['resolved', 'ignored']);

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function closedList<T extends string>(value: unknown, allowed: Set<string>, where: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where} must be a non-empty array of ${[...allowed].join(' | ')}`);
  }
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw new Error(`${where} must contain only ${[...allowed].join(' | ')}, got ${JSON.stringify(item)}`);
    }
    if (!out.includes(item as T)) out.push(item as T);
  }
  return out;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value.trim();
}

/**
 * Validate a declared `resolves_when` list into typed facts, refusing the
 * whole list on any bad entry (a half-declared card would silently lose the
 * refused fact). `capacity_target_unblocked` is harness-owned: capacity cards
 * are raised and closed by the harness from typed capacity state, so a
 * coordinator may not declare one.
 */
export function parseExternalFacts(
  raw: unknown,
  options: { allowCapacity?: boolean } = {},
): ExternalFact[] {
  if (!Array.isArray(raw)) throw new Error('resolves_when must be an array of facts');
  if (raw.length === 0) throw new Error('resolves_when must declare at least one fact (omit it when none applies)');
  if (raw.length > MAX_RESOLVES_WHEN_FACTS) {
    throw new Error(`resolves_when declares ${raw.length} facts; at most ${MAX_RESOLVES_WHEN_FACTS} are allowed — a card that waits on more is not one ask`);
  }
  const facts: ExternalFact[] = [];
  raw.forEach((entry, index) => {
    const where = `resolves_when[${index}]`;
    const fact = record(entry, where);
    switch (fact.kind) {
      case 'github_pr_state': {
        const repo = nonEmptyString(fact.repo, `${where}.repo`);
        if (!GITHUB_REPO.test(repo) || repo.split('/').some((part) => part === '.' || part === '..')) {
          throw new Error(`${where}.repo must be an exact GitHub owner/name, got ${JSON.stringify(fact.repo)}`);
        }
        const number = fact.number;
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
          throw new Error(`${where}.number must be a positive integer PR number, got ${JSON.stringify(number)}`);
        }
        facts.push({
          kind: 'github_pr_state',
          repo,
          number,
          states: closedList<'MERGED' | 'CLOSED'>(fact.states, PR_STATES, `${where}.states`),
        });
        return;
      }
      case 'sentry_issue_status': {
        const org = nonEmptyString(fact.org, `${where}.org`);
        if (!SENTRY_ORG.test(org)) {
          throw new Error(`${where}.org must be a Sentry organization slug, got ${JSON.stringify(fact.org)}`);
        }
        const shortId = nonEmptyString(fact.shortId, `${where}.shortId`).toUpperCase();
        if (!SENTRY_SHORT_ID.test(shortId)) {
          throw new Error(`${where}.shortId must be a Sentry short id like PROJECT-1A2, got ${JSON.stringify(fact.shortId)}`);
        }
        facts.push({
          kind: 'sentry_issue_status',
          org,
          shortId,
          statuses: closedList<'resolved' | 'ignored'>(fact.statuses, SENTRY_STATUSES, `${where}.statuses`),
        });
        return;
      }
      case 'capacity_target_unblocked': {
        if (!options.allowCapacity) {
          throw new Error(`${where}: capacity_target_unblocked is harness-owned — capacity cards are raised and closed by the harness from typed capacity state`);
        }
        const role = fact.role;
        if (role !== 'coordinator' && role !== 'worker') {
          throw new Error(`${where}.role must be coordinator | worker`);
        }
        const target = record(fact.target, `${where}.target`);
        facts.push({
          kind: 'capacity_target_unblocked',
          role,
          target: {
            executor: nonEmptyString(target.executor, `${where}.target.executor`),
            provider: nonEmptyString(target.provider, `${where}.target.provider`),
            model: nonEmptyString(target.model, `${where}.target.model`),
          },
        });
        return;
      }
      default:
        throw new Error(`${where}.kind ${JSON.stringify(fact.kind)} is not a known fact — declare github_pr_state or sentry_issue_status`);
    }
  });
  return facts;
}

/** One human-readable line per declared fact, for the projection and UI. */
export function describeExternalFact(fact: ExternalFact): string {
  switch (fact.kind) {
    case 'github_pr_state':
      return `${fact.repo}#${fact.number} is ${fact.states.join(' or ')}`;
    case 'sentry_issue_status':
      return `Sentry ${fact.org}/${fact.shortId} is ${fact.statuses.join(' or ')}`;
    case 'capacity_target_unblocked':
      return `${fact.role} capacity on ${fact.target.executor}:${fact.target.provider}:${fact.target.model} works again`;
  }
}

// ---------------------------------------------------------------------------
// Readback IO — host-side only

export interface PrStateReadback {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt?: string;
  closedAt?: string;
  url?: string;
}

export interface SentryIssueReadback {
  status: string;
  url?: string;
}

/**
 * Injectable provider seam. `null` means "no answer" — not configured, no
 * credential, or nothing exact came back — and never closes a card. A thrown
 * error is a failed read: logged, and also never closes a card.
 */
export interface AttentionReadbackIO {
  githubPrStates(repo: string, numbers: number[]): Promise<Map<number, PrStateReadback> | null>;
  sentryIssueStatus(org: string, shortId: string): Promise<SentryIssueReadback | null>;
}

const READBACK_TIMEOUT_MS = 15_000;
const GITHUB_API_VERSION = '2026-03-10';

/** The App READ token for exactly this repository, or null when the host has
 * no GitHub App (local installs) or the mint fails — personal auth is never a
 * fallback. */
async function mintRepoReadToken(repo: string): Promise<string | null> {
  try {
    if (!githubAppConfigured()) return null;
    return await mintGitHubAppToken(repo, 'read');
  } catch {
    return null;
  }
}

/** Executor-only, reloaded per use like WEAVER_PILOT_TOKEN so rotation needs
 * no restart. A worker-visible SENTRY_AUTH_TOKEN is deliberately never read. */
function sentryReadToken(): string | undefined {
  const token = loadExecutorSecrets().WEAVER_SENTRY_READ_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function liveAttentionReadbackIO(deps: {
  fetch?: typeof globalThis.fetch;
  mintGitHubReadToken?: (repo: string) => Promise<string | null>;
  sentryToken?: () => string | undefined;
} = {}): AttentionReadbackIO {
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const mint = deps.mintGitHubReadToken ?? mintRepoReadToken;
  const sentry = deps.sentryToken ?? sentryReadToken;
  return {
    async githubPrStates(repo, numbers) {
      const token = await mint(repo);
      if (!token) return null;
      const [owner, name] = repo.split('/') as [string, string];
      const unique = [...new Set(numbers)].filter((n) => Number.isSafeInteger(n) && n > 0).sort((a, b) => a - b);
      if (!unique.length) return new Map();
      // Numbers are validated integers, so the aliases are safe to inline;
      // owner/name travel as variables.
      const fields = unique
        .map((n) => `pr${n}: pullRequest(number: ${n}) { number state mergedAt closedAt url }`)
        .join(' ');
      const response = await doFetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
          variables: { owner, name },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(READBACK_TIMEOUT_MS),
      });
      if (response.status !== 200) throw new Error(`GitHub GraphQL readback for ${repo} failed (HTTP ${response.status})`);
      const body = record(await response.json(), 'GitHub GraphQL response');
      const data = typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : null;
      const repository = data && typeof data.repository === 'object' && data.repository !== null
        ? data.repository as Record<string, unknown>
        : null;
      if (!repository) return null;
      const out = new Map<number, PrStateReadback>();
      for (const n of unique) {
        const pr = repository[`pr${n}`];
        if (typeof pr !== 'object' || pr === null) continue; // not found / no access — unknown
        const fields = pr as Record<string, unknown>;
        if (fields.number !== n) continue;
        if (fields.state !== 'OPEN' && fields.state !== 'MERGED' && fields.state !== 'CLOSED') continue;
        const mergedAt = optionalString(fields.mergedAt);
        const closedAt = optionalString(fields.closedAt);
        const url = optionalString(fields.url);
        out.set(n, {
          number: n,
          state: fields.state,
          ...(mergedAt ? { mergedAt } : {}),
          ...(closedAt ? { closedAt } : {}),
          ...(url ? { url } : {}),
        });
      }
      return out;
    },

    async sentryIssueStatus(org, shortId) {
      const token = sentry();
      if (!token) return null;
      const response = await doFetch(
        `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/shortids/${encodeURIComponent(shortId)}/`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(READBACK_TIMEOUT_MS),
        },
      );
      if (response.status !== 200) throw new Error(`Sentry readback for ${org}/${shortId} failed (HTTP ${response.status})`);
      const body = record(await response.json(), 'Sentry shortid response');
      if (typeof body.shortId === 'string' && body.shortId.toUpperCase() !== shortId.toUpperCase()) return null;
      const group = typeof body.group === 'object' && body.group !== null ? body.group as Record<string, unknown> : null;
      const status = group ? optionalString(group.status) : undefined;
      if (!status) return null;
      const url = group ? optionalString(group.permalink) : undefined;
      return { status, ...(url ? { url } : {}) };
    },
  };
}

// ---------------------------------------------------------------------------
// Throttle — runner memory only, nothing persisted per check

/** Re-check cadence by card age: 5m in the first hour, 15m in the first day,
 * hourly in the first week, then every 6h. The facts these cards wait on move
 * at human/merge cadence; a card that has waited a week will not be hurt by a
 * few hours of latency, and the fleet's API budget is not spent on it. */
export function readbackIntervalMs(ageMs: number): number {
  if (ageMs < 60 * 60_000) return 5 * 60_000;
  if (ageMs < 24 * 60 * 60_000) return 15 * 60_000;
  if (ageMs < 7 * 24 * 60 * 60_000) return 60 * 60_000;
  return 6 * 60 * 60_000;
}

// ---------------------------------------------------------------------------
// Capacity: typed-state rules (no API calls)

/** Latest proof, per exact capacity target, that a real call got through. */
export type CapacitySuccessIndex = Map<string, { at: string; source: string }>;

/** A recorded call that reached its provider — the same criterion the fleet
 * ledger uses (no infrastructure wait on the result). Crash-recovered attempts
 * prove nothing about the provider and are excluded. */
export function capacitySuccessIndex(
  docs: Iterable<WorkstreamDoc>,
  ledger: FleetCapacityLedger = { recovered: {} },
): CapacitySuccessIndex {
  const index: CapacitySuccessIndex = new Map();
  const note = (key: string, at: string, source: string) => {
    const current = index.get(key);
    if (!current || current.at < at) index.set(key, { at, source });
  };
  for (const [key, at] of Object.entries(ledger.recovered)) note(key, at, 'fleet recovery ledger');
  for (const doc of docs) {
    const slug = doc.workstream.slug;
    for (const pass of doc.passes) {
      if (pass.infrastructure || pass.outcome === 'running' || !pass.endedAt) continue;
      if (!pass.executor || !pass.provider || !pass.model) continue;
      note(capacityTargetKey({ executor: pass.executor, provider: pass.provider, model: pass.model }), pass.endedAt, `pass ${pass.id} in ${slug}`);
    }
    for (const assignment of doc.assignments) {
      for (const attempt of assignment.attempts) {
        if (attempt.infrastructure || !attempt.endedAt || attempt.terminalReason === 'crashed') continue;
        if (!attempt.executor || !attempt.provider || !attempt.model) continue;
        note(capacityTargetKey({ executor: attempt.executor, provider: attempt.provider, model: attempt.model }), attempt.endedAt, `attempt ${attempt.runId} in ${slug}`);
      }
    }
  }
  return index;
}

/**
 * Rule (ii): the card's own workstream has moved the same role's work on ANY
 * target since `since` — a completed coordinator pass, or a worker attempt
 * whose submission stands. Returns a one-line observation, or null.
 */
export function roleWorkFlowedSince(
  doc: WorkstreamDoc,
  role: 'coordinator' | 'worker',
  since: string,
): string | null {
  if (role === 'coordinator') {
    const pass = doc.passes.find((p) =>
      p.outcome === 'completed' && !p.infrastructure && !!p.endedAt && p.endedAt > since);
    return pass
      ? `coordinator pass ${pass.id} completed at ${pass.endedAt}${pass.model ? ` on ${pass.executor ?? '?'}:${pass.model}` : ''}`
      : null;
  }
  for (const assignment of doc.assignments) {
    if (!assignment.submission) continue;
    if (assignment.state !== 'awaiting_review' && assignment.state !== 'completed') continue;
    const attempt = assignment.attempts.at(-1);
    if (!attempt?.executor || !attempt.endedAt || attempt.infrastructure || attempt.endedAt <= since) continue;
    return `worker attempt ${attempt.runId} on ${assignment.id} submitted at ${attempt.endedAt} on ${attempt.executor}:${attempt.model ?? '?'}`;
  }
  return null;
}

/** Which capacity rule, if any, makes this card moot right now. */
export function capacityCardMoot(
  doc: WorkstreamDoc,
  item: AttentionItem,
  successes: CapacitySuccessIndex,
  at: string,
): ExternalFactEvidence | null {
  const fact = capacityCardFact(doc, item);
  if (!fact) return null;
  // Rule (i): the exact target succeeded after the card was raised — anywhere
  // in the fleet, since capacity is an account-level fact.
  const success = successes.get(capacityTargetKey(fact.target));
  if (success && success.at > item.createdAt) {
    return { fact, observed: `${capacityTargetKey(fact.target)} succeeded at ${success.at} (${success.source})`, at };
  }
  // Rule (ii): only for harness capacity cards — the role's work is flowing
  // again in this workstream, whichever target carried it.
  if (item.kind === 'capacity') {
    const flowed = roleWorkFlowedSince(doc, fact.role, item.createdAt);
    if (flowed) return { fact, observed: flowed, at };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The write

interface CardClosure {
  slug: string;
  attentionId: string;
  resolvedBy: typeof READBACK_ACTOR | typeof CAPACITY_RECOVERED_ACTOR;
  evidence: ExternalFactEvidence[];
}

function applyClosure(
  d: WorkstreamDoc,
  event: (type: string, summary: string, refs?: string[]) => void,
  closure: CardClosure,
): boolean {
  const att = d.attention.find((item) => item.id === closure.attentionId);
  if (!att || att.status !== 'open') return false;
  const at = new Date().toISOString();
  att.status = 'resolved';
  att.resolvedAt = at;
  att.resolvedBy = closure.resolvedBy;
  att.resolution = { by: closure.resolvedBy, evidence: closure.evidence };
  const observed = closure.evidence.map((e) => e.observed).join('; ');
  if (closure.resolvedBy === READBACK_ACTOR) {
    event('attention.readback_resolved', `${att.id} closed by readback — ${observed}`, [att.id]);
    // The fact may be exactly what the stream was waiting on (a merged PR
    // unblocks the next step), and a resolved card no longer suppresses the
    // quiescence backstop — wake so a fresh pass reconciles it. A paused or
    // done stream keeps its closed card and is woken only by its own resume.
    if (d.workstream.status === 'active') {
      d.wakes.push({
        id: newId('wake'),
        reason: `${att.kind} ${att.id} closed by readback: ${observed.slice(0, 200)} — reconcile`,
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: at,
      });
    }
  } else {
    // Capacity recovery changes no plan: the stream already has its own
    // retry wakes, and routing state is untouched, so no wake is added.
    event('attention.capacity_recovered', `${att.id} closed — capacity ask is moot: ${observed}`, [att.id]);
  }
  // Deliberately NOT spend.humanInterventions: this is a system act.
  return true;
}

/**
 * Close one card with one write. The first attempt is revision-checked
 * against the cached document the decision was made on, so an unchanged
 * stream gets exactly one write and a card closed concurrently is a no-op.
 * On a lost race the card is re-read once; still open → one arrival.
 */
async function closeCard(cachedRevision: number, closure: CardClosure): Promise<boolean> {
  let closed = false;
  const mutator = (d: WorkstreamDoc, event: (type: string, summary: string, refs?: string[]) => void) => {
    closed = applyClosure(d, event, closure);
  };
  try {
    await mutate(closure.slug, cachedRevision, mutator);
    return closed;
  } catch (error) {
    if (!(error instanceof RevisionConflictError)) throw error;
  }
  const fresh = await load(closure.slug);
  if (!fresh.attention.some((item) => item.id === closure.attentionId && item.status === 'open')) return false;
  await arrive(closure.slug, mutator);
  return closed;
}

// ---------------------------------------------------------------------------
// The sweep

function factKey(fact: GitHubPrStateFact | SentryIssueStatusFact): string {
  return fact.kind === 'github_pr_state'
    ? `gh:${fact.repo.toLowerCase()}#${fact.number}`
    : `sentry:${fact.org.toLowerCase()}/${fact.shortId.toUpperCase()}`;
}

function externalFacts(item: AttentionItem): Array<GitHubPrStateFact | SentryIssueStatusFact> {
  return (item.resolvesWhen?.any ?? []).filter(
    (fact): fact is GitHubPrStateFact | SentryIssueStatusFact =>
      fact.kind === 'github_pr_state' || fact.kind === 'sentry_issue_status',
  );
}

export interface AttentionReadbackSweepOptions {
  io?: AttentionReadbackIO;
  /** Wall clock (ms) for the throttle; injectable for tests. */
  now?: number;
  /** Fleet recovery ledger; defaults to this host's ledger file. */
  ledger?: FleetCapacityLedger;
}

/**
 * One pass over the runner's cached documents. `nextCheckAt` is the runner's
 * in-memory throttle (attention id → earliest next external read); a restart
 * forgets it and simply checks each card once more. Returns the number of
 * cards closed.
 */
export async function sweepAttentionReadbacks(
  docs: ReadonlyMap<string, WorkstreamDoc>,
  nextCheckAt: Map<string, number>,
  log: (line: string) => void,
  options: AttentionReadbackSweepOptions = {},
): Promise<number> {
  const io = options.io ?? liveAttentionReadbackIO();
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const open: Array<{ slug: string; doc: WorkstreamDoc; item: AttentionItem }> = [];
  for (const [slug, doc] of docs) {
    for (const item of doc.attention) if (item.status === 'open') open.push({ slug, doc, item });
  }
  const openIds = new Set(open.map(({ item }) => item.id));
  for (const id of nextCheckAt.keys()) if (!openIds.has(id)) nextCheckAt.delete(id);

  const closures: Array<{ revision: number; closure: CardClosure }> = [];

  // Capacity cards: typed state only, so no read throttle is needed — the map
  // only holds back a card whose closing write recently failed.
  const successes = capacitySuccessIndex(docs.values(), options.ledger ?? readFleetCapacity());
  for (const { slug, doc, item } of open) {
    if (externalFacts(item).length === 0 && (nextCheckAt.get(item.id) ?? 0) > now) continue;
    const evidence = capacityCardMoot(doc, item, successes, at);
    if (evidence) {
      closures.push({
        revision: doc.revision,
        closure: { slug, attentionId: item.id, resolvedBy: CAPACITY_RECOVERED_ACTOR, evidence: [evidence] },
      });
    }
  }
  const closingCapacity = new Set(closures.map(({ closure }) => closure.attentionId));

  // External facts: only cards whose throttle window has elapsed.
  const due = open.filter(({ item }) =>
    !closingCapacity.has(item.id) &&
    externalFacts(item).length > 0 &&
    (nextCheckAt.get(item.id) ?? 0) <= now);
  for (const { item } of due) {
    const age = Math.max(0, now - Date.parse(item.createdAt));
    nextCheckAt.set(item.id, now + readbackIntervalMs(Number.isFinite(age) ? age : 0));
  }
  const prNumbersByRepo = new Map<string, { repo: string; numbers: Set<number> }>();
  const sentryIssues = new Map<string, SentryIssueStatusFact>();
  for (const { item } of due) {
    for (const fact of externalFacts(item)) {
      if (fact.kind === 'github_pr_state') {
        const key = fact.repo.toLowerCase();
        const entry = prNumbersByRepo.get(key) ?? { repo: fact.repo, numbers: new Set<number>() };
        entry.numbers.add(fact.number);
        prNumbersByRepo.set(key, entry);
      } else {
        sentryIssues.set(factKey(fact), fact);
      }
    }
  }
  const observations = new Map<string, { observed: string; url?: string; value: string }>();
  for (const [key, { repo, numbers }] of prNumbersByRepo) {
    try {
      const states = await io.githubPrStates(repo, [...numbers]);
      for (const [number, pr] of states ?? []) {
        const when = pr.state === 'MERGED' ? pr.mergedAt : pr.state === 'CLOSED' ? pr.closedAt : undefined;
        observations.set(`gh:${key}#${number}`, {
          value: pr.state,
          observed: `${repo}#${number} ${pr.state}${when ? ` at ${when}` : ''}`,
          ...(pr.url ? { url: pr.url } : {}),
        });
      }
    } catch (error) {
      log(`[run] attention readback: ${repo} PR states unreadable (${error instanceof Error ? error.message : error}) — cards stay open`);
    }
  }
  for (const [key, fact] of sentryIssues) {
    try {
      const issue = await io.sentryIssueStatus(fact.org, fact.shortId);
      if (issue) {
        observations.set(key, {
          value: issue.status,
          observed: `Sentry ${fact.org}/${fact.shortId} ${issue.status}`,
          ...(issue.url ? { url: issue.url } : {}),
        });
      }
    } catch (error) {
      log(`[run] attention readback: Sentry ${fact.org}/${fact.shortId} unreadable (${error instanceof Error ? error.message : error}) — card stays open`);
    }
  }
  for (const { slug, doc, item } of due) {
    const evidence: ExternalFactEvidence[] = [];
    for (const fact of externalFacts(item)) {
      const seen = observations.get(factKey(fact));
      if (!seen) continue;
      const holds = fact.kind === 'github_pr_state'
        ? (fact.states as string[]).includes(seen.value)
        : (fact.statuses as string[]).includes(seen.value);
      if (holds) evidence.push({ fact, observed: seen.observed, ...(seen.url ? { url: seen.url } : {}), at });
    }
    if (evidence.length) {
      closures.push({
        revision: doc.revision,
        closure: { slug, attentionId: item.id, resolvedBy: READBACK_ACTOR, evidence },
      });
    }
  }

  let closed = 0;
  for (const { revision, closure } of closures) {
    try {
      if (await closeCard(revision, closure)) {
        closed += 1;
        nextCheckAt.delete(closure.attentionId);
        log(`[run] ${closure.slug}: ${closure.attentionId} closed (${closure.resolvedBy}) — ${closure.evidence.map((e) => e.observed).join('; ')}`);
      }
    } catch (error) {
      nextCheckAt.set(closure.attentionId, now + readbackIntervalMs(0));
      log(`[run] ${closure.slug}: closing ${closure.attentionId} failed (${error instanceof Error ? error.message : error}) — retried on a later sweep`);
    }
  }
  return closed;
}
