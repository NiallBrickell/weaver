/**
 * `weaver backfill` — seed the policy store from the operator's EXISTING
 * practice, so Weaver already reflects how they work on first real use.
 *
 * Two sources:
 *  - Rules files (CLAUDE.md / AGENTS.md style): deterministic parsing, no
 *    model. Heuristics over cleverness: bullet lines and bold-lead rules
 *    under headings, skipping code blocks, links-only lines, and
 *    repo-internal sections (Commands, Architecture).
 *  - Claude Code session transcripts (--claude-projects): the user's own
 *    messages from recent sessions, distilled by ONE bounded model pass into
 *    correction-shaped candidates ("don't do X, always do Y"). Optional and
 *    secondary — deterministic parsing is the primary path.
 *
 * Backfill never shortcuts the learning loop (docs/learning.md): every seeded
 * policy lands in 'shadow' with full provenance and earns 'active' through
 * the normal evidence path. Text that reads like GRANTING authority (merge,
 * send, spend, bypass...) is skipped with a note, never converted — authority
 * is never learned, and it is certainly never imported.
 *
 * Re-running is not a no-op any more, and could not stay one. A rules file is
 * a living document — the operator edits a rule, deletes a section, tightens a
 * sentence — and a seeding pass that only ever ADDS leaves the store holding
 * the wording they abandoned, forever, beside the wording they now use. So a
 * re-run REFRESHES: a rule whose text changed under the same section updates
 * that policy in place (same id, same createdAt, journaled by the store's
 * mutation receipt), a section that no longer exists retires its policies with
 * the reason, and unchanged rules are still a no-op. Because a refreshed rule
 * means the operator's standing instruction moved, it also contests the
 * learned policies scoped to it — see `applyRulesRefresh` for why that blast
 * radius is the point rather than an accident.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  applyRulesRefresh,
  grantsAuthority,
  isDoctrine,
  loadPolicies,
  normalizeStatement,
  proposeBackfillPolicy,
  type PolicyRecord,
  type RulesRefreshUpdate,
} from './policies.js';
import { sdkEnv } from './secrets.js';

// The authority firewall lives in policies.ts now, so live proposal, backfill,
// and seed import share ONE lexical gate. Re-exported here for existing
// importers (cli.ts, backfill.test.ts) that reach for it via this module.
export { grantsAuthority } from './policies.js';

export interface BackfillCandidate {
  statement: string;
  effectKind: 'advisory' | 'add_verification';
  effectDescription: string;
  source: 'backfill:rules' | 'backfill:sessions';
  /** "path § heading" (rules) or "session <id>" (transcripts). */
  ref: string;
  /** The operator's verbatim words behind a transcript-distilled candidate.
   * Carried onto the policy's provenance because it is what separates their
   * own instruction from a model's reading of a conversation — the first is
   * doctrine, the second is a candidate like any other. */
  quote?: string;
  interventionSummary: string;
}

export interface BackfillReport {
  /** Policies actually written (empty on --dry-run). */
  created: PolicyRecord[];
  /** What --dry-run WOULD create. */
  wouldCreate: BackfillCandidate[];
  /** Candidates whose normalized statement already exists in the store. */
  duplicates: BackfillCandidate[];
  /** Rule text refused with a reason (authority-granting language). */
  skipped: { text: string; reason: string; ref: string }[];
  /**
   * Doctrine whose text moved with the rules file. `contested` names the
   * learned policies the refresh put under review — reported on a --dry-run
   * too, because a re-run after a heavy edit can pull a lot of guidance out of
   * the projection at once and the operator should see that before it happens,
   * not afterwards.
   */
  refreshed: { id: string; before: string; after: string; ref: string; contested: string[] }[];
  /** Rules that kept their words but changed section — the ref follows them. */
  moved: { id: string; from: string; to: string }[];
  /** Policies whose rules section no longer exists — retired with the reason. */
  retired: { id: string; statement: string; ref: string; reason: string }[];
  /** True when nothing was written (the caller passed --dry-run). */
  dryRun: boolean;
}

