import type {
  Assignment,
  AssignmentExecutionRequirements,
  AssignmentInputModality,
  AssignmentExecutionProfile,
} from './types.js';
import {
  coordinatorTargets,
  providerForExecutor,
  SUPPORTED_EXECUTORS,
  workerCapacityTarget,
  workerExecutorName,
  workerFallbackTargets,
  workerModel,
  workerModelComplex,
  type CapacityTarget,
} from './modelConfig.js';

export type RouteEvidenceExecutor = 'claude-sdk' | 'codex-sdk' | 'openhands' | 'pi';

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
export const WORK_MODEL_ROUTES: readonly WorkModelRoute[] = [
  {
    // Preferred coding route (Niall, 2026-08-21): glm-5.3 outscored Kimi on
    // code-repair, so it leads the ladder above the Kimi/Codex routes (pref
    // 100). Fires only for the bounded-code-repair profile — the z.ai coding
    // plan is licence-restricted to coding, so a route (never the general
    // seat) is the only place it may appear.
    id: 'pi-glm-5-3-bounded-code-repair',
    preference: 110,
    match: { profiles: ['bounded-code-repair'], modalities: ['text'] },
    target: { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' },
    evidence: {
      suiteRunId: '20260821T122900Z',
      executor: 'pi',
      model: 'zai-coding-plan/glm-5.3',
      harnessVersion: 'pi@0.84.2-weaver.4',
      cases: [{
        id: 'code-repair',
        version: 1,
        requiredHardGates: [
          'weaver-submission',
          'artifact-integrity',
          'adoption-separation',
          'target-identity',
          'runtime-completion',
          'workspace-scope',
        ],
        requiredGrades: ['hidden-tests', 'verification-evidence'],
      }],
      minRuns: 10,
    },
  },
  {
    id: 'codex-5-6-sol-bounded-code-repair',
    preference: 100,
    match: { profiles: ['bounded-code-repair'], modalities: ['text'] },
    target: { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
    evidence: {
      suiteRunId: '20260814T145942Z',
      executor: 'codex-sdk',
      model: 'gpt-5.6-sol',
      harnessVersion: 'codex-sdk-0.147.0-weaver.3',
      cases: [{
        id: 'code-repair',
        version: 1,
        requiredHardGates: [
          'weaver-submission',
          'artifact-integrity',
          'adoption-separation',
          'target-identity',
          'runtime-completion',
          'workspace-scope',
        ],
        requiredGrades: ['hidden-tests', 'verification-evidence'],
      }],
      minRuns: 10,
    },
  },
  {
    id: 'pi-kimi-k3-bounded-code-repair',
    preference: 100,
    match: { profiles: ['bounded-code-repair'], modalities: ['text'] },
    target: {
      executor: 'pi',
      provider: 'openrouter',
      model: 'openrouter/moonshotai/kimi-k3',
    },
    evidence: {
      suiteRunId: '20260815T105214Z',
      executor: 'pi',
      model: 'openrouter/moonshotai/kimi-k3',
      harnessVersion: 'pi@0.84.2-weaver.4',
      cases: [{
        id: 'code-repair',
        version: 1,
        requiredHardGates: [
          'weaver-submission',
          'artifact-integrity',
          'adoption-separation',
          'target-identity',
          'runtime-completion',
          'workspace-scope',
        ],
        requiredGrades: ['hidden-tests', 'verification-evidence'],
      }],
      minRuns: 10,
    },
  },
];

const KNOWN_EXECUTORS = new Set(SUPPORTED_EXECUTORS);

function normalizedRequirements(assignment: Assignment): AssignmentExecutionRequirements {
  return assignment.executionRequirements ?? DEFAULT_EXECUTION_REQUIREMENTS;
}

/** The model the operator's configured worker seat supplies for this
 * assignment's typed requirements: declared high complexity selects the
 * complex-tier model, everything else the standard one. The requirement never
 * names a model; this is where the operator's config answers it. */
export function workerSeatModelForAssignment(assignment: Assignment): string {
  return assignment.kind !== 'action' && normalizedRequirements(assignment).complexity === 'high'
    ? workerModelComplex()
    : workerModel();
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

/** Executors this process is willing to claim. The default is deliberately
 * the configured seats only: a checked-in performance route must not make a
 * host claim OpenHands work merely because that adapter exists in the build.
 * A heterogeneous Postgres fleet declares any extra substrates explicitly. */
export function runnerExecutorCapabilities(): ReadonlySet<string> {
  const configured = [
    workerExecutorName(),
    actionExecutorName(),
    ...coordinatorTargets().map((target) => target.executor),
    ...workerFallbackTargets().map((target) => target.executor),
  ];
  const raw = process.env.WEAVER_RUNNER_EXECUTORS;
  const executors = raw === undefined
    ? configured
    : raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (!executors.length) {
    throw new Error('WEAVER_RUNNER_EXECUTORS must declare at least one executor');
  }
  for (const executor of executors) {
    if (!KNOWN_EXECUTORS.has(executor)) {
      throw new Error(
        `unknown runner executor '${executor}' from WEAVER_RUNNER_EXECUTORS — supported: ${[...KNOWN_EXECUTORS].join(', ')}`,
      );
    }
  }
  return new Set(executors);
}

function sameTarget(a: CapacityTarget, b: CapacityTarget): boolean {
  return a.executor === b.executor && a.provider === b.provider && a.model === b.model;
}

/** Reviewed targets in preference order, then the operator-configured seat,
 * then the operator's explicit `WEAVER_WORKER_FALLBACKS` capacity ladder.
 * Requirements survive attempts; this ordered target list does not. */
export function workerTargetsForAssignment(
  assignment: Assignment,
  routes: readonly WorkModelRoute[] = WORK_MODEL_ROUTES,
): CapacityTarget[] {
  if (assignment.kind === 'action') return [actionCapacityTarget()];
  const requirements = normalizedRequirements(assignment);
  // Declared high complexity swaps the configured seat's MODEL only: same
  // executor (provider re-derived), reviewed routes and the operator's
  // explicit fallback ladder unchanged.
  const fallback = workerCapacityTarget(workerSeatModelForAssignment(assignment));
  const candidates = [...routes]
    // AUTOMATIC eval-route selection changes the model only within the
    // configured worker substrate: a checked-in performance route crossing
    // executors would need a durable Workstream execution policy, and a
    // process-local opt-in would make model choice a Postgres tick-lock race
    // during config skew. The ordered ladder appended below is different in
    // kind: it is the operator's explicit machine config, the same trust
    // class as WEAVER_EXECUTOR itself, so its entries may name any executor.
    .filter((candidate) => candidate.target.executor === fallback.executor)
    .filter((candidate) => routeMatches(candidate, requirements))
    .sort((a, b) => b.preference - a.preference || a.id.localeCompare(b.id))
    .map((route) => route.target);
  candidates.push(fallback, ...workerFallbackTargets());
  return candidates.filter(
    (target, index) => candidates.findIndex((candidate) => sameTarget(candidate, target)) === index,
  );
}

export function workerTargetForAssignment(
  assignment: Assignment,
  routes: readonly WorkModelRoute[] = WORK_MODEL_ROUTES,
): CapacityTarget {
  return workerTargetsForAssignment(assignment, routes)[0]!;
}
