import type { WorkerExecutor } from '../executor/types.js';

export const EVAL_EXECUTORS = ['claude-sdk', 'codex-sdk', 'opencode', 'openhands'] as const;

export type EvalExecutorId = (typeof EVAL_EXECUTORS)[number];

export interface EvalTarget {
  executor: EvalExecutorId;
  /** Provider-qualified where the substrate supports multiple providers. */
  model: string;
  label: string;
}

export interface EvalUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface EvalExecutionTelemetry {
  executor: EvalExecutorId;
  modelRequested: string;
  providerResolved: string | null;
  modelResolved: string | null;
  harnessVersion: string;
  isolation: 'host-process' | 'agent-server' | 'managed-sandbox';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  startupMs: number | null;
  timeToSubmissionMs: number | null;
  usage: EvalUsage;
  costUsd: number | null;
  sessionId: string | null;
  terminalReason: 'completed' | 'aborted' | 'unsupported' | 'error';
  error: string | null;
}

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
  schemaVersion: 1;
  suiteRunId: string;
  caseId: string;
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
