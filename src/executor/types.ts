/**
 * The WorkerExecutor seam: where a worker's model loop runs is a substrate
 * choice; what it is allowed to do never is.
 *
 * The executor owns the DISPOSABLE part of a worker run — the model loop, the
 * tool plumbing, the sandbox it executes in. The harness keeps the DURABLE
 * part and ALL authority: it builds the brief, decides the tool ceilings,
 * loads the secrets, records the attempt, and — critically — supplies the two
 * callbacks below. An executor cannot widen a worker's write surface because
 * the write surface is not something it constructs: `submit` is the ONLY path
 * into durable state, `supervise` is the ONLY authority over live tool calls,
 * and both are closures owned by the harness. An executor that ignores
 * `supervise` can at worst run tools the substrate itself exposes — it still
 * cannot touch a workstream except through `submit`.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Harness verdict on one live tool call. Deterministic or pilot-judged, always fail-closed. */
export type ToolDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Live per-call supervision, provided BY the harness: the pilot daemon for
 * action workers, the deterministic read-only gate for research workers. The
 * executor must route every non-auto-allowed tool call through this before
 * executing it, with the same inputs the model supplied.
 */
export type ToolSupervisor = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolDecision>;

/** What the executor relays back to the model after a submit-surface call. */
export interface SubmitReply {
  text: string;
  isError?: boolean;
}

/** The full submission payload — the shape `submit_result` has always taken. */
export interface SubmitResultArgs {
  /** 2-3 sentence faithful summary of what the artifact contains. */
  summary: string;
  artifact: {
    title: string;
    /** e.g. report, job_description, outreach_email */
    kind: string;
    file_name: string;
    /** Full content, or closing content / empty when sections were appended. */
    content: string;
  };
}

/**
 * The worker's ENTIRE write surface, implemented by the harness. Section
 * accumulation, the stub refusal, secret redaction, artifact persistence, the
 * submission record, and the completion wake all live behind these two calls —
 * the executor only relays arguments in and replies out.
 */
export interface SubmitSurface {
  /** One ordered section of a long artifact; replies with running totals. */
  appendSection(content: string): Promise<SubmitReply>;
  /** Finalize the submission. Idempotent-guarded by the harness: a second call is refused. */
  submitResult(args: SubmitResultArgs): Promise<SubmitReply>;
}

/**
 * One fully-specified worker run. Every field that carries authority (tool
 * ceilings, auto-allow list, cwd confinement, sandbox, env, the callbacks) is
 * computed by the harness before the executor ever sees the request — the
 * executor's job is to run exactly this, not to decide any of it.
 */
export interface WorkerExecutionRequest {
  workstreamSlug: string;
  assignmentId: string;
  /** The complete brief: objective, briefing, acceptance criteria, secret NAMES, declared inputs. */
  prompt: string;
  /** The worker behavior contract — identical across substrates. */
  systemPrompt: string;
  model: string;
  /** Base tool ceiling for the loop (e.g. Bash/Read/Grep/Glob/Write/Edit, or none). */
  tools: string[];
  /** Tools that bypass live supervision (the submit surface; read-only file
   * tools for research workers). Everything else must hit `supervise`. */
  allowedTools: string[];
  maxTurns: number;
  /** Working directory (action cwd, or first read dir); unset for dir-less research. */
  cwd?: string;
  /** Additional readable directories; meaningful only when cwd is set. */
  additionalDirectories: string[];
  /** Confine the loop's shell to cwd at the OS level (action workers unless overridden). */
  sandbox: boolean;
  /** Subprocess environment, already secret-injected and API-key-stripped by
   * the harness. Values in here must never reach durable state. */
  env: Record<string, string | undefined>;
  /** The operator's MCP server configs for the dirs this run touches. */
  operatorMcpServers: Record<string, unknown>;
  supervise: ToolSupervisor;
  submit: SubmitSurface;
  /** Harness-armed kill switch (the sleep-aware wall). */
  abort: AbortController;
  /** Observability only — the harness tails these; never truth. */
  onMessage?: (message: SDKMessage) => void;
}

/**
 * What the harness records from a run — exactly the facts worker.ts has always
 * kept on the attempt. Whether a submission happened is NOT reported here: the
 * harness knows that from its own `submit` closure, so an executor cannot
 * claim a submission that never went through the write surface.
 */
export interface WorkerExecutionOutcome {
  costUsd: number;
  /** Substrate session id — provenance only, never read back for state. */
  sessionId?: string;
  /** Loop failure, if any; the harness logs it and the no-submission path takes over. */
  error?: string;
}

export interface WorkerExecutor {
  execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome>;
}
