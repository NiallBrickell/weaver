import { hostname } from 'node:os';
import type { Assignment } from './types.js';

const RUNNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validate one durable runner name. Runner placement is an exact execution
 * constraint, so accepting invisible whitespace or shell-shaped values would
 * create work that no correctly configured process can honestly claim.
 */
export function assertRunnerId(value: string, source = 'runner id'): string {
  if (!RUNNER_ID_PATTERN.test(value)) {
    throw new Error(
      `${source} must be 1-128 characters matching ${RUNNER_ID_PATTERN}; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Stable identity for this execution host. An explicit value is required for
 * hosted/container runners whose OS hostname is not durable; a normal local
 * machine conservatively defaults to its hostname rather than a fleet-wide
 * label such as "local" that several machines could accidentally share.
 */
export function runnerIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
): string {
  const configured = environment.WEAVER_RUNNER_ID;
  return assertRunnerId(configured === undefined ? host : configured, 'WEAVER_RUNNER_ID');
}

export interface RunnerClaimIdentity {
  id: string;
  /** Narrow manual-tick posture: only assignments explicitly placed here. */
  placementOnly: boolean;
}

/** Resolve per-Assignment placement under an optional Workstream binding.
 * The binding is a hard resource constraint: callers may restate it, but may
 * not use an Assignment field to escape it. */
export function resolveAssignmentRunnerId(
  workstreamRunnerId: string | undefined,
  requestedRunnerId: string | undefined,
): string | undefined {
  if (workstreamRunnerId !== undefined) {
    assertRunnerId(workstreamRunnerId, 'workstream assignmentRunnerId');
  }
  if (requestedRunnerId !== undefined) assertRunnerId(requestedRunnerId, 'runner_id');
  if (workstreamRunnerId && requestedRunnerId && workstreamRunnerId !== requestedRunnerId) {
    throw new Error(
      `runner_id '${requestedRunnerId}' conflicts with this Workstream's assignment runner '${workstreamRunnerId}'`,
    );
  }
  return workstreamRunnerId ?? requestedRunnerId;
}

/** Parse the process claim posture once at an execution boundary. */
export function runnerClaimIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
): RunnerClaimIdentity {
  const raw = environment.WEAVER_RUNNER_PLACEMENT_ONLY;
  if (raw !== undefined && raw !== '0' && raw !== '1') {
    throw new Error(`WEAVER_RUNNER_PLACEMENT_ONLY must be 0 or 1; got ${JSON.stringify(raw)}`);
  }
  if (raw === '1' && environment.WEAVER_RUNNER_ID === undefined) {
    throw new Error('WEAVER_RUNNER_PLACEMENT_ONLY=1 requires an explicit nonempty WEAVER_RUNNER_ID');
  }
  return { id: runnerIdentity(environment, host), placementOnly: raw === '1' };
}

/** Placement is optional for backward compatibility; when present it is an
 * exact match and an unmatched runner must leave intended work untouched. */
export function assignmentMatchesRunner(assignment: Assignment, runner: RunnerClaimIdentity): boolean {
  if (runner.placementOnly) return assignment.runnerId === runner.id;
  return assignment.runnerId === undefined || assignment.runnerId === runner.id;
}

export class RunnerPlacementMismatchError extends Error {
  constructor(assignmentId: string, expected: string, actual: string) {
    super(`assignment ${assignmentId} is placed on runner '${expected}', not '${actual}'`);
    this.name = 'RunnerPlacementMismatchError';
  }
}
