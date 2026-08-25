/**
 * `weaver do "<message>"` — the zero-ceremony entry point.
 *
 * The human's message IS the input. Slug, title, objective, success
 * criteria, and routine-ness are derived: by one fast model pass when the
 * machine's Claude login is available, deterministically when it is not — a
 * failed derivation must never block starting work, so the fallback is the
 * message verbatim (and the CLI says so: a silent fallback reads as a bug in
 * naming, not a degraded mode). The same pass de-dupes against the fleet: a
 * message that is really an update to work an existing workstream already
 * owns is delivered to that workstream as human steering instead of
 * forking a near-duplicate stream. Constraints are the HOUSE PACK, never
 * model-generated: the operating rules of this machine do not vary with how
 * a task is phrased. The pack itself is machine-local config (`house.json`
 * under WEAVER_HOME), never source — a public harness cannot hardcode one
 * operator's repos.
 */

import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from './secrets.js';
import { arrive, createWorkstream, listWorkstreams, load, newId } from './store.js';
import { localTextModel } from './modelConfig.js';
import { addSteering, setPaused } from './humanActs.js';
import { newExecutionSafety } from './executionSafety.js';

/** The machine's standing rules and repo knowledge, applied to every stream
 * this entry point creates. Overridden per machine by `house.json` under
 * WEAVER_HOME: `{ "constraints": [..], "repoMap": "..", "tags": [..] }`. */
export interface HousePack {
  /** Standing rules attached verbatim as workstream constraints. */
  constraints: string[];
  /** Free-text map of this machine's repos, injected into derivation so a
   * one-liner that only implies its repo ("the upload composer") still
   * expands to an objective that NAMES it. Empty means no map is known and
   * derivation says nothing about repos. */
  repoMap: string;
  /** Tags every onboarded workstream starts with (policy scoping). */
  tags: string[];
}

export const DEFAULT_HOUSE: HousePack = {
  constraints: [
    'Research first; every worker has the normal Claude Code toolset including the operator\'s configured MCP servers, used read AND write — keeping the systems a brief names in sync (a tracker issue\'s status, comments, labels) is ordinary reversible work, not a gated effect. Repository investigation and implementation happen in a fresh git worktree (branch from origin/main) — never in the user\'s checkouts. Irreversible egress — opening or merging a PR, deploying, spending, or sending a message to a person — remains a gated action',
    'Never paste credentials or connection strings into prompts, state, or artifacts; reference credentials as $NAME (the engine injects values)',
    'When blocked on credentials, external accounts, or anything only the human can supply, raise attention with a one-click ask instead of improvising',
    'Verification runs against tests, previews, and readbacks by default — never poke production. Only when the objective explicitly calls for post-merge verification in the live product may you check there, and then strictly read-only (browser tooling included)',
    'All dates in artifacts and commits use the real current date',
  ],
  repoMap: '',
  tags: [],
};

function mergeHouse(base: HousePack, raw: Partial<HousePack>): HousePack {
  return {
    constraints: Array.isArray(raw.constraints) ? raw.constraints.filter((c): c is string => typeof c === 'string') : base.constraints,
    repoMap: typeof raw.repoMap === 'string' ? raw.repoMap : base.repoMap,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : base.tags,
  };
}

/** Merge machine-local `house.json`, then an optional deployment-supplied
 * `WEAVER_HOUSE_JSON`, over the defaults. The environment form is the same
 * HousePack shape and lets a stateless UI and a separately hosted runner apply
 * one canonical repository map/tags without moving secrets into shared state.
 * A malformed source never blocks model-independent intake. */
export function loadHouse(): HousePack {
  const home = process.env.WEAVER_HOME ?? path.resolve(process.cwd(), 'state');
  let house = DEFAULT_HOUSE;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'house.json'), 'utf8')) as Partial<HousePack>;
    house = mergeHouse(house, raw);
  } catch { /* absent or malformed local pack: retain the defaults */ }
  if (process.env.WEAVER_HOUSE_JSON) {
    try {
      house = mergeHouse(house, JSON.parse(process.env.WEAVER_HOUSE_JSON) as Partial<HousePack>);
    } catch { /* malformed deployment pack: retain the safe local/default pack */ }
  }
  return house;
}

