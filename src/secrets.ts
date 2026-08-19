/**
 * Secrets: credentials workers can USE without any value ever entering a
 * prompt, transcript, artifact, or the typed state.
 *
 * Values live in env files under WEAVER_HOME (0600, inside the gitignored
 * state dir): `secrets.env` is global, `<slug>/secrets.env` overlays it per
 * workstream, and `executor-secrets.env` is private to executor adapters.
 * Only action-secret NAMES are ever surfaced to models — the engine injects
 * their values into action workers and exec.run / exec.verify shells. Executor
 * secrets are never named or injected there; adapters consume them directly.
 * Every value joins the redaction/store-refusal set.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { weaverHome, workstreamDir } from './store.js';

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function globalSecretsPath(): string {
  return path.join(weaverHome(), 'secrets.env');
}

export function executorSecretsPath(): string {
  return path.join(weaverHome(), 'executor-secrets.env');
}

export function workstreamSecretsPath(slug: string): string {
  return path.join(workstreamDir(slug), 'secrets.env');
}

function parseEnvFile(p: string): Record<string, string> {
  if (!fs.existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function writeEnvFile(p: string, secrets: Record<string, string>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(p, body ? body + '\n' : '', { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

/** Global secrets overlaid with the workstream's own (workstream wins). */
export function loadSecrets(slug?: string): Record<string, string> {
  return {
    ...parseEnvFile(globalSecretsPath()),
    ...(slug ? parseEnvFile(workstreamSecretsPath(slug)) : {}),
  };
}

/** Provider credentials consumed only by executor adapters, never workers. */
export function loadExecutorSecrets(): Record<string, string> {
  return parseEnvFile(executorSecretsPath());
}

function addRetainingCollision(
  target: Record<string, string>,
  name: string,
  value: string,
  scope: string,
): void {
  if (target[name] === undefined || target[name] === value) {
    target[name] = value;
    return;
  }
  let label = `${scope}:${name}`;
  let suffix = 2;
  while (target[label] !== undefined && target[label] !== value) {
    label = `${scope}:${name}:${suffix++}`;
  }
  target[label] = value;
}

/**
 * Applicable action values plus executor-private values, solely for refusing
 * or redacting captured data. This function must never feed a model or shell.
 */
export function loadRedactionSecrets(slug?: string): Record<string, string> {
  const out = { ...loadSecrets(slug) };
  for (const [name, value] of Object.entries(loadExecutorSecrets())) {
    addRetainingCollision(out, name, value, 'executor');
  }
  return out;
}

/**
 * Every secret value across the fleet, retaining collisions where two
 * workstreams use the same name for different values. Global-policy-bearing
 * output can contain facts learned in any stream, so redacting only the page's
 * selected stream is insufficient.
 */
export function loadAllSecrets(): Record<string, string> {
  const all: Record<string, string> = { ...parseEnvFile(globalSecretsPath()) };
  for (const [name, value] of Object.entries(loadExecutorSecrets())) {
    addRetainingCollision(all, name, value, 'executor');
  }
  let slugs: string[] = [];
  try { slugs = fs.readdirSync(weaverHome()); }
  catch { return all; }
  for (const slug of slugs.sort()) {
    const local = parseEnvFile(workstreamSecretsPath(slug));
    for (const [name, value] of Object.entries(local)) {
      addRetainingCollision(all, name, value, slug);
    }
  }
  return all;
}

/** The only secret-related fact models ever see. */
export function secretNames(slug?: string): string[] {
  return Object.keys(loadSecrets(slug)).sort();
}

export function setSecret(name: string, value: string, slug?: string): void {
  setSecretAt(name, value, slug ? workstreamSecretsPath(slug) : globalSecretsPath());
}

export function setExecutorSecret(name: string, value: string): void {
  setSecretAt(name, value, executorSecretsPath());
}

function setSecretAt(name: string, value: string, p: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid secret name '${name}' — use UPPER_SNAKE_CASE`);
  }
  if (!value) throw new Error('empty secret value');
  const current = parseEnvFile(p);
  current[name] = value;
  writeEnvFile(p, current);
}

export function removeSecret(name: string, slug?: string): boolean {
  return removeSecretAt(name, slug ? workstreamSecretsPath(slug) : globalSecretsPath());
}

export function removeExecutorSecret(name: string): boolean {
  return removeSecretAt(name, executorSecretsPath());
}

export function executorSecretNames(): string[] {
  return Object.keys(loadExecutorSecrets()).sort();
}

function removeSecretAt(name: string, p: string): boolean {
  const current = parseEnvFile(p);
  if (!(name in current)) return false;
  delete current[name];
  writeEnvFile(p, current);
  return true;
}

/**
 * Environment for SDK subprocesses. Weaver rides the LOCAL Claude Code
 * subscription login — never API credits or injected OAuth tokens. Stray
 * exported credentials in the launching shell would silently change the
 * principal or billing path, so they are stripped unconditionally. The
 * operator's ambient CLAUDE_CONFIG_DIR remains the sole local-login selector.
 * (SDK `env` REPLACES the subprocess environment, hence the process.env
 * spread.)
 *
 * The one exception is REGISTERED identity: a CLAUDE_CODE_OAUTH_TOKEN or
 * ANTHROPIC_API_KEY the operator explicitly placed in the executor-only secret
 * store (`weaver login` / `weaver secret set <NAME> --executor`) is injected
 * here so a headless host with no Claude login can still run local-sdk work.
 * That does not weaken the anti-hijack invariant — registration is a
 * deliberate operator act against the 0600 store, not something an ambient
 * export or a caller-passed extra can do (both are still stripped above).
 * Exactly one credential is injected — the subscription token wins over an
 * API key — so the billing principal stays unambiguous.
 */
/**
 * Registered identity is injected for the Claude SDK only. An executor that
 * hands the environment to a different principal's agent process (Codex) must
 * strip it back out — a Claude credential has no business inside a process an
 * OpenAI model steers. Before registered injection existed, sdkEnv guaranteed
 * these names were absent, so the codex adapters never had to; now the
 * guarantee lives here, named, instead of implicitly in each adapter.
 */
export function stripClaudeCredentials(env: Record<string, string | undefined>): void {
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
}

export function sdkEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  stripClaudeCredentials(env);
  const registered = loadExecutorSecrets();
  if (registered.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = registered.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (registered.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = registered.ANTHROPIC_API_KEY;
  }
  return env;
}

/**
 * Refuse text that embeds a known secret VALUE — used when humans author
 * commands/constraints that will be stored in typed state. The fix is always
 * to reference the secret as `$NAME`; the engine injects the value at exec.
 */
export function assertNoSecretValues(text: string, secrets: Record<string, string>): void {
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length >= 4 && text.includes(value)) {
      throw new Error(
        `text embeds the VALUE of secret ${name} — reference it as $${name} instead; ` +
          `stored state must never contain secret values`,
      );
    }
  }
}

/**
 * Scrub secret VALUES from captured text, longest value first so an
 * overlapping shorter value can't split a longer one. Values shorter than 4
 * chars are skipped (too collision-prone to substitute safely).
 */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (value.length < 4) continue;
    out = out.split(value).join(`«secret:${name}»`);
  }
  return out;
}
