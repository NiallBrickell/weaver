/**
 * A small, synchronous, cross-process lock for Weaver's local filesystem.
 *
 * The visible directory is installed with complete owner metadata in one
 * rename. Its owner filename is unique, so a stale contender can unlink only
 * the owner it inspected; it can never recursively delete a successor's lock.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OWNER_SUFFIX = '.owner.json';
const LEGACY_OWNER_FILE = 'pid';
const INCOMPLETE_LOCK_STALE_MS = 10_000;

type SignalProbe = (pid: number, signal: 0) => unknown;

interface LockOwner {
  pid: number;
  token: string;
  fileName: string;
}

type LockSnapshot =
  | { kind: 'owned'; owner: LockOwner }
  | { kind: 'empty'; mtimeMs: number }
  | { kind: 'malformed' }
  | { kind: 'missing' };

export interface ProcessLockOptions {
  /** How long to wait for a live owner. Zero makes acquisition non-blocking. */
  timeoutMs?: number;
  pollMs?: number;
}

/** Only ESRCH proves absence. EPERM and unknown probe errors fail closed. */
export function pidIsLive(pid: number, probe: SignalProbe = process.kill): boolean {
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function snapshot(lockDir: string): LockSnapshot {
  let names: string[];
  try {
    names = fs.readdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  const ownerNames = names.filter((name) => name.endsWith(OWNER_SUFFIX));
  if (ownerNames.length === 1 && names.length === 1) {
    const fileName = ownerNames[0]!;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(lockDir, fileName), 'utf8')) as {
        pid?: unknown;
        token?: unknown;
      };
      if (
        Number.isInteger(parsed.pid) &&
        (parsed.pid as number) > 0 &&
        typeof parsed.token === 'string' &&
        parsed.token.length > 0
      ) {
        return {
          kind: 'owned',
          owner: { pid: parsed.pid as number, token: parsed.token, fileName },
        };
      }
    } catch {
      // Invalid owner metadata is fail-closed below.
    }
    return { kind: 'malformed' };
  }

  // Locks written by Weaver before ownership tokens used a fixed pid file.
  if (names.length === 1 && names[0] === LEGACY_OWNER_FILE) {
    try {
      const pid = Number(fs.readFileSync(path.join(lockDir, LEGACY_OWNER_FILE), 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        return {
          kind: 'owned',
          owner: { pid, token: `legacy-${pid}`, fileName: LEGACY_OWNER_FILE },
        };
      }
    } catch {
      // Invalid legacy metadata is fail-closed below.
    }
    return { kind: 'malformed' };
  }

  if (names.length === 0) {
    try {
      return { kind: 'empty', mtimeMs: fs.statSync(lockDir).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw error;
    }
  }
  return { kind: 'malformed' };
}

function removeObservedOwner(lockDir: string, owner: LockOwner): boolean {
  try {
    fs.unlinkSync(path.join(lockDir, owner.fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  try {
    fs.rmdirSync(lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

function removeStaleEmptyLock(lockDir: string, mtimeMs: number): boolean {
  if (mtimeMs > Date.now() - INCOMPLETE_LOCK_STALE_MS) return false;
  try {
    // Non-recursive removal cannot touch a completely installed successor.
    fs.rmdirSync(lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    throw error;
  }
}

function installCandidate(candidateDir: string, lockDir: string): boolean {
  try {
    fs.renameSync(candidateDir, lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    // Windows reports EPERM when the destination directory already exists.
    if ((code === 'EPERM' || code === 'EACCES') && fs.existsSync(lockDir)) return false;
    throw error;
  }
}

function pause(ms: number): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

/** Acquire a local process lock, reclaiming only an owner proven dead. */
export function acquireProcessLock(
  lockDir: string,
  options: ProcessLockOptions = {},
): (() => void) | null {
  const timeoutMs = options.timeoutMs ?? 0;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  const ownerFile = `${process.pid}-${token}${OWNER_SUFFIX}`;
  const candidateDir = `${lockDir}.candidate-${token}`;

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(candidateDir);
  fs.writeFileSync(
    path.join(candidateDir, ownerFile),
    JSON.stringify({ pid: process.pid, token }),
  );

  let acquired = false;
  try {
    for (;;) {
      if (installCandidate(candidateDir, lockDir)) {
        acquired = true;
        break;
      }

      const current = snapshot(lockDir);
      if (current.kind === 'owned' && !pidIsLive(current.owner.pid)) {
        removeObservedOwner(lockDir, current.owner);
        continue;
      }
      if (current.kind === 'empty' && removeStaleEmptyLock(lockDir, current.mtimeMs)) {
        continue;
      }
      if (current.kind === 'missing') continue;

      if (Date.now() >= deadline) return null;
      pause(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    }
  } finally {
    if (!acquired) fs.rmSync(candidateDir, { recursive: true, force: true });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // If the pathname was replaced, our unique owner filename is absent and
    // this release becomes a no-op instead of deleting the successor.
    removeObservedOwner(lockDir, { pid: process.pid, token, fileName: ownerFile });
  };
}

/** Return a live owner's pid. A dead, exactly-identified owner is reclaimed. */
export function liveProcessLockPid(lockDir: string): number | null {
  const current = snapshot(lockDir);
  if (current.kind !== 'owned') return null;
  if (pidIsLive(current.owner.pid)) return current.owner.pid;
  removeObservedOwner(lockDir, current.owner);
  return null;
}
