import { assertRunnerId } from './runnerIdentity.js';
import type { RunnerPresence } from './store/types.js';
import type { WorkstreamDoc } from './types.js';

/** Four missed default 30-second runner polls before standby takeover. */
export const RUNNER_PRESENCE_TTL_MS = 120_000;

export function validateCoordinatorRunnerOrder(order: readonly string[]): string[] {
  if (order.length === 0) throw new Error('coordinator runner order must name at least one runner');
  const validated = order.map((runnerId) => assertRunnerId(runnerId, 'coordinator runner id'));
  if (new Set(validated).size !== validated.length) {
    throw new Error('coordinator runner order must not contain duplicate runner ids');
  }
  return validated;
}

export interface CoordinatorRunnerEligibility {
  eligible: boolean;
  reason?: string;
  preferredLiveRunner?: string;
}

export function liveRunnerIds(
  presences: readonly RunnerPresence[],
  nowMs = Date.now(),
  ttlMs = RUNNER_PRESENCE_TTL_MS,
): string[] {
  const latest = new Map<string, number>();
  for (const presence of presences) {
    const at = Date.parse(presence.heartbeatAt);
    if (Number.isFinite(at) && at > (latest.get(presence.runnerId) ?? Number.NEGATIVE_INFINITY)) {
      latest.set(presence.runnerId, at);
    }
  }
  return [...latest]
    .filter(([, heartbeatAt]) => nowMs - heartbeatAt <= ttlMs)
    .map(([runnerId]) => runnerId)
    .sort();
}

/** The current process proves its own liveness; only earlier preferred
 * runners need a stored heartbeat. Omitted policy preserves fleet-wide
 * coordinator eligibility. */
export function coordinatorRunnerEligibility(
  doc: WorkstreamDoc,
  runnerId: string,
  presences: readonly RunnerPresence[],
  nowMs = Date.now(),
  ttlMs = RUNNER_PRESENCE_TTL_MS,
): CoordinatorRunnerEligibility {
  const order = doc.workstream.executionPolicy?.coordinatorRunnerOrder;
  if (!order) return { eligible: true };
  const index = order.indexOf(runnerId);
  if (index < 0) {
    return { eligible: false, reason: `runner '${runnerId}' is not in the coordinator runner order` };
  }
  const latest = new Map<string, number>();
  for (const presence of presences) {
    const at = Date.parse(presence.heartbeatAt);
    if (Number.isFinite(at) && at > (latest.get(presence.runnerId) ?? Number.NEGATIVE_INFINITY)) {
      latest.set(presence.runnerId, at);
    }
  }
  const preferredLiveRunner = order.slice(0, index).find((candidate) => {
    const heartbeatAt = latest.get(candidate);
    return heartbeatAt !== undefined && nowMs - heartbeatAt <= ttlMs;
  });
  return preferredLiveRunner
    ? {
        eligible: false,
        preferredLiveRunner,
        reason: `preferred coordinator runner '${preferredLiveRunner}' has a fresh shared heartbeat`,
      }
    : { eligible: true };
}
