/**
 * The ENGINE-computed repo-egress gate: which pushes, PR-opens, merges and
 * deploys may be cleared by Pilot, and which need a person no matter what the
 * coordinator chose for `approval_mode`.
 *
 * Why the engine and not the prompt. The fleet reads untrusted text — support
 * threads, Sentry payloads, session replays, issues — and before this gate
 * nothing deterministic stood between that text and merged production code:
 * the coordinator (a model) picked `approval_mode`, Pilot (a small model with
 * the operator's rules) judged `gh pr merge` and `git push` from the command
 * string alone, and the "DevBot-clean + CI-green" merge bar was prompt text.
 * Every one of those can be steered by the text the fleet was asked to read.
 * So two facts the model cannot author now decide the approval path:
 *
 *   1. WHAT CHANGES. The engine computes the changed paths itself — the
 *      pushed range in the checkout, or the PR's own file list via the
 *      read-only token — and any path in the sensitive set (CI config, auth,
 *      billing, migrations, infra, and the files that steer every later agent)
 *      makes the act human-only. If the paths cannot be computed, the act is
 *      human-only: absence of evidence is not evidence of safety.
 *   2. WHERE THE WORK CAME FROM. A workstream whose origin is `untrusted`
 *      (see `workstreamOriginForAuthority`) may push and open PRs — the fleet
 *      still does the work — but a merge or deploy from it is always a
 *      person's act.
 *
 * A command shape the gate cannot classify (a `gh api` write it does not
 * recognise, `curl` at the GitHub API, `hub`, an aliased or `--mirror` push)
 * fails closed to human-only too. The structural backstop underneath all of
 * this: the engine hands a WRITE token only to a command whose literal text is
 * `git push`/`gh pr create`/`gh pr merge` (deconflict.ts matchesRepoEgressWrite),
 * and every such shape is classified here. Anything else runs with a read token
 * GitHub will refuse to write with.
 *
 * Doctrine: this gate only ever NARROWS authority. A human approval still
 * clears it, but only an approval that pinned the exact gate fingerprint the
 * person saw — the engine recomputes the gate immediately before egress
 * (kernel rule 7), and a diff that moved after approval revokes it.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  autoApprovableCustomer,
  emailDomain,
  parsePlainReplyCommand,
  PLAIN_AUTO_REPLY_DOMAIN,
  plainReplyTextHash,
  plainSeam,
  plainSendOutsideReplyCommand,
  type PlainCustomerLookup,
  type PlainIO,
} from './plain.js';
import { engineCommandEnv } from './secrets.js';
import type { Assignment, EgressGateReason, WorkstreamCore, WorkstreamOrigin } from './types.js';

// ---------------------------------------------------------------------------
// Sensitive paths

export const DEFAULT_HUMAN_REVIEW_PATHS: readonly string[] = [
  '.github/**',
  '**/auth/**',
  '**/*auth*.{ts,go,py}',
  '**/billing/**',
  '**/payments/**',
  '**/migrations/**',
  'infra/**',
  'deploy/**',
  '**/Dockerfile*',
  '**/*.tf',
  // The last four are the files that steer every later agent run in the
  // repository. A self-merged edit to one of them would re-brief the whole
  // fleet from inside the code it is supposed to be changing.
  '.claude/**',
  '**/CLAUDE.md',
  '**/AGENTS.md',
  '**/.mcp.json',
];

/** The operator's configured sensitive set: `WEAVER_HUMAN_REVIEW_PATHS` as
 * comma-separated globs replaces the default. An empty or whitespace-only
 * value keeps the default — silently disabling the gate by a stray empty
 * variable would widen authority. */
export function humanReviewPathGlobs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.WEAVER_HUMAN_REVIEW_PATHS;
  if (raw === undefined) return [...DEFAULT_HUMAN_REVIEW_PATHS];
  const globs = splitGlobList(raw);
  return globs.length ? globs : [...DEFAULT_HUMAN_REVIEW_PATHS];
}

/** Split on commas that are not inside a `{a,b}` alternation. */
function splitGlobList(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of raw) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((glob) => glob.trim()).filter(Boolean);
}

/**
 * Glob → RegExp. `**` spans any number of path segments (including none, so
 * `**\/auth/**` matches `auth/x.ts`), `*` and `?` stay inside one segment, and
 * `{a,b}` alternates. Matching is case-insensitive on purpose: a checkout on
 * a case-insensitive filesystem reads `claude.md` as `CLAUDE.md`, so the
 * conservative answer is to treat them as the same file.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` → zero or more whole segments; a trailing `**` → anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      braceDepth++;
      re += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (ch === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Every changed path that matches the sensitive set, de-duplicated. */
export function sensitivePaths(paths: readonly string[], globs: readonly string[] = humanReviewPathGlobs()): string[] {
  const patterns = globs.map(globToRegExp);
  const hits = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, '');
    if (patterns.some((pattern) => pattern.test(path))) hits.add(path);
  }
  return [...hits].sort();
}

// ---------------------------------------------------------------------------
// Origin

/**
 * The origin that bounds AUTHORITY. New documents carry `origin` explicitly.
 * A legacy document without it reads as `untrusted` when it has a manager
 * (every managed child could have been authored from untrusted text, and the
 * record of which ones were is exactly what is missing), and `operator`
 * otherwise. Fail safe: the unknown case is the narrower one.
 */
