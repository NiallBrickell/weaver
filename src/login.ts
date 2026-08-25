/**
 * `weaver login` — the operator front door to registered execution identity.
 *
 * `sdkEnv()` strips ambient Claude credentials so a stray export can never
 * silently switch the billing principal; the deliberate exception is identity
 * the operator REGISTERS in the executor-only secret store. This command is
 * how that registration happens without hand-editing 0600 files: pick the
 * executor this host runs work through, register the credential it needs,
 * choose models, and write plain config (never secrets) into the repo `.env`.
 *
 * Three forms:
 *   weaver login                      interactive setup
 *   weaver login --status             read-only status (names/sources, no values)
 *   weaver login --render-remote-env  KEY=value lines for provisioning a
 *                                     headless host (refuses a TTY; piped over
 *                                     SSH by bin/weaver-gcp.sh)
 *   weaver login --render-remote-executor-secrets
 *                                     the exact registered adapter-only secret
 *                                     store (same TTY refusal; provisioning use)
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultEnvPath } from './env.js';
import {
  loadExecutorSecrets,
  removeExecutorSecret,
  setExecutorSecret,
} from './secrets.js';
import {
  coordinatorExecutorName,
  coordinatorFallbackExecutorName,
  coordinatorFallbackModel,
  coordinatorModel,
  workerExecutorName,
  workerModel,
} from './modelConfig.js';

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** The identity pair sdkEnv() injects; the oauth token always wins. */
const CLAUDE_IDENTITY_NAMES = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** Mirrors PI_PROVIDERS in src/executor/pi.ts (module-private there). */
const PI_PROVIDER_KEYS: Record<string, readonly string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  zai: ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
  'zai-coding-plan': ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
  'prime-inference': ['PRIME_API_KEY'],
};

/** Every provider credential --render-remote-env forwards when registered. */
const PROVIDER_KEY_NAMES = [
  'OPENROUTER_API_KEY',
  'ZHIPU_API_KEY',
  'ZAI_API_KEY',
  'PRIME_API_KEY',
  'WEAVER_MODEL_API_KEY',
] as const;

/** The model/executor config `login` prompts for and mirrors to remote hosts. */
const CONFIG_NAMES = [
  'WEAVER_EXECUTOR',
  'WEAVER_WORKER_MODEL',
  'WEAVER_COORDINATOR_MODEL',
  'WEAVER_COORDINATOR_EXECUTOR',
  'WEAVER_COORDINATOR_FALLBACK_MODEL',
  'WEAVER_COORDINATOR_FALLBACK_EXECUTOR',
] as const;

/** Mirrored to a remote host only when the operator set them explicitly. */
const OPTIONAL_CONFIG_NAMES = [
  'WEAVER_COORDINATOR_FALLBACKS',
  'WEAVER_WORKER_MODEL_COMPLEX',
  'WEAVER_WORKER_FALLBACKS',
  'WEAVER_ASK_MODEL',
  'WEAVER_ACTION_MODEL',
  'WEAVER_ACTION_EXECUTOR',
  'WEAVER_RUNNER_EXECUTORS',
  'WEAVER_HOUSE_JSON',
  'WEAVER_WORKSPACE_ROOT',
  'WEAVER_OPENHANDS_BASE_URL',
  'WEAVER_PILOT_URL',
  'WEAVER_WORKER_MAX_TURNS',
  'WEAVER_ATTEMPT_STALE_MS',
] as const;

/** Host-local by design: provisioning owns them, so they are never mirrored. */
const NEVER_REMOTE = new Set(['WEAVER_STORE', 'WEAVER_HOME']);

// ── pure helpers (unit-tested in login.test.ts) ──────────────────────────────

/**
 * Update KEY=value lines in `.env` content in place: an existing assignment
 * (even a commented-out `# KEY=` line stays untouched) is rewritten where it
 * sits, a missing key is appended, and every other line and comment survives
 * byte-for-byte. Config only — secret values never go through here.
 */
