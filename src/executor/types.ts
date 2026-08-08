/**
 * The WorkerExecutor seam: where a worker's model loop runs is a substrate
 * choice; what it is allowed to do never is.
 *
 * The executor owns the DISPOSABLE part of a worker run — the model loop and
 * normal coding-agent tool plumbing. The harness keeps the DURABLE part: it
 * builds the brief, loads action secrets, records the attempt, and supplies
 * the submit callback. `submit` is the only harness API a worker receives for
 * proposing Workstream state through the harness. The launch substrate, not
 * Weaver, owns process containment for ordinary workers in this MVP.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** Harness verdict on one live tool call for an explicitly declared action. */
export type ToolDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * Live per-call supervision supplied by the harness for action workers. An
 * ordinary worker uses the host's normal Claude Code permissions instead.
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
 * One fully-specified worker run. The executor's job is to run this request,
 * not reinterpret the assignment or manufacture durable state.
 */
export interface WorkerExecutionRequest {
  workstreamSlug: string;
  assignmentId: string;
  /** The complete brief: objective, briefing, acceptance criteria, secret NAMES, declared inputs. */
  prompt: string;
  /** Normal Claude Code behavior plus Weaver's bounded-assignment contract. */
  systemPrompt: {
    type: 'preset';
    preset: 'claude_code';
    append: string;
  };
  model: string;
  /** Ordinary workers use the complete Claude Code tool preset. */
  tools: { type: 'preset'; preset: 'claude_code' };
  /** Harness tools that never need a permission round trip. */
  allowedTools: string[];
  /** Ordinary workers run as normal unattended Code sessions; declared
   * actions retain Pilot's per-call supervision. */
  permissionMode: 'bypassPermissions' | 'default';
  /** Filesystem settings loaded by the SDK. Ordinary workers inherit Code's
   * normal settings; actions use only the explicitly supplied MCP surface so
   * a local allow rule cannot skip Pilot. */
  settingSources: Array<'user' | 'project' | 'local'>;
  strictMcpConfig: boolean;
  maxTurns: number;
  /** Working directory (action cwd, first declared source, or process cwd). */
  cwd?: string;
  /** Additional source/working directories; meaningful only when cwd is set. */
  additionalDirectories: string[];
  /** Subprocess environment, already secret-injected and API-key-stripped by
   * the harness — including the ephemeral env placeholders that carry MCP
   * header credentials (secureMcpHeaderCredentials keeps the values out of
   * SDK process arguments). Values in here must never reach durable state;
   * the harness holds the matching redaction set. */
  env: Record<string, string | undefined>;
  /** The operator's SECURED MCP server configs for the dirs this run touches:
   * header credential values are already replaced with env expansions whose
   * values ride `env` above. */
  operatorMcpServers: Record<string, unknown>;
  /** Present only for declared actions; every non-auto-allowed call hits Pilot. */
  supervise?: ToolSupervisor;
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
