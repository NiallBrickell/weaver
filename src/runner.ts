/**
 * The resident runner as a module, so `weaver run` (headless) and the watch
 * dashboard (embedded) share one implementation. Exactly one runner may be
 * live per WEAVER_HOME — a pid lockfile enforces it, so opening the dashboard
 * while a headless runner exists just attaches as a viewer.
 *
 * The runner holds no state: it polls active workstreams and ticks them
 * (concurrently), and every guarantee lives in the tick itself (per-stream
 * cross-process locks, rolling execution guard, readback discipline). Kill and
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
  capacityBackoffFor,
  clearCapacityBackoff,
  isClaudeSdkWait,
  resolveCapacityAttention,
  retryCapacityTargetNow,
} from './capacity.js';
import { readFleetCapacity, supersededByFleetRecovery } from './fleetCapacity.js';
import { coordinatorCapacityTarget, targetOfWait, type CapacityTarget } from './modelConfig.js';
import { acquireProcessLock, liveProcessLockPid } from './processLock.js';

function lockDir(): string {
  return path.join(weaverHome(), '.runner.lock');
}

/**
 * Runners used to write the loop heartbeat INSIDE the lock dir. A second file
 * there makes the lock snapshot malformed — fail-closed — so a dead runner's
 * lock could never be reclaimed until a human deleted it by hand. The
 * heartbeat carries no ownership, so clearing a legacy one is always safe: a
 * still-live old runner rewrites it on its next iteration.
 */
function clearLegacyHeartbeat(): void {
  try {
    fs.unlinkSync(path.join(lockDir(), 'heartbeat'));
  } catch { /* absent — the normal case */ }
}

/** The pid of a live runner, or null. Reclaims a dead holder's lock. */
export function liveRunnerPid(): number | null {
  clearLegacyHeartbeat();
  return liveProcessLockPid(lockDir());
}

/** Acquire the singleton runner lock; null when a live runner already holds it. */
export function acquireRunnerLock(): (() => void) | null {
  clearLegacyHeartbeat();
  const releaseLock = acquireProcessLock(lockDir());
  if (!releaseLock) return null;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    releaseLock();
  };
  process.once('exit', release);
  return release;
}

/**
 * Viewer→runner promotion for a standby dashboard. A `weaver watch` opened while
 * another runner held the lock is a pure viewer with no tick loop. When that
 * runner dies and frees the lock, SOMETHING must take over or the fleet silently
 * stops ticking while a live dashboard sits right there rendering a frozen view
 * (seen in production: a headless runner died at 14:02 and a `weaver watch`
 * opened before it kept viewing a dead fleet for 46 minutes — nothing ticked).
 * This polls the singleton lock and, the first time it acquires, hands the
 * release to `onPromote` and stops. Returns a stop() for the poller; the timer
 * is unref'd so a standby dashboard never pins the process on this alone.
 */
export function promoteOnRunnerVacancy(
  onPromote: (release: () => void) => void,
  intervalMs = 5_000,
): () => void {
  const timer = setInterval(() => {
    const release = acquireRunnerLock();
    if (!release) return;
    clearInterval(timer);
    onPromote(release);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
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
        (entry) => isClaudeSdkWait(entry.wait) && entry.wait.retryAt > now,
      )) {
        out.push(slug);
      }
    } catch { /* unreadable stream — its own tick reports it */ }
  }
  return out;
}

/**
 * Streams still parked on a target the fleet has since proved healthy, with
 * the targets to release them on. Recovery is an account-level fact — one
 * stream's successful call is proof for every stream parked on the same pool —
 * so a stream whose own retryAt sits further out must not go on waiting for a
 * limit that demonstrably ended. Comparing against the wait's DETECTION time
 * (not its retry time) is what makes the release safe: a limit recorded after
 * the recovery is a new one, and holds.
 */
export async function fleetRecoveredSlugs(): Promise<Map<string, CapacityTarget[]>> {
  const ledger = readFleetCapacity();
  const out = new Map<string, CapacityTarget[]>();
  if (!Object.keys(ledger.recovered).length) return out;
  const now = virtualNow().toISOString();
  for (const slug of await listWorkstreams()) {
    try {
      const d = await load(slug);
      if (d.workstream.status !== 'active') continue;
      const targets: CapacityTarget[] = [];
      for (const entry of Object.values(d.capacity?.byModel ?? {})) {
        if (entry.wait.retryAt <= now) continue; // already due — its own tick retries
        const target = targetOfWait(entry.wait);
        if (!target) continue; // ambiguous legacy wait: never guess a pool
        if (supersededByFleetRecovery(ledger, target, entry.wait.detectedAt)) targets.push(target);
      }
      if (targets.length) out.set(slug, targets);
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
      if (isClaudeSdkWait(entry.wait) && entry.wait.retryAt > now) models.add(entry.wait.model);
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
        tools: [],
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'dontAsk',
        settingSources: [],
        strictMcpConfig: true,
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
        (entry) => isClaudeSdkWait(entry.wait) && (!recoveredModel || entry.wait.model === recoveredModel),
      );
      if (!hasMatchingWait) continue;
      await arrive(slug, (d, event) => {
        const wakeIds = d.wakes
          .filter((wake) =>
            wake.status === 'pending' &&
            wake.condition.type === 'time' &&
            wake.infrastructure &&
            isClaudeSdkWait(wake.infrastructure) &&
            (!recoveredModel || wake.infrastructure.model === recoveredModel))
          .map((wake) => wake.id);
        const recoveredModels = [...new Set(
          Object.values(d.capacity?.byModel ?? {})
            .map((entry) => entry.wait)
            .filter((wait) => isClaudeSdkWait(wait) && (!recoveredModel || wait.model === recoveredModel))
            .map((wait) => wait.model),
        )];
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
          const target: CapacityTarget = coordinatorCapacityTarget(model);
          retryCapacityTargetNow(d, now, target);
          clearCapacityBackoff(d, target);
          resolveCapacityAttention(d, target, 'capacity-probe');
        }
      });
      log(`[run] ${slug}: infra-backoff wake expedited — provider recovered${recoveredModel ? ` for ${recoveredModel}` : ''}`);
    } catch { /* stream's own tick will retry on schedule */ }
  }
}