export function updateEnvContent(content: string, updates: Record<string, string>): string {
  const hadTrailingNewline = content === '' || content.endsWith('\n');
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const matched = new Set<string>();
  const out = lines.map((line) => {
    const m = /^(export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!m || !(m[2]! in updates)) return line;
    const key = m[2]!;
    // EVERY assignment of the key is rewritten: env parsers let the last one
    // win, so updating only the first could leave the change ineffective.
    matched.add(key);
    return `${m[1] ?? ''}${key}=${updates[key]}`;
  });
  const appended = Object.entries(updates).filter(([key]) => !matched.has(key));
  for (const [key, value] of appended) out.push(`${key}=${value}`);
  const body = out.join('\n');
  return body === '' ? '' : hadTrailingNewline || appended.length > 0 ? `${body}\n` : body;
}

export interface RemoteEnv {
  lines: string[];
  included: string[];
  warnings: string[];
}

/** Exact, validated executor-secret records for a remote adapter store. */
export function renderRemoteExecutorSecretLines(
  executorSecrets: Record<string, string>,
): string[] {
  return Object.entries(executorSecrets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => {
      assertRenderable(name, value);
      return `${name}=${value}`;
    });
}

function assertRenderable(name: string, value: string): void {
  if (!ENV_NAME_RE.test(name) || /[\r\n]/.test(name)) {
    throw new Error(`refusing to render env name '${name}' — not a plain KEY`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `refusing to render ${name} — its value contains a newline, which an EnvironmentFile would misparse`,
    );
  }
}

/**
 * The pure render behind --render-remote-env: executor secrets + effective
 * config in, EnvironmentFile-parseable KEY=value lines out. One identity
 * principal only (the subscription token wins, exactly as sdkEnv injects);
 * WEAVER_STORE/WEAVER_HOME are host-local and never emitted. The caller is
 * responsible for having minted WEAVER_SERVE_TOKEN first (ensureServeToken).
 */
export function renderRemoteEnvLines(
  executorSecrets: Record<string, string>,
  config: Record<string, string | undefined>,
): RemoteEnv {
  const lines: string[] = [];
  const included: string[] = [];
  const warnings: string[] = [];
  const emit = (name: string, value: string) => {
    if (NEVER_REMOTE.has(name)) return;
    assertRenderable(name, value);
    lines.push(`${name}=${value}`);
    included.push(name);
  };

  const identity = CLAUDE_IDENTITY_NAMES.find((name) => executorSecrets[name]);
  if (identity) emit(identity, executorSecrets[identity]!);
  else {
    warnings.push(
      'no Claude identity registered — the remote host cannot run local-sdk work until you run `weaver login` and register CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY',
    );
  }
  for (const name of PROVIDER_KEY_NAMES) {
    if (executorSecrets[name]) emit(name, executorSecrets[name]!);
  }
  if (executorSecrets.WEAVER_SERVE_TOKEN) {
    emit('WEAVER_SERVE_TOKEN', executorSecrets.WEAVER_SERVE_TOKEN);
  } else {
    warnings.push('no WEAVER_SERVE_TOKEN registered — the remote ingress refuses to start without one');
  }

  const configured = new Set<string>();
  for (const name of [...CONFIG_NAMES, ...OPTIONAL_CONFIG_NAMES]) {
    const value = config[name];
    if (value === undefined || NEVER_REMOTE.has(name)) continue;
    emit(name, value);
    configured.add(value);
  }
  if ([...configured].some((v) => v.split(',').map((s) => s.trim()).includes('codex-sdk'))) {
    warnings.push(
      'codex-sdk auth is a login file (~/.codex/auth.json), delivered by the provisioning script, not by env',
    );
  }
  return { lines, included, warnings };
}

// ── impure plumbing ──────────────────────────────────────────────────────────

/**
 * The serve bearer token lives in the executor store so every render of the
 * remote env ships the SAME token. Minted once, persisted before first use.
 */
