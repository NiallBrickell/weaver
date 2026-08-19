/**
 * Optional `.env` config for Weaver. Machine-local settings (which coordinator
 * model to use, a Postgres URL, the pilot endpoint) belong next to the repo,
 * not scattered through a shell rc where they silently apply to everything —
 * so `weaver` reads a `.env` at the repo root before any command runs.
 *
 * The contract is deliberately narrow: the file only FILLS gaps. Anything
 * already set in the real environment (an explicit `export`, or the value the
 * global shim derives for WEAVER_HOME) always wins — the file can never
 * override what the operator set for this invocation. A missing file is a
 * no-op, so `.env` stays optional. Secrets do NOT belong here: per-workstream
 * secrets live in the store (`weaver secret set`); this is plain config.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo-root `.env`, resolved relative to this module (src/ → ..). */
export function defaultEnvPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
}

/**
 * Load KEY=value pairs from `file` into process.env without overriding vars
 * already set. Uses Node's built-in env-file parser (comments, quotes and
 * `export ` prefixes handled; no dependency). All WEAVER_* config is read
 * lazily, so one call before the first command handler runs is enough.
 */
export function loadDotenv(file: string = defaultEnvPath()): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // No `.env` (ENOENT) or unreadable — env-file config is optional.
  }
}
