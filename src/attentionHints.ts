/**
 * A one-time operator CLI that turns prose PR mentions on LEGACY attention
 * cards into a hint for the coordinator — never an automatic resolution.
 *
 * `attentionReadback.ts` already closes a card automatically, but only from a
 * fact the card DECLARED at raise time (`resolvesWhen`). Most existing cards
 * predate that mechanism: they mention a PR only in prose, as background to a
 * still-live ask (in production, 14 of 19 PR-mentioning cards are like this).
 * Binding those automatically would silently close cards that are still
 * waiting on something else. So this module never writes to `doc.attention`
 * and never calls a resolve path — it reads back the PR's state and posts a
 * plain Observation to the card's owning workstream, exactly the way any
 * other external signal arrives (kernel rule 9: a mention is untrusted input,
 * not authority). The coordinator decides whether the card is actually done.
 *
 * `extractPrCitations` is pure text-mining over the card summary; the rest of
 * this module is the one-off sweep: gather open cards across the fleet, read
 * PR states back once per repo, and post one idempotent hint per (card, PR,
 * state) — a second run of the same sweep is a no-op by `ingressKey`.
 */

import type { AttentionReadbackIO, GitHubPrStateFact, PrStateReadback } from './attentionReadback.js';
import { liveAttentionReadbackIO } from './attentionReadback.js';
import { githubRepositoryFromCwd } from './githubApp.js';
import { recordObservation } from './ingress.js';
import { listWorkstreams, load } from './store.js';
import type { AttentionItem, WorkstreamDoc } from './types.js';