export function ensureServeToken(): string {
  const existing = loadExecutorSecrets().WEAVER_SERVE_TOKEN;
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('hex');
  setExecutorSecret('WEAVER_SERVE_TOKEN', token);
  return token;
}

/** Effective model/executor config, defaults resolved; optionals only when set. */
function currentConfig(): Record<string, string | undefined> {
  return {
    WEAVER_EXECUTOR: workerExecutorName(),
    WEAVER_WORKER_MODEL: workerModel(),
    WEAVER_COORDINATOR_MODEL: coordinatorModel(),
    WEAVER_COORDINATOR_EXECUTOR: coordinatorExecutorName(),
    WEAVER_COORDINATOR_FALLBACK_MODEL: coordinatorFallbackModel(),
    WEAVER_COORDINATOR_FALLBACK_EXECUTOR: coordinatorFallbackExecutorName(),
    WEAVER_COORDINATOR_FALLBACKS: process.env.WEAVER_COORDINATOR_FALLBACKS,
    WEAVER_WORKER_MODEL_COMPLEX: process.env.WEAVER_WORKER_MODEL_COMPLEX,
    WEAVER_WORKER_FALLBACKS: process.env.WEAVER_WORKER_FALLBACKS,
    WEAVER_ASK_MODEL: process.env.WEAVER_ASK_MODEL,
    WEAVER_ACTION_MODEL: process.env.WEAVER_ACTION_MODEL,
    WEAVER_ACTION_EXECUTOR: process.env.WEAVER_ACTION_EXECUTOR,
    WEAVER_RUNNER_EXECUTORS: process.env.WEAVER_RUNNER_EXECUTORS,
    WEAVER_HOUSE_JSON: process.env.WEAVER_HOUSE_JSON,
    WEAVER_WORKSPACE_ROOT: process.env.WEAVER_WORKSPACE_ROOT,
    WEAVER_OPENHANDS_BASE_URL: process.env.WEAVER_OPENHANDS_BASE_URL,
    WEAVER_PILOT_URL: process.env.WEAVER_PILOT_URL,
    WEAVER_WORKER_MAX_TURNS: process.env.WEAVER_WORKER_MAX_TURNS,
    WEAVER_ATTEMPT_STALE_MS: process.env.WEAVER_ATTEMPT_STALE_MS,
  };
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function keychainHasClaudeLogin(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return (
      spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
        stdio: 'ignore',
      }).status === 0
    );
  } catch {
    return false;
  }
}

export interface ExecutorStatus {
  name: string;
  ok: boolean;
  detail: string;
}

/** Exported for `weaver link`, which reuses the same auth-standing detection. */
export function executorStatuses(secrets: Record<string, string>): ExecutorStatus[] {
  const out: ExecutorStatus[] = [];

  // Registered identity is reported first because it is what sdkEnv actually
  // injects — a machine login alongside it is real but overridden.
  const credFile = path.join(claudeConfigDir(), '.credentials.json');
  const machineLogin = fs.existsSync(credFile)
    ? credFile
    : keychainHasClaudeLogin()
      ? 'macOS keychain'
      : null;
  const registered = CLAUDE_IDENTITY_NAMES.find((name) => secrets[name]);
  if (registered) {
    out.push({
      name: 'local-sdk',
      ok: true,
      detail: `registered ${registered} (executor secrets${machineLogin ? '; overrides the machine login' : ''})`,
    });
  } else if (machineLogin) {
    out.push({ name: 'local-sdk', ok: true, detail: `machine Claude login (${machineLogin})` });
  } else {
    out.push({ name: 'local-sdk', ok: false, detail: 'no Claude login or registered identity' });
  }

  const codexAuth = path.join(codexHome(), 'auth.json');
  out.push(
    fs.existsSync(codexAuth)
      ? { name: 'codex-sdk', ok: true, detail: `ChatGPT login (${codexAuth})` }
      : { name: 'codex-sdk', ok: false, detail: 'no login file — run `codex login` first' },
  );

  const piReady = Object.entries(PI_PROVIDER_KEYS)
    .map(([provider, names]) => {
      const found = names.find((n) => secrets[n]);
      return found ? `${provider} (${found})` : null;
    })
    .filter((s): s is string => s !== null);
  out.push(
    piReady.length
      ? { name: 'pi', ok: true, detail: piReady.join(', ') }
      : { name: 'pi', ok: false, detail: 'no provider key registered' },
  );

  const openhandsKeys = Object.keys(secrets)
    .filter((n) => n === 'WEAVER_MODEL_API_KEY' || /^[A-Z][A-Z0-9_]*_API_KEY$/.test(n))
    .sort();
  out.push(
    openhandsKeys.length
      ? { name: 'openhands', ok: true, detail: openhandsKeys.join(', ') }
      : { name: 'openhands', ok: false, detail: 'no provider key or WEAVER_MODEL_API_KEY registered' },
  );
  return out;
}

