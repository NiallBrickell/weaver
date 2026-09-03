import { capacityBackoffFor } from './capacity.js';
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

/** A runner can take a pass on a Workstream only through a coordinator seat
 * that Workstream has not capacity-parked. A presence that publishes seats is
 * seated while at least one of them has no active wait here; a presence from
 * a runner that predates seat publication counts as seated, liveness alone. */
export function runnerCoordinatorSeatOpen(
  doc: WorkstreamDoc,
  presence: RunnerPresence,
  nowIso: string,
): boolean {
  const seats = presence.coordinatorSeats;
  if (seats === undefined) return true;
  return seats.some((seat) => {
    const wait = capacityBackoffFor(doc, seat)?.wait;
    return !wait || wait.retryAt <= nowIso;
  });
}

/** The current process proves its own liveness; only earlier preferred
 * runners need a stored heartbeat, and one with a fresh heartbeat still yields
 * when every coordinator seat it publishes is parked on this Workstream — a
 * live host that cannot launch a pass must not hold the claim while a later
 * host could. Omitted policy preserves fleet-wide coordinator eligibility. */
export function coordinatorRunnerEligibility(
  doc: WorkstreamDoc,
  runnerId: string,
  presences: readonly RunnerPresence[],
  nowMs = Date.now(),
  ttlMs = RUNNER_PRESENCE_TTL_MS,
  capacityNowIso = new Date(nowMs).toISOString(),
): CoordinatorRunnerEligibility {
  const order = doc.workstream.executionPolicy?.coordinatorRunnerOrder;
  if (!order) return { eligible: true };
  const index = order.indexOf(runnerId);
  if (index < 0) {
    return { eligible: false, reason: `runner '${runnerId}' is not in the coordinator runner order` };
  }
  const latest = new Map<string, RunnerPresence>();
  for (const presence of presences) {
    const at = Date.parse(presence.heartbeatAt);
    const known = latest.get(presence.runnerId);
    if (Number.isFinite(at) && (!known || at > Date.parse(known.heartbeatAt))) {
      latest.set(presence.runnerId, presence);
    }
  }
  const preferredLiveRunner = order.slice(0, index).find((candidate) => {
    const presence = latest.get(candidate);
    return presence !== undefined &&
      nowMs - Date.parse(presence.heartbeatAt) <= ttlMs &&
      runnerCoordinatorSeatOpen(doc, presence, capacityNowIso);
  });
  return preferredLiveRunner
    ? {
        eligible: false,
        preferredLiveRunner,
        reason: `preferred coordinator runner '${preferredLiveRunner}' has a fresh shared heartbeat`,
      }
    : { eligible: true };
}
