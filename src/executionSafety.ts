/**
 * Durable runaway protection without pretending SDK estimates are money.
 *
 * The old budget accumulated estimated dollars and coordinator passes for the
 * entire Workstream lifetime. Every healthy routine therefore had a scheduled
 * death: eventually it hit the cap and needed a human "top-up". The guard here
 * measures STARTS in a rolling wall-clock window from typed pass/attempt
 * records. Hitting it stores a typed physical-time wake and resumes automatically.
 */

import { arrive, load, newId } from './store.js';
import type { WorkstreamCore, WorkstreamDoc } from './types.js';

export interface ExecutionSafetyConfig {
  windowSeconds: number;
  maxModelStarts: number;
}

export const DEFAULT_EXECUTION_SAFETY: Readonly<ExecutionSafetyConfig> = Object.freeze({
  windowSeconds: 60 * 60,
  maxModelStarts: 30,
});

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function configuredPositiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Existing documents without executionSafety keep loading; their historical
 * lifetime dollar/pass fields deliberately carry no policy into this guard. */
export function executionSafetyConfig(core: WorkstreamCore): ExecutionSafetyConfig {
  const stored = core.executionSafety;
  return {
    windowSeconds: positiveInt(stored?.windowSeconds, DEFAULT_EXECUTION_SAFETY.windowSeconds),
    maxModelStarts: positiveInt(stored?.maxModelStarts, DEFAULT_EXECUTION_SAFETY.maxModelStarts),
  };
}

export function newExecutionSafety(overrides: Partial<ExecutionSafetyConfig> = {}): ExecutionSafetyConfig {
  return {
    windowSeconds: configuredPositiveInt(
      overrides.windowSeconds,
      DEFAULT_EXECUTION_SAFETY.windowSeconds,
      'execution safety windowSeconds',
    ),
    maxModelStarts: configuredPositiveInt(
      overrides.maxModelStarts,
      DEFAULT_EXECUTION_SAFETY.maxModelStarts,
      'execution safety maxModelStarts',
    ),
  };
}

export interface ExecutionPosition {
  count: number;
  limit: number;
  windowSeconds: number;
  blocked: boolean;
  /** Wall-clock boundary at which enough old starts have left the window. */
  retryAt: string | null;
}

function starts(doc: WorkstreamDoc): number[] {
  const values = [
    ...doc.passes.map((pass) => pass.startedAt),
    ...doc.assignments.flatMap((assignment) => assignment.attempts
      // Engine actions are deterministic commands, not model executions.
      // A missing legacy model value was a model-backed worker and counts.
      .filter((attempt) => attempt.model !== 'engine')
      .map((attempt) => attempt.startedAt)),
  ];
  return values
    .map((iso) => Date.parse(iso))
    .filter((value) => Number.isFinite(value));
}

/** Pure over typed state + an explicit wall clock, so the rolling contract is
 * deterministic in tests and independent of narrative events/transcripts. */
export function executionPosition(
  doc: WorkstreamDoc,
  wallNow = new Date(),
): ExecutionPosition {
  const safety = executionSafetyConfig(doc.workstream);
  const windowMs = safety.windowSeconds * 1_000;
  const nowMs = wallNow.getTime();
  const recent = starts(doc)
    .filter((startedAt) => startedAt <= nowMs && startedAt > nowMs - windowMs)
    .sort((a, b) => a - b);
  const limit = safety.maxModelStarts;
  const blocked = recent.length >= limit;
  // If a lowered limit finds us already above it, enough oldest starts must
  // expire to bring the count strictly below the ceiling before one more runs.
  const expiryIndex = blocked ? recent.length - limit : -1;
  const retryAtMs = expiryIndex >= 0 ? recent[expiryIndex]! + windowMs : null;
  return {
    count: recent.length,
    limit,
    windowSeconds: safety.windowSeconds,
    blocked,
    retryAt: retryAtMs === null ? null : new Date(retryAtMs).toISOString(),
  };
}

export class ExecutionSafetyLimitedError extends Error {
  constructor(readonly position: ExecutionPosition) {
    super(`execution safety pause: ${position.count}/${position.limit} model starts in ${position.windowSeconds}s`);
  }
}

/** Called inside the same revision-checked mutation that records a start. */
export function assertExecutionStartAllowed(doc: WorkstreamDoc, wallNow = new Date()): void {
  const position = executionPosition(doc, wallNow);
  if (position.blocked) throw new ExecutionSafetyLimitedError(position);
}

