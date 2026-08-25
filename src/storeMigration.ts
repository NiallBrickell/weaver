/**
 * One-time exact copy from Weaver's reference filesystem store to a new
 * shared Postgres store.
 *
 * This is intentionally not a generic import/export subsystem. It holds the
 * local fleet still, takes and validates one typed snapshot, installs that
 * snapshot into a provably empty destination in one transaction, then opens a
 * fresh Postgres store and proves every document, artifact and policy came
 * back unchanged. Source state is never rewritten.
 *
 * Machine-local sidecars are deliberately outside this copy: secrets must not
 * enter shared storage, while printout receipts, tail feeds, runner locks and
 * the simulated outbox are local observations rather than StateStore truth.
 * They remain untouched under WEAVER_HOME; this moves exactly the three
 * backend-owned kinds (typed heads, artifact bytes, global PolicyStore).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { PolicyStore } from './policies.js';
import { acquireProcessLock } from './processLock.js';
import { acquireRunnerLock, liveRunnerPid } from './runner.js';
import { assertNoSecretValues, loadAllSecrets } from './secrets.js';
import { sha256, weaverHome, workstreamDir } from './store.js';
import { emptyPolicyStore } from './store/doc.js';
import { PgStore, type ExactPgFleetSnapshot } from './store/pg.js';
import type { WorkstreamDoc } from './types.js';

export interface FleetArtifactSnapshot {
  slug: string;
  relPath: string;
  /** Artifact storage is text by contract; this string round-trips its exact UTF-8 bytes. */
  content: string;
  contentHash: string;
  byteLength: number;
}

export interface FilesystemFleetSnapshot {
  workstreams: { slug: string; revision: number; doc: WorkstreamDoc }[];
  artifacts: FleetArtifactSnapshot[];
  policies: PolicyStore;
  /** Hash of the source files' paths and exact bytes, used only for stability checks. */
  sourceFingerprint: string;
}

export interface FleetCopyResult {
  workstreams: number;
  artifacts: number;
  policyRevision: number;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactUtf8(bytes: Buffer, label: string): string {
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8 — Postgres text storage cannot preserve its exact bytes`);
  }
  return content;
}

function readRegularFile(file: string, label: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file — refusing an ambiguous filesystem snapshot`);
  }
  return fs.readFileSync(file);
}

function artifactFiles(dir: string, prefix = ''): { relPath: string; bytes: Buffer }[] {
  if (!fs.existsSync(dir)) return [];
  const rootStat = fs.lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`artifact root '${dir}' is not a regular directory`);
  }

  const out: { relPath: string; bytes: Buffer }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`artifact '${relPath}' is a symlink — refusing an ambiguous filesystem snapshot`);
    }
    if (entry.isDirectory()) {
      out.push(...artifactFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      out.push({ relPath, bytes: readRegularFile(fullPath, `artifact '${relPath}'`) });
    } else {
      throw new Error(`artifact '${relPath}' is not a regular file`);
    }
  }
  return out;
}

function filesystemSlugs(home: string): string[] {
  if (!fs.existsSync(home)) return [];
  const root = fs.lstatSync(home);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(`WEAVER_HOME '${home}' is not a regular directory`);
  }
  const slugs: string[] = [];
  for (const entry of fs.readdirSync(home, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const doc = path.join(home, entry.name, 'workstream.json');
    if (!fs.existsSync(doc)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`workstream '${entry.name}' is not a regular directory`);
    }
    slugs.push(entry.name);
  }
  return slugs;
}

function safeArtifactPath(relPath: string): boolean {
  return relPath.length > 0 &&
    !path.posix.isAbsolute(relPath) &&
    !relPath.includes('\0') &&
    !relPath.split('/').includes('..');
}

