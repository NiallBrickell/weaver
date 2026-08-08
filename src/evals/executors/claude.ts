import { performance } from 'node:perf_hooks';
import { LocalSdkExecutor } from '../../executor/localSdk.js';
import type { WorkerExecutionOutcome, WorkerExecutionRequest } from '../../executor/types.js';
import type { EvalExecutionTelemetry, EvalExecutor, EvalUsage } from '../types.js';

const NULL_USAGE: EvalUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
};

/** The current production baseline, instrumented without changing its contract. */
export class ClaudeSdkEvalExecutor implements EvalExecutor {
  readonly id = 'claude-sdk' as const;
  private readonly delegate: LocalSdkExecutor;
  private telemetry: EvalExecutionTelemetry | null = null;

  constructor(delegate = new LocalSdkExecutor()) {
    this.delegate = delegate;
  }

  lastTelemetry(): EvalExecutionTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const startedMs = performance.now();
    const startedAt = new Date().toISOString();
    let submittedAtMs: number | null = null;
    const outcome = await this.delegate.execute({
      ...req,
      submit: {
        appendSection: (content) => req.submit.appendSection(content),
        submitResult: async (args) => {
          const reply = await req.submit.submitResult(args);
          if (!reply.isError) submittedAtMs ??= performance.now();
          return reply;
        },
      },
    });
    const endedMs = performance.now();
    this.telemetry = {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: 'anthropic',
      modelResolved: req.model,
      harnessVersion: '@anthropic-ai/claude-agent-sdk@0.3.220',
      isolation: 'host-process',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: endedMs - startedMs,
      startupMs: null,
      timeToSubmissionMs: submittedAtMs === null ? null : submittedAtMs - startedMs,
      usage: NULL_USAGE,
      costUsd: outcome.costUsd > 0 ? outcome.costUsd : null,
      sessionId: outcome.sessionId ?? null,
      terminalReason: outcome.error
        ? (req.abort.signal.aborted ? 'aborted' : 'error')
        : 'completed',
      error: outcome.error ?? null,
    };
    return outcome;
  }
}
