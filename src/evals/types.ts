import type {
  ExecutorTelemetry,
  ExecutorUsage,
  WorkerExecutor,
} from '../executor/types.js';

export const EVAL_EXECUTORS = ['claude-sdk', 'codex-sdk', 'opencode', 'openhands'] as const;

export type EvalExecutorId = (typeof EVAL_EXECUTORS)[number];

export interface EvalTarget {
  executor: EvalExecutorId;
  /** Provider-qualified where the substrate supports multiple providers. */
  model: string;
  label: string;
}

/**
 * Eval telemetry is the production `ExecutorTelemetry` with its `executor`
 * label narrowed to the known eval candidates. The shape is owned by the
 * executor layer so production code never depends on the eval harness.
 */
export type EvalUsage = ExecutorUsage;

export type EvalExecutionTelemetry = Omit<ExecutorTelemetry, 'executor'> & {
  executor: EvalExecutorId;
};

/**
 * An eval candidate is still a real WorkerExecutor. Telemetry is deliberately
 * separate from its durable outcome: missing provider metrics stay null and an
 * executor cannot use this side channel to claim that it submitted anything.
 */
export interface EvalExecutor extends WorkerExecutor {
  readonly id: EvalExecutorId;
  lastTelemetry(): EvalExecutionTelemetry | null;
}

export interface EvalGrade {
  id: string;
  hardGate: boolean;
  passed: boolean;
  score: number | null;
  detail: string;
}

export interface EvalCaseResult {
  /** Schema 1 ledger rows predate case/adapter evidence epochs. New runs write
   * schema 2 and carry an explicit case version; readers retain schema 1 as
   * case version 0 under the synthetic `unknown` harness epoch. */
  schemaVersion: 1 | 2;
  suiteRunId: string;
  caseId: string;
  caseVersion?: number;
  repetition: number;
  target: EvalTarget;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  execution: EvalExecutionTelemetry | null;
  submitted: boolean;
  adoptionState: 'none' | 'proposed' | 'accepted' | 'rejected';
  grades: EvalGrade[];
  passedHardGates: boolean;
  artifactPath: string | null;
  artifactHash: string | null;
  error: string | null;
}
