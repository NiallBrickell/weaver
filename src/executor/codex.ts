/**
 * The local Codex executor: one fresh `@openai/codex-sdk` thread per worker
 * assignment. The disposable loop runs as a host process while Weaver keeps
 * the durable boundary: the worker can propose state only through the
 * harness-owned submission surface exposed by an authenticated MCP bridge.
 *
 * Codex's TypeScript SDK does not expose a per-tool authority callback.
 * Requests carrying live action supervision therefore fail closed before the
 * bridge or SDK client starts; this executor is scoped to cooperative work
 * assignments until that authority hook exists.
 */

import {
  Codex,
  type CodexOptions,
  type RunStreamedResult,
  type ThreadOptions,
} from '@openai/codex-sdk';
import { performance } from 'node:perf_hooks';
import { startSubmitBridge, type SubmitBridge } from './submitBridge.js';
import type {
  ExecutorTelemetry,
  ExecutorUsage,
  SubmitSurface,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
  WorkerExecutor,
} from './types.js';

const SUBMIT_TOKEN_ENV = 'WEAVER_CODEX_SUBMIT_TOKEN';
// Weaver adapter behavior is part of eval identity. The .3 epoch separates
// the declared host-process/full-access worker boundary from .2's
// workspace-write runs retained in the durable ledger.
const HARNESS_VERSION = 'codex-sdk-0.147.0-weaver.3';
const EMPTY_USAGE: ExecutorUsage = {
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

export interface CodexExecutorDependencies {
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

export class CodexExecutor implements WorkerExecutor {
  readonly id = 'codex-sdk' as const;

  private readonly createCodex: (options: CodexOptions) => CodexLike;
  private readonly startBridge: typeof startSubmitBridge;
  private readonly monotonicNow: () => number;
  private readonly now: () => Date;
  private readonly harnessVersion: string;
  private telemetry: ExecutorTelemetry | null = null;

  constructor(dependencies: CodexExecutorDependencies = {}) {
    this.createCodex = dependencies.createCodex ?? ((options) => new Codex(options));
    this.startBridge = dependencies.startBridge ?? startSubmitBridge;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.now = dependencies.now ?? (() => new Date());
    this.harnessVersion = dependencies.harnessVersion ?? HARNESS_VERSION;
  }

  lastTelemetry(): ExecutorTelemetry | null {
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
      const error = 'Codex SDK run was aborted before launch';
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
    let usage: ExecutorUsage = EMPTY_USAGE;
    let startupMs: number | null = null;
    let timeToSubmissionMs: number | null = null;
    let terminalReason: ExecutorTelemetry['terminalReason'] = 'error';
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
      const env = stringEnv(req.env);
      // This local executor is deliberately subscription-backed. Stray API
      // credentials in the launching shell must never switch the principal or
      // billing path while telemetry still reports zero marginal SDK cost.
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      const codex = this.createCodex({
        // Passing the harness-built environment preserves the operator's local
        // Codex login/config while preventing the SDK from independently
        // inheriting a different subprocess environment.
        env: {
          ...env,
          [SUBMIT_TOKEN_ENV]: bridge.token,
        },
        config: {
          forced_login_method: 'chatgpt',
          // Session ids are provenance only. Weaver never resumes a worker,
          // and durable continuation comes from typed state rather than a
          // Codex transcript.
          history: { persistence: 'none' },
          mcp_servers: {
            weaver: {
              url: bridge.url,
              bearer_token_env_var: SUBMIT_TOKEN_ENV,
              required: true,
              enabled: true,
              enabled_tools: ['append_section', 'submit_result'],
              // `auto` still routes mutating tools to a reviewer; an isolated
              // headless run has no reviewer and cancels them. `approve` is
              // the deterministic owner approval, scoped to this per-run
              // server whose only tools are Weaver's submission closures.
              default_tools_approval_mode: 'approve',
            },
          },
        },
      });
      const thread = codex.startThread({
        model: req.model,
        // This executor is explicitly a host-process substrate and must expose
        // the same ordinary coding-agent surface as the local Claude worker.
        // Codex's workspace-write mode recursively protects Git metadata and
        // cannot cover every host daemon/cache a normal coding run may need.
        // Irreversible egress remains gated by Weaver's action lifecycle and
        // Pilot; supervised actions already fail closed above.
        sandboxMode: 'danger-full-access',
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
    usage?: ExecutorUsage;
    sessionId?: string | null;
    providerResolved?: string | null;
    modelResolved?: string | null;
    terminalReason: ExecutorTelemetry['terminalReason'];
    error: string | null;
  }): ExecutorTelemetry {
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
