/**
 * The only Weaver extension loaded into Pi/Prime harness-eval runs.
 *
 * Keep this file dependency-free: both CLIs load it from Weaver's checkout,
 * while their extension package dependencies live beside the installed CLI.
 * The per-run bearer and endpoint are process plumbing supplied by Weaver;
 * neither is written to a session because eval runs use --no-session.
 */

const url = process.env.WEAVER_HARNESS_SUBMIT_URL;
const token = process.env.WEAVER_HARNESS_SUBMIT_TOKEN;

async function relay(path: string, payload: unknown): Promise<{ text: string; isError?: boolean }> {
  if (!url || !token) throw new Error('Weaver submission bridge is not configured');
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const reply = await response.json() as { text?: unknown; isError?: unknown };
  const text = typeof reply.text === 'string' ? reply.text : `Weaver bridge returned HTTP ${response.status}`;
  if (!response.ok || reply.isError === true) throw new Error(text);
  return { text };
}

export default function (pi: any) {
  pi.registerTool({
    name: 'weaver_append_section',
    label: 'Append Weaver section',
    description: 'Append one ordered section to the current Weaver assignment deliverable.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', minLength: 1 } },
      required: ['content'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: { content: string }) {
      const reply = await relay('/append-section', args);
      return { content: [{ type: 'text', text: reply.text }], details: {} };
    },
  });

  pi.registerTool({
    name: 'weaver_submit_result',
    label: 'Submit Weaver result',
    description: 'Finalize the one proposed result for the current Weaver assignment.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        artifact: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            kind: { type: 'string' },
            file_name: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title', 'kind', 'file_name', 'content'],
          additionalProperties: false,
        },
      },
      required: ['summary', 'artifact'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: unknown) {
      const reply = await relay('/submit-result', args);
      return { content: [{ type: 'text', text: reply.text }], details: {} };
    },
  });
}
