/**
 * The resident runner as a module, so `weaver run` (headless) and the watch
 * dashboard (embedded) share one implementation. Exactly one runner may be
 * live per WEAVER_HOME — a pid lockfile enforces it, so opening the dashboard
 * while a headless runner exists just attaches as a viewer.
 *
 * The runner holds no durable truth: it polls active workstreams and ticks
 * them (concurrently), and every guarantee lives in the tick itself
 * (per-stream cross-process locks, rolling execution guard, readback
 * discipline). Its revision-keyed document cache is disposable and validated
 * against current store heads before every logical scan. Kill and restart
 * freely.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tick } from './engine.js';
import { coordinatorRunnerEligibility } from './coordinatorRunner.js';
import { isLegacyDollarBudgetAttention, isWakeDue } from './executionSafety.js';
import { sweepPrConflicts } from './prConflicts.js';
import { sdkEnv } from './secrets.js';
import {
  arrive,
  heartbeatRunner,
  listRunnerPresence,
  listWorkstreamHeads,
  load,
  weaverHome,
  type RunnerPresence,
  type WorkstreamHead,
} from './store.js';
import { virtualNow } from './clock.js';
import {
  capacityBackoffFor,
  clearCapacityBackoff,
  isClaudeSdkWait,
  resolveCapacityAttention,
  retryCapacityTargetNow,
} from './capacity.js';
import { readFleetCapacity, supersededByFleetRecovery } from './fleetCapacity.js';
import { targetOfWait, type CapacityTarget } from './modelConfig.js';
import { runnerExecutorCapabilities } from './modelRouting.js';
import { acquireProcessLock, liveProcessLockPid, pidIsLive } from './processLock.js';
import { runnerClaimIdentity, type RunnerClaimIdentity } from './runnerIdentity.js';
import type { WorkstreamDoc } from './types.js';

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
 * Disposable runner-local document cache. A scan never trusts elapsed time or
 * a prior read: it first asks durable state for every current `(slug,
 * revision)` head, then reuses a body only while that exact revision stands.
 * Changed heads are reloaded, absent heads are evicted, and a failed changed
 * read removes the stale body. A concurrent arrival may make load() return a
 * document newer than the head just read; keeping the document's own revision
 * is safe because the next scan validates it against a fresh head list.
 */
export class RunnerWorkstreamCache {
  private cached = new Map<string, WorkstreamDoc>();

  constructor(
    private readonly listHeads: () => Promise<WorkstreamHead[]> = listWorkstreamHeads,
    private readonly loadDoc: (slug: string) => Promise<WorkstreamDoc> = load,
  ) {}

  async scan(): Promise<ReadonlyMap<string, WorkstreamDoc>> {
    const heads = await this.listHeads();
    const next = new Map<string, WorkstreamDoc>();
    for (const head of heads) {
      const cached = this.cached.get(head.slug);
      if (cached?.revision === head.revision) {
        next.set(head.slug, cached);
        continue;
      }
      try {
        const doc = await this.loadDoc(head.slug);
        if (doc.workstream.slug !== head.slug || !Number.isInteger(doc.revision) || doc.revision < head.revision) continue;
        next.set(head.slug, doc);
      } catch {
        // Deleted between head read and load, or currently unreadable. Never
        // retain an old body merely because its replacement could not load.
      }
    }
    this.cached = next;
    return new Map(next);
  }
}

/** Manager notices are cross-document durable facts. Derive the exact missing
 * dedup keys from the same cached fleet snapshot so concluded children can be
 * repaired without polling them forever after delivery. */
