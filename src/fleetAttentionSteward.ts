import {
  setAssignmentPlacement,
  setCoordinatorRunnerOrder,
  setPaused,
  type SetAssignmentPlacementResult,
  type SetPausedResult,
} from './humanActs.js';
import { liveRunnerIds } from './coordinatorRunner.js';
import { recordObservation } from './ingress.js';
import { createFleetAttentionSteward } from './operatorUi.js';
import { assertRunnerId } from './runnerIdentity.js';
import { listRunnerPresence, load } from './store.js';

export interface FleetAttentionStewardResult {
  slug: string;
  created: boolean;
  placement: SetAssignmentPlacementResult;
  coordinatorPlacement: { previous: string[] | null; current: string[] | null; changed: boolean };
  activation: SetPausedResult;
  wokeDormant: boolean;
  runnerLive: boolean;
}

/**
 * Start or move the durable steward onto one exact execution host. Creation
 * writes coordinator and Assignment placement before the initial wake. An
 * existing routine moves only at the safe typed seams: running history stays
 * pinned to its original host while future and safely pending work moves.
 */
export async function runFleetAttentionSteward(
  actor: string,
  runnerId: string,
): Promise<FleetAttentionStewardResult> {
  assertRunnerId(runnerId, 'runner id');
  const created = await createFleetAttentionSteward(actor, runnerId);
  const placement = await setAssignmentPlacement(created.slug, runnerId);
  const coordinatorPlacement = await setCoordinatorRunnerOrder(created.slug, [runnerId]);
  const activation = await setPaused(created.slug, false);

  const current = await load(created.slug);
  const hasPendingWake = current.wakes.some((wake) => wake.status === 'pending');
  const hasLiveWork = current.assignments.some((assignment) =>
    assignment.state === 'queued' || assignment.state === 'running' || assignment.state === 'gated',
  );
  const wokeDormant = !hasPendingWake && !hasLiveWork;
  if (wokeDormant) {
    await recordObservation(created.slug, {
      source: `operator-cli:${safeActor(actor)}`,
      summary: `Run the standing fleet attention steward on execution host ${runnerId}.`,
    });
  }

  const runnerLive = liveRunnerIds(await listRunnerPresence()).includes(runnerId);
  return { ...created, placement, coordinatorPlacement, activation, wokeDormant, runnerLive };
}

function safeActor(value: string): string {
  return value.replace(/[\r\n\0]/g, '').trim().slice(0, 80) || 'operator';
}
