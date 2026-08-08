import {
  Codex,
  type CodexOptions,
  type RunStreamedResult,
  type ThreadOptions,
} from '@openai/codex-sdk';
import { performance } from 'node:perf_hooks';
import { startSubmitBridge, type SubmitBridge } from '../../executor/submitBridge.js';
import type {
  SubmitSurface,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import type { EvalExecutionTelemetry, EvalExecutor, EvalUsage } from '../types.js';

const SUBMIT_TOKEN_ENV = 'WEAVER_CODEX_SUBMIT_TOKEN';
const HARNESS_VERSION = 'codex-sdk-0.147.0';
const EMPTY_USAGE: EvalUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
};

interface CodexThreadLike {
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<RunStreamedResult>;
}

interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export interface CodexEvalExecutorDependencies {
  createCodex?: (options: CodexOptions) => CodexLike;
  startBridge?: typeof startSubmitBridge;
  monotonicNow?: () => number;
  now?: () => Date;
  harnessVersion?: string;
}

function stringEnv(env: WorkerExecutionRequest['env']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Eval-only Codex SDK candidate. Each execution creates one new thread and
 * exposes Weaver's harness-owned submission surface over an authenticated,
 * required remote MCP server. The TypeScript SDK has no per-tool authority
 * callback, so supervised action requests fail closed before any process or
 * bridge is launched.
 */
export class CodexEvalExecutor implements EvalExecutor {
  readonly id = 'codex-sdk' as const;

  private readonly createCodex: (options: CodexOptions) => CodexLike;
  private readonly startBridge: typeof startSubmitBridge;
  private readonly monotonicNow: () => number;
  private readonly now: () => Date;
  private readonly harnessVersion: string;
  private telemetry: EvalExecutionTelemetry | null = null;

  constructor(dependencies: CodexEvalExecutorDependencies = {}) {
    this.createCodex = dependencies.createCodex ?? ((options) => new Codex(options));
    this.startBridge = dependencies.startBridge ?? startSubmitBridge;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.now = dependencies.now ?? (() => new Date());
    this.harnessVersion = dependencies.harnessVersion ?? HARNESS_VERSION;
  }

  lastTelemetry(): EvalExecutionTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const startedMs = this.monotonicNow();
    const startedAt = this.now().toISOString();

    if (req.supervise) {
      const error = 'Codex SDK does not expose a per-tool authority callback; supervised action execution is unsupported';
      const endedMs = this.monotonicNow();
      this.telemetry = this.makeTelemetry({
        req,
        startedAt,
        startedMs,
        endedMs,
        terminalReason: 'unsupported',
        error,
      });
      return { costUsd: 0, error };
    }

    if (req.abort.signal.aborted) {
      const error = 'Codex SDK eval run was aborted before launch';
      const endedMs = this.monotonicNow();
      this.telemetry = this.makeTelemetry({
        req,
        startedAt,
        startedMs,
        endedMs,
        terminalReason: 'aborted',
        error,
      });
      return { costUsd: 0, error };
    }

    let bridge: SubmitBridge | null = null;
    let sessionId: string | null = null;
    let usage: EvalUsage = EMPTY_USAGE;
    let startupMs: number | null = null;
    let timeToSubmissionMs: number | null = null;
    let terminalReason: EvalExecutionTelemetry['terminalReason'] = 'error';
    let error: string | null = null;
    let completed = false;
    let launched = false;

    const observedSubmit: SubmitSurface = {
      appendSection: (content) => req.submit.appendSection(content),
      submitResult: async (args) => {
        const reply = await req.submit.submitResult(args);
        if (!reply.isError && timeToSubmissionMs === null) {
          timeToSubmissionMs = this.monotonicNow() - startedMs;
        }
        return reply;
      },
    };

    try {
      bridge = await this.startBridge(observedSubmit);
      const codex = this.createCodex({
        env: {
          ...stringEnv(req.env),
          [SUBMIT_TOKEN_ENV]: bridge.token,
        },
        config: {
          mcp_servers: {
            weaver: {
              url: bridge.url,
              bearer_token_env_var: SUBMIT_TOKEN_ENV,
              required: true,
              enabled: true,
              enabled_tools: ['append_section', 'submit_result'],
            },
          },
        },
      });
      const thread = codex.startThread({
        model: req.model,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        workingDirectory: req.cwd ?? process.cwd(),
        additionalDirectories: req.additionalDirectories,
        skipGitRepoCheck: true,
      });
      const streamed = await thread.runStreamed(
        `${req.systemPrompt.append.trim()}\n\n${req.prompt}`,
        { signal: req.abort.signal },
      );
      launched = true;

      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          sessionId = event.thread_id;
          startupMs = this.monotonicNow() - startedMs;
          continue;
        }
        if (event.type === 'turn.completed') {
          completed = true;
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          };
          continue;
        }
        if (event.type === 'turn.failed') {
          error = event.error.message;
          continue;
        }
        if (event.type === 'error') {
          error = event.message;
          continue;
        }
      }

      if (!completed && !error) error = 'Codex stream ended without turn.completed';
      terminalReason = error
        ? (req.abort.signal.aborted ? 'aborted' : 'error')
        : 'completed';
    } catch (caught) {
      error = errorMessage(caught);
      terminalReason = req.abort.signal.aborted ? 'aborted' : 'error';
    } finally {
      if (bridge) {
        try {
          await bridge.close();
        } catch (caught) {
          error = error ?? `submit bridge close failed: ${errorMessage(caught)}`;
          terminalReason = 'error';
        }
      }
    }

    const endedMs = this.monotonicNow();
    this.telemetry = this.makeTelemetry({
      req,
      startedAt,
      startedMs,
      endedMs,
      startupMs,
      timeToSubmissionMs,
      usage,
      sessionId,
      providerResolved: launched ? 'openai' : null,
      modelResolved: launched ? req.model : null,
      terminalReason,
      error,
    });

    return {
      costUsd: 0,
      ...(sessionId ? { sessionId } : {}),
      ...(error ? { error } : {}),
    };
  }

  private makeTelemetry(args: {
    req: WorkerExecutionRequest;
    startedAt: string;
    startedMs: number;
    endedMs: number;
    startupMs?: number | null;
    timeToSubmissionMs?: number | null;
    usage?: EvalUsage;
    sessionId?: string | null;
    providerResolved?: string | null;
    modelResolved?: string | null;
    terminalReason: EvalExecutionTelemetry['terminalReason'];
    error: string | null;
  }): EvalExecutionTelemetry {
    return {
      executor: this.id,
      modelRequested: args.req.model,
      providerResolved: args.providerResolved ?? null,
      modelResolved: args.modelResolved ?? null,
      harnessVersion: this.harnessVersion,
      isolation: 'host-process',
      startedAt: args.startedAt,
      endedAt: this.now().toISOString(),
      durationMs: args.endedMs - args.startedMs,
      startupMs: args.startupMs ?? null,
      timeToSubmissionMs: args.timeToSubmissionMs ?? null,
      usage: args.usage ?? EMPTY_USAGE,
      costUsd: null,
      sessionId: args.sessionId ?? null,
      terminalReason: args.terminalReason,
      error: args.error,
    };
  }
}