function emptyReport(dryRun: boolean): BackfillReport {
  return { created: [], wouldCreate: [], duplicates: [], skipped: [], refreshed: [], moved: [], retired: [], dryRun };
}

// Effect classification, deliberately simple: a rule that mandates
// verifying/testing becomes add_verification; everything else is advisory.
// narrow_authority is never inferred from text — narrowing is a deliberate
// human act, not a parsing guess.
const VERIFY_WORDS = /\b(verif\w*|test\w*|validat\w*|confirm\w*|check\w*|typecheck|lint\w*)\b/i;
const MANDATE_WORDS = /\b(must|always|never|before|ensure|require[sd]?)\b/i;

function classifyEffect(text: string): BackfillCandidate['effectKind'] {
  return VERIFY_WORDS.test(text) && MANDATE_WORDS.test(text) ? 'add_verification' : 'advisory';
}

function effectDescription(kind: BackfillCandidate['effectKind']): string {
  return kind === 'add_verification'
    ? 'Add the verification step the statement mandates before adopting related work'
    : 'Advisory guidance imported from pre-Weaver operator practice';
}

// ---------------------------------------------------------------------------
// Source 1: rules files — deterministic, no model.

/** Headings whose content is repo plumbing, not durable operator practice. */
const SKIP_HEADINGS = /^(commands?|architecture|installation|setup|dependencies|project (structure|layout)|directory (structure|layout)|file (structure|layout))\b/i;

function cleanMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the line is nothing but markdown links / bare URLs. */
function linksOnly(text: string): boolean {
  const residual = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\s,;.·|—-]+/g, '');
  return residual.length < 3;
}

export function parseRulesFile(filePath: string): {
  candidates: BackfillCandidate[];
  skipped: BackfillReport['skipped'];
  /**
   * Every rule-bearing section the file still HAS, whether or not any line
   * under it survived the filters. Refresh needs this to tell "the operator
   * deleted this section" from "this section's bullets happen not to parse as
   * rules today" — only the first is a deletion, and inferring the second as
   * one would retire policies on a parser heuristic.
   */
  sections: string[];
} {
  const raw = fs.readFileSync(filePath, 'utf8');
  const candidates: BackfillCandidate[] = [];
  const skipped: BackfillReport['skipped'] = [];
  const sections = new Set<string>();

  // Heading stack by level; a rule line needs a level>=2 heading above it and
  // no repo-internal heading anywhere in its ancestry.
  const headings: (string | undefined)[] = [];
  let inFence = false;

  /** The ref a rule under the CURRENT heading stack would carry, or undefined
   * when this position cannot hold a rule at all. One definition, used both
   * when a heading opens a section and when a rule line lands in one, so the
   * two can never disagree about what a section is called. */
  const refHere = (): string | undefined => {
    const stack = headings.filter((h): h is string => Boolean(h));
    const underRuleHeading = headings.slice(2).some(Boolean);
    if (!underRuleHeading || stack.some((h) => SKIP_HEADINGS.test(h))) return undefined;
    const headingLabel = stack.slice(1).join(' › ') || stack.join(' › ');
    return `${filePath} § ${headingLabel}`;
  };

  for (const line of raw.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      headings[level] = cleanMarkdown(heading[2]!);
      headings.length = level + 1; // deeper headings reset
      const opened = refHere();
      if (opened) sections.add(opened);
      continue;
    }

    const ref = refHere();
    if (!ref) continue;

    // Rule shapes: a bullet (-, *, 1.) or a bold-lead paragraph line.
    const bullet = /^\s{0,3}(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    const boldLead = !bullet && /^\*\*[^*]/.test(line.trim());
    const ruleText = bullet ? bullet[1]! : boldLead ? line.trim() : undefined;
    if (!ruleText || linksOnly(ruleText)) continue;

    const statement = cleanMarkdown(ruleText);
    if (statement.length < 20 || statement.length > 600) continue;

    const headingLabel = ref.slice(ref.indexOf(' § ') + 3);
    if (grantsAuthority(statement)) {
      skipped.push({ text: statement, reason: 'reads like granting authority — authority is never learned or imported', ref });
      continue;
    }
    const effectKind = classifyEffect(statement);
    candidates.push({
      statement,
      effectKind,
      effectDescription: effectDescription(effectKind),
      source: 'backfill:rules',
      ref,
      interventionSummary: `backfilled from ${path.basename(filePath)} § ${headingLabel}`,
    });
  }
  return { candidates, skipped, sections: [...sections] };
}