export function workstreamOriginForAuthority(ws: Pick<WorkstreamCore, 'origin' | 'managedBy'>): WorkstreamOrigin {
  return ws.origin ?? (ws.managedBy ? 'untrusted' : 'operator');
}

/** The origin shown to people. A legacy document is presented as it was
 * created — by the operator — while authority still uses the narrower read. */
export function workstreamOriginForDisplay(ws: Pick<WorkstreamCore, 'origin'>): WorkstreamOrigin {
  return ws.origin ?? 'operator';
}

/**
 * The taint rule for a managed child, in one place.
 *
 *   - A child created by a COORDINATOR is always `untrusted`. The objective,
 *     criteria and constraints it carries are model-authored, and the pass
 *     that authored them read a projection full of text the fleet did not
 *     write — observations, replies, worker deliverables, probe output. A
 *     pass woken only by human steering still reads all of that, so "woken by
 *     a steer" is no proof the child's brief is clean; we do not pretend it is.
 *   - A child created by a HUMAN (`weaver create --under`, browser intake with
 *     a parent) is `operator` — unless its parent is untrusted, whose taint it
 *     inherits: the person chose the words, but the parent's managing passes
 *     will keep directing it.
 *   - A child created through bot INGRESS (`weaver serve`) is `untrusted`.
 */
export function childOrigin(
  creator: 'coordinator' | 'human' | 'ingress',
  parent: Pick<WorkstreamCore, 'origin' | 'managedBy'>,
): WorkstreamOrigin {
  if (creator !== 'human') return 'untrusted';
  return workstreamOriginForAuthority(parent);
}

/**
 * Who clears a MERGE or DEPLOY from an untrusted-origin workstream — the one
 * part of this gate the operator may relax without a code change, because it
 * withdraws self-merge from most of a fleet whose jobs are customer-derived.
 *
 *   - `person` (default): always a person.
 *   - `pilot`: the ordinary Pilot-or-human path again, but ONLY for an act the
 *     rest of the gate already clears. The sensitive-path gate, the
 *     cannot-compute and cannot-classify fail-closed rules, and the missing
 *     `workflows` permission stay unconditional.
 *
 * Any other value is a configuration error and refuses to start: a typo must
 * never silently read as either setting.
 */
export type UntrustedMergePolicy = 'person' | 'pilot';

export function untrustedMergePolicy(env: NodeJS.ProcessEnv = process.env): UntrustedMergePolicy {
  const raw = env.WEAVER_UNTRUSTED_MERGE;
  if (raw === undefined || raw.trim() === '') return 'person';
  const value = raw.trim();
  if (value === 'person' || value === 'pilot') return value;
  throw new Error(`WEAVER_UNTRUSTED_MERGE must be 'person' or 'pilot', got '${raw}' — refusing to start rather than guess who may merge untrusted work`);
}

// ---------------------------------------------------------------------------
// Command classification

export type EgressClass = 'push' | 'pr-create' | 'merge' | 'deploy' | 'customer-reply' | 'unclassified';

export type EgressShape =
  | {
      class: 'push';
      /** `-C dir` or a leading `cd dir &&`, when the command names one. */
      dir?: string;
      remote?: string;
      /** Source ref (`HEAD` when the refspec names none). */
      src: string;
      /** Destination branch, or undefined to resolve the checkout's upstream. */
      dst?: string;
      /** A push onto a trunk branch lands without review: it is a merge. */
      intoTrunk: boolean;
      command: string;
    }
  | { class: 'pr-create'; dir?: string; head?: string; base?: string; repo?: string; command: string }
  | { class: 'merge'; dir?: string; repo?: string; selector?: string; command: string }
  | { class: 'deploy'; command: string }
  /** A customer-facing support reply in the one recognised shape
   * (`weaver plain reply`, src/plain.ts). Who must approve it depends on the
   * thread's customer, which the engine reads back from Plain. */
  | { class: 'customer-reply'; threadId: string; textHash: string; command: string }
  | { class: 'unclassified'; detail: string; command: string };

const TRUNK_BRANCHES = /^(main|master|trunk|production|prod|release(\/.*)?|develop)$/i;

/** Split a shell command into simple-command segments. Deliberately naive
 * about quoting: over-splitting only ever produces MORE segments to classify. */
