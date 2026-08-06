/**
 * Secrets: credentials workers can USE without any value ever entering a
 * prompt, transcript, artifact, or the typed state.
 *
 * Values live in env files under WEAVER_HOME (0600, inside the gitignored
 * state dir): `secrets.env` is global, `<slug>/secrets.env` overlays it per
 * workstream. Only NAMES are ever surfaced to models — the engine injects
 * values as environment variables into action workers and into exec.run /
 * exec.verify shells, and `redactSecrets` scrubs values from everything the
 * harness captures back (verify output, execution records, artifacts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { weaverHome, workstreamDir } from './store.js';

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function globalSecretsPath(): string {
  return path.join(weaverHome(), 'secrets.env');
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

/** The only secret-related fact models ever see. */
export function secretNames(slug?: string): string[] {
  return Object.keys(loadSecrets(slug)).sort();
}

export function setSecret(name: string, value: string, slug?: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid secret name '${name}' — use UPPER_SNAKE_CASE`);
  }
  if (!value) throw new Error('empty secret value');
  const p = slug ? workstreamSecretsPath(slug) : globalSecretsPath();
  const current = parseEnvFile(p);
  current[name] = value;
  writeEnvFile(p, current);
}

export function removeSecret(name: string, slug?: string): boolean {
  const p = slug ? workstreamSecretsPath(slug) : globalSecretsPath();
  const current = parseEnvFile(p);
  if (!(name in current)) return false;
  delete current[name];
  writeEnvFile(p, current);
  return true;
}

/**
 * Environment for SDK subprocesses. Weaver rides the LOCAL Claude Code
 * subscription login — never API credits. A stray exported API key in the
 * launching shell would silently switch the SDK to API billing, so it is
 * stripped unconditionally. (SDK `env` REPLACES the subprocess environment,
 * hence the process.env spread.)
 */
export function sdkEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
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
