/**
 * `weaver link` — fleet membership as one command.
 *
 * `weaver login` gives a machine its execution identity; `link` is the other
 * half of the remote story: point THIS machine at an existing shared store and
 * prove the connection carries real fleet data before anything relies on it.
 * Weaver stays single-operator — link is your machine joining your fleet, not
 * an account system.
 *
 * Three forms:
 *   weaver link <store-url>   validate → probe (read-only) → persist WEAVER_STORE into .env
 *   weaver link               report current linkage (source + redacted target) and re-probe it
 *   weaver link --unlink      remove WEAVER_STORE from .env
 *
 * The probe goes through the REAL store layer — the same getStore()/WEAVER_STORE
 * seam every command uses — never a parallel client, so what link proves is
 * exactly what `weaver run`/`weaver watch` will experience. It only enumerates
 * and loads: linking must never write to the fleet it is joining.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultEnvPath } from './env.js';
import { configSource, executorStatuses, updateEnvContent } from './login.js';
import { loadExecutorSecrets } from './secrets.js';
import { closeStore, listWorkstreams, load } from './store.js';
import { expandTilde } from './store/sqlite.js';
import type { WorkstreamDoc } from './types.js';

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

// ── pure helpers (unit-tested in link.test.ts) ───────────────────────────────

const ACCEPTED_FORMS = 'postgres://user:pass@host:5432/db · postgresql://… · sqlite:/path/to/fleet.db';

/** Null when the URL is a store target Weaver accepts; otherwise the reason. */
export function validateStoreUrl(url: string): string | null {
  if (/^postgres(ql)?:\/\//.test(url)) return null;
  if (url.startsWith('sqlite:')) return null;
  return `'${url}' is not a store URL — accepted forms: ${ACCEPTED_FORMS}`;
}

export function storeBackend(url: string | undefined): 'postgres' | 'sqlite' | 'fs' {
  if (url && /^postgres(ql)?:\/\//.test(url)) return 'postgres';
  if (url?.startsWith('sqlite:')) return 'sqlite';
  return 'fs';
}

/**
 * A store URL safe to echo: the password in the userinfo becomes `***`.
 * URLs without userinfo (or with a bare username) and sqlite paths pass
 * through unchanged — there is nothing secret in them.
 */
export function redactStoreUrl(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/)([^@/]*)@/, (_m, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(':');
    return colon >= 0 ? `${scheme}${userinfo.slice(0, colon)}:***@` : `${scheme}${userinfo}@`;
  });
}

/** The raw password embedded in a store URL, for scrubbing error output. */
function storePassword(url: string): string | null {
  const m = /^postgres(?:ql)?:\/\/([^@/]*)@/.exec(url);
  if (!m) return null;
  const colon = m[1]!.indexOf(':');
  return colon >= 0 && colon < m[1]!.length - 1 ? m[1]!.slice(colon + 1) : null;
}

/**
 * Scrub a message (typically a driver error, which loves to echo the
 * connection string) so neither the raw URL nor the bare password survives.
 */
export function scrubStoreSecrets(text: string, url: string): string {
  let out = text.split(url).join(redactStoreUrl(url));
  const password = storePassword(url);
  if (password) out = out.split(password).join('***');
  return out;
}

export interface FleetSummary {
  backend: 'postgres' | 'sqlite' | 'fs';
  workstreamCount: number;
  /** The most recently updated workstream — proof the fleet carries real data. */
  recent?: { slug: string; title: string; status: 'active' | 'paused' | 'done'; updatedAt: string };
}

/** Real wall-clock recency: the last event's timestamp, else creation. */
function docUpdatedAt(doc: WorkstreamDoc): string {
  return doc.events.at(-1)?.at ?? doc.workstream.createdAt;
}

/**
 * Prove the store at `url` (undefined = the machine-local fs default) is
 * reachable and readable through the real store layer: point this process's
 * WEAVER_STORE at it, enumerate workstreams, and fully load each doc to find
 * the most recently updated one. Strictly read-only — nothing here mutates,
 * and a missing sqlite file is refused rather than silently minted into an
 * empty fleet. The prior WEAVER_STORE and active backend are restored on exit.
 */
export async function probeFleet(url: string | undefined): Promise<FleetSummary> {
  if (url?.startsWith('sqlite:')) {
    const dbPath = path.resolve(expandTilde(url.slice('sqlite:'.length)));
    if (!fs.existsSync(dbPath)) {
      throw new Error(`no database file at ${dbPath} — linking never creates a fleet; check the path`);
    }
  }
  await closeStore(); // release the active backend so getStore() re-reads WEAVER_STORE
  const prior = process.env.WEAVER_STORE;
  if (url === undefined) delete process.env.WEAVER_STORE;
  else process.env.WEAVER_STORE = url;
  try {
    const slugs = await listWorkstreams();
    let recent: FleetSummary['recent'];
    for (const slug of slugs) {
      const doc = await load(slug);
      const updatedAt = docUpdatedAt(doc);
      if (!recent || updatedAt > recent.updatedAt) {
        recent = { slug, title: doc.workstream.title, status: doc.workstream.status, updatedAt };
      }
    }
    return { backend: storeBackend(url), workstreamCount: slugs.length, ...(recent ? { recent } : {}) };
  } finally {
    await closeStore();
    if (prior === undefined) delete process.env.WEAVER_STORE;
    else process.env.WEAVER_STORE = prior;
  }
}