function segments(cmd: string): string[] {
  return cmd.split(/&&|\|\||;|\||\n|\$\(|`/).map((s) => s.trim()).filter(Boolean);
}

/** Whitespace tokens with surrounding quotes dropped. */
function tokens(segment: string): string[] {
  return segment.split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
}

function dirOf(cmd: string, segment: string): string | undefined {
  const c = /\bgit\s+(?:[^|;&\n]*\s)?-C\s+(['"]?)([^\s'"]+)\1/.exec(segment);
  if (c?.[2]) return c[2];
  // `cd dir && git push`: the last cd before this segment in the same command.
  const before = cmd.slice(0, Math.max(0, cmd.indexOf(segment)));
  const cds = [...before.matchAll(/\bcd\s+(['"]?)([^\s'";&|]+)\1/g)];
  return cds.at(-1)?.[2];
}

const GIT_PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);

function classifyGitPush(cmd: string, segment: string): EgressShape[] {
  const m = /\bgit\b(.*?)\bpush\b(.*)$/.exec(segment);
  if (!m) return [];
  const pre = m[1] ?? '';
  // Anything between `git` and `push` other than -C/--no-pager/-c k=v of a
  // non-alias key is a shape we do not parse: an alias can make `push` mean
  // anything, and --git-dir/--work-tree move the repository out of view.
  const preTokens = tokens(pre);
  for (let i = 0; i < preTokens.length; i++) {
    const t = preTokens[i]!;
    if (t === '-C') { i++; continue; }
    if (t === '--no-pager' || t === '--no-replace-objects') continue;
    if (t === '-c') {
      const kv = preTokens[i + 1] ?? '';
      if (/^alias\./i.test(kv) || /^(core\.hookspath|core\.sshcommand|url\.)/i.test(kv)) {
        return [{ class: 'unclassified', detail: `git -c ${kv} changes what push does`, command: segment }];
      }
      i++;
      continue;
    }
    return [{ class: 'unclassified', detail: `git option ${t} before push`, command: segment }];
  }
  const args = tokens(m[2] ?? '');
  const positionals: string[] = [];
  let deleting = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GIT_PUSH_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a === '--all' || a === '--mirror' || a === '--branches') {
      return [{ class: 'unclassified', detail: `git push ${a} writes every ref`, command: segment }];
    }
    if (a === '--tags' || a === '--follow-tags') {
      // A tag push is how releases ship (a pushed version tag publishes
      // through CI) — the npm incident's shape. It is a deploy.
      return [{ class: 'deploy', command: segment }];
    }
    if (a === '--delete' || a === '-d') { deleting = true; continue; }
    if (a.startsWith('-')) continue;
    positionals.push(a);
  }
  const dir = dirOf(cmd, segment);
  const remote = positionals[0];
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    if (deleting) return [];
    return [{ class: 'push', ...(dir ? { dir } : {}), ...(remote ? { remote } : {}), src: 'HEAD', intoTrunk: false, command: segment }];
  }
  const shapes: EgressShape[] = [];
  for (const refspec of refspecs) {
    const colon = refspec.indexOf(':');
    const src = (colon >= 0 ? refspec.slice(0, colon) : refspec).replace(/^\+/, '');
    const dstRaw = colon >= 0 ? refspec.slice(colon + 1) : refspec.replace(/^\+/, '');
    if (/^refs\/tags\//.test(dstRaw) || /^refs\/tags\//.test(src) || /^v?\d+\.\d+/.test(dstRaw)) {
      shapes.push({ class: 'deploy', command: segment });
      continue;
    }
    if (dstRaw && !/^refs\/heads\//.test(dstRaw) && dstRaw.startsWith('refs/')) {
      shapes.push({ class: 'unclassified', detail: `push to non-branch ref ${dstRaw}`, command: segment });
      continue;
    }
    const dst = dstRaw.replace(/^refs\/heads\//, '');
    const intoTrunk = TRUNK_BRANCHES.test(dst);
    // Deleting a branch writes no content — the cleanup after a merge — but
    // deleting a trunk branch is never routine.
    if (deleting || (colon === 0)) {
      if (intoTrunk) shapes.push({ class: 'merge', ...(dir ? { dir } : {}), command: segment });
      continue;
    }
    shapes.push({
      class: 'push',
      ...(dir ? { dir } : {}),
      ...(remote ? { remote } : {}),
      src: src || 'HEAD',
      ...(dst && dst !== 'HEAD' ? { dst } : {}),
      intoTrunk,
      command: segment,
    });
  }
  return shapes;
}

function optionValue(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) return args[i + 1];
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
    }
  }
  return undefined;
}

const GH_VALUE_FLAGS = new Set([
  '-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '--match-head-commit',
  '-A', '--author-email', '--jq', '-q', '--template', '-H', '--head', '-B', '--base', '--title',
  '-l', '--label', '-a', '--assignee', '-r', '--reviewer', '-m', '--milestone', '-p', '--project',
]);

function classifyGh(cmd: string, segment: string): EgressShape[] {
  const m = /\bgh\s+(.*)$/.exec(segment);
  if (!m) return [];
  const args = tokens(m[1] ?? '');
  const [group, sub] = args;
  const dir = dirOf(cmd, segment);
  const repo = optionValue(args, '-R', '--repo');
  if (group === 'pr' && sub === 'merge') {
    const rest = args.slice(2);
    let selector: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (GH_VALUE_FLAGS.has(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      selector = a;
      break;
    }
    return [{ class: 'merge', ...(dir ? { dir } : {}), ...(repo ? { repo } : {}), ...(selector ? { selector } : {}), command: segment }];
  }
  if (group === 'pr' && sub === 'create') {
    const head = optionValue(args, '-H', '--head');
    const base = optionValue(args, '-B', '--base');
    return [{ class: 'pr-create', ...(dir ? { dir } : {}), ...(head ? { head } : {}), ...(base ? { base } : {}), ...(repo ? { repo } : {}), command: segment }];
  }
  if ((group === 'release' && (sub === 'create' || sub === 'upload' || sub === 'edit'))
    || (group === 'workflow' && (sub === 'run' || sub === 'enable'))
    || (group === 'run' && sub === 'rerun')) {
    return [{ class: 'deploy', command: segment }];
  }
  if (group === 'repo' && (sub === 'delete' || sub === 'edit' || sub === 'rename' || sub === 'archive' || sub === 'sync')) {
    return [{ class: 'unclassified', detail: `gh repo ${sub}`, command: segment }];
  }
  if (group === 'api') return classifyGhApi(segment, args.slice(1));
  return [];
}

/** `gh api` is a raw GitHub write surface. Reads pass; a recognisable merge
 * is a merge; every other write is unclassified and needs a person. */
function classifyGhApi(segment: string, args: string[]): EgressShape[] {
  const method = (optionValue(args, '-X', '--method') ?? '').toUpperCase();
  const hasBody = args.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^(--field|--raw-field|--input)=/.test(a));
  const path = args.find((a) => !a.startsWith('-') && /\//.test(a) || a === 'graphql') ?? '';
  if (path === 'graphql' || /(^|\/)graphql$/.test(path)) {
    if (/\bmutation\b/.test(segment)) {
      if (/mergePullRequest|enablePullRequestAutoMerge/.test(segment)) return [{ class: 'merge', command: segment }];
      return [{ class: 'unclassified', detail: 'gh api graphql mutation', command: segment }];
    }
    return [];
  }
  const writes = (method && method !== 'GET' && method !== 'HEAD') || (!method && hasBody);
  if (!writes) return [];
  const pullMerge = /repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge\b/.exec(path);
  if (pullMerge) {
    const repo = pullMerge[1]!.includes('{') ? undefined : pullMerge[1];
    return [{ class: 'merge', ...(repo ? { repo } : {}), selector: pullMerge[2]!, command: segment }];
  }
  if (/\/merges\b|\/dispatches\b|\/deployments\b|\/releases\b/.test(path)) {
    return [{ class: /\/merges\b/.test(path) ? 'merge' : 'deploy', command: segment }];
  }
  return [{ class: 'unclassified', detail: `gh api ${method || 'POST'} ${path}`, command: segment }];
}

const DEPLOY_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn(\s+npm)?|bun)\s+publish\b/,
  /\bcargo\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bgem\s+push\b/,
  /\bdocker\s+(push|buildx\s+build\b[^|;&\n]*--push)\b/,
  /\bkubectl\s+(apply|create|replace|patch|set|delete|scale)\b/,
  /\bkubectl\s+rollout\s+(restart|undo|resume)\b/,
  /\bhelm\s+(install|upgrade|uninstall|rollback)\b/,
  /\bterraform\s+(apply|destroy|import)\b/,
  /\btofu\s+(apply|destroy)\b/,
  /\bpulumi\s+(up|destroy)\b/,
  /\b(fly|flyctl)\s+deploy\b/,
  /\bvercel\b[^|;&\n]*(--prod\b|\bdeploy\b|\bpromote\b)/,
  /\bnetlify\s+deploy\b/,
  /\brailway\s+(up|redeploy)\b/,
  /\bgcloud\s+(run|functions|app)\s+[^|;&\n]*\bdeploy\b/,
  /\bgcloud\s+(beta\s+)?(run|functions|app)\s+deploy\b/,
  /\bgcloud\s+builds\s+submit\b/,
  /\baws\s+(deploy\s+create-deployment|ecs\s+update-service|lambda\s+update-function-code|cloudformation\s+(deploy|update-stack|create-stack))\b/,
  /\bfirebase\s+deploy\b/,
  /\bheroku\b[^|;&\n]*\b(releases:rollback|container:release|deploy)\b/,
  /\b(serverless|sls)\s+deploy\b/,
  /\bwrangler\s+(deploy|publish)\b/,
  /\bencore\b[^|;&\n]*\bdeploy\b/,
  /\beas\s+(submit|update)\b/,
];

/**
 * Bumped whenever the command classifier changes its verdict on some command.
 * An action parked by an older version for a command it could not classify
 * is checked once more by the current one (engine.ts gateRepoEgressActions).
 * 2: literal text (quoted strings, heredoc bodies) no longer counts as code.
 * 3: no text-pattern check for "opaque code" at all, and a push or PR open
 *    that cannot reach the default branch is not held for its paths.
 */
export const EGRESS_CLASSIFIER_VERSION = 3;

/**
 * Classify every repo egress a shell command could perform. Returns an empty
 * list for a command with no egress shape at all. Classification is over the
 * command's own text, never its description; over-matching is intended (it
 * only ever routes an act to a person).
 */
export function classifyEgressCommand(cmd: string): EgressShape[] {
  if (!cmd?.trim()) return [];
  // The recognised reply is the whole command, and its heredoc body is the
  // customer's message, not code: it is never scanned for other shapes.
  const reply = parsePlainReplyCommand(cmd);
  if (reply) {
    return [{ class: 'customer-reply', threadId: reply.threadId, textHash: plainReplyTextHash(reply.text), command: cmd.slice(0, 200) }];
  }
  const shapes: EgressShape[] = [];
  const plainSend = plainSendOutsideReplyCommand(cmd);
  if (plainSend) shapes.push({ class: 'unclassified', detail: plainSend, command: cmd.slice(0, 200) });
  for (const segment of segments(cmd)) {
    if (/\bgit\b[^&|;\n]*\bpush\b/.test(segment)) shapes.push(...classifyGitPush(cmd, segment));
    if (/\bgh\s+\S/.test(segment)) shapes.push(...classifyGh(cmd, segment));
    if (/\bhub\s+(merge|push|pull-request|api|release|sync|ci-status\s+--)\b/.test(segment)) {
      shapes.push({ class: 'unclassified', detail: 'hub writes', command: segment });
    }
    if (DEPLOY_PATTERNS.some((pattern) => pattern.test(segment))) shapes.push({ class: 'deploy', command: segment });
  }
  // The GitHub API reached without gh: curl/wget/httpie or a script. A read
  // passes; anything that looks like a write — a method, a body, or a script
  // that could do either — cannot be classified and needs a person.
  if (/api\.github\.com|uploads\.github\.com/i.test(cmd)) {
    const writes = /(-X|--request)\s*['"]?(POST|PUT|PATCH|DELETE)/i.test(cmd)
      || /\s(-d|--data(-raw|-binary|-urlencode)?|--json|-F|--form|-T|--upload-file)\b/.test(cmd)
      || /\b(http|https|xh)\s+(POST|PUT|PATCH|DELETE)\b/i.test(cmd)
      // A script that names the API in its own source can issue any request.
      || segments(cmd).some((segment) => /api\.github\.com|uploads\.github\.com/i.test(segment)
        && /^(\w+=\S*\s+)*(node|python3?|ruby|perl|deno|bun|php|pwsh)\b/.test(segment))
      || /method\s*[:=]/i.test(cmd);
    if (writes) shapes.push({ class: 'unclassified', detail: 'GitHub API write outside gh', command: cmd.slice(0, 200) });
  }
  // A token-bearing network request whose target we cannot see (the URL in a
  // variable, a script). Comparing or testing the token is not a request.
  if (/\$\{?(GH_TOKEN|GITHUB_TOKEN)\b/.test(cmd)
    && /(^|[\s;&|(`])(curl|wget|http|https|xh|node|python3?|ruby|perl|deno|bun|php|pwsh|nc|openssl)(\s|$)/.test(cmd)
    && !shapes.some((s) => s.class === 'unclassified')) {
    shapes.push({ class: 'unclassified', detail: 'uses the GitHub token outside gh', command: cmd.slice(0, 200) });
  }
  return shapes;
}