function renderStatuses(statuses: ExecutorStatus[]): string {
  return statuses
    .map((s, i) => `  ${i + 1}) ${s.name.padEnd(10)} ${s.ok ? '✓' : '✗'} ${s.detail}`)
    .join('\n');
}

/** Where a config value came from — the repo `.env`, explicit env, or default.
 * Exported for `weaver link`, which reports where WEAVER_STORE points. */
export function configSource(name: string): '.env' | 'env' | 'default' {
  const live = process.env[name];
  if (live === undefined) return 'default';
  try {
    for (const line of fs.readFileSync(defaultEnvPath(), 'utf8').split('\n')) {
      const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m && m[1] === name && m[2]!.replace(/^["']|["']$/g, '') === live) return '.env';
    }
  } catch {
    /* no .env — the value is a real export */
  }
  return 'env';
}

// ── interactive prompts ──────────────────────────────────────────────────────

/**
 * One question per readline instance: `readSecretInput()` takes stdin into raw
 * mode between questions, so a long-lived interface would fight it for data
 * events.
 */
async function ask(question: string, def?: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
    return answer || def || '';
  } finally {
    rl.close();
  }
}

async function askChoice(question: string, choices: string[]): Promise<number> {
  for (;;) {
    const raw = await ask(`${question} [1-${choices.length}]`);
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
    process.stdout.write(`  enter a number between 1 and ${choices.length}\n`);
  }
}

async function pasteSecret(name: string): Promise<string> {
  const { readSecretInput } = await import('./secretInput.js');
  if (process.stdin.isTTY) {
    process.stdout.write(`paste the value for ${name} and press Enter (input hidden): `);
  }
  const value = await readSecretInput();
  if (process.stdin.isTTY) process.stdout.write('\n');
  if (!value) fail('empty value — nothing stored');
  return value;
}

/**
 * Registering one Claude identity retires the other: sdkEnv injects exactly
 * one principal (oauth wins), so leaving a stale counterpart behind would
 * either shadow the new key silently or spring back when the token is removed.
 */
function registerClaudeIdentity(name: (typeof CLAUDE_IDENTITY_NAMES)[number], value: string): void {
  setExecutorSecret(name, value);
  const other = CLAUDE_IDENTITY_NAMES.find((n) => n !== name)!;
  if (removeExecutorSecret(other)) {
    process.stdout.write(`removed previously registered ${other} — one principal only\n`);
  }
  process.stdout.write(`registered ${name} (executor-only store; value never printed)\n`);
}

async function acquireLocalSdk(secrets: Record<string, string>): Promise<void> {
  process.stdout.write(
    '\nHow should local-sdk authenticate?\n' +
      "  1) use this machine's Claude login (nothing stored)\n" +
      '  2) register a headless token — run `claude setup-token` in another terminal and paste the result\n' +
      '  3) paste an Anthropic API key (API billing, not a subscription)\n',
  );
  const pick = await askChoice('choose', ['machine login', 'setup-token', 'api key']);
  if (pick === 0) {
    // "Nothing stored" must also mean nothing REMAINS stored: a registered
    // identity would still win inside sdkEnv and silently override the login.
    for (const name of CLAUDE_IDENTITY_NAMES) {
      if (secrets[name] && removeExecutorSecret(name)) {
        process.stdout.write(`removed registered ${name} — the machine's Claude login now applies\n`);
      }
    }
    if (!fs.existsSync(path.join(claudeConfigDir(), '.credentials.json')) && !keychainHasClaudeLogin()) {
      process.stdout.write('note: no Claude login found on this machine — run `claude` once to log in\n');
    }
    return;
  }
  const name = pick === 1 ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  registerClaudeIdentity(name, await pasteSecret(name));
}

async function acquirePi(): Promise<void> {
  const providers = Object.keys(PI_PROVIDER_KEYS);
  process.stdout.write(
    `\nWhich Pi provider?\n${providers.map((p, i) => `  ${i + 1}) ${p} (${PI_PROVIDER_KEYS[p]!.join(' or ')})`).join('\n')}\n`,
  );
  const provider = providers[await askChoice('choose', providers)]!;
  const name = PI_PROVIDER_KEYS[provider]![0]!;
  setExecutorSecret(name, await pasteSecret(name));
  process.stdout.write(`registered ${name} for ${provider} (executor-only store)\n`);
}