/**
 * Release parks the fleet has already disproved. Unlike the credential probe,
 * nothing is spent here: another stream's successful call is the evidence, and
 * the targets are known exactly rather than derived from a model name, so a
 * worker pool and a coordinator pool on the same model never release each
 * other. Making the waits due (rather than deleting them) keeps the recovery
 * honest — the next real attempt is still what proves the pool, and a fresh
 * rejection simply records a new, later wait.
 */
export async function releaseFleetRecovered(
  recovered: Map<string, CapacityTarget[]>,
  log: (l: string) => void,
): Promise<void> {
  const now = virtualNow().toISOString();
  for (const [slug, targets] of recovered) {
    try {
      await arrive(slug, (d, event) => {
        const released: string[] = [];
        for (const target of targets) {
          if (!capacityBackoffFor(d, target)) continue; // cleared since the scan
          retryCapacityTargetNow(d, now, target);
          clearCapacityBackoff(d, target);
          resolveCapacityAttention(d, target, 'fleet-capacity');
          released.push(target.model);
        }
        if (released.length) {
          event(
            'capacity.fleet_recovered',
            `park released for ${[...new Set(released)].sort().join(', ')} — another workstream's call proved the pool recovered`,
            [],
          );
        }
      });
      log(`[run] ${slug}: park released — fleet proved ${targets.map((t) => t.model).join(', ')} recovered`);
    } catch (e) {
      // Never silent: a release that fails leaves the stream parked behind a
      // limit the fleet has disproved, and the whole point of this sweep is
      // that nobody has to notice that by hand. The stored wait still stands,
      // so its own timer remains the backstop.
      log(`[run] ${slug}: park release FAILED (${e instanceof Error ? e.message : e}) — stream stays on its own retry timer`);
    }
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
  /** System-load sampler for load-aware slot throttling; injectable for tests.
   * Defaults to the OS 1-minute load average and logical core count. */
  loadSample?: () => { load1: number; cores: number };
}

/**
 * Load-aware slot cap. Each granted slot spawns a worker/coordinator SDK
 * subprocess of a few hundred MB, and the runner shares the machine with the
 * operator's editor, simulators, Docker, and other agent sessions. When the
 * 1-minute load already exceeds the core count the box is saturated (often
 * swapping), and fanning out the full width tips it further — on a thrashing
 * machine that makes EVERY tick slower, not faster. Scale the cap down as load
 * climbs past the cores, but never below 1: the fleet must always make some
 * progress. At or below capacity, run at the configured width. This is the
 * same "wait for headroom before doing expensive work" discipline the repo's
 * heavy-command lock applies machine-wide.
 */
export function effectiveConcurrency(configured: number, load1: number, cores: number): number {
  if (!Number.isFinite(load1) || load1 <= 0 || cores <= 0) return configured;
  if (load1 <= cores) return configured;
  const scaled = Math.floor((configured * cores) / load1);
  return Math.max(1, Math.min(configured, scaled));
}

function heartbeatPath(): string {
  // BESIDE the lock dir, never inside it: the process lock treats any second
  // file in its dir as a malformed lock and fails closed (see processLock.ts).
  return path.join(weaverHome(), '.runner.heartbeat');
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
  const loadSample = opts.loadSample ?? (() => ({ load1: os.loadavg()[0]!, cores: os.cpus().length }));
  // Last announced slot cap, so a throttle/recovery is logged on transition
  // only — never silently, and never once per iteration.
  let lastCap = opts.concurrency;
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
      // Free recovery first: any stream still parked on a pool another stream
      // has since used successfully is released without spending a call.
      const fleetRecovered = await fleetRecoveredSlugs();
      if (fleetRecovered.size) await releaseFleetRecovered(fleetRecovered, log);
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
      // Load-aware cap: when the machine is oversubscribed, grant fewer slots
      // this iteration (in-flight ticks finish; none are added past the cap).
      const { load1, cores } = loadSample();
      const cap = effectiveConcurrency(opts.concurrency, load1, cores);
      if (cap !== lastCap) {
        log(cap < opts.concurrency
          ? `[run] load ${load1.toFixed(1)} on ${cores} cores — throttling parallel ticks ${opts.concurrency}→${cap}`
          : `[run] load eased (${load1.toFixed(1)} on ${cores} cores) — parallel ticks back to ${cap}`);
        lastCap = cap;
      }
      for (const slug of due) {
        if (inFlight.size >= cap) break;
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