export interface Derived {
  slug: string;
  title: string;
  objective: string;
  successCriteria: string[];
  routine: boolean;
}

/** One existing stream as the derivation pass sees it for de-duping. */
export interface FleetCandidate {
  slug: string;
  status: string;
  title: string;
  createdAt: string;
}

/** The model either defines a new workstream or names the existing one this
 * message really belongs to. */
export type ParsedDerivation =
  | { kind: 'create'; derived: Derived }
  | { kind: 'attach'; slug: string };

export type OnboardResult =
  | {
      action: 'created';
      derived: Derived;
      /** Present when the model pass failed and the deterministic word-mash
       * fallback named the stream — the CLI surfaces this to the operator. */
      fallbackReason?: string;
    }
  | { action: 'steered'; slug: string; title: string; reopened: boolean };

/** Kebab, [a-z0-9-], bounded, non-empty; '-2', '-3'… on collision. */
export function sanitizeSlug(raw: string, taken: Set<string>): string {
  let s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (!s) s = 'task';
  if (!taken.has(s)) return s;
  for (let i = 2; ; i++) {
    const c = `${s}-${i}`;
    if (!taken.has(c)) return c;
  }
}

/** Deterministic derivation — used whenever the model pass fails. */
export function deriveFallback(message: string, taken: Set<string>, done?: string): Derived {
  const words = message
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((w) => w.length > 2)
    .slice(0, 4)
    .join('-');
  return {
    slug: sanitizeSlug(words || 'task', taken),
    title: message.slice(0, 70),
    objective: message,
    successCriteria: done ? [done] : [],
    routine: false,
  };
}

/** Strict-ish parse of the model's JSON (fenced or bare). */
export function parseDerivation(text: string, taken: Set<string>): ParsedDerivation | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Partial<Derived> & { attachTo?: unknown };
    if (typeof j.attachTo === 'string') {
      // Attaching only ever targets a workstream that actually exists — a
      // hallucinated slug falls through to ordinary creation.
      return taken.has(j.attachTo) ? { kind: 'attach', slug: j.attachTo } : null;
    }
    if (typeof j.slug !== 'string' || typeof j.title !== 'string' || typeof j.objective !== 'string') return null;
    return {
      kind: 'create',
      derived: {
        slug: sanitizeSlug(j.slug, taken),
        title: j.title.slice(0, 90),
        objective: j.objective,
        successCriteria: Array.isArray(j.successCriteria) ? j.successCriteria.filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
        routine: j.routine === true,
      },
    };
  } catch {
    return null;
  }
}

/** Newest-first digest of the fleet for the de-dupe decision, bounded so a
 * long tail of old concluded work never bloats a cheap derivation pass. */
