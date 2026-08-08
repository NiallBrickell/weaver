/**
 * Append-only sidecars for operator printouts.
 *
 * Revision receipts are written before the matching workstream/policy head.
 * A process interruption can therefore leave an orphan future receipt, which
 * readers ignore, rather than a head with no receipt. A monotonic delivery
 * cursor lives outside organizational state, so reading progress never
 * conflicts with a coordinator's revision-checked write.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JsonValue, PrintoutChange, PrintoutFieldDelta, WorkstreamDoc } from './types.js';

export interface PrintoutCheckpoint {
  throughRevision: number;
  through: string;
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function revisionName(revision: number): string {
  return `revision-${String(revision).padStart(16, '0')}.json`;
}

function pointerPart(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function jsonValue(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

/** Exact recursive JSON delta. Arrays are compared by index, so appends stay O(1). */
export function diffPrintoutFields(before: unknown, after: unknown, pointer = ''): PrintoutFieldDelta[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const beforeObject = before !== null && typeof before === 'object';
  const afterObject = after !== null && typeof after === 'object';
  if (beforeObject && afterObject && Array.isArray(before) === Array.isArray(after)) {
    const prior = before as Record<string, unknown>;
    const current = after as Record<string, unknown>;
    const keys = Array.isArray(before)
      ? Array.from({ length: Math.max((before as unknown[]).length, (after as unknown[]).length) }, (_, index) => String(index))
      : [...new Set([...Object.keys(prior), ...Object.keys(current)])].sort();
    return keys.flatMap((key) => diffPrintoutFields(prior[key], current[key], `${pointer}/${pointerPart(key)}`));
  }
  return [{
    path: pointer || '/',
    ...(before !== undefined ? { before: jsonValue(before) } : {}),
    ...(after !== undefined ? { after: jsonValue(after) } : {}),
  }];
}

export function writeJournalReceipt<T extends { revision: number }>(dir: string, receipt: T): void {
  atomicWrite(path.join(dir, 'revisions', revisionName(receipt.revision)), JSON.stringify(receipt, null, 2) + '\n');
}

/** Per-entity exact deltas, keyed by id — shared by doc receipts (below) and
 * the backends' policy-store receipts. */
export function changedById<T extends { id: string }>(
  before: T[],
  after: T[],
): { id: string; fields: PrintoutFieldDelta[] }[] {
  const old = new Map(before.map((value) => [value.id, value]));
  const next = new Map(after.map((value) => [value.id, value]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort()
    .flatMap((id) => {
      const prior = old.get(id);
      const current = next.get(id);
      if (JSON.stringify(prior) === JSON.stringify(current)) return [];
      return [{ id, fields: diffPrintoutFields(prior, current) }];
    });
}

function changedEntities<T extends { id: string }>(
  kind: PrintoutChange['kind'],
  before: T[],
  after: T[],
): PrintoutChange[] {
  return changedById(before, after).map((change) => ({ kind, ...change }));
}

/**
 * Central exact diff: eventless writers and intermediate values survive.
 * Backend-agnostic (a pure function of two docs) so every StateStore backend
 * builds identical receipts.
 */
export function printoutChanges(before: WorkstreamDoc, after: WorkstreamDoc): PrintoutChange[] {
  const changes: PrintoutChange[] = [];
  if (JSON.stringify(before.workstream) !== JSON.stringify(after.workstream)) {
    changes.push({ kind: 'workstream', fields: diffPrintoutFields(before.workstream, after.workstream) });
  }
  changes.push(
    ...changedEntities('decision', before.decisions, after.decisions),
    ...changedEntities('assignment', before.assignments, after.assignments),
    ...changedEntities('deliverable', before.deliverables, after.deliverables),
    ...changedEntities('interaction', before.interactions, after.interactions),
    ...changedEntities('observation', before.observations, after.observations),
    ...changedEntities('wake', before.wakes, after.wakes),
    ...changedEntities('steering', before.steering, after.steering),
    ...changedEntities('attention', before.attention, after.attention),
    ...changedEntities('pass', before.passes, after.passes),
    ...changedEntities('manager_direction', before.managerDirections ?? [], after.managerDirections ?? []),
    ...changedEntities('manager_notice', before.managerNotices ?? [], after.managerNotices ?? []),
  );
  if (JSON.stringify(before.spend) !== JSON.stringify(after.spend)) {
    changes.push({ kind: 'spend', fields: diffPrintoutFields(before.spend, after.spend) });
  }
  if (JSON.stringify(before.capacity) !== JSON.stringify(after.capacity)) {
    changes.push({ kind: 'capacity', fields: diffPrintoutFields(before.capacity, after.capacity) });
  }
  if (JSON.stringify(before.lease) !== JSON.stringify(after.lease)) {
    changes.push({ kind: 'lease', fields: diffPrintoutFields(before.lease, after.lease) });
  }
  return changes;
}

export function readJournalReceipts<T extends { revision: number }>(
  dir: string,
  afterRevision: number | undefined,
  throughRevision: number,
): T[] {
  const revisionsDir = path.join(dir, 'revisions');
  try {
    return fs.readdirSync(revisionsDir)
      .flatMap((name) => {
        const match = /^revision-(\d+)\.json$/.exec(name);
        if (!match) return [];
        const revision = Number(match[1]);
        return revision <= throughRevision && (afterRevision === undefined || revision > afterRevision) ? [name] : [];
      })
      .flatMap((name) => {
        try {
          const value = JSON.parse(fs.readFileSync(path.join(revisionsDir, name), 'utf8')) as T;
          return Number.isInteger(value.revision) && value.revision <= throughRevision &&
            (afterRevision === undefined || value.revision > afterRevision) ? [value] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.revision - b.revision);
  } catch {
    return [];
  }
}

export function missingJournalRevisions(
  receipts: readonly { revision: number }[],
  afterRevision: number | undefined,
  throughRevision: number,
): number[] {
  const start = afterRevision === undefined ? 0 : afterRevision + 1;
  const present = new Set(receipts.map((receipt) => receipt.revision));
  const missing: number[] = [];
  for (let revision = start; revision <= throughRevision; revision++) {
    if (!present.has(revision)) missing.push(revision);
  }
  return missing;
}

function withCheckpointLock<T>(dir: string, fn: () => T): T {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.checkpoint.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (fs.statSync(lock).mtimeMs < Date.now() - 5_000) {
          const stale = `${lock}.stale-${randomUUID()}`;
          try { fs.renameSync(lock, stale); fs.rmSync(stale, { recursive: true, force: true }); }
          catch { /* another acknowledger recovered it */ }
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('printout checkpoint lock timeout');
      const until = Date.now() + 5;
      while (Date.now() < until) { /* acknowledgement writes are sub-ms */ }
    }
  }
  try { return fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

/** Monotonic, bounded delivery cursor; same-revision races can only advance time. */
export function writePrintoutCheckpoint(dir: string, checkpoint: PrintoutCheckpoint): void {
  withCheckpointLock(dir, () => {
    const current = readLatestPrintoutCheckpoint(dir);
    if (current && (current.throughRevision > checkpoint.throughRevision ||
      (current.throughRevision === checkpoint.throughRevision && current.through >= checkpoint.through))) return;
    atomicWrite(path.join(dir, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2) + '\n');
  });
}

export function readLatestPrintoutCheckpoint(dir: string): PrintoutCheckpoint | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8')) as PrintoutCheckpoint;
    return Number.isInteger(value.throughRevision) && typeof value.through === 'string' ? value : undefined;
  } catch { /* no printout has been delivered */ }
  return undefined;
}
