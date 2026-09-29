/**
 * Host-side git in a worker-writable checkout.
 *
 * Container workers mount their assignment checkout read-write, and the
 * runner later runs git in that same checkout as itself: the nightly
 * workspace collector (`status`, `log`), the repo-egress gate and PR conflict
 * watch (`rev-parse`, `merge-base`, `diff`, and `gh`, which runs git
 * internally), origin resolution for GitHub App scope, and every approved
 * engine command (`exec.run`, its verifier, a probe) that happens to call
 * git. Git configuration can execute programs — `core.fsmonitor`, hooks,
 * `filter.<driver>.clean`, `diff.<driver>.textconv`, `credential.helper`,
 * `include.path` pulling in any of those — so a worker that writes one line
 * into `.git/config` (a prompt-injected Sentry event is enough to ask it to)
 * gets code execution as the runner user on the next host git call, with the
 * executor-only secret store and the runner's service environment in reach.
 *
 * Two independent defences, both applied by this module:
 *
 * 1. Refusal. Before any harness process runs in a checkout, the checkout's
 *    git control plane is read WITHOUT executing it — the repository is
 *    discovered the way git discovers it (the `.git` directory or gitfile,
 *    `commondir`, an implicit bare directory), every config file git would
 *    read is listed with `git config --file … --list` (which never follows
 *    includes and never runs a program), and the hooks directory is listed.
 *    Any exec-capable key or executable hook refuses the checkout; nothing is
 *    run there, and the caller records the refusal. `.gitattributes` filters
 *    need a matching `filter.*` driver in config, which is itself refused, so
 *    the attributes files need no inspection.
 * 2. Neutralising overrides. Every harness git call also runs with
 *    command-scope configuration (GIT_CONFIG_COUNT, the highest precedence)
 *    that turns off the exec paths a single value can turn off, so a key the
 *    refusal list does not know about, or a checkout poisoned between the
 *    inspection and the call, still meets a git that will not run it.
 *
 * Harness probes also ignore the system and global configuration: they need
 * nothing from it. An approved engine command keeps the operator's system
 * and global configuration (commit identity, URL rewrites, LFS) because those
 * files are operator-owned and outside every worker mount
 * (workspaceMounts.protectedWorkerPaths refuses the home directory, ~/.config
 * and /), and it keeps the operator's credential helpers, which the GitHub
 * App environment already replaces with its own process-local helper when it
 * is in play. A repository-local credential helper is refused like any other
 * exec-capable key.
 */

import { execFileSync, type StdioOptions } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { engineCommandEnv } from './secrets.js';
import { arrive, load } from './store.js';
import type { WorkstreamDoc } from './types.js';

/** Command-scope overrides that neutralise every exec path a single value can
 * turn off. Applied to every harness-authored git process and, through
 * GIT_CONFIG_COUNT, to every git an approved engine command starts. */
export const GIT_EXEC_NEUTRALISING_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  // /dev/null is not a directory, so no hook (repository or hooksPath) can
  // resolve under it.
  ['core.hooksPath', '/dev/null'],
  ['core.pager', 'cat'],
  ['core.editor', 'false'],
  ['sequence.editor', 'false'],
  // An empty value clears a configured external diff (verified against git).
  ['diff.external', ''],
  ['protocol.ext.allow', 'never'],
  // A worker cannot turn the checkout into an implicitly discovered bare
  // repository whose own config git would then read.
  ['safe.bareRepository', 'explicit'],
];

/** Extra overrides for the harness's own read-only probes: they never need a
 * credential, a custom ssh, or an askpass program, so every one is cleared. An
 * empty `credential.helper` resets the helper list, URL-scoped helpers
 * included (verified against git). */
const HARNESS_ONLY_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['credential.helper', ''],
  ['core.sshCommand', 'ssh'],
  ['core.askPass', ''],
];

/** Inherited variables that would make git read a different repository or
 * configuration than the one inspected here. */
