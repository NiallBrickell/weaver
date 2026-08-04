/**
 * The resident runner as a module, so `weaver run` (headless) and the watch
 * dashboard (embedded) share one implementation. Exactly one runner may be
 * live per WEAVER_HOME — a pid lockfile enforces it, so opening the dashboard
 * while a headless runner exists just attaches as a viewer.
 *
 * The runner holds no state: it polls active workstreams and ticks them
 * (concurrently), and every guarantee lives in the tick itself (per-stream
 * cross-process locks, budget backstop, readback discipline). Kill and
 * restart freely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tick } from './engine.js';
import { listWorkstreams, load, weaverHome } from './store.js';

function lockDir(): string {
  return path.join(weaverHome(), '.runner.lock');
}

/** The pid of a live runner, or null. Reclaims a dead holder's lock. */
export function liveRunnerPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(lockDir(), 'pid'), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.rmSync(lockDir(), { recursive: true, force: true });
    return null;
  }
}

/** Acquire the singleton runner lock; null when a live runner already holds it. */
export function acquireRunnerLock(): (() => void) | null {
  try {
    fs.mkdirSync(lockDir(), { recursive: false });
  } catch {
    if (liveRunnerPid() !== null) return null;
    try {
      fs.mkdirSync(lockDir(), { recursive: false });
    } catch {
      return null; // raced another starter; exactly one wins
    }
  }
  fs.writeFileSync(path.join(lockDir(), 'pid'), String(process.pid));
  const release = () => fs.rmSync(lockDir(), { recursive: true, force: true });
  process.on('exit', release);
  return release;
}

export interface RunnerOptions {
  intervalMs: number;
  concurrency: number;
  /** Progress lines (a tick that did something). Default: stdout. */
  log?: (line: string) => void;
  /** Errors. Default: stderr. */
  logError?: (line: string) => void;
}

function heartbeatPath(): string {
  return path.join(lockDir(), 'heartbeat');
}

/**
 * TRUE loop liveness — a live pid whose loop died (unhandled rejection, hung
 * awaits eating every slot) must not render as "runner ✓". The loop touches
 * a heartbeat every iteration; stale heartbeat + live pid = stalled runner.
 */
export function runnerLoopHealthy(): boolean {
  if (liveRunnerPid() === null) return false;
  try {
    return Date.now() - fs.statSync(heartbeatPath()).mtimeMs < 120_000;
  } catch {
    return false;
  }
}

/** The poll loop. Never returns; run it detached (`void runLoop(...)`) to embed. */
export async function runLoop(opts: RunnerOptions): Promise<never> {
  const log = opts.log ?? ((l: string) => process.stdout.write(l + '\n'));
  const logError = opts.logError ?? ((l: string) => process.stderr.write(l + '\n'));
  const inFlight = new Set<string>();
  // Slot starvation guard: a tick that exceeds this is presumed hung (an SDK
  // call that never returned); its SLOT is reclaimed so the rest of the fleet
  // keeps moving. The stream's own tick lock still serializes it, and dead-pid
  // /stale-attempt recovery repairs whatever the hung call abandoned.
  const SLOT_TIMEOUT_MS = 45 * 60_000;
  for (;;) {
    try {
      try {
        fs.writeFileSync(heartbeatPath(), String(Date.now()));
      } catch { /* lock dir may be mid-recreate */ }
      const due = listWorkstreams().filter((slug) => {
        if (inFlight.has(slug)) return false;
        try {
          return load(slug).workstream.status === 'active';
        } catch {
          return false;
        }
      });
      for (const slug of due) {
        if (inFlight.size >= opts.concurrency) break;
        inFlight.add(slug);
        let settled = false;
        const slotTimer = setTimeout(() => {
          if (!settled) {
            logError(`[run] ${slug}: tick exceeded ${SLOT_TIMEOUT_MS / 60_000}m — presumed hung; freeing its slot`);
            inFlight.delete(slug);
          }
        }, SLOT_TIMEOUT_MS);
        void tick(slug, {})
          .then((report) => {
            if (report.workersRun.length || report.passes.length || report.sendsExecuted || report.unknownsResolved) {
              log(
                `[${new Date().toTimeString().slice(0, 8)}] ${slug}: workers=[${report.workersRun.join(',')}] passes=${report.passes.length} sends=${report.sendsExecuted}`,
              );
            }
          })
          .catch((e) => {
            logError(`[run] ${slug}: ${e instanceof Error ? e.message : e}`);
          })
          .finally(() => {
            settled = true;
            clearTimeout(slotTimer);
            inFlight.delete(slug);
          });
      }
    } catch (e) {
      // The LOOP must survive anything an iteration throws (fd exhaustion on
      // listWorkstreams once killed it silently while the pid lived on).
      logError(`[run] loop iteration failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