export function isWakeDue(
  condition: WorkstreamDoc['wakes'][number]['condition'],
  wallNow = new Date(),
  virtualNow = wallNow,
): boolean {
  if (condition.type === 'immediate') return true;
  return condition.type === 'wall_time'
    ? condition.dueAt <= wallNow.toISOString()
    : condition.dueAtVirtual <= virtualNow.toISOString();
}

/** If limited, persist exactly one typed physical-time wake. No
 * attention item is raised: time, not human judgment, is the unblock signal. */
export async function parkIfExecutionLimited(
  slug: string,
  wallNow = new Date(),
): Promise<ExecutionPosition | null> {
  const before = await load(slug);
  const position = executionPosition(before, wallNow);
  if (!position.blocked || !position.retryAt) return null;
  const alreadyParked = before.wakes.some(
    (wake) => wake.status === 'pending' && wake.executionSafety !== undefined,
  );
  if (alreadyParked) {
    const wake = before.wakes.find((item) => item.status === 'pending' && item.executionSafety);
    if (wake?.executionSafety?.blockedUntil === position.retryAt) return position;
  }
  await arrive(slug, (doc, event) => {
    // Re-derive inside the serialized arrival. A concurrent start may have
    // changed the count/retry boundary between the read above and this write.
    const current = executionPosition(doc, wallNow);
    if (!current.blocked || !current.retryAt) return;
    const existing = doc.wakes.find((wake) => wake.status === 'pending' && wake.executionSafety);
    if (existing) {
      if (existing.executionSafety!.blockedUntil === current.retryAt) return;
      existing.condition = { type: 'wall_time', dueAt: current.retryAt };
      existing.executionSafety = {
        blockedUntil: current.retryAt,
        observedStarts: current.count,
        limit: current.limit,
        windowSeconds: current.windowSeconds,
      };
      existing.reason = `execution safety pause: ${current.count} model starts in the last ${Math.round(current.windowSeconds / 60)}m (limit ${current.limit}); resumes automatically when the rolling window reopens`;
      event('execution_safety.updated', `model starts ${current.count}/${current.limit}; existing wake ${existing.id} moved to ${current.retryAt}`, [existing.id]);
      return;
    }
    const id = newId('wake');
    doc.wakes.push({
      id,
      reason: `execution safety pause: ${current.count} model starts in the last ${Math.round(current.windowSeconds / 60)}m (limit ${current.limit}); resumes automatically when the rolling window reopens`,
      condition: { type: 'wall_time', dueAt: current.retryAt },
      status: 'pending',
      createdAt: new Date().toISOString(),
      executionSafety: {
        blockedUntil: current.retryAt,
        observedStarts: current.count,
        limit: current.limit,
        windowSeconds: current.windowSeconds,
      },
    });
    event('execution_safety.parked', `model starts ${current.count}/${current.limit} in ${current.windowSeconds}s; ${id} resumes automatically at ${current.retryAt}`, [id]);
  });
  return position;
}

export function isLegacyDollarBudgetAttention(item: WorkstreamDoc['attention'][number]): boolean {
  return item.kind === 'budget' && item.summary.startsWith('Budget exhausted ($');
}

/** Retire only cards emitted by the removed dollar gate. Other historical
 * kind=budget questions remain human decisions and are not silently closed. */
export async function retireLegacyDollarBudgetCard(slug: string): Promise<boolean> {
  const before = await load(slug);
  const stale = before.attention.filter(
    (item) => item.status === 'open' && isLegacyDollarBudgetAttention(item),
  );
  if (!stale.length) return false;
  await arrive(slug, (doc, event) => {
    let retired = 0;
    for (const item of doc.attention) {
      if (item.status !== 'open' || !isLegacyDollarBudgetAttention(item)) continue;
      item.status = 'resolved';
      item.resolvedAt = new Date().toISOString();
      item.resolvedBy = 'execution-safety-migration';
      retired += 1;
    }
    if (!retired) return;
    if (doc.workstream.status === 'active' && !doc.wakes.some((wake) => wake.status === 'pending')) {
      doc.wakes.push({
        id: newId('wake'),
        reason: 'legacy lifetime dollar cap retired — reconcile under rolling execution safety',
        condition: { type: 'immediate' },
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    }
    event('budget.legacy_retired', `${retired} lifetime-dollar exhaustion card(s) retired; dollars no longer gate execution`);
  });
  return true;
}
