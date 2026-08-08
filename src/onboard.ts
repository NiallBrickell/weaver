/**
 * `weaver do "<message>"` — the zero-ceremony entry point.
 *
 * The founder's message IS the input. Slug, title, objective, success
 * criteria, and routine-ness are derived: by one fast model pass when the
 * machine's Claude login is available, deterministically when it is not — a
 * failed derivation must never block starting work, so the fallback is the
 * message verbatim. Constraints are the HOUSE PACK, never model-generated:
 * the operating rules of this machine do not vary with how a task is phrased.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { sdkEnv } from './secrets.js';
import { arrive, createWorkstream, listWorkstreams, newId } from './store.js';
import { workerModel } from './worker.js';

/** Standing rules applied to every stream this entry point creates. */
export const HOUSE_CONSTRAINTS = [
  'Research first; every worker has the normal Claude Code toolset. Repository investigation and implementation happen in a fresh git worktree under /Users/niall/work/projects/workspace (branch from origin/main) — never in the user\'s checkouts. Opening or merging a PR, deploying, sending, or mutating a remote service remains a gated action',
  'Heavy commands (encore test, go build ./..., yarn build:check) must run through /Users/niall/work/projects/acme-development/scripts/with-heavy-lock.sh; prefer targeted package tests over full sweeps',
  'PR lifecycle on acme org repos: open the PR, never ask the human to review it — DevBot reviews via COMMENTS (it never submits GitHub approvals). Poll via gh on scheduled wakes; address every concrete issue. When DevBot\'s latest completed review reports zero concrete issues AND CI is green, merge yourself via exec_run (gh pr merge N --squash --repo NiallBrickell/<repo>), readback-confirmed',
  'Database access goes through the encore CLI — never paste connection strings into prompts, state, or artifacts; reference credentials as $NAME (the engine injects values)',
  'When blocked on credentials, external accounts, or anything only the founder can supply, raise attention with a one-click ask instead of improvising',
  'Verification runs against tests, previews, and readbacks by default — never poke production. Only when the objective explicitly calls for post-merge verification in the live product may you check there, and then strictly read-only (browser tooling included)',
  'All dates in artifacts and commits use the real current date',
];

/**
 * The machine's repo map, injected into derivation so a one-liner that only
 * implies its repo ("the leads UI", "the upload composer") still expands to
 * an objective that NAMES it. Coordinators can always fall back to scouting
 * ~/work/acme with a regular worker, but a named repo skips that pass.
 * Maintained by hand; keep entries to what a task message might mean.
 */
export const REPO_MAP = `Known repos under /Users/niall/work/projects (supply the parent dir as worker context to search across them):
- acme — the main product: Encore Go backend (backend/), Next.js frontend (frontend/), e2e tests, evals. Default guess for product features, uploads, threads, approvals, integrations, accounts.
- maurice — leads/growth engine: lead capture, enrichment, brand-style skills, growth experiments, landing pages.
- devbot — the PR-review bot (deployed on Railway, api devbot.example.com).
- engineering — the engineering.example.com public site (blog, docs pages).
- acme-data-platform — EDP: data syncs and pipelines.
- acme-development — dev tooling and scripts (worktree setup, heavy-lock).
- pilot — the local command-approval daemon.
- weaver — this harness itself.
- acme-cli, acme-ts-sdk, acme-python-sdk, acme-integrations, codeexec — CLI, SDKs, integrations, code-execution service.`;

export interface Derived {
  slug: string;
  title: string;
  objective: string;
  successCriteria: string[];
  routine: boolean;
}

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
export function parseDerivation(text: string, taken: Set<string>): Derived | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Partial<Derived>;
    if (typeof j.slug !== 'string' || typeof j.title !== 'string' || typeof j.objective !== 'string') return null;
    return {
      slug: sanitizeSlug(j.slug, taken),
      title: j.title.slice(0, 90),
      objective: j.objective,
      successCriteria: Array.isArray(j.successCriteria) ? j.successCriteria.filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
      routine: j.routine === true,
    };
  } catch {
    return null;
  }
}

async function deriveWithModel(message: string, taken: Set<string>, done?: string): Promise<Derived | null> {
  const prompt = [
    `Turn this raw task message from the founder into a workstream definition. Reply with ONLY a JSON object: {"slug", "title", "objective", "successCriteria": [..], "routine": bool}.`,
    ``,
    `- slug: 2-4 word kebab-case name`,
    `- objective: the founder's ask, expanded into a self-contained brief a fresh agent can act on. PRESERVE every concrete detail verbatim (names, URLs, error text, repos); resolve relative dates against today (${new Date().toISOString().slice(0, 10)}); name likely evidence sources when the message implies them. Never invent requirements the message doesn't contain.`,
    `- when the message implies code work, name the repo(s) it most likely lives in from the map below (with the full path), and say scouting across the parent dir is the fallback if that guess is wrong — a wrong guess must redirect, not derail.`,
    ``,
    REPO_MAP,
    `- successCriteria: 1-3 checkable statements of done.${
      done
        ? ' The founder EXPLICITLY stated what done means — it is the first criterion, meaning-preserved: ' + JSON.stringify(done)
        : ' Default bar for code work: root-caused/implemented, PR merged through the review loop, verification evidence in the PR. Do NOT include verifying in production unless the founder asked for it.'
    }`,
    `- routine: true ONLY if the message describes recurring work (weekly, nightly, "keep doing X") — then state the cadence inside the objective and note that each completed cycle schedules the next via a time wake.`,
    ``,
    `Message: ${JSON.stringify(message)}`,
  ].join('\n');
  try {
    let text = '';
    for await (const msg of query({
      prompt,
      options: {
        model: workerModel(),
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
      if (msg.type === 'result' && 'result' in msg && typeof msg.result === 'string' && !msg.is_error) text = msg.result;
    }
    return parseDerivation(text, taken);
  } catch {
    return null;
  }
}

/** Create a workstream from one raw message (plus an optional explicit
 * statement of what done means). Returns what was decided. */
export async function onboard(message: string, done?: string): Promise<Derived> {
  const taken = new Set(await listWorkstreams());
  const d = (await deriveWithModel(message, taken, done)) ?? deriveFallback(message, taken, done);
  await createWorkstream({
    slug: d.slug,
    title: d.title,
    objective: d.objective,
    tags: d.routine ? ['acme', 'routine'] : ['acme'],
    successCriteria: d.successCriteria,
    constraints: HOUSE_CONSTRAINTS,
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 500, maxCostUsd: 1000 },
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
  return d;
}