function assertSecretFree(label: string, text: string, secrets: Record<string, string>): void {
  try {
    assertNoSecretValues(text, secrets);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate the contracts an exact copy must not turn into authoritative shared
 * state. This function is exported so corruption cases stay deterministic and
 * need no live database in the test suite.
 */
export function validateFleetSnapshot(
  snapshot: FilesystemFleetSnapshot,
  knownSecrets: Record<string, string> = {},
): void {
  if (
    snapshot.policies.schemaVersion !== 1 ||
    !Number.isInteger(snapshot.policies.revision) ||
    snapshot.policies.revision < 0 ||
    !Array.isArray(snapshot.policies.policies)
  ) {
    throw new Error('global policy store has an invalid schema or revision');
  }
  const policyIds = new Set<string>();
  for (const policy of snapshot.policies.policies) {
    if (!policy.id || policyIds.has(policy.id)) throw new Error(`duplicate or empty policy id '${policy.id}'`);
    policyIds.add(policy.id);
    if (
      policy.widensAuthority !== false ||
      !['add_verification', 'narrow_authority', 'advisory'].includes(policy.effect?.kind) ||
      !['shadow', 'active', 'superseded'].includes(policy.status)
    ) {
      throw new Error(`policy '${policy.id}' has invalid trust, effect, or status state`);
    }
  }
  assertSecretFree('global policy store', JSON.stringify(snapshot.policies), knownSecrets);

  const slugs = new Set<string>();
  const workstreamIds = new Set<string>();
  const sourceKeys = new Map<string, string>();
  for (const entry of snapshot.workstreams) {
    if (!entry.slug || slugs.has(entry.slug)) throw new Error(`duplicate or empty workstream slug '${entry.slug}'`);
    slugs.add(entry.slug);
    if (
      entry.doc?.schemaVersion !== 1 ||
      !entry.doc.workstream ||
      !['active', 'paused', 'done'].includes(entry.doc.workstream.status)
    ) {
      throw new Error(`workstream '${entry.slug}' has an invalid schema or status`);
    }
    if (entry.doc.workstream.slug !== entry.slug) {
      throw new Error(
        `workstream directory '${entry.slug}' contains document for '${entry.doc.workstream.slug}'`,
      );
    }
    if (!Number.isInteger(entry.revision) || entry.revision < 0 || entry.doc.revision !== entry.revision) {
      throw new Error(`workstream '${entry.slug}' has an invalid or mismatched revision`);
    }
    const id = entry.doc.workstream.id;
    if (!id || workstreamIds.has(id)) throw new Error(`duplicate or empty workstream id '${id}'`);
    workstreamIds.add(id);
    const sourceKey = entry.doc.workstream.sourceKey;
    if (sourceKey !== undefined) {
      if (typeof sourceKey !== 'string') {
        throw new Error(`workstream '${entry.slug}' has an invalid sourceKey`);
      }
      const existing = sourceKeys.get(sourceKey);
      if (existing) {
        throw new Error(`workstreams '${existing}' and '${entry.slug}' share sourceKey '${sourceKey}'`);
      }
      sourceKeys.set(sourceKey, entry.slug);
    }
    if (!Array.isArray(entry.doc.deliverables)) {
      throw new Error(`workstream '${entry.slug}' has an invalid deliverables collection`);
    }
    assertSecretFree(`workstream '${entry.slug}'`, JSON.stringify(entry.doc), knownSecrets);
  }

  const artifacts = new Map<string, FleetArtifactSnapshot>();
  for (const artifact of snapshot.artifacts) {
    if (typeof artifact.slug !== 'string' || typeof artifact.relPath !== 'string' || typeof artifact.content !== 'string') {
      throw new Error('artifact snapshot contains an invalid slug, path, or content value');
    }
    if (!slugs.has(artifact.slug)) {
      throw new Error(`artifact '${artifact.relPath}' belongs to unknown workstream '${artifact.slug}'`);
    }
    if (!safeArtifactPath(artifact.relPath)) {
      throw new Error(`artifact '${artifact.relPath}' for '${artifact.slug}' has an unsafe relative path`);
    }
    const key = `${artifact.slug}\0${artifact.relPath}`;
    if (artifacts.has(key)) throw new Error(`duplicate artifact '${artifact.relPath}' for '${artifact.slug}'`);
    if (Buffer.byteLength(artifact.content, 'utf8') !== artifact.byteLength) {
      throw new Error(`artifact '${artifact.relPath}' for '${artifact.slug}' has a mismatched byte length`);
    }
    if (sha256(artifact.content) !== artifact.contentHash) {
      throw new Error(`artifact '${artifact.relPath}' for '${artifact.slug}' has a mismatched snapshot hash`);
    }
    assertSecretFree(
      `artifact '${artifact.relPath}' for '${artifact.slug}'`,
      `${artifact.relPath}\n${artifact.content}`,
      knownSecrets,
    );
    artifacts.set(key, artifact);
  }

  for (const entry of snapshot.workstreams) {
    for (const deliverable of entry.doc.deliverables) {
      if (typeof deliverable.path !== 'string' || !safeArtifactPath(deliverable.path)) {
        throw new Error(`deliverable '${deliverable.id}' in '${entry.slug}' has an unsafe artifact path`);
      }
      const artifact = artifacts.get(`${entry.slug}\0${deliverable.path}`);
      if (!artifact) {
        throw new Error(
          `deliverable '${deliverable.id}' in '${entry.slug}' references missing artifact '${deliverable.path}'`,
        );
      }
      if (artifact.contentHash !== deliverable.contentHash) {
        throw new Error(`deliverable '${deliverable.id}' in '${entry.slug}' has a contentHash that does not match its bytes`);
      }
      if (deliverable.adopted && deliverable.adopted.contentHash !== deliverable.contentHash) {
        throw new Error(`adopted deliverable '${deliverable.id}' in '${entry.slug}' does not pin its proposed contentHash`);
      }
    }
  }
}

/** Capture all backend-equivalent filesystem truth; lock acquisition is the caller's job. */
export function snapshotFilesystemFleet(
  home = weaverHome(),
  knownSecrets: Record<string, string> = loadAllSecrets(),
): FilesystemFleetSnapshot {
  const fingerprintParts: { kind: string; path: string; bytes: number; hash: string }[] = [];
  const workstreams: FilesystemFleetSnapshot['workstreams'] = [];
  const artifacts: FleetArtifactSnapshot[] = [];

  for (const slug of filesystemSlugs(home)) {
    const docFile = path.join(home, slug, 'workstream.json');
    const docBytes = readRegularFile(docFile, `workstream '${slug}' document`);
    const docText = exactUtf8(docBytes, `workstream '${slug}' document`);
    let doc: WorkstreamDoc;
    try {
      doc = JSON.parse(docText) as WorkstreamDoc;
    } catch (error) {
      throw new Error(`cannot parse workstream '${slug}': ${error instanceof Error ? error.message : String(error)}`);
    }
    workstreams.push({ slug, revision: doc.revision, doc });
    fingerprintParts.push({ kind: 'workstream', path: slug, bytes: docBytes.length, hash: hashBytes(docBytes) });

    for (const artifact of artifactFiles(path.join(home, slug, 'artifacts'))) {
      const content = exactUtf8(artifact.bytes, `artifact '${artifact.relPath}' for '${slug}'`);
      artifacts.push({
        slug,
        relPath: artifact.relPath,
        content,
        contentHash: sha256(content),
        byteLength: artifact.bytes.length,
      });
      fingerprintParts.push({
        kind: 'artifact',
        path: `${slug}/${artifact.relPath}`,
        bytes: artifact.bytes.length,
        hash: hashBytes(artifact.bytes),
      });
    }
  }

  const policiesFile = path.join(home, 'policies.json');
  let policies: PolicyStore;
  if (fs.existsSync(policiesFile)) {
    const bytes = readRegularFile(policiesFile, 'global policy store');
    try {
      policies = JSON.parse(exactUtf8(bytes, 'global policy store')) as PolicyStore;
    } catch (error) {
      throw new Error(`cannot parse global policy store: ${error instanceof Error ? error.message : String(error)}`);
    }
    fingerprintParts.push({ kind: 'policies', path: 'policies.json', bytes: bytes.length, hash: hashBytes(bytes) });
  } else {
    policies = emptyPolicyStore();
    fingerprintParts.push({ kind: 'policies', path: 'policies.json', bytes: 0, hash: 'absent' });
  }

  workstreams.sort((a, b) => a.slug.localeCompare(b.slug));
  artifacts.sort((a, b) => a.slug.localeCompare(b.slug) || a.relPath.localeCompare(b.relPath));
  const snapshot: FilesystemFleetSnapshot = {
    workstreams,
    artifacts,
    policies,
    sourceFingerprint: sha256(JSON.stringify(fingerprintParts)),
  };
  validateFleetSnapshot(snapshot, knownSecrets);
  return snapshot;
}

export function assertSourceStable(
  before: Pick<FilesystemFleetSnapshot, 'sourceFingerprint'>,
  after: Pick<FilesystemFleetSnapshot, 'sourceFingerprint'>,
): void {
  if (before.sourceFingerprint !== after.sourceFingerprint) {
    throw new Error('filesystem fleet changed while it was being snapshotted — nothing was copied; retry while it is idle');
  }
}

function pgSnapshot(snapshot: FilesystemFleetSnapshot): ExactPgFleetSnapshot {
  return {
    workstreams: snapshot.workstreams.map(({ slug, revision, doc }) => ({ slug, revision, doc })),
    artifacts: snapshot.artifacts.map(({ slug, relPath, content }) => ({ slug, relPath, content })),
    policies: snapshot.policies,
  };
}

function verifyPostgresReadback(
  expected: FilesystemFleetSnapshot,
  actual: ExactPgFleetSnapshot,
  knownSecrets: Record<string, string>,
): void {
  const actualForValidation: FilesystemFleetSnapshot = {
    workstreams: actual.workstreams,
    artifacts: actual.artifacts.map((artifact) => ({
      ...artifact,
      contentHash: sha256(artifact.content),
      byteLength: Buffer.byteLength(artifact.content, 'utf8'),
    })),
    policies: actual.policies,
    sourceFingerprint: '',
  };
  validateFleetSnapshot(actualForValidation, knownSecrets);

  if (!isDeepStrictEqual(actual.workstreams, pgSnapshot(expected).workstreams)) {
    throw new Error('Postgres verification failed: workstream documents or revisions differ from the source snapshot');
  }
  if (!isDeepStrictEqual(actual.artifacts, pgSnapshot(expected).artifacts)) {
    throw new Error('Postgres verification failed: artifact paths or bytes differ from the source snapshot');
  }
  if (!isDeepStrictEqual(actual.policies, expected.policies)) {
    throw new Error('Postgres verification failed: policy records, trust state, or revision differ from the source snapshot');
  }
}

function scrubPgError(error: unknown, url: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  message = message.split(url).join('[Postgres destination]');
  try {
    const parsed = new URL(url);
    if (parsed.password) message = message.split(decodeURIComponent(parsed.password)).join('***');
  } catch { /* URL form is checked before any connection is attempted. */ }
  return new Error(message);
}

/**
 * Copy the current filesystem fleet into an empty Postgres store and prove the
 * result. The caller supplies the destination URL explicitly; WEAVER_STORE
 * remains the declaration of the source and therefore must still be fs/unset.
 */
export async function runFilesystemToPostgresCopy(destinationUrl: string): Promise<FleetCopyResult> {
  const sourceStore = process.env.WEAVER_STORE;
  if (sourceStore !== undefined && sourceStore !== '' && sourceStore !== 'fs') {
    throw new Error('filesystem migration requires WEAVER_STORE to be unset or exactly fs');
  }
  if (!/^postgres(ql)?:\/\//.test(destinationUrl)) {
    throw new Error('migration destination must be a postgres:// or postgresql:// URL');
  }

  const home = weaverHome();
  const releaseRunner = acquireRunnerLock();
  if (!releaseRunner) {
    const pid = liveRunnerPid();
    throw new Error(
      pid === null
        ? 'runner lock is held or malformed — refusing to snapshot a fleet that may be moving'
        : `runner pid ${pid} is live — stop it before copying the filesystem fleet`,
    );
  }

  const releases: (() => void)[] = [releaseRunner];
  try {
    const acquire = (dir: string, label: string): void => {
      const release = acquireProcessLock(dir);
      if (!release) throw new Error(`${label} is busy — nothing was copied; retry when the local fleet is idle`);
      releases.push(release);
    };

    // The create lock freezes the slug set and rename operations. Tick locks
    // stop manual ticks; write/policy locks stop every remaining typed writer.
    acquire(path.join(home, '.create.lock'), 'workstream creation');
    for (const slug of filesystemSlugs(home)) {
      acquire(path.join(workstreamDir(slug), '.tick.lock'), `workstream '${slug}' tick`);
      acquire(path.join(workstreamDir(slug), '.write.lock'), `workstream '${slug}' write`);
    }
    acquire(path.join(home, 'policies.json.lock'), 'global policy store');

    const source = snapshotFilesystemFleet(home);
    assertSourceStable(source, snapshotFilesystemFleet(home));

    let destination = new PgStore(destinationUrl);
    try {
      await destination.importExactFleet(pgSnapshot(source));
      await destination.close();

      // A new pool proves the committed database state, not an object retained
      // from the transaction that wrote it.
      destination = new PgStore(destinationUrl);
      verifyPostgresReadback(source, await destination.readExactFleet(), loadAllSecrets());

      // Re-read the still-locked source after network I/O: the operation did
      // not mutate it and the destination corresponds to the stable snapshot.
      assertSourceStable(source, snapshotFilesystemFleet(home));
      return {
        workstreams: source.workstreams.length,
        artifacts: source.artifacts.length,
        policyRevision: source.policies.revision,
      };
    } catch (error) {
      throw scrubPgError(error, destinationUrl);
    } finally {
      await destination.close().catch(() => {});
    }
  } finally {
    for (const release of releases.reverse()) release();
  }
}