/** True when the command could write repo state or deploy. */
export function commandHasEgress(cmd: string): boolean {
  return classifyEgressCommand(cmd).length > 0;
}

// ---------------------------------------------------------------------------
// Changed paths (IO)

export type PathsResult = { ok: true; paths: string[]; identity: string } | { ok: false; error: string };

/** Injectable IO seam so the gate is deterministic in tests. */
export interface EgressDiffIO {
  pushedPaths(cwd: string, shape: Extract<EgressShape, { class: 'push' }>, env: Record<string, string>): PathsResult;
  prCreatePaths(cwd: string, shape: Extract<EgressShape, { class: 'pr-create' }>, env: Record<string, string>): PathsResult;
  mergePaths(cwd: string, shape: Extract<EgressShape, { class: 'merge' }>, env: Record<string, string>): PathsResult;
  /** The checkout's default branch name (origin/HEAD), or null. */
  defaultBranch(cwd: string, env: Record<string, string>): string | null;
  /** The branch an unqualified push lands on (upstream, else current), or null. */
  upstreamBranch(cwd: string, env: Record<string, string>): string | null;
}

/** Git through a scrubbed environment with every repo-configurable command
 * hook disabled: the checkout is model-influenced, and its config can execute
 * programs (fsmonitor, hooks, external diff, textconv). */
