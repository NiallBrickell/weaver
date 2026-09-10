import { capacityBackoffFor, capacityPresentation, type CapacityPresentation } from './capacity.js';
import { assertRunnerId, runnerDisabled, runnerIdentity } from './runnerIdentity.js';
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

/** Operator clients cannot use their own model configuration as evidence
 * about a different execution host. This projection never changes routing. */
export function operatorCapacityPresentation(
  doc: WorkstreamDoc,
  nowIso: string,
  presences: readonly RunnerPresence[] = [],
  wallNowMs = Date.now(),
): CapacityPresentation {
  const order = doc.workstream.executionPolicy?.coordinatorRunnerOrder;
  const shared = /^postgres(?:ql)?:\/\//.test(process.env.WEAVER_STORE ?? '');
  const remote = shared || runnerDisabled() || !!order?.some((id) => id !== runnerIdentity());
  if (!remote) return capacityPresentation(doc, nowIso);

  const live = new Set(liveRunnerIds(presences, wallNowMs));
  const candidates = (order ?? [...live].sort()).flatMap((id) => {
    if (!live.has(id)) return [];
    const latest = presences.filter((presence) => presence.runnerId === id)
      .sort((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt))[0];
    return latest ? [latest] : [];
  });
  // Match the runner preference rule: an earlier host whose published seats
  // are all parked yields to the next live host with an open seat.
  const selected = candidates.find((presence) => runnerCoordinatorSeatOpen(doc, presence, nowIso))
    ?? candidates[0];
  const seats = selected?.coordinatorSeats ?? [];
  const unknown = !selected
    ? 'coordinator capacity unknown — no fresh heartbeat from an eligible runner'
    : !seats.length
      ? `coordinator capacity unknown — runner ${selected.runnerId} publishes no coordinator seats`
      : undefined;
  return capacityPresentation(doc, nowIso, new Set(seats.map((seat) => seat.executor)), {
    coordinatorTargets: seats,
    ...(unknown ? { coordinatorUnknown: unknown } : {}),
    // Presence currently publishes coordinator seats only. Inferring worker
    // fallback availability from the viewer's env would repeat the same bug.
    workerUnknown: `worker capacity unknown — ${doc.workstream.assignmentRunnerId ?? 'execution runner'} does not publish worker seats`,
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
