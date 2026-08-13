/**
 * Which steering still counts as live direction.
 *
 * "Unconsumed" was the whole test, spelled out separately at every reader —
 * the projection, the board's acknowledgement line, the capacity view, and the
 * pass that marks steering consumed. Withdrawal adds a second way for a steer
 * to stop being live, and a predicate repeated at four sites is a predicate
 * that gets updated at three: a withdrawn message would have gone on reaching
 * the coordinator through whichever reader was missed. One definition, so
 * "live" means the same thing everywhere.
 */

import type { Steering } from './types.js';

export function isPendingSteering(s: Steering): boolean {
  return !s.consumedByPass && !s.revokedAt;
}

export function pendingSteering(steering: readonly Steering[]): Steering[] {
  return steering.filter(isPendingSteering);
}
