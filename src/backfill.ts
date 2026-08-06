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
 * is never learned, and it is certainly never imported. Re-running is a
 * no-op: candidates dedup on normalized statement against the whole store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  loadPolicies,
  normalizeStatement,
  proposeBackfillPolicy,
  type PolicyRecord,
} from './policies.js';

export interface BackfillCandidate {
  statement: string;
  effectKind: 'advisory' | 'add_verification';
  effectDescription: string;
  source: 'backfill:rules' | 'backfill:sessions';
  /** "path § heading" (rules) or "session <id>" (transcripts). */
  ref: string;
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
}

// ---------------------------------------------------------------------------
// The authority firewall at import time. A rule that reads like a GRANT
// (a spend/send/merge verb with no restricting language around it) is
// refused outright — the effect vocabulary couldn't represent it anyway
// (docs/learning.md), and converting it to "advice to do X" would smuggle
// the grant in through the back door.

const GRANT_VERBS = /\b(merge|send|spend|deploy|publish|bypass|force-push|delete|approve)(s|ed|ing)?\b/i;
const RESTRICTING = /\b(never|not|don'?t|do not|cannot|must not|avoid|refuse[sd]?|forbidden|only|require[sd]?|approval|ask|explicit)\b/i;

export function grantsAuthority(text: string): boolean {
  return GRANT_VERBS.test(text) && !RESTRICTING.test(text);
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
} {
  const raw = fs.readFileSync(filePath, 'utf8');
  const candidates: BackfillCandidate[] = [];
  const skipped: BackfillReport['skipped'] = [];

  // Heading stack by level; a rule line needs a level>=2 heading above it and
  // no repo-internal heading anywhere in its ancestry.
  const headings: (string | undefined)[] = [];
  let inFence = false;

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
      continue;
    }

    const stack = headings.filter((h): h is string => Boolean(h));
    const underRuleHeading = headings.slice(2).some(Boolean);
    if (!underRuleHeading || stack.some((h) => SKIP_HEADINGS.test(h))) continue;

    // Rule shapes: a bullet (-, *, 1.) or a bold-lead paragraph line.
    const bullet = /^\s{0,3}(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    const boldLead = !bullet && /^\*\*[^*]/.test(line.trim());
    const ruleText = bullet ? bullet[1]! : boldLead ? line.trim() : undefined;
    if (!ruleText || linksOnly(ruleText)) continue;

    const statement = cleanMarkdown(ruleText);
    if (statement.length < 20 || statement.length > 600) continue;

    const headingLabel = stack.slice(1).join(' › ') || stack.join(' › ');
    const ref = `${filePath} § ${headingLabel}`;
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
  return { candidates, skipped };
}

// ---------------------------------------------------------------------------
// Dedup + write (shared by both sources).

function applyCandidates(
  candidates: BackfillCandidate[],
  tags: string[],
  dryRun: boolean,
  report: BackfillReport,
): void {
  const existing = new Set(loadPolicies().policies.map((p) => normalizeStatement(p.statement)));
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
        proposeBackfillPolicy({
          statement: c.statement,
          tags,
          effectKind: c.effectKind,
          effectDescription: c.effectDescription,
          source: c.source,
          ref: c.ref,
          interventionSummary: c.interventionSummary,
        }),
      );
    }
  }
}

export function backfillRules(paths: string[], tags: string[], dryRun: boolean): BackfillReport {
  const report: BackfillReport = { created: [], wouldCreate: [], duplicates: [], skipped: [] };
  const candidates: BackfillCandidate[] = [];
  for (const p of paths) {
    const parsed = parseRulesFile(p);
    candidates.push(...parsed.candidates);
    report.skipped.push(...parsed.skipped);
  }
  applyCandidates(candidates, tags, dryRun, report);
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
  const report: BackfillReport = { created: [], wouldCreate: [], duplicates: [], skipped: [] };
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
    `- statement: the rule as a general imperative`,
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
      maxTurns: 4,
      persistSession: false,
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
      interventionSummary: `backfilled from Claude Code ${ref}: "${s.quote.slice(0, 200)}"`,
    });
  }
  applyCandidates(candidates, tags, opts.dryRun, report);
  return report;
}

// ---------------------------------------------------------------------------

export function renderBackfillReport(report: BackfillReport, dryRun: boolean): string {
  const lines: string[] = [];
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