const REDIRECTING_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
] as const;

/** Append `entries` after any GIT_CONFIG_KEY_n/VALUE_n already in `env`, so
 * earlier entries (the GitHub App's own credential helper) keep their order
 * and the appended ones win every single-valued key. */
export function appendGitConfigEnv(
  env: Record<string, string>,
  entries: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const out = { ...env };
  const existing = Number.parseInt(out.GIT_CONFIG_COUNT ?? '0', 10);
  let count = Number.isInteger(existing) && existing > 0 ? existing : 0;
  if (count === 0) delete out.GIT_CONFIG_COUNT;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

/**
 * The environment for an approved engine command (exec.run, its verifier, a
 * probe): its own environment plus the neutralising overrides, so any git it
 * starts — directly, through gh, or through a build tool — cannot run
 * checkout-controlled programs. The operator's system/global configuration is
 * kept (see the module comment).
 */
export function actionGitHardenedEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) base[name] = value;
  for (const name of REDIRECTING_GIT_ENV) delete base[name];
  base.GIT_TERMINAL_PROMPT = '0';
  return appendGitConfigEnv(base, GIT_EXEC_NEUTRALISING_CONFIG);
}

/**
 * The environment for a harness-authored git (or gh) call in a checkout: the
 * engine's scrubbed environment (never WEAVER_STORE, the App key, or a model
 * credential), no system or global configuration, no prompt, and every
 * neutralising override. `selected` (a GitHub App read environment) keeps
 * its credential helper: its entries precede the overrides, and its own
 * `credential.helper=` reset precedes its github.com helper.
 */
export function harnessGitEnv(
  selected: Record<string, string> = {},
  extraConfig: ReadonlyArray<readonly [string, string]> = [],
): Record<string, string> {
  const env = engineCommandEnv(selected);
  for (const name of REDIRECTING_GIT_ENV) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  const keepsOwnHelper = Object.keys(selected).some((name) => /^GIT_CONFIG_KEY_\d+$/.test(name)
    && /^credential\..+\.helper$/i.test(selected[name] ?? ''));
  const overrides = [
    ...GIT_EXEC_NEUTRALISING_CONFIG,
    // A caller that installed its own URL-scoped helper (the App read token
    // for gh's git calls) already reset the inherited list before it.
    ...HARNESS_ONLY_CONFIG.filter(([key]) => !(keepsOwnHelper && key === 'credential.helper')),
    ...extraConfig,
  ];
  return appendGitConfigEnv(env, overrides);
}

// ---------------------------------------------------------------------------
// Refusal: read the git control plane without executing it.

/** Why a checkout's git control plane is refused: the checkout and every
 * exec-capable finding, each naming the key (or hook) and the file it is in. */
export interface CheckoutRefusal {
  checkout: string;
  findings: string[];
}

export type CheckoutInspection =
  | { verdict: 'clean'; worktree: string; gitDir: string; commonDir: string }
  | { verdict: 'absent' }
  | { verdict: 'refused'; refusal: CheckoutRefusal };

export class PoisonedCheckoutError extends Error {
  override name = 'PoisonedCheckoutError';
  constructor(readonly refusal: CheckoutRefusal) {
    super(describeCheckoutRefusal(refusal));
  }
}

export function describeCheckoutRefusal(refusal: CheckoutRefusal): string {
  const shown = refusal.findings.slice(0, 6).join('; ');
  const more = refusal.findings.length > 6 ? `; +${refusal.findings.length - 6} more` : '';
  return `host git refused in ${refusal.checkout}: its git control plane can execute programs (${shown}${more}). `
    + 'Weaver runs no git there until the operator removes them.';
}

/** The dedup token a refusal record carries: same checkout, same findings →
 * one record, however many ticks meet it. */
export function checkoutRefusalToken(refusal: CheckoutRefusal): string {
  return `[git-refused ${refusal.checkout}:${[...refusal.findings].sort().join(',')}]`;
}

const BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off|1|0|)$/i;

/**
 * Whether one repository-local configuration entry can make git execute a
 * program (or pull in a file that could). Keys arrive as `git config --list`
 * prints them: section and variable lowercased, subsection verbatim.
 */
export function execCapableGitConfig(key: string, value: string | null): boolean {
  const k = key.toLowerCase();
  const v = value ?? '';
  if (/^include\./.test(k) || /^includeif\./.test(k)) return true;
  if (/^filter\..+\.(?:clean|smudge|process)$/.test(k)) return true;
  if (/^diff\..+\.(?:textconv|command)$/.test(k) || k === 'diff.external') return true;
  if (/^merge\..+\.driver$/.test(k)) return true;
  if (/^(?:diff|merge)tool\..+\.cmd$/.test(k) || /^(?:man|browser)\..+\.(?:cmd|path)$/.test(k) || k === 'web.browser') return true;
  if (/^credential\.(?:.+\.)?helper$/.test(k)) return v !== '';
  if (/^alias\./.test(k)) return true;
  if (/^gpg\.(?:.+\.)?program$/.test(k)) return true;
  if (/^remote\..+\.(?:uploadpack|receivepack|vcs)$/.test(k)) return true;
  if (/^remote\..+\.(?:url|pushurl)$/.test(k)) return /^ext::/i.test(v);
  if (/^url\..+\.(?:insteadof|pushinsteadof)$/.test(k)) return true;
  if (/^protocol\.(?:.+\.)?allow$/.test(k)) return v.toLowerCase() !== 'never' && v.toLowerCase() !== 'user';
  if (/^submodule\..+\.update$/.test(k)) return v.startsWith('!');
  if (/^pager\./.test(k)) return !BOOLEAN_VALUE.test(v);
  switch (k) {
    case 'core.fsmonitor':
      return !BOOLEAN_VALUE.test(v);
    case 'core.hookspath':
    case 'core.pager':
    case 'core.editor':
    case 'sequence.editor':
    case 'core.sshcommand':
    case 'core.gitproxy':
    case 'core.askpass':
    case 'core.alternaterefscommand':
    case 'uploadpack.packobjectshook':
    case 'sendemail.smtpserver':
    case 'sendemail.tocmd':
    case 'sendemail.cccmd':
      return true;
    default:
      return false;
  }
}

/** git's is_git_directory, without running git: HEAD plus objects and refs
 * (in the common directory when `commondir` redirects them). */