/**
 * Remove every assignment of `key` from `.env` content (export-prefixed too;
 * a `# KEY=` comment is not an assignment and survives). Every other line is
 * kept byte-for-byte.
 */
export function removeEnvKey(content: string, key: string): { content: string; removed: boolean } {
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const kept = lines.filter((line) => {
    const m = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    return !(m && m[1] === key);
  });
  const body = kept.join('\n');
  return { content: body === '' ? '' : `${body}\n`, removed: kept.length !== lines.length };
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderFleet(summary: FleetSummary): string {
  const recent = summary.recent
    ? `most recent: ${summary.recent.slug} — "${summary.recent.title}" (${summary.recent.status})`
    : 'empty fleet — no workstreams yet';
  return `  workstreams: ${summary.workstreamCount}; ${recent}\n`;
}

function nextSteps(): string {
  // Reuse login's status detection: no executor standing ok means this machine
  // has no execution identity yet, and `weaver login` is the missing half.
  const anyIdentity = executorStatuses(loadExecutorSecrets()).some((s) => s.ok);
  return (
    'next:\n' +
    (anyIdentity ? '' : '  weaver login    — no execution identity detected on this machine\n') +
    '  restart any resident `weaver run` / `weaver watch` — they snapshot .env at launch\n' +
    '  weaver watch\n'
  );
}

// ── the three command forms ──────────────────────────────────────────────────

async function linkCommand(url: string): Promise<void> {
  const invalid = validateStoreUrl(url);
  if (invalid) fail(invalid);
  const redacted = redactStoreUrl(url);

  // Captured BEFORE the write: after .env changes, the live process value from
  // the old .env would misreport as a real export.
  const priorValue = process.env.WEAVER_STORE;
  const priorSource = configSource('WEAVER_STORE');

  let summary: FleetSummary;
  try {
    summary = await probeFleet(url);
  } catch (e) {
    fail(
      `could not reach the store at ${redacted}: ${scrubStoreSecrets(e instanceof Error ? e.message : String(e), url)}\n` +
        '       (is the tunnel up? link needs the database reachable from this machine right now)',
    );
  }

  const envPath = defaultEnvPath();
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    /* no .env yet — created below */
  }
  fs.writeFileSync(envPath, updateEnvContent(content, { WEAVER_STORE: url }));

  process.stdout.write(
    `linked — this machine now points at the shared fleet\n` +
      `  store: ${summary.backend} — ${redacted}  (WEAVER_STORE in ${envPath})\n` +
      renderFleet(summary),
  );
  if (priorSource === 'env' && priorValue !== url) {
    process.stdout.write(
      `  note: your environment exports WEAVER_STORE=${redactStoreUrl(priorValue!)} — an explicit export wins over .env; unset or update it\n`,
    );
  }
  process.stdout.write(nextSteps());
}

async function statusCommand(): Promise<void> {
  const value = process.env.WEAVER_STORE;
  const source = configSource('WEAVER_STORE');
  process.stdout.write(
    value === undefined
      ? `WEAVER_STORE: (unset) — machine-local filesystem store under WEAVER_HOME\n`
      : `WEAVER_STORE: ${redactStoreUrl(value)}  (from ${source})\n`,
  );
  let summary: FleetSummary;
  try {
    summary = await probeFleet(value);
  } catch (e) {
    fail(
      `store unreachable: ${value ? scrubStoreSecrets(e instanceof Error ? e.message : String(e), value) : e instanceof Error ? e.message : String(e)}\n` +
        '       (is the tunnel up?)',
    );
  }
  process.stdout.write(`reachable — ${summary.backend} store\n${renderFleet(summary)}`);
}

function unlinkCommand(): void {
  const envPath = defaultEnvPath();
  // Before the removal: afterwards the live process value (loaded from the old
  // .env at startup) would misreport as a real export.
  const wasRealExport = configSource('WEAVER_STORE') === 'env';
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    /* no .env — nothing to unlink */
  }
  const { content: next, removed } = removeEnvKey(content, 'WEAVER_STORE');
  if (!removed) {
    process.stdout.write(`no WEAVER_STORE in ${envPath} — nothing to unlink\n`);
    return;
  }
  fs.writeFileSync(envPath, next);
  process.stdout.write(
    `unlinked — removed WEAVER_STORE from ${envPath}; commands on this machine use the local filesystem store again\n` +
      (wasRealExport
        ? `  note: your environment still exports WEAVER_STORE — the export wins until you unset it\n`
        : `  note: an ambient WEAVER_STORE export would still win over .env if you set one\n`),
  );
}

export async function runLink(rest: string[]): Promise<void> {
  if (rest.includes('--unlink')) {
    if (rest.length > 1) fail('usage: weaver link --unlink');
    return unlinkCommand();
  }
  if (rest.length === 0) return statusCommand();
  if (rest.length > 1 || rest[0]!.startsWith('--')) {
    fail('usage: weaver link <store-url> | weaver link | weaver link --unlink');
  }
  return linkCommand(rest[0]!);
}