async function acquireOpenhands(): Promise<void> {
  const provider = await ask(
    '\nProvider name for the key (e.g. openrouter; empty = generic WEAVER_MODEL_API_KEY)',
  );
  // Same normalization as the OpenHands adapter's providerSecretName().
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const name = normalized ? `${normalized}_API_KEY` : 'WEAVER_MODEL_API_KEY';
  setExecutorSecret(name, await pasteSecret(name));
  process.stdout.write(`registered ${name} (executor-only store)\n`);
}

const MODEL_PROMPTS: Record<(typeof CONFIG_NAMES)[number], { label: string; suggest: string }> = {
  WEAVER_EXECUTOR: {
    label: 'worker executor',
    suggest: 'local-sdk / codex-sdk / pi / openhands',
  },
  WEAVER_WORKER_MODEL: {
    label: 'worker model',
    suggest: 'sonnet / gpt-5.6-sol / zai-coding-plan/glm-5.3 / openrouter/moonshotai/kimi-k3',
  },
  WEAVER_COORDINATOR_MODEL: {
    label: 'coordinator model',
    suggest: 'claude-fable-5 / claude-opus-4-8 / gpt-5.6-sol',
  },
  WEAVER_COORDINATOR_EXECUTOR: {
    label: 'coordinator executor',
    suggest: 'local-sdk / codex-sdk',
  },
  WEAVER_COORDINATOR_FALLBACK_MODEL: {
    label: 'coordinator fallback model',
    suggest: 'claude-opus-4-8 / gpt-5.6-sol',
  },
  WEAVER_COORDINATOR_FALLBACK_EXECUTOR: {
    label: 'coordinator fallback executor',
    suggest: 'local-sdk / codex-sdk',
  },
};

async function configureModels(): Promise<void> {
  process.stdout.write('\nModel & executor config (Enter keeps the current value):\n');
  const config = currentConfig();
  const updates: Record<string, string> = {};
  for (const name of CONFIG_NAMES) {
    const { label, suggest } = MODEL_PROMPTS[name];
    process.stdout.write(`  ${label} — e.g. ${suggest}\n`);
    const value = await ask(`  ${name}`, config[name]);
    if (value) updates[name] = value;
  }
  const envPath = defaultEnvPath();
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    /* no .env yet — created below */
  }
  fs.writeFileSync(envPath, updateEnvContent(content, updates));
  process.stdout.write(
    `\nwrote ${Object.keys(updates).length} settings to ${envPath} (config only — secrets stay in the 0600 store)\n` +
      Object.entries(updates)
        .map(([k, v]) => `  ${k}=${v}\n`)
        .join('') +
      'resident processes snapshot .env at launch — restart `weaver run` / `weaver watch` to pick these up\n',
  );
}