// ---------------------------------------------------------------------------
// Dedup + write (shared by both sources).

async function applyCandidates(
  candidates: BackfillCandidate[],
  tags: string[],
  dryRun: boolean,
  report: BackfillReport,
): Promise<void> {
  const existing = new Set((await loadPolicies()).policies.map((p) => normalizeStatement(p.statement)));
  for (const c of candidates) {
    const key = normalizeStatement(c.statement);
    if (existing.has(key)) {
      report.duplicates.push(c);
      continue;
    }
    existing.add(key); // also dedups within the batch
    if (dryRun) {
      report.wouldCreate.push(c);
    } else {
      report.created.push(
        await proposeBackfillPolicy({
          statement: c.statement,
          tags,
          effectKind: c.effectKind,
          effectDescription: c.effectDescription,
          source: c.source,
          ref: c.ref,
          ...(c.quote ? { quote: c.quote } : {}),
          interventionSummary: c.interventionSummary,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Refresh: matching this run's parsed rules against what a previous run stored.

/**
 * How alike two rule statements are, as the fraction of distinct words they
 * share. Word overlap is a crude measure of meaning and a good measure of
 * EDITING, which is what this has to detect: a rule the operator reworded keeps
 * most of its vocabulary, while two different rules under one heading rarely do.
 */
function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(normalizeStatement(s).split(/[^a-z0-9]+/).filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Below this, two statements under one heading are treated as different rules
 * rather than one edited rule. Set high on purpose: mistaking two bullets for
 * one another would overwrite a rule the operator still holds, while missing an
 * edit merely leaves an extra shadow candidate for them to supersede. */
const REFRESH_SIMILARITY = 0.45;

export interface RulesRefreshPlan {
  /** Candidate text identical to what is stored — nothing to do. */
  unchanged: { candidate: BackfillCandidate; id: string }[];
  /** Same rule, new wording: update in place. */
  updates: { id: string; before: string; candidate: BackfillCandidate }[];
  /** Genuinely new rules. */
  creates: BackfillCandidate[];
  /** Same rule, same words, new section: follow it rather than retiring it. */
  moves: { id: string; from: string; to: string }[];
  /** Policies whose section is gone from a file this run parsed. */
  retires: { id: string; statement: string; ref: string; reason: string }[];
}

/**
 * Match this run's parsed rules against the rules-file policies already stored.
 * Pure, so the matching rules can be argued with in tests rather than inferred
 * from a store.
 *
 * Identity is (section, wording), in that order, because a rules file gives us
 * nothing better: bullets have no ids, and their ORDER within a section is not
 * identity either — inserting one line at the top would otherwise renumber
 * every rule beneath it and rewrite them all. So a candidate claims a stored
 * policy under the same section ref when their text matches exactly, and
 * failing that when each is the other's closest match above the threshold.
 * Mutual-best matters: without it, two candidates both drift toward the same
 * policy and one of them silently overwrites a rule it has nothing to do with.
 *
 * Deletion is inferred ONLY from a vanished section, never a vanished bullet.
 * A section that is gone from the file is unambiguous; a bullet that stopped
 * parsing may have been reformatted, moved into a code fence, or grown past the
 * length cap, and retiring the operator's rule because our own heuristics
 * changed their mind about it would be the worst kind of quiet damage.
 */
export function planRulesRefresh(
  candidates: BackfillCandidate[],
  parsedFiles: { path: string; sections: string[] }[],
  stored: PolicyRecord[],
): RulesRefreshPlan {
  const plan: RulesRefreshPlan = { unchanged: [], updates: [], creates: [], moves: [], retires: [] };
  const live = stored.filter(
    (p) => p.status !== 'superseded' && 'source' in p.provenance && p.provenance.source === 'backfill:rules',
  );
  const refOf = (p: PolicyRecord): string => ('ref' in p.provenance ? p.provenance.ref : '');
  const byRef = new Map<string, PolicyRecord[]>();
  for (const p of live) {
    const list = byRef.get(refOf(p)) ?? [];
    list.push(p);
    byRef.set(refOf(p), list);
  }

  const claimed = new Set<string>();
  const remaining: BackfillCandidate[] = [];

  // 1. Exact text under the same section: unchanged, nothing to write.
  for (const c of candidates) {
    const hit = (byRef.get(c.ref) ?? []).find(
      (p) => !claimed.has(p.id) && normalizeStatement(p.statement) === normalizeStatement(c.statement),
    );
    if (hit) {
      claimed.add(hit.id);
      plan.unchanged.push({ candidate: c, id: hit.id });
    } else {
      remaining.push(c);
    }
  }

  // 2. Same section, reworded: mutual-best match above the threshold.
  const scored: { c: BackfillCandidate; p: PolicyRecord; score: number }[] = [];
  for (const c of remaining) {
    for (const p of byRef.get(c.ref) ?? []) {
      if (claimed.has(p.id)) continue;
      const score = similarity(c.statement, p.statement);
      if (score >= REFRESH_SIMILARITY) scored.push({ c, p, score });
    }
  }
  const bestFor = new Map<object, number>();
  for (const s of scored) {
    bestFor.set(s.c, Math.max(bestFor.get(s.c) ?? 0, s.score));
    bestFor.set(s.p, Math.max(bestFor.get(s.p) ?? 0, s.score));
  }
  const matchedCandidates = new Set<BackfillCandidate>();
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (matchedCandidates.has(s.c) || claimed.has(s.p.id)) continue;
    if (bestFor.get(s.c) !== s.score || bestFor.get(s.p) !== s.score) continue; // not mutual-best
    claimed.add(s.p.id);
    matchedCandidates.add(s.c);
    plan.updates.push({ id: s.p.id, before: s.p.statement, candidate: s.c });
  }

  // 3. Everything still unmatched is a new rule (the global normalized-statement
  //    dedup in applyCandidates still catches one that moved between sections).
  for (const c of remaining) if (!matchedCandidates.has(c)) plan.creates.push(c);

  // 4. Sections that no longer exist in a file this run actually parsed.
  //    Scoped by the path as it was spelled when the policy was seeded, so a
  //    run that names the same file differently (relative vs absolute, a
  //    symlinked home) retires nothing rather than guessing — the worst it
  //    costs is a re-seed the statement dedup then catches.
  //
  //    Renaming a heading LOOKS exactly like deleting one, so a rule whose
  //    text is still somewhere in this run's candidates is a MOVE, not a
  //    deletion — it follows the text to its new section. Without that, a
  //    renamed heading would retire the rules and then the store-wide
  //    statement dedup would refuse to re-create them, and the operator's
  //    rules would quietly vanish from a store that still had their file.
  const candidateByText = new Map<string, BackfillCandidate>();
  for (const c of candidates) candidateByText.set(normalizeStatement(c.statement), c);
  const moved = new Set<BackfillCandidate>();
  const settled = new Set<string>();
  for (const file of parsedFiles) {
    const present = new Set(file.sections);
    for (const p of live) {
      const ref = refOf(p);
      if (!ref.startsWith(`${file.path} § `) || present.has(ref) || settled.has(p.id)) continue;
      settled.add(p.id);
      const elsewhere = candidateByText.get(normalizeStatement(p.statement));
      if (elsewhere) {
        plan.moves.push({ id: p.id, from: ref, to: elsewhere.ref });
        moved.add(elsewhere);
        plan.unchanged.push({ candidate: elsewhere, id: p.id });
        continue;
      }
      plan.retires.push({
        id: p.id,
        statement: p.statement,
        ref,
        reason: `the rules section it came from no longer exists in ${file.path} — the operator removed the rule`,
      });
    }
  }
  plan.creates = plan.creates.filter((c) => !moved.has(c));
  return plan;
}

export async function backfillRules(paths: string[], tags: string[], dryRun: boolean): Promise<BackfillReport> {
  const report = emptyReport(dryRun);
  const candidates: BackfillCandidate[] = [];
  const parsedFiles: { path: string; sections: string[] }[] = [];
  for (const p of paths) {
    const parsed = parseRulesFile(p);
    candidates.push(...parsed.candidates);
    report.skipped.push(...parsed.skipped);
    parsedFiles.push({ path: p, sections: parsed.sections });
  }

  const store = await loadPolicies();
  const plan = planRulesRefresh(candidates, parsedFiles, store.policies);
  // An unchanged rule is reported exactly as a duplicate was before refresh
  // existed: present in the store, nothing written.
  for (const u of plan.unchanged) report.duplicates.push(u.candidate);

  const updates: RulesRefreshUpdate[] = plan.updates.map((u) => ({
    id: u.id,
    statement: u.candidate.statement,
    effectKind: u.candidate.effectKind,
    effectDescription: u.candidate.effectDescription,
  }));

  if (dryRun) {
    // Predict the contests from the loaded store, using the same rule the
    // mutation applies — the operator sees the blast radius before choosing.
    const refOf = (id: string): string => {
      const p = store.policies.find((x) => x.id === id);
      return p && 'ref' in p.provenance ? p.provenance.ref : '';
    };
    for (const u of plan.updates) {
      const target = store.policies.find((p) => p.id === u.id)!;
      const contested = store.policies
        .filter(
          (p) =>
            p.id !== target.id &&
            p.status !== 'superseded' &&
            !p.contested &&
            !isDoctrine(p) &&
            p.scope.tags.some((t) => target.scope.tags.includes(t)),
        )
        .map((p) => p.id);
      report.refreshed.push({
        id: u.id,
        before: u.before,
        after: u.candidate.statement,
        ref: refOf(u.id),
        contested,
      });
    }
    report.retired.push(...plan.retires);
    report.moved.push(...plan.moves);
  } else if (updates.length || plan.retires.length || plan.moves.length) {
    const applied = await applyRulesRefresh({
      updates,
      moves: plan.moves.map((m) => ({ id: m.id, ref: m.to })),
      retire: plan.retires.map((r) => ({ id: r.id, reason: r.reason })),
    });
    for (const m of applied.moved) {
      report.moved.push({ id: m.id, from: plan.moves.find((x) => x.id === m.id)?.from ?? '', to: m.ref });
    }
    for (const u of applied.updated) {
      report.refreshed.push({
        id: u.id,
        before: u.before,
        after: u.after,
        ref: plan.updates.find((x) => x.id === u.id)?.candidate.ref ?? '',
        contested: u.contested,
      });
    }
    for (const r of applied.retired) {
      report.retired.push({
        id: r.id,
        statement: r.statement,
        ref: plan.retires.find((x) => x.id === r.id)?.ref ?? '',
        reason: r.reason,
      });
    }
  }

  await applyCandidates(plan.creates, tags, dryRun, report);
  return report;
}

// ---------------------------------------------------------------------------
// Source 2: Claude Code session transcripts — one bounded model pass.

/**
 * USER messages only from the most recent transcripts: plain text, no tool
 * results, no meta/command wrappers. Throws when the directory is missing —
 * the model path refuses to run on a guess.
 */
export function extractUserMessages(
  projectsDir: string,
  limit: number,
): { sessionId: string; messages: string[] }[] {
  if (!fs.existsSync(projectsDir) || !fs.statSync(projectsDir).isDirectory()) {
    throw new Error(`--claude-projects directory not found: ${projectsDir}`);
  }
  const files = fs
    .readdirSync(projectsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(projectsDir, f);
      return { full, name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  const sessions: { sessionId: string; messages: string[] }[] = [];
  for (const f of files) {
    const messages: string[] = [];
    for (const line of fs.readFileSync(f.full, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec: {
        type?: string;
        isMeta?: boolean;
        message?: { role?: string; content?: unknown };
      };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== 'user' || rec.isMeta || rec.message?.role !== 'user') continue;
      const content = rec.message.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((b): b is { type: string; text: string } => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
      }
      text = text.trim();
      // Command wrappers and system reminders arrive as user-role messages
      // starting with an XML-ish tag — they are not the human speaking.
      if (!text || text.startsWith('<')) continue;
      messages.push(text.slice(0, 2000));
    }
    if (messages.length) sessions.push({ sessionId: f.name.replace(/\.jsonl$/, ''), messages });
  }
  return sessions;
}

const DISTILL_SYSTEM = `You distill a user's past messages to coding agents into durable policy candidates. You only ever call the submit_corrections tool — no prose answer is read.`;

export async function backfillSessions(
  projectsDir: string,
  tags: string[],
  opts: { dryRun: boolean; limit: number },
): Promise<BackfillReport> {
  const report = emptyReport(opts.dryRun);
  const sessions = extractUserMessages(projectsDir, opts.limit);
  if (!sessions.length) return report;

  // Cap the transcript excerpt so one pathological session can't blow the pass.
  const MAX_TOTAL = 40_000;
  let used = 0;
  const excerpt: string[] = [];
  for (const s of sessions) {
    excerpt.push(`## session ${s.sessionId}`);
    for (const m of s.messages) {
      if (used + m.length > MAX_TOTAL) break;
      used += m.length;
      excerpt.push(`- ${m.replace(/\n/g, '\n  ')}`);
    }
  }

  const submissions: { statement: string; effect: 'advisory' | 'add_verification'; quote: string; sessionId: string }[] = [];
  let submitted = false;
  const server = createSdkMcpServer({
    name: 'backfill',
    version: '0.1.0',
    tools: [
      tool(
        'submit_corrections',
        'Submit every durable correction you found. Call exactly once; an empty list is a valid answer.',
        {
          corrections: z.array(
            z.object({
              statement: z.string().describe('the rule, imperative and general, one sentence'),
              effect: z.enum(['advisory', 'add_verification']),
              quote: z.string().max(300).describe('short verbatim quote from the user message that evidences it'),
              sessionId: z.string(),
            }),
          ),
        },
        async (a) => {
          if (submitted) {
            return { content: [{ type: 'text' as const, text: 'already submitted — stop' }], isError: true };
          }
          submitted = true;
          submissions.push(...a.corrections);
          return { content: [{ type: 'text' as const, text: `${a.corrections.length} correction(s) recorded — you are done` }] };
        },
      ),
    ],
  });

  const prompt = [
    `Below are USER messages (only) from recent coding-agent sessions, grouped by session id.`,
    ``,
    `Identify durable CORRECTIONS the user made — moments where they redirected the agent in a way that generalizes ("don't do X, always do Y"), not one-off task instructions, facts, or approvals. For each, submit:`,
    `- statement: the rule as a general imperative, in the user's own terms and NOTHING MORE. Strip execution detail they did not themselves choose — exact commands, flags, file paths, numeric thresholds, tool names. A quote makes this rule count as the user's own standing doctrine, which outranks what the fleet infers for itself, so a detail smuggled into the sentence inherits an authority the user never gave it. If they named the command, keep it; if you are supplying it, leave it out.`,
    `- effect: 'add_verification' when it mandates verifying/testing/checking, else 'advisory'`,
    `- quote: a short verbatim quote from the message`,
    `- sessionId: the session it came from`,
    ``,
    `Never submit anything that would grant authority (merging, sending, spending, deploying, bypassing gates) — those are not learnable. Call submit_corrections exactly once.`,
    ``,
    excerpt.join('\n'),
  ].join('\n');

  for await (const message of query({
    prompt,
    options: {
      model: 'sonnet',
      systemPrompt: DISTILL_SYSTEM,
      tools: [],
      mcpServers: { backfill: server } as never,
      allowedTools: ['mcp__backfill__*'],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 4,
      persistSession: false,
      env: sdkEnv(),
    },
  })) {
    void message;
  }

  const candidates: BackfillCandidate[] = [];
  for (const s of submissions) {
    const ref = `session ${s.sessionId}`;
    // Same firewall as the rules path — model output gets no exemption.
    if (grantsAuthority(s.statement)) {
      report.skipped.push({ text: s.statement, reason: 'reads like granting authority — authority is never learned or imported', ref });
      continue;
    }
    candidates.push({
      statement: s.statement,
      effectKind: s.effect,
      effectDescription: effectDescription(s.effect),
      source: 'backfill:sessions',
      ref,
      quote: s.quote.slice(0, 300),
      interventionSummary: `backfilled from Claude Code ${ref}: "${s.quote.slice(0, 200)}"`,
    });
  }
  await applyCandidates(candidates, tags, opts.dryRun, report);
  return report;
}

// ---------------------------------------------------------------------------

export function renderBackfillReport(report: BackfillReport, dryRun: boolean): string {
  const lines: string[] = [];
  const would = dryRun ? '(dry-run) ' : '';
  for (const r of report.refreshed) {
    lines.push(`~ ${would}${r.id} rule text updated in place from ${r.ref}`);
    lines.push(`    was: "${r.before}"`);
    lines.push(`    now: "${r.after}"`);
    if (r.contested.length) {
      lines.push(
        `    ${dryRun ? 'would contest' : 'contested'} ${r.contested.length} learned polic${r.contested.length === 1 ? 'y' : 'ies'} sharing its scope — they were learned under the old wording and stop guiding until reconciled: ${r.contested.join(', ')}`,
      );
    }
  }
  for (const m of report.moved) {
    lines.push(`> ${would}${m.id} still in the file, under a different section: ${m.from} → ${m.to}`);
  }
  for (const r of report.retired) {
    lines.push(`- ${would}${r.id} retired: "${r.statement}"`);
    lines.push(`    ${r.reason}`);
  }
  for (const p of report.created) {
    lines.push(`+ ${p.id} [shadow/${p.effect.kind}] "${p.statement}"`);
    lines.push(`    from ${'ref' in p.provenance ? p.provenance.ref : ''}`);
  }
  for (const c of report.wouldCreate) {
    lines.push(`+ (dry-run) [shadow/${c.effectKind}] "${c.statement}"`);
    lines.push(`    from ${c.ref}`);
  }
  for (const c of report.duplicates) {
    lines.push(`= duplicate, skipped: "${c.statement}"`);
  }
  for (const s of report.skipped) {
    lines.push(`! refused: "${s.text}"`);
    lines.push(`    ${s.reason} (${s.ref})`);
  }
  const n = dryRun ? report.wouldCreate.length : report.created.length;
  lines.push(
    `${dryRun ? 'would create' : 'created'} ${n} shadow polic${n === 1 ? 'y' : 'ies'}, ` +
      `${report.duplicates.length} duplicate(s), ${report.skipped.length} refused` +
      (dryRun ? ' — nothing written (--dry-run)' : ''),
  );
  if (n && !dryRun) {
    lines.push(`all backfilled policies start in shadow — they earn 'active' only through applied, intervention-free evidence`);
  }
  return lines.join('\n');
}