async function fleetCandidates(slugs: string[]): Promise<FleetCandidate[]> {
  const out: FleetCandidate[] = [];
  for (const slug of slugs) {
    try {
      const d = await load(slug);
      out.push({
        slug,
        status: d.workstream.status,
        title: d.workstream.title.replace(/\s+/g, ' ').slice(0, 90),
        createdAt: d.workstream.createdAt,
      });
    } catch {
      // An unreadable stream can't be a de-dupe target.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 60);
}

async function deriveWithModel(
  message: string,
  taken: Set<string>,
  house: HousePack,
  candidates: FleetCandidate[],
  done?: string,
): Promise<{ parsed: ParsedDerivation | null; error?: string }> {
  const prompt = [
    `Turn this raw task message from the human into a workstream definition. Reply with ONLY a JSON object: {"slug", "title", "objective", "successCriteria": [..], "routine": bool}.`,
    ``,
    `- slug: 2-4 word kebab-case name`,
    `- objective: the human's ask, expanded into a self-contained brief a fresh agent can act on. PRESERVE every concrete detail verbatim (names, URLs, error text, repos); resolve relative dates against today (${new Date().toISOString().slice(0, 10)}); name likely evidence sources when the message implies them. Never invent requirements the message doesn't contain.`,
    ...(house.repoMap
      ? [
          `- when the message implies code work, name the repo(s) it most likely lives in from the map below (with the full path), and say scouting across the parent dir is the fallback if that guess is wrong — a wrong guess must redirect, not derail.`,
          ``,
          house.repoMap,
        ]
      : []),
    `- successCriteria: 1-3 checkable statements of done.${
      done
        ? ' The human EXPLICITLY stated what done means — it is the first criterion, meaning-preserved: ' + JSON.stringify(done)
        : ' Default bar for code work: root-caused/implemented, PR merged through the review loop, verification evidence in the PR. Do NOT include verifying in production unless the human asked for it.'
    }`,
    `- routine: true ONLY if the message describes recurring work (weekly, nightly, "keep doing X") — then state the cadence inside the objective and note that each completed cycle schedules the next via a time wake.`,
    ...(candidates.length
      ? [
          ``,
          `Existing workstreams in this fleet (slug [status] title):`,
          ...candidates.map((c) => `- ${c.slug} [${c.status}] ${c.title}`),
          ``,
          `If the human's message is an update to, a duplicate of, or a direct follow-up on ONE of these — the same work or the same outcome, not merely a related topic — reply instead with ONLY {"attachTo": "<slug>"}. The message is then delivered to that workstream as human steering, and a done or paused workstream is reopened with its history intact. When unsure, create a new workstream.`,
        ]
      : []),
    ``,
    `Message: ${JSON.stringify(message)}`,
  ].join('\n');
  try {
    let text = '';
    let errText = '';
    for await (const msg of query({
      prompt,
      options: {
        // NOT workerModel(): the worker model may be provider-prefixed for a
        // non-Claude executor, and this pass always runs through the local
        // Claude SDK — see localTextModel().
        model: localTextModel(),
        tools: [],
        allowedTools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
        maxTurns: 1,
        persistSession: false,
        env: sdkEnv(),
      },
    })) {
      if (msg.type === 'result' && 'result' in msg && typeof msg.result === 'string') {
        if (msg.is_error) errText = msg.result;
        else text = msg.result;
      }
    }
    const parsed = parseDerivation(text, taken);
    return {
      parsed,
      error: parsed
        ? undefined
        : text
          ? 'model reply was not a usable derivation'
          : errText || 'model pass produced no result',
    };
  } catch (e) {
    return { parsed: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Deliver the human's message as steering to the existing stream that
 * already owns this work, reopening it first when it is paused or concluded
 * (conclusion lineage is kept — this is `weaver resume` + `weaver steer`,
 * not a new identity). */
export async function attachToExisting(slug: string, message: string, done?: string): Promise<OnboardResult> {
  const doc = await load(slug);
  const reopened = doc.workstream.status !== 'active';
  if (reopened) await setPaused(slug, false);
  await addSteering(slug, done ? `${message}\n\nDone means: ${done}` : message);
  return { action: 'steered', slug, title: doc.workstream.title, reopened };
}

/** Create a workstream from one raw message (plus an optional explicit
 * statement of what done means) — or route the message to the existing
 * workstream it is really about. Returns what was decided. */
export async function onboard(message: string, done?: string): Promise<OnboardResult> {
  const slugs = await listWorkstreams();
  const taken = new Set(slugs);
  const house = loadHouse();
  const { parsed, error } = await deriveWithModel(message, taken, house, await fleetCandidates(slugs), done);
  if (parsed?.kind === 'attach') return attachToExisting(parsed.slug, message, done);
  const d = parsed?.derived ?? deriveFallback(message, taken, done);
  await createWorkstream({
    slug: d.slug,
    title: d.title,
    objective: d.objective,
    tags: d.routine ? [...house.tags, 'routine'] : house.tags,
    successCriteria: d.successCriteria,
    constraints: house.constraints,
    autonomy: { sendsRequireApproval: true },
    executionSafety: newExecutionSafety(),
  });
  await arrive(d.slug, (doc, event) => {
    doc.wakes.push({
      id: newId('wake'),
      reason: 'workstream created — establish direction and dispatch initial work',
      condition: { type: 'immediate' },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    event('wake.scheduled', 'initial reconciliation wake');
  });
  return { action: 'created', derived: d, fallbackReason: parsed ? undefined : error };
}
