/**
 * Linear intake sweep: `weaver`-labeled issues become workstreams; new issue
 * comments become observations. Intake is the ONLY thing this module does —
 * outbound (posting comments back, moving issue state) deliberately stays on
 * the sanctioned path: gated `kind:'action'` assignments authored by the
 * coordinator, executed with $LINEAR_API_KEY injected by the engine, and
 * confirmed by readback. There is still no channel adapter layer (docs/
 * harness.md); a Jira/Sheets intake would be a sibling of this file.
 *
 * The sweep is deterministic — no model call anywhere. It is safe to run on
 * any cadence: at-least-once by design, exactly-once by `ingressKey` dedupe
 * and the mirror map. A sweep that finds nothing new writes nothing (no
 * revision bumps, no spurious coordinator conflicts).
 *
 * Fleet-level typed state lives in WEAVER_HOME/linear.json: the updatedAt
 * cursor and the issue→workstream mirror map. Weaver's own posted comments
 * are recognized by their mandatory `[weaver ...]` marker and skipped, so the
 * sweep never mirrors its own egress back in as input.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { virtualNow } from './clock.js';
import { HOUSE_CONSTRAINTS, sanitizeSlug } from './onboard.js';
import { loadSecrets } from './secrets.js';
import { arrive, createWorkstream, listWorkstreams, load, newId, weaverHome } from './store.js';

export const LINEAR_LABEL_DEFAULT = 'weaver';
/** Comments containing this marker are Weaver's own egress — never intake. */
export const WEAVER_COMMENT_MARKER = '[weaver';
const OBSERVATION_BODY_LIMIT = 1500;

export interface LinearComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  updatedAt: string;
  stateName: string;
  /** Linear workflow state type: triage|backlog|unstarted|started|completed|canceled */
  stateType: string;
  comments: LinearComment[];
}

export interface LinearMirrorState {
  schemaVersion: 1;
  /** Max issue updatedAt seen; next fetch filters updatedAt >= cursor. */
  cursor: string | null;
  /** Linear issue uuid → mirrored workstream. */
  issues: Record<string, { slug: string; identifier: string }>;
}

export interface SweepResult {
  created: { slug: string; identifier: string }[];
  observations: { slug: string; count: number }[];
  skipped: { identifier: string; reason: string }[];
}

export function mirrorPath(): string {
  return path.join(weaverHome(), 'linear.json');
}

