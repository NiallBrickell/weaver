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
import { coordinatorModel } from './coordinator.js';
import { tick } from './engine.js';
import { sdkEnv } from './secrets.js';
import { arrive, listWorkstreams, load, weaverHome } from './store.js';

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
 * Infra-backoff recovery. When passes fail on limits/credits/auth, streams
 * park behind 15-minute backoff wakes — but the outage usually ends the
 * moment the operator re-logs-in or buys credits, and nothing used to tell
 * the streams the world had changed (the operator watched a healed fleet sit
 * out its backoff). While any backoff wake is pending, the runner (a) watches
 * the credential file and probes IMMEDIATELY when it changes, and (b) probes
 * every few minutes regardless. A probe is one throwaway max-1-turn pass on
 * the coordinator model — the only true test, since limits are per-model. On
 * success every infra-backoff wake fleet-wide is expedited to now.
 */
const PROBE_EVERY_MS = 3 * 60_000;
const BACKOFF_WAKE_RE = /retry after infrastructure failure/;

async function infraBackoffSlugs(): Promise<string[]> {
  const out: string[] = [];
  for (const slug of await listWorkstreams()) {
    try {
      const d = await load(slug);
      if (d.workstream.status !== 'active') continue;
      if (d.wakes.some((w) => w.status === 'pending' && w.condition.type === 'time' && BACKOFF_WAKE_RE.test(w.reason))) {
        out.push(slug);
      }
    } catch { /* unreadable stream — its own tick reports it */ }
  }
  return out;
}

function credentialsMtime(): number {
  try {
    return fs.statSync(path.join(os.homedir(), '.claude', '.credentials.json')).mtimeMs;
  } catch {
    return 0; // e.g. macOS keychain storage — the periodic probe still covers recovery
  }
}

async function authProbe(): Promise<boolean> {
  try {
    for await (const m of query({
      prompt: 'Reply with the single word: ok',
      options: {
        model: coordinatorModel(),
        maxTurns: 1,
        allowedTools: [],
        persistSession: false,
        env: sdkEnv(),
      },
    })) {
      if (m.type === 'result') return m.subtype === 'success';
    }
  } catch { /* fall through */ }
  return false;
}

async function expediteBackoffWakes(slugs: string[], log: (l: string) => void): Promise<void> {
  const now = new Date().toISOString();
  for (const slug of slugs) {
    try {
      await arrive(slug, (d, event) => {
        for (const w of d.wakes) {
          if (w.status === 'pending' && w.condition.type === 'time' && BACKOFF_WAKE_RE.test(w.reason)) {
            w.condition = { type: 'time', dueAtVirtual: now };
            event('wake.expedited', `${w.id} pulled forward — auth/credit probe succeeded, the outage behind this backoff is over`, [w.id]);
          }
        }
      });
      log(`[run] ${slug}: infra-backoff wake expedited — credits/auth recovered`);
    } catch { /* stream's own tick will retry on schedule */ }
  }
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
  let lastProbeAt = 0;
  let probing = false;
  let lastCredMtime = credentialsMtime();
  for (;;) {
    try {
      try {
        fs.writeFileSync(heartbeatPath(), String(Date.now()));
      } catch { /* lock dir may be mid-recreate */ }
      // Outage recovery: probe (never concurrently) while streams are parked
      // behind infra-backoff wakes; a credential-file change probes at once.
      const backedOff = probing ? [] : await infraBackoffSlugs();
      if (backedOff.length) {
        const credMtime = credentialsMtime();
        const credChanged = credMtime !== lastCredMtime;
        if (credChanged || Date.now() - lastProbeAt >= PROBE_EVERY_MS) {
          lastCredMtime = credMtime;
          lastProbeAt = Date.now();
          probing = true;
          log(`[run] ${backedOff.length} stream(s) in infra-backoff — probing auth/credits${credChanged ? ' (credentials changed)' : ''}`);
          void authProbe()
            .then(async (ok) => { if (ok) await expediteBackoffWakes(backedOff, log); })
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
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
