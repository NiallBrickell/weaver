import type {
  Assignment,
  AssignmentExecutionRequirements,
  AssignmentInputModality,
  AssignmentExecutionProfile,
} from './types.js';
import {
  providerForExecutor,
  workerCapacityTarget,
  type CapacityTarget,
} from './modelConfig.js';

export type RouteEvidenceExecutor = 'claude-sdk' | 'codex-sdk' | 'openhands';

export interface RouteEvidenceCase {
  id: string;
  version: number;
  requiredHardGates: string[];
  requiredGrades: string[];
}

export interface RouteEvidence {
  /** One complete experimental cohort. Every matching repetition is audited;
   * individual successful rows cannot be cherry-picked out of a failed suite. */
  suiteRunId: string;
  executor: RouteEvidenceExecutor;
  model: string;
  harnessVersion: string;
  cases: RouteEvidenceCase[];
  minRuns: number;
}

export interface WorkModelRoute {
  id: string;
  /** Explicit operator preference. Unknown cost is never treated as zero. */
  preference: number;
  match: {
    profiles: AssignmentExecutionProfile[];
    modalities: AssignmentInputModality[];
  };
  target: CapacityTarget;
  /** Reviewable provenance for this commitment; production never reads the
   * ledger and appending a result cannot silently activate a route. */
  evidence: RouteEvidence;
}

export const DEFAULT_EXECUTION_REQUIREMENTS: AssignmentExecutionRequirements = {
  profile: 'general',
  modalities: ['text'],
};

/** Reviewed routing commitments. Each active entry is audited against the
 * append-only ledger in modelRouting.test.ts. */
export const WORK_MODEL_ROUTES: readonly WorkModelRoute[] = [];

function normalizedRequirements(assignment: Assignment): AssignmentExecutionRequirements {
  return assignment.executionRequirements ?? DEFAULT_EXECUTION_REQUIREMENTS;
}

function routeMatches(
  route: WorkModelRoute,
  requirements: AssignmentExecutionRequirements,
): boolean {
  return route.match.profiles.includes(requirements.profile) &&
    requirements.modalities.length > 0 &&
    requirements.modalities.every((modality) => route.match.modalities.includes(modality));
}

export function actionModel(): string {
  return process.env.WEAVER_ACTION_MODEL ?? 'sonnet';
}

export function actionExecutorName(): string {
  return process.env.WEAVER_ACTION_EXECUTOR ?? 'local-sdk';
}

/** Actions never enter the evidence router: they require the executor whose
 * tool calls the operator's Pilot can supervise live. */
export function actionCapacityTarget(): CapacityTarget {
  const executor = actionExecutorName();
  const model = actionModel();
  return { executor, provider: providerForExecutor(executor, model), model };
}

export function workerTargetForAssignment(
  assignment: Assignment,
  routes: readonly WorkModelRoute[] = WORK_MODEL_ROUTES,
): CapacityTarget {
  if (assignment.kind === 'action') return actionCapacityTarget();
  const requirements = normalizedRequirements(assignment);
  const route = [...routes]
    .filter((candidate) => routeMatches(candidate, requirements))
    .sort((a, b) => b.preference - a.preference || a.id.localeCompare(b.id))[0];
  return route?.target ?? workerCapacityTarget();
}