function isGitDirectory(dir: string): boolean {
  try {
    if (!existsSync(join(dir, 'HEAD'))) return false;
    let common = dir;
    const commondirFile = join(dir, 'commondir');
    if (existsSync(commondirFile)) {
      const pointer = readFileSync(commondirFile, 'utf8').trim();
      common = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
    }
    return statSync(join(common, 'objects')).isDirectory() && statSync(join(common, 'refs')).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve `<dir>/.git` when it is a gitfile (`gitdir: <path>`). */
function readGitfile(dotGit: string): string | null {
  const content = readFileSync(dotGit, 'utf8');
  const match = /^gitdir: (.+?)\s*$/m.exec(content);
  if (!match?.[1]) return null;
  return isAbsolute(match[1]) ? match[1] : resolve(dirname(dotGit), match[1]);
}

/** The git layout rooted exactly at `worktree` (its own `.git`, no walking
 * up), or null when it holds no valid repository. Used to plan the read-only
 * control-plane overlays a container worker gets. */
export function repositoryLayout(worktree: string): { dotGit: string; dotGitIsFile: boolean; gitDir: string; commonDir: string } | null {
  const dotGit = join(worktree, '.git');
  let gitDir: string | null = null;
  let dotGitIsFile = false;
  try {
    const entry = lstatSync(dotGit);
    if (entry.isFile()) {
      dotGitIsFile = true;
      gitDir = readGitfile(dotGit);
    } else if (entry.isDirectory()) {
      gitDir = dotGit;
    }
  } catch {
    return null;
  }
  if (!gitDir || !isGitDirectory(gitDir)) return null;
  let commonDir = gitDir;
  try {
    const pointer = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    commonDir = isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
  } catch {
    // No commondir: the git directory is its own common directory.
  }
  return { dotGit, dotGitIsFile, gitDir, commonDir };
}

/** List one config file WITHOUT executing it. `--file` never follows
 * include.path (verified), and nothing in `config --list` runs a program. */
function listConfigFile(file: string): Array<{ key: string; value: string | null }> {
  const out = execFileSync('git', ['config', '--file', file, '--list', '--null'], {
    // A neutral cwd: `git config --file` needs no repository, and the
    // checkout under inspection must not be discovered around it.
    cwd: resolve('/'),
    env: harnessGitEnv(),
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entries: Array<{ key: string; value: string | null }> = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    entries.push(newline === -1
      ? { key: record, value: null }
      : { key: record.slice(0, newline), value: record.slice(newline + 1) });
  }
  return entries;
}

/**
 * Discover the repository git would use from `cwd` and judge its control
 * plane. Discovery mirrors git's: walk up from cwd; at each level a valid
 * `.git` directory or gitfile wins, then the directory itself as a bare
 * repository (refused unless it is a `.git` directory, as git's
 * safe.bareRepository=explicit would). Any unreadable pointer or config file
 * refuses — git would die or read something this inspection could not.
 */
export function inspectCheckout(cwd: string): CheckoutInspection {
  let dir = resolve(cwd);
  // git cannot start in a directory that does not exist, so nothing it could
  // read there can run; walking up from a missing path would instead judge
  // some unrelated ancestor repository.
  if (!existsSync(dir)) return { verdict: 'absent' };
  for (;;) {
    const dotGit = join(dir, '.git');
    let entry: ReturnType<typeof lstatSync> | null = null;
    try {
      entry = lstatSync(dotGit);
    } catch {
      entry = null;
    }
    if (entry) {
      if (entry.isFile()) {
        let gitDir: string | null;
        try {
          gitDir = readGitfile(dotGit);
        } catch {
          gitDir = null;
        }
        if (!gitDir || !isGitDirectory(gitDir)) {
          return { verdict: 'refused', refusal: { checkout: dir, findings: ['.git is an unreadable or invalid gitfile'] } };
        }
        return judge(dir, gitDir);
      }
      if (isGitDirectory(dotGit)) return judge(dir, dotGit);
      // An invalid .git directory: git keeps looking, and so do we.
    }
    if (isGitDirectory(dir)) {
      if (basename(dir) === '.git') return judge(dirname(dir), dir);
      return {
        verdict: 'refused',
        refusal: { checkout: dir, findings: ['an implicitly discovered bare repository (safe.bareRepository=explicit)'] },
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return { verdict: 'absent' };
    dir = parent;
  }
}

function judge(worktree: string, gitDir: string): CheckoutInspection {
  let commonDir = gitDir;
  const findings: string[] = [];
  try {
    const commondirFile = join(gitDir, 'commondir');
    if (existsSync(commondirFile)) {
      const pointer = readFileSync(commondirFile, 'utf8').trim();
      commonDir = isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
    }
  } catch {
    findings.push(`${gitDir}/commondir is unreadable`);
  }
  // Every file git reads for repository scope: the common config and the
  // per-worktree config (read only under extensions.worktreeConfig, but a
  // worker could set that too — inspect it regardless).
  const files = [...new Set([join(commonDir, 'config'), join(gitDir, 'config.worktree'), join(commonDir, 'config.worktree')])];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let entries: Array<{ key: string; value: string | null }>;
    try {
      entries = listConfigFile(file);
    } catch {
      findings.push(`${file} is unreadable as git configuration`);
      continue;
    }
    for (const { key, value } of entries) {
      if (execCapableGitConfig(key, value)) findings.push(`${key} in ${file}`);
    }
  }
  const hooksDir = join(commonDir, 'hooks');
  let hooks: string[] = [];
  try {
    hooks = readdirSync(hooksDir);
  } catch {
    hooks = [];
  }
  for (const name of hooks) {
    if (name.endsWith('.sample')) continue;
    try {
      const stat = statSync(join(hooksDir, name));
      if (stat.isFile() && (stat.mode & 0o111) !== 0) findings.push(`executable hook ${join(hooksDir, name)}`);
    } catch {
      // A dangling link is no hook git can run.
    }
  }
  if (findings.length) return { verdict: 'refused', refusal: { checkout: worktree, findings } };
  return { verdict: 'clean', worktree, gitDir, commonDir };
}

/** The refusal for `cwd`, or null when git may run there (a clean checkout,
 * or no repository at all). */
export function checkoutRefusal(cwd: string): CheckoutRefusal | null {
  const inspection = inspectCheckout(cwd);
  return inspection.verdict === 'refused' ? inspection.refusal : null;
}

/** The typed event a refusal leaves on the workstream whose work named the
 * checkout; printout, `weaver log` and the operator surfaces show it. */
export const CHECKOUT_REFUSED_EVENT = 'checkout.git_refused';

/**
 * Record a refusal on `slug`, once per (checkout, findings): a refused
 * checkout stays refused every tick until the operator cleans it, and a
 * record that repeats itself is one nobody reads. Returns whether it wrote.
 */
export async function recordCheckoutRefusal(
  slug: string,
  refusal: CheckoutRefusal,
  refs: string[] = [],
  current?: WorkstreamDoc,
): Promise<boolean> {
  const token = checkoutRefusalToken(refusal);
  // Every arrive() is a document write; a refusal already on record must not
  // cost one per tick, so the common case is decided from a read.
  const seen = (doc: WorkstreamDoc) => doc.events.some((e) => e.type === CHECKOUT_REFUSED_EVENT && e.summary.includes(token));
  if (seen(current ?? await load(slug))) return false;
  let recorded = false;
  await arrive(slug, (doc, event) => {
    if (seen(doc)) return;
    event(CHECKOUT_REFUSED_EVENT, `${describeCheckoutRefusal(refusal)} ${token}`, refs);
    recorded = true;
  });
  return recorded;
}

/** Throw PoisonedCheckoutError unless git may run in `cwd`. */
export function assertCheckoutSafe(cwd: string): void {
  const refusal = checkoutRefusal(cwd);
  if (refusal) throw new PoisonedCheckoutError(refusal);
}

export interface HarnessCommandOptions {
  cwd: string;
  /** Selected values (a GitHub App read environment) layered onto the
   * scrubbed engine environment. */
  environment?: Record<string, string>;
  /** Further command-scope configuration (e.g. safe.directory for the
   * collector, which reads checkouts a container user may own). */
  extraConfig?: ReadonlyArray<readonly [string, string]>;
  timeoutMs?: number;
  stdio?: StdioOptions;
}

/**
 * THE way the harness runs git — or gh, which runs git internally — in a
 * checkout a worker could have written. Refuses a poisoned checkout before
 * anything starts (PoisonedCheckoutError), then runs with harnessGitEnv.
 * Returns stdout; a non-zero exit throws as execFileSync does.
 */
export function runHarnessCommand(bin: 'git' | 'gh', args: readonly string[], options: HarnessCommandOptions): string {
  assertCheckoutSafe(options.cwd);
  return execFileSync(bin, [...args], {
    cwd: options.cwd,
    env: harnessGitEnv(options.environment ?? {}, options.extraConfig ?? []),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

export function runHarnessGit(args: readonly string[], options: HarnessCommandOptions): string {
  return runHarnessCommand('git', args, options);
}
