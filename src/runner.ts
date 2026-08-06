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
import * as os from 'node:os';
import * as path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tick } from './engine.js';
import { sdkEnv } from './secrets.js';
import { arrive, listWorkstreams, load, weaverHome } from './store.js';
import { virtualNow } from './clock.js';
import {
  clearCapacityBackoff,
  resolveCapacityAttention,
  retryCapacityNow,
} from './capacity.js';

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

/**
 * Infra-backoff recovery. When passes fail on limits or auth, streams park
 * behind provider-timed backoff wakes — but an auth outage usually ends the
 * moment the operator re-authenticates. While a backoff wake is pending, the
 * runner watches credential-file metadata and performs one bounded probe when
 * that metadata changes. It never polls model capacity: scheduled wakes do the
 * ordinary retry, and `weaver capacity retry` is the explicit path after a
 * provider-side billing change. Success expedites only that model's waits.
 */
export async function infraBackoffSlugs(): Promise<string[]> {
  const out: string[] = [];
  const now = virtualNow().toISOString();
  for (const slug of await listWorkstreams()) {
    try {
      const d = await load(slug);
      if (d.workstream.status !== 'active') continue;
      if (Object.values(d.capacity?.byModel ?? {}).some(
        (entry) => entry.wait.retryAt > now,
      )) {
        out.push(slug);
      }
    } catch { /* unreadable stream — its own tick reports it */ }
  }
  return out;
}

function credentialsMtime(): number {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    return fs.statSync(path.join(configDir, '.credentials.json')).mtimeMs;
  } catch {
    return 0; // e.g. macOS keychain storage — use the explicit retry command
  }
}

async function infraBackoffModels(slugs: string[]): Promise<string[]> {
  const models = new Set<string>();
  const now = virtualNow().toISOString();
  for (const slug of slugs) {
    for (const entry of Object.values((await load(slug)).capacity?.byModel ?? {})) {
      if (entry.wait.retryAt > now) models.add(entry.wait.model);
    }
  }
  return [...models].sort();
}

async function capacityProbe(model: string): Promise<boolean> {
  try {
    for await (const m of query({
      prompt: 'Reply with the single word: ok',
      options: {
        model,
        maxTurns: 1,
        allowedTools: [],
        persistSession: false,
        env: sdkEnv(),
      },
    })) {
      if (m.type === 'result') return m.subtype === 'success' && !m.is_error;
    }
  } catch { /* fall through */ }
  return false;
}

export async function expediteBackoffWakes(
  slugs: string[],
  log: (l: string) => void,
  recoveredModel?: string,
): Promise<void> {
  const now = virtualNow().toISOString();
  for (const slug of slugs) {
    try {
      const before = await load(slug);
      const hasMatchingWait = Object.values(before.capacity?.byModel ?? {}).some(
        (entry) => !recoveredModel || entry.wait.model === recoveredModel,
      );
      if (!hasMatchingWait) continue;
      await arrive(slug, (d, event) => {
        const wakeIds = d.wakes
          .filter((wake) =>
            wake.status === 'pending' &&
            wake.condition.type === 'time' &&
            wake.infrastructure &&
            (!recoveredModel || wake.infrastructure.model === recoveredModel))
          .map((wake) => wake.id);
        const recoveredModels = retryCapacityNow(d, now, recoveredModel);
        for (const wakeId of wakeIds) {
          event('wake.expedited', `${wakeId} pulled forward — credential-change probe confirmed provider recovery`, [wakeId]);
        }
        for (const item of d.attention) {
          if (item.status === 'open' && item.refId && wakeIds.includes(item.refId)) {
            item.status = 'resolved';
            item.resolvedAt = new Date().toISOString();
            item.resolvedBy = 'capacity-probe';
          }
        }
        for (const model of recoveredModels) {
          clearCapacityBackoff(d, model);
          resolveCapacityAttention(d, model, 'capacity-probe');
        }
      });
      log(`[run] ${slug}: infra-backoff wake expedited — provider recovered${recoveredModel ? ` for ${recoveredModel}` : ''}`);
    } catch { /* stream's own tick will retry on schedule */ }
  }
}

export interface RunnerOptions {
  intervalMs: number;
  concurrency: number;
  /** Stops the poll loop owned by an interactive dashboard on exit. In-flight
   * ticks remain crash-recoverable work; the loop itself must not pin Node. */
  signal?: AbortSignal;
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

function waitForNextIteration(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The poll loop. Headless runners omit `signal`; embedded dashboards own one. */
export async function runLoop(opts: RunnerOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => process.stdout.write(l + '\n'));
  const logError = opts.logError ?? ((l: string) => process.stderr.write(l + '\n'));
  const inFlight = new Set<string>();
  // Fairness: slots are granted least-recently-ticked first. A stable
  // (alphabetical) scan with a concurrency break starves every stream ranked
  // below the cap the moment enough earlier streams exist — sentry-sweep sat
  // 19h behind a due wake while ten alphabetically-earlier streams re-took
  // all ten slots every iteration.
  const lastTickedAt = new Map<string, number>();
  // Slot starvation guard: a tick that exceeds this is presumed hung (an SDK
  // call that never returned); its SLOT is reclaimed so the rest of the fleet
  // keeps moving. The stream's own tick lock still serializes it, and dead-pid
  // /stale-attempt recovery repairs whatever the hung call abandoned.
  const SLOT_TIMEOUT_MS = 45 * 60_000;
  let probing = false;
  let lastCredMtime = credentialsMtime();
  while (!opts.signal?.aborted) {
    try {
      try {
        fs.writeFileSync(heartbeatPath(), String(Date.now()));
      } catch { /* lock dir may be mid-recreate */ }
      // Auth recovery: one probe (never concurrently) when credential-file
      // metadata changes. Usage/rate recovery waits for the stored wake or an
      // explicit `weaver capacity retry`; blind probes only consume capacity.
      const backedOff = probing ? [] : await infraBackoffSlugs();
      if (backedOff.length) {
        const credMtime = credentialsMtime();
        const credChanged = credMtime !== lastCredMtime;
        if (credChanged) {
          lastCredMtime = credMtime;
          probing = true;
          const models = await infraBackoffModels(backedOff);
          log(`[run] credentials changed — probing ${models.join(', ')} for ${backedOff.length} stream(s) in infra-backoff`);
          void Promise.all(models.map(async (model) => ({ model, ok: await capacityProbe(model) })))
            .then(async (results) => {
              for (const result of results) {
                if (result.ok) await expediteBackoffWakes(backedOff, log, result.model);
              }
            })
            .finally(() => { probing = false; });
        }
      } else {
        lastCredMtime = credentialsMtime();
      }
      const due: string[] = [];
      for (const slug of await listWorkstreams()) {
        if (inFlight.has(slug)) continue;
        try {
          if ((await load(slug)).workstream.status === 'active') due.push(slug);
        } catch {
          /* unreadable stream — its own tick reports it */
        }
      }
      due.sort((a, b) => (lastTickedAt.get(a) ?? 0) - (lastTickedAt.get(b) ?? 0));
      for (const slug of due) {
        if (inFlight.size >= opts.concurrency) break;
        inFlight.add(slug);
        lastTickedAt.set(slug, Date.now());
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
    await waitForNextIteration(opts.intervalMs, opts.signal);
  }
}