export function pendingManagerNoticeKeys(
  doc: WorkstreamDoc,
  managerDoc: WorkstreamDoc | undefined,
): string[] {
  if (!doc.workstream.managedBy || !managerDoc) return [];
  const existing = new Set((managerDoc.managerNotices ?? []).map((notice) => notice.dedupKey));
  const candidates: string[] = [];
  if (doc.workstream.conclusion) candidates.push(`finished:${doc.workstream.conclusion.passId}`);
  for (const attention of doc.attention) {
    if (
      attention.status === 'open' &&
      !isLegacyDollarBudgetAttention(attention) &&
      (attention.kind === 'blocker' || attention.kind === 'budget')
    ) {
      candidates.push(`attention:${attention.id}`);
    }
  }
  return candidates.filter((key) => !existing.has(key)).sort();
}

/**
 * The durable facts which can make an unchanged workstream tickable.
 *
 * A document revision is the ordinary event signal. Time is the one planned
 * exception: a stored wake or recovery lease can become due without a write.
 * Runner failover is another stored seam outside the document, so the exact
 * coordinator eligibility result joins the signature only while wakes are
 * due. A running attempt whose owner later dies or crosses its recovery
 * horizon is included for the same reason.
 *
 * Everything here is derived from typed state plus explicit clocks/liveness;
 * no transcript or generated summary participates in scheduling.
 */
export function runnerDispatchSignature(
  doc: WorkstreamDoc,
  runner: RunnerClaimIdentity,
  presences: readonly RunnerPresence[],
  wallNow = new Date(),
  virtual = virtualNow(),
  managerDoc?: WorkstreamDoc,
): string {
  const dueWakeIds = doc.wakes
    .filter((wake) => wake.status === 'pending' && isWakeDue(wake.condition, wallNow, virtual))
    .map((wake) => wake.id)
    .sort();
  const leaseExpired = doc.lease && Date.parse(doc.lease.expiresAt) <= wallNow.getTime()
    ? doc.lease.passId
    : null;
  const staleMs = Number(process.env.WEAVER_ATTEMPT_STALE_MS ?? 45 * 60_000);
  const recoverableAttempts = doc.assignments
    .filter((assignment) => assignment.state === 'running')
    .flatMap((assignment) => {
      const attempt = assignment.attempts.at(-1);
      if (!attempt || attempt.endedAt) return [];
      if (attempt.runnerId !== undefined && attempt.runnerId !== runner.id) return [];
      const driverDead = !!attempt.runnerPid &&
        attempt.runnerPid !== process.pid &&
        !pidIsLive(attempt.runnerPid);
      const ageMs = wallNow.getTime() - Date.parse(attempt.startedAt);
      return driverDead || ageMs >= staleMs ? [attempt.runId] : [];
    })
    .sort();
  const duePilotRetryIds = doc.assignments
    .filter((assignment) =>
      assignment.kind === 'action' &&
      assignment.state === 'gated' &&
      assignment.exec?.approvalMode !== 'human-only' &&
      !assignment.exec?.approval &&
      !assignment.exec?.pilotVerdict &&
      !!assignment.exec?.pilotRetryAt &&
      assignment.exec.pilotRetryAt <= wallNow.toISOString())
    .map((assignment) => assignment.id)
    .sort();
  const coordinatorEligibility = dueWakeIds.length
    ? coordinatorRunnerEligibility(doc, runner.id, presences, wallNow.getTime())
    : null;
  return JSON.stringify({
    revision: doc.revision,
    dueWakeIds,
    leaseExpired,
    recoverableAttempts,
    duePilotRetryIds,
    managerNoticeKeys: pendingManagerNoticeKeys(doc, managerDoc),
    coordinatorRunner: coordinatorEligibility?.eligible
      ? 'eligible'
      : coordinatorEligibility?.preferredLiveRunner ?? coordinatorEligibility?.reason ?? null,
  });
}

/** Disposable acknowledgement of scheduling observations. A runner restart
 * intentionally forgets it and gives every active stream one recovery tick. */
export class RunnerDispatchTracker {
  private dispatched = new Map<string, string>();

  shouldDispatch(slug: string, signature: string): boolean {
    return this.dispatched.get(slug) !== signature;
  }

