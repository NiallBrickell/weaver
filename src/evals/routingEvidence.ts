import { providerForExecutor } from '../modelConfig.js';
import {
  WORK_MODEL_ROUTES,
  type RouteEvidenceExecutor,
  type WorkModelRoute,
} from '../modelRouting.js';
import type { EvalCaseResult } from './types.js';

export interface RouteEvidenceFailure {
  routeId: string;
  message: string;
}

function evalExecutorForProduction(executor: string): RouteEvidenceExecutor | null {
  if (executor === 'local-sdk') return 'claude-sdk';
  if (executor === 'codex-sdk' || executor === 'openhands' || executor === 'pi') return executor;
  return null;
}

/** Audit one reviewed commitment against raw, versioned results. It requires
 * complete hard-gate and named-grade vectors; aggregate means and cost are
 * deliberately irrelevant. Kept in the eval layer so production routing has
 * no dependency on harness result types or ledger readers. */
export function auditRouteEvidence(
  route: WorkModelRoute,
  results: readonly EvalCaseResult[],
): RouteEvidenceFailure[] {
  const failures: RouteEvidenceFailure[] = [];
  if (
    evalExecutorForProduction(route.target.executor) !== route.evidence.executor ||
    route.target.model !== route.evidence.model ||
    route.target.provider !== providerForExecutor(route.target.executor, route.target.model)
  ) {
    failures.push({
      routeId: route.id,
      message: 'route target does not exactly match its cited executor/model evidence and provider identity',
    });
    return failures;
  }
  for (const requiredCase of route.evidence.cases) {
    const matching = results.filter((result) =>
      result.schemaVersion === 2 &&
      result.suiteRunId === route.evidence.suiteRunId &&
      result.caseId === requiredCase.id &&
      result.caseVersion === requiredCase.version &&
      result.target.executor === route.evidence.executor &&
      result.target.model === route.evidence.model &&
      result.execution?.harnessVersion === route.evidence.harnessVersion,
    );
    const repetitionCounts = new Map<number, number>();
    for (const result of matching) {
      repetitionCounts.set(result.repetition, (repetitionCounts.get(result.repetition) ?? 0) + 1);
    }
    const duplicateRepetitions = [...repetitionCounts]
      .filter(([, count]) => count > 1)
      .map(([repetition]) => repetition)
      .sort((a, b) => a - b);
    if (duplicateRepetitions.length) {
      failures.push({
        routeId: route.id,
        message: `${requiredCase.id}@${requiredCase.version} has duplicate repetitions ${duplicateRepetitions.join(', ')}`,
      });
    }
    const missingRequiredRepetitions = Array.from(
      { length: route.evidence.minRuns },
      (_, index) => index + 1,
    ).filter((repetition) => !repetitionCounts.has(repetition));
    if (repetitionCounts.size < route.evidence.minRuns || missingRequiredRepetitions.length) {
      failures.push({
        routeId: route.id,
        message: `${requiredCase.id}@${requiredCase.version} has ${repetitionCounts.size}/${route.evidence.minRuns} distinct exact runs` +
          (missingRequiredRepetitions.length
            ? `; missing repetitions ${missingRequiredRepetitions.join(', ')}`
            : ''),
      });
      continue;
    }
    for (const result of matching) {
      if (result.error || !result.passedHardGates || result.execution?.error || result.execution?.terminalReason !== 'completed') {
        failures.push({
          routeId: route.id,
          message: `${requiredCase.id}@${requiredCase.version} run ${result.suiteRunId}/${result.repetition} did not complete every hard gate`,
        });
        continue;
      }
      for (const gateId of requiredCase.requiredHardGates) {
        const gate = result.grades.find((candidate) =>
          candidate.id === gateId && candidate.hardGate,
        );
        if (!gate?.passed) {
          failures.push({
            routeId: route.id,
            message: `${requiredCase.id}@${requiredCase.version} run ${result.suiteRunId}/${result.repetition} failed or omitted hard gate ${gateId}`,
          });
        }
      }
      for (const gradeId of requiredCase.requiredGrades) {
        const grade = result.grades.find((candidate) =>
          candidate.id === gradeId && !candidate.hardGate,
        );
        if (!grade?.passed) {
          failures.push({
            routeId: route.id,
            message: `${requiredCase.id}@${requiredCase.version} run ${result.suiteRunId}/${result.repetition} failed or omitted ${gradeId}`,
          });
        }
      }
    }
  }
  return failures;
}

export function auditRoutingRegistry(
  results: readonly EvalCaseResult[],
  routes: readonly WorkModelRoute[] = WORK_MODEL_ROUTES,
): RouteEvidenceFailure[] {
  return routes.flatMap((route) => auditRouteEvidence(route, results));
}