const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Explicit URL: `github.com/<owner>/<repo>/pull/<n>`, with or without `https://`.
const URL_PR_RE = /(?:https:\/\/)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
// Explicit `<owner>/<repo>#<n>` token — unambiguous by construction. The
// owner must start the token: `a/b/c#12` (a path) is not `b/c#12`.
const OWNER_REPO_HASH_RE = /(?<![A-Za-z0-9_.\/-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/g;
// Bare `#<n>`, not preceded by a word char or `/` (excludes `foo#12`, `/#12`,
// and the owner/repo#n form above, whose digits are always preceded by a
// repo-name character).
const BARE_HASH_RE = /(?<![\w/])#(\d+)/g;
// `github.com/<owner>/<repo>` appearing anywhere (not only as a PR link) —
// used to find the repos a workstream's constraints name.
const CONSTRAINT_REPO_RE = /(?:https:\/\/)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;

function isValidRepo(repo: string): boolean {
  return GITHUB_REPO_RE.test(repo);
}

function isPositiveInt(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** First-seen casing, case-insensitive membership. */
function dedupeReposCaseInsensitive(repos: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of repos) {
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/**
 * Find PR citations in a card's summary text. Pure — no I/O, no store access.
 * `workstreamRepos` (deduped case-insensitively before use) is the candidate
 * set a bare `#<n>` may bind to: only when it has exactly one entry, since a
 * bare number is ambiguous across more than one repo and meaningless across
 * zero. Results are ordered by first appearance in `summary` and deduped by
 * (repo lowercased, number), keeping the first-seen repo casing.
 */
export function extractPrCitations(
  summary: string,
  workstreamRepos: string[],
): Array<{ repo: string; number: number }> {
  const raw: Array<{ index: number; repo: string; number: number }> = [];

  for (const m of summary.matchAll(URL_PR_RE)) {
    const repo = m[1]!;
    const number = Number(m[2]);
    if (isValidRepo(repo) && isPositiveInt(number)) raw.push({ index: m.index, repo, number });
  }
  for (const m of summary.matchAll(OWNER_REPO_HASH_RE)) {
    const repo = m[1]!;
    const number = Number(m[2]);
    if (isValidRepo(repo) && isPositiveInt(number)) raw.push({ index: m.index, repo, number });
  }
  const uniqueRepos = dedupeReposCaseInsensitive(workstreamRepos);
  if (uniqueRepos.length === 1) {
    const only = uniqueRepos[0]!;
    for (const m of summary.matchAll(BARE_HASH_RE)) {
      const number = Number(m[1]);
      if (isPositiveInt(number)) raw.push({ index: m.index, repo: only, number });
    }
  }

  raw.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: Array<{ repo: string; number: number }> = [];
  for (const { repo, number } of raw) {
    const key = `${repo.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo, number });
  }
  return out;
}

/** The live default: the repo of a checked-out directory's git origin, or
 * null on any failure (missing dir, non-GitHub origin, no git) — fails
 * closed, same as every other GitHub App readback seam. */
function defaultRepoOfDir(dir: string): string | null {
  try {
    return githubRepositoryFromCwd(dir);
  } catch {
    return null;
  }
}

/**
 * Candidate repos for a bare `#n` citation in this workstream: the union of
 * `github.com/<owner>/<repo>` URLs named in its constraints, and the repo of
 * every assignment's `readDirs` (non-null results only). `repoOfDir` is
 * injectable so tests never touch git or the filesystem.
 */
export function workstreamRepos(
  doc: WorkstreamDoc,
  repoOfDir: (dir: string) => string | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (repo: string) => {
    const key = repo.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(repo);
  };

  for (const constraint of doc.workstream.constraints) {
    for (const m of constraint.matchAll(CONSTRAINT_REPO_RE)) {
      const repo = m[1];
      if (repo && isValidRepo(repo)) add(repo);
    }
  }
  for (const assignment of doc.assignments) {
    for (const dir of assignment.readDirs ?? []) {
      const repo = repoOfDir(dir);
      if (repo) add(repo);
    }
  }
  return out;
}

function declaresFact(item: AttentionItem, repo: string, number: number): boolean {
  return (item.resolvesWhen?.any ?? []).some(
    (fact): fact is GitHubPrStateFact =>
      fact.kind === 'github_pr_state' && fact.repo.toLowerCase() === repo.toLowerCase() && fact.number === number,
  );
}

/** ISO timestamp trimmed to minute precision plus `Z` — `describeExternalFact`
 * style granularity, so a hint reads like the rest of the readback vocabulary. */
function trimToMinutes(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16)}Z`;
}

function hintSummary(att: AttentionItem, repo: string, number: number, pr: PrStateReadback): string {
  const when = pr.state === 'MERGED' ? pr.mergedAt : pr.state === 'CLOSED' ? pr.closedAt : undefined;
  return `${att.id} cites ${repo}#${number} — ${pr.state}${when ? ` at ${trimToMinutes(when)}` : ''}; if the card only waited on that, withdraw it`;
}

function hintIngressKey(att: AttentionItem, repo: string, number: number, state: string): string {
  return `attention-hint:${att.id}:${repo}#${number}:${state}`;
}

interface CardCitation {
  slug: string;
  att: AttentionItem;
  repo: string;
  number: number;
}

export interface AttentionHintsResult {
  wouldPost: number;
  posted: number;
  duplicates: number;
  skippedRepos: string[];
}

/**
 * Read back PRs cited by open needs-you cards and post one hint Observation
 * per card citing a MERGED/CLOSED PR. Without `apply`, this only prints what
 * it would post and writes nothing at all. It never touches `doc.attention`
 * and never resolves a card — that stays the coordinator's call.
 */
export async function runAttentionHints(options: {
  apply: boolean;
  io?: AttentionReadbackIO;
  repoOfDir?: (dir: string) => string | null;
  out?: (line: string) => void;
}): Promise<AttentionHintsResult> {
  const io = options.io ?? liveAttentionReadbackIO();
  const repoOfDir = options.repoOfDir ?? defaultRepoOfDir;
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  const slugs = await listWorkstreams();
  const docs: Array<{ slug: string; doc: WorkstreamDoc }> = [];
  let skippedDoneCards = 0;
  let skippedDoneWorkstreams = 0;
  for (const slug of slugs) {
    const doc = await load(slug);
    if (doc.workstream.status === 'done') {
      skippedDoneWorkstreams += 1;
      skippedDoneCards += doc.attention.filter((item) => item.status === 'open').length;
      continue;
    }
    docs.push({ slug, doc });
  }
  if (skippedDoneCards > 0) {
    out(`skipped ${skippedDoneCards} open card(s) across ${skippedDoneWorkstreams} done workstream(s) — an observation there is a dead letter`);
  }

  const cardCitations: CardCitation[] = [];
  for (const { slug, doc } of docs) {
    const repos = workstreamRepos(doc, repoOfDir);
    for (const att of doc.attention) {
      if (att.status !== 'open') continue;
      for (const { repo, number } of extractPrCitations(att.summary, repos)) {
        if (declaresFact(att, repo, number)) continue; // the runner already reads this back
        cardCitations.push({ slug, att, repo, number });
      }
    }
  }

  const byRepo = new Map<string, { repo: string; numbers: Set<number> }>();
  for (const c of cardCitations) {
    const key = c.repo.toLowerCase();
    const entry = byRepo.get(key) ?? { repo: c.repo, numbers: new Set<number>() };
    entry.numbers.add(c.number);
    byRepo.set(key, entry);
  }

  const skippedRepos: string[] = [];
  const skippedSeen = new Set<string>();
  const addSkipped = (repo: string) => {
    const key = repo.toLowerCase();
    if (skippedSeen.has(key)) return;
    skippedSeen.add(key);
    skippedRepos.push(repo);
  };
  const statesByRepo = new Map<string, Map<number, PrStateReadback>>();
  for (const [key, { repo, numbers }] of byRepo) {
    try {
      const result = await io.githubPrStates(repo, [...numbers]);
      if (!result) {
        addSkipped(repo);
        out(`skipped ${repo} — no GitHub App configured or repo unreadable`);
        continue;
      }
      statesByRepo.set(key, result);
    } catch (error) {
      addSkipped(repo);
      out(`skipped ${repo} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let wouldPost = 0;
  let posted = 0;
  let duplicates = 0;
  for (const { slug, att, repo, number } of cardCitations) {
    const readback = statesByRepo.get(repo.toLowerCase());
    if (!readback) continue; // repo unreadable — skipped above
    const pr = readback.get(number);
    if (!pr || pr.state === 'OPEN') continue; // no answer, or still open — nothing to hint

    const summary = hintSummary(att, repo, number, pr);
    const ingressKey = hintIngressKey(att, repo, number, pr.state);

    if (!options.apply) {
      wouldPost += 1;
      out(`would post to ${slug}: ${summary} [${ingressKey}]`);
      continue;
    }
    const result = await recordObservation(slug, { source: 'attention-hints', summary, ingressKey });
    if (result.duplicate) {
      duplicates += 1;
      out(`duplicate — already recorded for ${slug}: ${ingressKey}`);
    } else {
      posted += 1;
      out(`posted to ${slug}: ${summary} [${ingressKey}]`);
    }
  }

  return { wouldPost, posted, duplicates, skippedRepos };
}