export function loadMirror(): LinearMirrorState {
  const p = mirrorPath();
  if (!fs.existsSync(p)) return { schemaVersion: 1, cursor: null, issues: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8')) as LinearMirrorState;
}

export function saveMirror(state: LinearMirrorState): void {
  const p = mirrorPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** The post-back lifecycle, as human-owned constraints on the mirror stream.
 * Outbound authority stays exactly where it always is: gated actions. */
export function linearMirrorConstraints(issue: LinearIssue, slug: string): string[] {
  return [
    `This workstream mirrors Linear issue ${issue.identifier} (uuid ${issue.id}, ${issue.url}). Progress worth sharing, questions for the team, and the final outcome are posted BACK to that issue as comments via gated actions: curl -s https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" with GraphQL mutation commentCreate(input:{issueId:"${issue.id}", body:"..."}). LINEAR_API_KEY is a global secret — reference it as $LINEAR_API_KEY; the engine injects the value at exec`,
    `Every comment posted to Linear must end with a marker line "[weaver ${slug} <token>]" where <token> is a short unique token chosen per comment. exec_verify must confirm the post by querying the issue's comments back and grepping for that exact marker — after an unknown result, read back; never re-post. The intake sweep ignores comments carrying a ${WEAVER_COMMENT_MARKER} marker, so posted updates do not echo back as input`,
    `When the objective is met, move the Linear issue to its team's Done workflow state (mutation issueUpdate) via a gated action, readback-confirmed. If a human moves the issue to Done or Canceled in Linear, reconcile by concluding or pausing this workstream — never reopen the issue`,
  ];
}

function issueObjective(issue: LinearIssue): string {
  return [
    `Linear issue ${issue.identifier} — "${issue.title}"`,
    ``,
    issue.description.trim() || '(no description on the issue)',
    ``,
    `Issue: ${issue.url}`,
  ].join('\n');
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated)`;
}

/**
 * Apply one batch of fetched issues to the store. Deterministic; idempotent
 * under re-delivery (ingressKey dedupe, mirror map, marker skip). Writes at
 * most one arrival per workstream per sweep so a burst of comments coalesces
 * into one wake.
 */
export function sweepIssues(issues: LinearIssue[], mirror: LinearMirrorState): SweepResult {
  const result: SweepResult = { created: [], observations: [], skipped: [] };
  const taken = new Set(listWorkstreams());

  for (const issue of issues) {
    // One poisoned issue (e.g. a secret VALUE pasted into its body tripping
    // the store's write guard) must not wedge the whole sweep — isolate it,
    // report it, and keep going. Its cursor position is not advanced past
    // permanently: the failure is visible in `skipped` every sweep.
    try {
      sweepOneIssue(issue, mirror, taken, result);
    } catch (error) {
      result.skipped.push({
        identifier: issue.identifier,
        reason: String((error as Error).message ?? error).slice(0, 200),
      });
    }
  }

  const maxUpdated = issues.map((i) => i.updatedAt).sort().at(-1);
  if (maxUpdated && (!mirror.cursor || maxUpdated > mirror.cursor)) mirror.cursor = maxUpdated;
  return result;
}

function sweepOneIssue(
  issue: LinearIssue,
  mirror: LinearMirrorState,
  taken: Set<string>,
  result: SweepResult,
): void {
  {
    let mirrored = mirror.issues[issue.id];

    if (!mirrored) {
      if (issue.stateType === 'completed' || issue.stateType === 'canceled') {
        result.skipped.push({ identifier: issue.identifier, reason: `already ${issue.stateName}` });
        return;
      }
      const slug = sanitizeSlug(`${issue.identifier}-${issue.title}`, taken);
      taken.add(slug);
      createWorkstream({
        slug,
        title: `${issue.identifier}: ${issue.title}`.slice(0, 90),
        objective: issueObjective(issue),
        tags: ['erdo', 'linear'],
        successCriteria: [
          'The issue\'s ask is delivered — for code work: root-caused/implemented, PR merged through the review loop, verification evidence in the PR',
          'The outcome is posted back to the Linear issue as a comment and the issue is moved to Done, readback-confirmed',
        ],
        constraints: [...HOUSE_CONSTRAINTS, ...linearMirrorConstraints(issue, slug)],
        autonomy: { sendsRequireApproval: true },
        budget: { maxCoordinatorPasses: 500, maxCostUsd: 1000 },
      });
      arrive(slug, (d, event) => {
        d.wakes.push({
          id: newId('wake'),
          reason: `mirrored from Linear issue ${issue.identifier} — establish direction and dispatch initial work`,
          condition: { type: 'immediate' },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
        event('wake.scheduled', `initial reconciliation wake (Linear ${issue.identifier})`);
      });
      mirrored = { slug, identifier: issue.identifier };
      mirror.issues[issue.id] = mirrored;
      // Persist the mapping the moment the workstream exists: a crash between
      // creation and the end-of-sweep save must not orphan the new stream
      // (an orphaned mapping re-mirrors as a suffixed sibling next sweep).
      saveMirror(mirror);
      result.created.push(mirrored);
    }

    // New human comments + terminal state changes → observations, deduped by
    // ingressKey against the stream's own typed state (not the mirror file),
    // so a lost mirror file repairs itself without duplicating arrivals.
    const doc = load(mirrored.slug);
    const seen = new Set(doc.observations.map((o) => o.ingressKey).filter(Boolean));
    const newComments = issue.comments.filter(
      (c) => !c.body.includes(WEAVER_COMMENT_MARKER) && !seen.has(`linear-comment:${c.id}`),
    );
    const stateKey = `linear-state:${issue.id}:${issue.stateType}`;
    // A terminal issue state is only news when the stream hasn't concluded:
    // Weaver's own move-to-Done lands after conclusion, and echoing it back
    // would wake a finished stream to reconcile its own egress.
    const terminal =
      (issue.stateType === 'completed' || issue.stateType === 'canceled') &&
      doc.workstream.status !== 'done' &&
      !seen.has(stateKey);

    if (!newComments.length && !terminal) return;

    const slug = mirrored.slug;
    const identifier = mirrored.identifier;
    arrive(slug, (d, event) => {
      for (const c of newComments) {
        const id = newId('obs');
        d.observations.push({
          id,
          ingressKey: `linear-comment:${c.id}`,
          source: `linear:${identifier}`,
          summary: `${c.author} commented on ${identifier}: ${truncate(c.body, OBSERVATION_BODY_LIMIT)}`,
          atVirtual: virtualNow().toISOString(),
        });
        event('observation.arrived', `${id} [linear:${identifier}] comment by ${c.author}`, [id]);
      }
      if (terminal) {
        const id = newId('obs');
        d.observations.push({
          id,
          ingressKey: stateKey,
          source: `linear:${identifier}`,
          summary: `Linear issue ${identifier} was moved to ${issue.stateName} in Linear — reconcile: conclude or pause this workstream (never reopen the issue)`,
          atVirtual: virtualNow().toISOString(),
        });
        event('observation.arrived', `${id} [linear:${identifier}] issue moved to ${issue.stateName}`, [id]);
      }
      d.wakes.push({
        id: newId('wake'),
        reason: `Linear activity on ${identifier}: ${newComments.length} new comment(s)${terminal ? `, issue moved to ${issue.stateName}` : ''}`,
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    });
    result.observations.push({ slug, count: newComments.length + (terminal ? 1 : 0) });
  }
}

// ---------------------------------------------------------------------------
// Network layer (not exercised by tests — tests drive sweepIssues directly)

export function linearApiKey(): string {
  const key = process.env.LINEAR_API_KEY ?? loadSecrets()['LINEAR_API_KEY'];
  if (!key) {
    throw new Error(
      'no LINEAR_API_KEY — store it once with: weaver secret set LINEAR_API_KEY  (value from stdin)',
    );
  }
  return key;
}

interface GqlIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  state: { name: string; type: string };
  comments: { nodes: { id: string; body: string; createdAt: string; user: { displayName: string } | null }[] };
}

const ISSUES_QUERY = `
query WeaverSweep($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 50, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description url updatedAt
      state { name type }
      comments(first: 100) { nodes { id body createdAt user { displayName } } }
    }
  }
}`;

/** Fetch all issues carrying the label, updated at/after the cursor. */
export async function fetchLabeledIssues(label: string, cursor: string | null): Promise<LinearIssue[]> {
  const key = linearApiKey();
  const filter: Record<string, unknown> = { labels: { name: { eq: label } } };
  if (cursor) filter.updatedAt = { gte: cursor };
  const out: LinearIssue[] = [];
  let after: string | null = null;
  for (;;) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query: ISSUES_QUERY, variables: { filter, after } }),
    });
    if (!res.ok) throw new Error(`Linear API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      data?: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlIssueNode[] } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new Error(`Linear API: ${json.errors.map((e) => e.message).join('; ')}`);
    const page = json.data?.issues;
    if (!page) throw new Error('Linear API: empty response');
    for (const n of page.nodes) {
      out.push({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        description: n.description ?? '',
        url: n.url,
        updatedAt: n.updatedAt,
        stateName: n.state.name,
        stateType: n.state.type,
        comments: n.comments.nodes.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user?.displayName ?? 'unknown',
          createdAt: c.createdAt,
        })),
      });
    }
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}

/** One full sweep: fetch → apply → persist cursor+mirror. */
export async function runLinearSweep(label = process.env.WEAVER_LINEAR_LABEL ?? LINEAR_LABEL_DEFAULT): Promise<SweepResult> {
  const mirror = loadMirror();
  const issues = await fetchLabeledIssues(label, mirror.cursor);
  const result = sweepIssues(issues, mirror);
  saveMirror(mirror);
  return result;
}