function git(cwd: string, args: string[], env: Record<string, string>): string {
  return execFileSync('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    ...args,
  ], {
    cwd,
    env: { ...engineCommandEnv(env), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gh(cwd: string, args: string[], env: Record<string, string>): string {
  return execFileSync('gh', args, {
    cwd,
    env: { ...engineCommandEnv(env), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);
}

/** Paths a range changes: every commit's paths plus the net tree difference,
 * so an intermediate commit that touched a file and a later one that reverted
 * it are both still seen. */
function rangePaths(cwd: string, base: string, tip: string, env: Record<string, string>): string[] {
  const perCommit = lines(git(cwd, ['log', '--no-renames', '--name-only', '--format=', `${base}..${tip}`], env));
  const net = lines(git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', base, tip], env));
  return [...new Set([...perCommit, ...net])].sort();
}

function mergeBaseWithDefault(cwd: string, tip: string, env: Record<string, string>, base?: string): string {
  const candidates = base ? [`refs/remotes/origin/${base}`] : ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];
  for (const ref of candidates) {
    try {
      return git(cwd, ['merge-base', ref, tip], env);
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`no merge-base between ${tip} and ${candidates.join('/')}`);
}

export const liveEgressDiffIO: EgressDiffIO = {
  pushedPaths(cwd, shape, env) {
    try {
      const tip = git(cwd, ['rev-parse', '--verify', `${shape.src}^{commit}`], env);
      const dst = shape.dst ?? this.upstreamBranch(cwd, env);
      if (!dst) return { ok: false, error: `cannot tell which branch ${shape.src} pushes to` };
      const remote = shape.remote && !/[:/]/.test(shape.remote) ? shape.remote : 'origin';
      let base: string;
      try {
        base = git(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/${dst}^{commit}`], env);
      } catch {
        base = mergeBaseWithDefault(cwd, tip, env);
      }
      return { ok: true, paths: rangePaths(cwd, base, tip, env), identity: `push:${dst}@${tip}` };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  },
  prCreatePaths(cwd, shape, env) {
    try {
      const headName = shape.head?.includes(':') ? shape.head.slice(shape.head.indexOf(':') + 1) : shape.head;
      let tip: string;
      try {
        tip = git(cwd, ['rev-parse', '--verify', `${headName ?? 'HEAD'}^{commit}`], env);
      } catch {
        tip = git(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${headName}^{commit}`], env);
      }
      const base = mergeBaseWithDefault(cwd, tip, env, shape.base);
      return { ok: true, paths: rangePaths(cwd, base, tip, env), identity: `pr-create:${headName ?? 'HEAD'}@${tip}` };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  },
  mergePaths(cwd, shape, env) {
    try {
      let repo = shape.repo;
      let number = shape.selector && /^\d+$/.test(shape.selector) ? shape.selector : undefined;
      const url = shape.selector ? /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(shape.selector) : null;
      if (url) {
        repo = url[1];
        number = url[2];
      }
      if (!repo || !number) {
        // A branch selector, the current branch's PR, or an unnamed repo:
        // ask gh which PR this is before reading its files.
        const selector = number ?? shape.selector;
        const view = JSON.parse(gh(cwd, [
          'pr', 'view',
          ...(selector ? [selector] : []),
          ...(repo ? ['--repo', repo] : []),
          '--json', 'number,url',
        ], env)) as { number?: number; url?: string };
        const fromUrl = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(view.url ?? '');
        if (!fromUrl || !view.number) return { ok: false, error: 'gh could not resolve the PR being merged' };
        repo = fromUrl[1];
        number = String(view.number);
      }
      const pr = JSON.parse(gh(cwd, ['api', `repos/${repo}/pulls/${number}`], env)) as {
        changed_files?: number;
        head?: { sha?: string };
      };
      const headSha = pr.head?.sha;
      if (!headSha || typeof pr.changed_files !== 'number') return { ok: false, error: `PR ${repo}#${number} did not report its head and file count` };
      // The files endpoint stops at 3000 entries; a larger PR cannot be
      // proven clean from it.
      if (pr.changed_files >= 3000) return { ok: false, error: `PR ${repo}#${number} changes ${pr.changed_files} files, beyond what the files API lists` };
      const files = lines(gh(cwd, [
        'api', '--paginate', `repos/${repo}/pulls/${number}/files?per_page=100`,
        '--jq', '.[] | .filename, (.previous_filename // empty)',
      ], env));
      return { ok: true, paths: [...new Set(files)].sort(), identity: `merge:${repo}#${number}@${headSha}` };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  },
  defaultBranch(cwd, env) {
    try {
      return git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env).replace(/^origin\//, '') || null;
    } catch {
      return null;
    }
  },
  upstreamBranch(cwd, env) {
    try {
      return git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], env).replace(/^[^/]+\//, '') || null;
    } catch {
      try {
        const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
        return branch && branch !== 'HEAD' ? branch : null;
      } catch {
        return null;
      }
    }
  },
};

/** The IO the engine and the worker supervisor use. Replaceable only so the
 * deterministic tests can stand in for git and the GitHub API. */
export const egressGateSeam: { io: EgressDiffIO } = { io: liveEgressDiffIO };

// ---------------------------------------------------------------------------
// The gate

export interface EgressGateResult {
  /** The command performs at least one classified repo egress or deploy. */
  egress: boolean;
  /** A person must clear it; Pilot is never consulted. */
  humanOnly: boolean;
  reasons: EgressGateReason[];
  /** Stable identity of exactly what was judged — the reasons plus the
   * commits/PR heads involved. A human approval pins it; a different value at
   * egress means the act changed after the person looked. */
  fingerprint: string;
}

export interface EgressGateInput {
  origin: WorkstreamOrigin;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  io?: EgressDiffIO;
  globs?: readonly string[];
  /** Defaults to WEAVER_UNTRUSTED_MERGE; throws on an unknown value. */
  untrustedMerge?: UntrustedMergePolicy;
  /** The customer of each replied-to Plain thread, read back from Plain by
   * the async caller (resolvePlainCustomers). A reply whose thread is absent
   * here was not read back and needs a person. */
  plainCustomers?: ReadonlyMap<string, PlainCustomerLookup>;
}

export function evaluateEgressGate(input: EgressGateInput): EgressGateResult {
  const io = input.io ?? liveEgressDiffIO;
  const env = input.env ?? {};
  const globs = input.globs ?? humanReviewPathGlobs();
  // Only the untrusted-origin merge/deploy rule reads this; every other
  // reason below is unconditional.
  const untrustedNeedsPerson = input.origin === 'untrusted'
    && (input.untrustedMerge ?? untrustedMergePolicy()) === 'person';
  const shapes = classifyEgressCommand(input.command);
  const reasons: EgressGateReason[] = [];
  const identities: string[] = [];
  const sensitive = new Set<string>();
  for (const shape of shapes) {
    if (shape.class === 'unclassified') {
      reasons.push({ kind: 'unclassified-egress', detail: shape.detail });
      continue;
    }
    if (shape.class === 'customer-reply') {
      // Who must approve depends on who receives it, read back from Plain —
      // never from the command, the brief, or anything a model wrote.
      const lookup = input.plainCustomers?.get(shape.threadId);
      if (!lookup) {
        reasons.push({ kind: 'customer-reply-unverified', detail: 'the thread\'s customer was not read back from Plain for this act' });
      } else if (!lookup.ok) {
        reasons.push({ kind: 'customer-reply-unverified', detail: lookup.error });
      } else if (!autoApprovableCustomer(lookup)) {
        reasons.push({
          kind: 'customer-reply-external',
          domain: emailDomain(lookup.email) ?? 'an unreadable address',
          ...(lookup.verified ? {} : { unverified: true }),
        });
      }
      // The recipient joins the fingerprint as a hash: a person's approval
      // covers this text to this customer, and a thread whose customer
      // changed after approval is a different act.
      const recipient = lookup?.ok ? createHash('sha256').update(lookup.email.toLowerCase()).digest('hex').slice(0, 16) : 'unread';
      identities.push(`customer-reply:${shape.threadId}:${shape.textHash}:${recipient}`);
      continue;
    }
    if (shape.class === 'deploy') {
      identities.push(`deploy:${shape.command}`);
      if (untrustedNeedsPerson) reasons.push({ kind: 'untrusted-origin', egress: 'deploy', setting: 'person' });
      continue;
    }
    const cwd = shape.dir ?? input.cwd;
    let result: PathsResult;
    let merges = shape.class === 'merge';
    if (shape.class === 'push') {
      const dst = shape.dst ?? io.upstreamBranch(cwd, env) ?? undefined;
      const trunk = shape.intoTrunk || (!!dst && (TRUNK_BRANCHES.test(dst) || dst === io.defaultBranch(cwd, env)));
      merges = trunk;
      if (!trunk) {
        // A feature branch reaches the default branch only through a merge,
        // and the repositories' own rulesets require a reviewed PR for that.
        // What the branch touches is the merge's question, asked there.
        identities.push(`push:${shape.command}`);
        continue;
      }
      result = io.pushedPaths(cwd, dst ? { ...shape, dst } : shape, env);
    } else if (shape.class === 'pr-create') {
      // Opening a PR changes nothing that ships; it is where review starts.
      identities.push(`pr-create:${shape.command}`);
      continue;
    } else {
      result = io.mergePaths(cwd, shape, env);
    }
    if (merges && untrustedNeedsPerson) reasons.push({ kind: 'untrusted-origin', egress: 'merge', setting: 'person' });
    if (!result.ok) {
      reasons.push({ kind: 'diff-unavailable', detail: result.error });
      continue;
    }
    identities.push(result.identity);
    for (const path of sensitivePaths(result.paths, globs)) sensitive.add(path);
  }
  if (sensitive.size) reasons.unshift({ kind: 'sensitive-path', paths: [...sensitive].sort() });
  const deduped = dedupeReasons(reasons);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ reasons: deduped, identities: [...new Set(identities)].sort() }))
    .digest('hex');
  return { egress: shapes.length > 0, humanOnly: deduped.length > 0, reasons: deduped, fingerprint };
}

/**
 * Read back, from Plain, the customer of every thread this command replies
 * to — the input the gate decides a reply's approver from. Runs at gate time
 * and again immediately before egress. A missing key or a failed read is
 * recorded as a failed lookup, which the gate turns into a person's act.
 */
export async function resolvePlainCustomers(
  command: string,
  apiKey: string | undefined,
  io: PlainIO = plainSeam.io,
): Promise<Map<string, PlainCustomerLookup>> {
  const lookups = new Map<string, PlainCustomerLookup>();
  for (const shape of classifyEgressCommand(command)) {
    if (shape.class !== 'customer-reply' || lookups.has(shape.threadId)) continue;
    if (!apiKey?.trim()) {
      lookups.set(shape.threadId, { ok: false, error: 'PLAIN_API_KEY is not set on this runner' });
      continue;
    }
    try {
      lookups.set(shape.threadId, await io.threadCustomer(shape.threadId, apiKey));
    } catch (error) {
      lookups.set(shape.threadId, { ok: false, error: errorText(error) });
    }
  }
  return lookups;
}

function dedupeReasons(reasons: EgressGateReason[]): EgressGateReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = JSON.stringify(reason);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Does this action's current approval authorise the act the gate just saw?
 * A gate that needs no person is covered by any matching approval; a gate
 * that needs a person is covered only by a HUMAN approval that pinned this
 * exact fingerprint — so a diff that moved after approval is caught. */
export function approvalCoversGate(asg: Assignment, gate: EgressGateResult): boolean {
  const approval = asg.exec?.approval;
  if (!approval) return false;
  if (!gate.humanOnly) return true;
  return approval.by === 'human' && approval.egressFingerprint === gate.fingerprint;
}

/** One plain sentence per reason, for the card, status, printout, timeline. */
export function describeEgressGateReason(reason: EgressGateReason): string {
  switch (reason.kind) {
    case 'sensitive-path': {
      const shown = reason.paths.slice(0, 3).join(', ');
      const more = reason.paths.length > 3 ? ` and ${reason.paths.length - 3} more` : '';
      return `touches ${shown}${more}, ${reason.paths.length === 1 ? 'a sensitive path' : 'sensitive paths'}: needs a person`;
    }
    case 'untrusted-origin':
      return `${reason.egress === 'merge' ? 'merges' : 'deploys'} from customer-derived jobs need a person (WEAVER_UNTRUSTED_MERGE=${reason.setting ?? 'person'})`;
    case 'unclassified-egress':
      return `the engine cannot classify this repo write (${reason.detail}), so it fails closed to a person`;
    case 'diff-unavailable':
      return `the engine could not compute what this changes (${reason.detail}), so it fails closed to a person`;
    case 'customer-reply-external':
      return `customer replies need a person unless the customer is a verified ${PLAIN_AUTO_REPLY_DOMAIN} address (this one is at ${reason.domain}${reason.unverified ? ', unverified' : ''})`;
    case 'customer-reply-unverified':
      return `the engine could not read this thread's customer back from Plain (${reason.detail}), so the reply fails closed to a person`;
    case 'workflow-permission':
      return 'GitHub refused the push because it changes workflow files and the fleet token has no workflows permission: a person must push or merge it';
  }
}

export function describeEgressGate(reasons: readonly EgressGateReason[]): string {
  return reasons.map(describeEgressGateReason).join('; ');
}

/** GitHub's refusal when an App token without `workflows` writes a workflow
 * file. Recognised so the outcome is a typed "a person must do this" rather
 * than an unknown result anyone would retry. */
export function isWorkflowPermissionRefusal(output: string): boolean {
  return /refusing to allow a GitHub App to create or update workflow/i.test(output)
    || /without [`'"]?workflows[`'"]? permission/i.test(output);
}

// ---------------------------------------------------------------------------
// Model-driven actions: the same gate, per call

/** MCP tool names that write repository state or deploy. A model-driven
 * action could otherwise reach the egress through a connector instead of a
 * shell command; the engine cannot compute that diff, so it fails closed. */
const MCP_EGRESS_TOOL = /(merge|deploy|publish|release|push|create_or_update_file|update_ref|create_ref|delete_ref|dispatch|workflow)/i;

/**
 * The gate for ONE tool call inside a model-driven action. A Bash command is
 * classified and judged exactly like an engine `exec.run`; an MCP tool whose
 * name says it merges, pushes or deploys is unclassifiable and needs a person.
 * Everything else is not repo egress and returns null (Pilot judges it).
 */
export function workerToolEgressGate(
  toolName: string,
  input: Record<string, unknown>,
  origin: WorkstreamOrigin,
  cwd: string,
  io: EgressDiffIO = egressGateSeam.io,
): EgressGateResult | null {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!commandHasEgress(command)) return null;
    return evaluateEgressGate({ origin, command, cwd, io });
  }
  if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__weaver__') && MCP_EGRESS_TOOL.test(toolName)) {
    const reasons: EgressGateReason[] = [{ kind: 'unclassified-egress', detail: `connector tool ${toolName}` }];
    const fingerprint = createHash('sha256').update(JSON.stringify({ reasons, input })).digest('hex');
    return { egress: true, humanOnly: true, reasons, fingerprint };
  }
  return null;
}

type SupervisorVerdict =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Wrap a model-driven action's live supervisor with the engine gate. The gate
 * runs FIRST and deterministically; only a call it clears reaches Pilot. A
 * call that needs a person is denied unless a human approval pinned exactly
 * this act — which a model-driven action cannot have, because its diff does
 * not exist when the card is approved — so the worker is told to report the
 * blocker and the coordinator raises it as a deterministic action a person
 * can see and approve.
 */
export function egressGatedSupervisor(
  asg: Pick<Assignment, 'exec'>,
  origin: WorkstreamOrigin,
  inner: (toolName: string, input: Record<string, unknown>) => Promise<SupervisorVerdict>,
  onDenied: (toolName: string, gate: EgressGateResult) => Promise<void> = async () => {},
): (toolName: string, input: Record<string, unknown>) => Promise<SupervisorVerdict> {
  return async (toolName, input) => {
    let gate: EgressGateResult | null;
    try {
      gate = workerToolEgressGate(toolName, input, origin, asg.exec?.cwd ?? process.cwd());
    } catch (error) {
      gate = {
        egress: true,
        humanOnly: true,
        reasons: [{ kind: 'diff-unavailable', detail: errorText(error) }],
        fingerprint: '',
      };
    }
    if (gate?.humanOnly) {
      const approval = asg.exec?.approval;
      const covered = approval?.by === 'human' && !!gate.fingerprint && approval.egressFingerprint === gate.fingerprint;
      if (!covered) {
        try {
          await onDenied(toolName, gate);
        } catch {
          // The record is best-effort; the denial itself is what protects.
        }
        return {
          behavior: 'deny',
          message: `Weaver's egress gate: ${describeEgressGate(gate.reasons)}. This act needs a person — do not retry it or reach it another way (a different command shape, the API, curl, a connector). Finish what is reversible, then report this blocker via submit_result so the coordinator can raise it for human approval as an exact exec_run action.`,
        };
      }
    }
    return inner(toolName, input);
  };
}
