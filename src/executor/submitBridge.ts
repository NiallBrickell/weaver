import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SubmitReply, SubmitSurface } from './types.js';
import {
  startToolBridge,
  type ToolBridge,
  type ToolBridgeOptions,
} from './toolBridge.js';

export type SubmitBridge = ToolBridge;
export type SubmitBridgeOptions = ToolBridgeOptions;

function toolResult(reply: SubmitReply) {
  return {
    content: [{ type: 'text' as const, text: reply.text }],
    ...(reply.isError ? { isError: true } : {}),
  };
}

function submitTools(submit: SubmitSurface) {
  return [
    tool(
      'append_section',
      'Append one ordered section to a long Weaver deliverable before submitting it.',
      { content: z.string().min(1) },
      async ({ content }) => toolResult(await submit.appendSection(content)),
    ),

    tool(
      'submit_result',
      'Finalize the one proposed result for this Weaver assignment.',
      {
        summary: z.string(),
        artifact: z.object({
          title: z.string(),
          kind: z.string(),
          file_name: z.string(),
          content: z.string(),
        }),
      },
      async (args) => toolResult(await submit.submitResult(args)),
    ),
  ];
}

/**
 * Expose Weaver's in-process submission closures to a disposable remote agent
 * loop. The bearer token is per-run and remains process-local; binding and
 * advertising are separate because a container may reach the host under a
 * different name than the interface on which Node listens.
 */
export async function startSubmitBridge(
  submit: SubmitSurface,
  options: SubmitBridgeOptions = {},
): Promise<SubmitBridge> {
  return startToolBridge(submitTools(submit), options);
}