// ── the three command forms ──────────────────────────────────────────────────

function statusCommand(): void {
  const secrets = loadExecutorSecrets();
  process.stdout.write(`executors:\n${renderStatuses(executorStatuses(secrets))}\n\nconfig:\n`);
  const config = currentConfig();
  for (const name of [...CONFIG_NAMES, ...OPTIONAL_CONFIG_NAMES]) {
    const value = config[name];
    if (value === undefined) continue;
    process.stdout.write(`  ${name.padEnd(37)} ${value}  (${configSource(name)})\n`);
  }
  const registered = [...CLAUDE_IDENTITY_NAMES, ...PROVIDER_KEY_NAMES, 'WEAVER_SERVE_TOKEN'].filter(
    (n) => secrets[n],
  );
  process.stdout.write(
    `\nregistered executor secrets: ${registered.length ? registered.join(', ') : '(none)'}\n`,
  );
}

function renderRemoteEnvCommand(): void {
  if (process.stdout.isTTY) {
    fail(
      '--render-remote-env emits secret VALUES — pipe it (e.g. over SSH), never display it on a terminal',
    );
  }
  ensureServeToken();
  const { lines, included, warnings } = renderRemoteEnvLines(loadExecutorSecrets(), currentConfig());
  process.stdout.write(lines.map((l) => `${l}\n`).join(''));
  process.stderr.write(`rendered remote env: ${included.join(', ')}\n`);
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
}

function renderRemoteExecutorSecretsCommand(): void {
  if (process.stdout.isTTY) {
    fail(
      '--render-remote-executor-secrets emits secret VALUES — pipe it over SSH; never display it on a terminal',
    );
  }
  const lines = renderRemoteExecutorSecretLines(loadExecutorSecrets());
  process.stdout.write(lines.map((line) => `${line}\n`).join(''));
  process.stderr.write(`rendered ${lines.length} registered executor secrets for remote delivery\n`);
}

async function interactiveLogin(): Promise<void> {
  if (!process.stdin.isTTY) {
    fail('`weaver login` is interactive — use `weaver login --status` or `weaver secret set <NAME> --executor` in scripts');
  }
  const secrets = loadExecutorSecrets();
  const statuses = executorStatuses(secrets);
  process.stdout.write(`Which executor does this host run work through?\n${renderStatuses(statuses)}\n`);
  const picked = statuses[await askChoice('choose', statuses.map((s) => s.name))]!;

  switch (picked.name) {
    case 'local-sdk':
      await acquireLocalSdk(secrets);
      break;
    case 'codex-sdk':
      process.stdout.write(
        picked.ok
          ? '\ncodex-sdk resolves the login file ambiently — nothing to store\n'
          : '\ncodex-sdk has nothing to register here — run `codex login` first, then rerun `weaver login` to check status\n',
      );
      break;
    case 'pi':
      await acquirePi();
      break;
    case 'openhands':
      await acquireOpenhands();
      break;
  }

  await configureModels();
  process.stdout.write(`\ncurrent standing:\n${renderStatuses(executorStatuses(loadExecutorSecrets()))}\n`);
}

export async function runLogin(rest: string[]): Promise<void> {
  if (rest.includes('--render-remote-executor-secrets')) {
    return renderRemoteExecutorSecretsCommand();
  }
  if (rest.includes('--render-remote-env')) return renderRemoteEnvCommand();
  if (rest.includes('--status')) return statusCommand();
  if (rest.length) {
    fail('usage: weaver login [--status | --render-remote-env | --render-remote-executor-secrets]');
  }
  return interactiveLogin();
}
