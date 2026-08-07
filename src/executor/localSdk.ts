/**
 * The reference executor: today's local `@anthropic-ai/claude-agent-sdk`
 * `query()` invocation, moved verbatim-in-spirit behind the WorkerExecutor
 * contract. Every load-bearing option (`tools`, `permissionMode`,
 * `persistSession`, `env`) is exactly what src/worker.ts passed before the
 * seam existed — this file is plumbing, not policy. The harness's submit
 * callbacks are wired into an SDK MCP server here because that is how THIS
 * substrate exposes tools; the handlers themselves stay harness-owned.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  SubmitReply,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
  WorkerExecutor,
} from './types.js';

/** Map a harness SubmitReply onto the SDK's MCP tool-result shape. */
function asToolResult(r: SubmitReply): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

export class LocalSdkExecutor implements WorkerExecutor {
  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const server = createSdkMcpServer({
      name: 'weaver',
      version: '0.1.0',
      tools: [
        tool(
          'append_section',
          'Append one section of a long artifact, in order. Use for any deliverable longer than ~150 lines, then finish with submit_result (whose content may be empty — appended sections are included automatically).',
          { content: z.string().min(1) },
          async (a) => asToolResult(await req.submit.appendSection(a.content)),
        ),

        tool(
          'submit_result',
          'Finalize your submission. If you used append_section, the appended sections form the artifact body and content may be empty. Call exactly once.',
          {
            summary: z.string().describe('2-3 sentence faithful summary of what the artifact contains'),
            artifact: z.object({
              title: z.string(),
              kind: z.string().describe('e.g. report, job_description, outreach_email'),
              file_name: z.string(),
              content: z.string().describe('full content, or closing content / empty when sections were appended'),
            }),
          },
          async (a) => asToolResult(await req.submit.submitResult(a)),
        ),
      ],
    });

    let costUsd = 0;
    let sessionId: string | undefined;
    let error: string | undefined;
    try {
      for await (const message of query({
        prompt: req.prompt,
        options: {
          model: req.model,
          systemPrompt: req.systemPrompt,
          tools: req.tools,
          env: req.env,
          ...(req.cwd !== undefined
            ? { cwd: req.cwd, additionalDirectories: req.additionalDirectories }
            : {}),
          // The sandbox's ONE invariant is the write boundary (an action
          // cannot mutate outside its approved cwd — that is what stops a
          // misbriefed worker forging workstream state). Two carve-outs keep
          // that invariant while keeping Bash usable on THIS substrate:
          // session-env is Claude Code's own per-session Bash bootstrap dir
          // (its 2.1.223 update made the mkdir happen at Bash init — EPERM
          // there killed EVERY command, even `echo`), and network egress is
          // deliberately open because command-level judgment is pilot's job,
          // made per call with the full command visible — a domain allowlist
          // would re-gate what pilot already judged.
          ...(req.sandbox
            ? {
                sandbox: {
                  enabled: true,
                  autoAllowBashIfSandboxed: true,
                  failIfUnavailable: false,
                  filesystem: { allowWrite: [join(homedir(), '.claude', 'session-env')] },
                  network: { allowedDomains: ['*'] },
                },
              }
            : {}),
          mcpServers: { ...req.operatorMcpServers, weaver: server } as never,
          allowedTools: req.allowedTools,
          permissionMode: 'default',
          canUseTool: req.supervise as never,
          maxTurns: req.maxTurns,
          persistSession: false,
          abortController: req.abort,
        },
      })) {
        req.onMessage?.(message);
        if (message.type === 'result') {
          sessionId = message.session_id;
          costUsd = 'total_cost_usd' in message ? message.total_cost_usd : 0;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return {
      costUsd,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}