  markDispatched(slug: string, signature: string): void {
    this.dispatched.set(slug, signature);
  }

  forget(slug: string): void {
    this.dispatched.delete(slug);
  }

  retain(slugs: ReadonlySet<string>): void {
    for (const slug of this.dispatched.keys()) {
      if (!slugs.has(slug)) this.dispatched.delete(slug);
    }
  }
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
export async function infraBackoffSlugs(cache = new RunnerWorkstreamCache()): Promise<string[]> {
  const out: string[] = [];
  const now = virtualNow().toISOString();
  for (const [slug, d] of await cache.scan()) {
    if (d.workstream.status !== 'active') continue;
    if (Object.values(d.capacity?.byModel ?? {}).some(
      (entry) => isClaudeSdkWait(entry.wait) && entry.wait.retryAt > now,
    )) {
      out.push(slug);
    }
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
export async function fleetRecoveredSlugs(cache = new RunnerWorkstreamCache()): Promise<Map<string, CapacityTarget[]>> {
  const ledger = readFleetCapacity();
  const out = new Map<string, CapacityTarget[]>();
  if (!Object.keys(ledger.recovered).length) return out;
  const now = virtualNow().toISOString();
  for (const [slug, d] of await cache.scan()) {
    if (d.workstream.status !== 'active') continue;
    const targets: CapacityTarget[] = [];
    for (const entry of Object.values(d.capacity?.byModel ?? {})) {
      if (entry.wait.retryAt <= now) continue; // already due — its own tick retries
      const target = targetOfWait(entry.wait);
      if (!target) continue; // ambiguous legacy wait: never guess a pool
      if (supersededByFleetRecovery(ledger, target, entry.wait.detectedAt)) targets.push(target);
    }
    if (targets.length) out.set(slug, targets);
  }
  return out;
}

/**
 * Slot ordering. Priority decides WHICH streams get scarce slots; within one
 * priority the old least-recently-ticked fairness still decides the order, so
 * raising one stream never starves its peers — it moves the whole band ahead
 * of the bands below it. A stream with no priority set sits in 'normal', which
 * is what every stream was before this existed.
 */
export function priorityRank(priority: 'high' | 'normal' | 'low' | undefined): number {
  return priority === 'high' ? 0 : priority === 'low' ? 2 : 1;
}

export function byPriorityThenFairness(
  priority: ReadonlyMap<string, number>,
  lastTickedAt: ReadonlyMap<string, number>,
): (a: string, b: string) => number {
  return (a, b) =>
    (priority.get(a) ?? 1) - (priority.get(b) ?? 1) ||
    (lastTickedAt.get(a) ?? 0) - (lastTickedAt.get(b) ?? 0);
}

/**
 * Which of the ordered due streams actually get slots this iteration.
 *
 * Ordering alone decides who is FIRST in the queue, and the runner then filled
 * every remaining slot from that same queue — so with twenty active streams
 * and ten slots a high stream took one and nine backstop polls took the rest.
 * Every one of those slots is an SDK subprocess of a few hundred MB, so the
 * urgent stream then did its multi-step work on a machine nine other ticks
 * were competing for, which is the crawl priority was raised to prevent. A
 * live client stream hit exactly that, and the only remedy to hand was pausing
 * nineteen streams one by one — blunt, because it also stops legitimate
 * background work, and somebody then has to remember to undo it.
 *
 * So a due high band RESERVES the budget rather than merely leading the queue:
 * the high band may take everything except a floor, and that floor is what the
 * rest of the fleet shares. Slots the high band has no due streams for are
 * deliberately left ungranted — keeping the machine free is the whole point,
 * and a stream with nothing to do would only hand its slot back seconds later.
 * The floor is never zero, so a long-running high band cannot freeze the fleet
 * behind it: 'low' keeps moving, more slowly, and the partition lifts entirely
 * the moment no high stream is due, which is the behaviour every fleet without
 * a ranked stream has always had.
 *
 * Expects `due` already ordered by `byPriorityThenFairness` and preserves that
 * order within each band, so least-recently-ticked still decides who goes.
 *
 * STARVATION FLOOR ACROSS BANDS: priority-first ordering means a saturated
 * higher band starves everything below it — with twenty due streams, ten (or
 * load-throttled fewer) slots, and eleven 'normal' streams busy all evening,
 * the 'low' band never got a slot at all, and the streams parked there were
 * the standing routines (sentry-sweep, the daily update, thread-review): a
 * crashed action sat unrecovered for hours with zero telemetry because its
 * stream was simply never ticked. So whenever the queue overflows the cap,
 * the last max(1, cap/4) slots are granted purely least-recently-ticked
 * across every band (`fairnessDue`), making starvation impossible: any due
 * stream, whatever its rank, eventually becomes the oldest and rotates
 * through the floor. Priority still owns the rest of the budget.
 */
export function allocateSlots(
  due: readonly string[],
  priority: ReadonlyMap<string, number>,
  cap: number,
  fairnessDue: readonly string[] = due,
): string[] {
  if (cap <= 0) return [];
  const withFairnessFloor = (head: readonly string[], budget: number): string[] => {
    if (due.length <= budget) return due.slice(0, budget);
    const floor = Math.max(1, Math.floor(budget / 4));
    const granted = head.slice(0, Math.max(1, budget - floor));
    const taken = new Set(granted);
    const rotation = fairnessDue.filter((slug) => !taken.has(slug));
    return granted.concat(rotation.slice(0, budget - granted.length));
  };
  const isHigh = (slug: string) => (priority.get(slug) ?? priorityRank('normal')) === priorityRank('high');
  const highDue = due.filter(isHigh);
  if (!highDue.length) return withFairnessFloor(due, cap);
  // A quarter of the budget, at least one slot: enough for the rest of the
  // fleet to keep rotating its backstop polls (they are granted
  // least-recently-ticked, so the floor rotates rather than favouring anyone)
  // without putting the machine back under the load the reservation exists to
  // lift.
  const fleetFloor = Math.max(1, Math.floor(cap / 4));
  // At a cap of one there is nothing to partition, and the ranking is what a
  // human asking for high priority meant by it — so the high band is never
  // reserved down to nothing either.
  const highGranted = highDue.slice(0, Math.max(1, cap - fleetFloor));
  const taken = new Set(highGranted);
  // The fleet floor rotates least-recently-ticked across the non-high bands
  // (an ungranted HIGH stream never eats the floor — the floor exists for the
  // rest of the fleet), so 'normal' saturation cannot starve 'low' either.
  const rotation = fairnessDue.filter((slug) => !taken.has(slug) && !isHigh(slug));
  return highGranted.concat(rotation.slice(0, Math.min(fleetFloor, cap - highGranted.length)));
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
          // Credential probing is Claude-only, so retain the exact local SDK
          // identity instead of rebuilding a target through whatever
          // coordinator executor happens to be configured now.
          const target: CapacityTarget = {
            executor: 'local-sdk',
            provider: 'anthropic',
            model,
          };
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
  /** Exact substrates this process may claim. Defaults to the configured
   * seats; heterogeneous hosts opt into additional executors explicitly. */
  executorCapabilities?: ReadonlySet<string>;
  /** Tick implementation; injectable only for deterministic runner tests. */
  tickFn?: typeof tick;
  /** Source-revision probe; injectable only for deterministic runner tests. */
  sourceStale?: () => boolean;
  /** How long the loop waits for in-flight ticks after polling stops (owner
   * abort or source replacement) before giving up. An abandoned tick can hold
   * a mid-push ACTION whose orphan costs a human a manual provider
   * reconciliation (three in one day when restarts killed the runner
   * mid-action), so exit waits for the short ones. Default 3 minutes: covers
   * action executions and coordinator passes while never pinning a restart
   * behind a 40-minute worker wall. */
  drainMs?: number;
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

/**
 * The commit this process's code was loaded from.
 *
 * The runner executes the checkout's source through tsx, so its behaviour is
 * frozen at the moment it started: merging a Weaver fix changes nothing until
 * somebody restarts it. That is invisible from the dashboard — a runner
 * happily ticking on last hour's code looks exactly like a healthy one — and
 * the cost lands on whoever owns the terminal, who has to be told. Three
 * separate fixes tonight were merged, verified, and then re-raised by the
 * running process because it had never reloaded them.
 *
 * Cheap enough to poll: one `git rev-parse HEAD` against the repo the module
 * was loaded from, not the cwd, so a runner started from anywhere reports its
 * own code. Returns null where git cannot answer, which reads as "unknown"
 * and never as "stale".
 */
export function runnerSourceRevision(): string | null {
  try {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** The revision this process started on — captured once, at module load. */
const startedAtRevision = runnerSourceRevision();

/**
 * True when the checkout has moved since this process loaded its code, so what
 * is running is not what is committed. The dashboard says so out loud rather
 * than leaving a stale runner looking healthy.
 */
export function runnerSourceStale(): boolean {
  const current = runnerSourceRevision();
  return current !== null && startedAtRevision !== null && current !== startedAtRevision;
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
  const executorCapabilities = opts.executorCapabilities ?? runnerExecutorCapabilities();
  const tickFn = opts.tickFn ?? tick;
  const sourceStale = opts.sourceStale ?? runnerSourceStale;
  const runner = runnerClaimIdentity();
  const workstreams = new RunnerWorkstreamCache();
  const dispatches = new RunnerDispatchTracker();
  if (runner.placementOnly) {
    throw new Error('WEAVER_RUNNER_PLACEMENT_ONLY=1 is only for bounded `weaver tick <slug> --engine-only` invocations, not a resident runner');
  }
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
  // Open-PR conflict watch throttle (see prConflicts.ts). Runner memory only.
  const prConflictProbedAt = new Map<string, number>();
  let prConflictSweepInFlight = false;
  let probing = false;
  let lastCredMtime = credentialsMtime();
  while (!opts.signal?.aborted) {
    if (sourceStale()) {
      logError('[run] Weaver source changed since startup — stopping before further dispatch; restart Weaver');
      // Start nothing else and leave polling now. In-flight ticks already own
      // crash-recoverable work, and the shared bounded drain below is the one
      // exit contract — waiting for them here would make source-stale restarts
      // unbounded.
      break;
    }
    try {
      // Shared TTL presence is separate from Workstream truth and from the
      // machine-local pid heartbeat. Publish before scanning so a preferred
      // coordinator host is visible before any standby considers a claim.
      await heartbeatRunner(runner.id);
      try {
        fs.writeFileSync(heartbeatPath(), String(Date.now()));
      } catch { /* lock dir may be mid-recreate */ }
      // Auth recovery: one probe (never concurrently) when credential-file
      // metadata changes. Usage/rate recovery waits for the stored wake or an
      // explicit `weaver capacity retry`; blind probes only consume capacity.
      // Free recovery first: any stream still parked on a pool another stream
      // has since used successfully is released without spending a call.
      const fleetRecovered = await fleetRecoveredSlugs(workstreams);
      if (fleetRecovered.size) await releaseFleetRecovered(fleetRecovered, log);
      // Open-PR conflict watch: probes are gh calls, so they run off the loop
      // (never blocking an iteration) and at most one sweep is in flight.
      if (!prConflictSweepInFlight) {
        prConflictSweepInFlight = true;
        void sweepPrConflicts(prConflictProbedAt, log)
          .catch((e) => logError(`[run] PR conflict sweep failed: ${e instanceof Error ? e.message : e}`))
          .finally(() => { prConflictSweepInFlight = false; });
      }
      const backedOff = probing ? [] : await infraBackoffSlugs(workstreams);
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
      const priority = new Map<string, number>();
      const dispatchSignatures = new Map<string, string>();
      const docs = await workstreams.scan();
      dispatches.retain(new Set(docs.keys()));
      const presences = await listRunnerPresence();
      const wallNow = new Date();
      const virtual = virtualNow();
      for (const [slug, doc] of docs) {
        if (inFlight.has(slug)) continue;
        const ws = doc.workstream;
        const managerDoc = ws.managedBy ? docs.get(ws.managedBy.slug) : undefined;
        const missingManagerNotices = pendingManagerNoticeKeys(doc, managerDoc);
        if (ws.status !== 'active' && !(ws.status === 'done' && missingManagerNotices.length)) continue;
        const signature = runnerDispatchSignature(doc, runner, presences, wallNow, virtual, managerDoc);
        if (!dispatches.shouldDispatch(slug, signature)) continue;
        due.push(slug);
        dispatchSignatures.set(slug, signature);
        priority.set(slug, priorityRank(ws.priority));
      }
      due.sort(byPriorityThenFairness(priority, lastTickedAt));
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
      // Slots are granted from the allocation, not from the raw queue: when a
      // high stream is due, most of the budget is held for its band instead of
      // being filled first-come. The partition applies to what THIS iteration
      // grants; ticks still running from earlier ones keep occupying the
      // budget, and the break below remains what bounds the total.
      const fairnessDue = [...due].sort(
        (a, b) => (lastTickedAt.get(a) ?? 0) - (lastTickedAt.get(b) ?? 0),
      );
      for (const slug of allocateSlots(due, priority, cap, fairnessDue)) {
        if (inFlight.size >= cap) break;
        const dispatchSignature = dispatchSignatures.get(slug)!;
        inFlight.add(slug);
        lastTickedAt.set(slug, Date.now());
        // A concurrency slot belongs to the tick until that exact promise
        // settles. The worker and coordinator own abortable, sleep-aware walls
        // around the SDK calls that can hang; a second coarse timer here cannot
        // stop the underlying tick. Reclaiming only the Set entry used to make
        // accounting lie, allowing another tick to exceed the configured cap
        // while the first process and its cross-process lock were still live.
        void tickFn(slug, { executorCapabilities })
          .then((report) => {
            if (report.skipped === 'another process is ticking this workstream') {
              // A competing tick has not yet proved this observed revision
              // quiescent. Retry after its shared lock is released.
              dispatches.forget(slug);
            } else {
              dispatches.markDispatched(slug, dispatchSignature);
            }
            if (report.workersRun.length || report.passes.length || report.sendsExecuted || report.unknownsResolved) {
              log(
                `[${new Date().toTimeString().slice(0, 8)}] ${slug}: workers=[${report.workersRun.join(',')}] passes=${report.passes.length} sends=${report.sendsExecuted}`,
              );
            }
          })
          .catch((e) => {
            // A transport/tooling failure did not prove this durable position
            // quiescent. Forget the observation so the next loop retries it.
            dispatches.forget(slug);
            logError(`[run] ${slug}: ${e instanceof Error ? e.message : e}`);
          })
          .finally(() => {
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
  // Drain: the loop was told to stop or its loaded source was replaced, but
  // in-flight ticks may hold live external acts. Give the short-lived ones a
  // bounded window to settle so a routine restart stops orphaning mid-push
  // actions.
  if (inFlight.size) {
    log(`[run] stopping — draining ${inFlight.size} in-flight tick(s) (${[...inFlight].join(', ')})`);
    const deadline = Date.now() + (opts.drainMs ?? 180_000);
    while (inFlight.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (inFlight.size) {
      logError(`[run] drain window elapsed — exiting with ${inFlight.size} tick(s) still in flight: ${[...inFlight].join(', ')} (crash recovery reconciles their attempts)`);
    } else {
      log('[run] drained cleanly');
    }
  }
}
