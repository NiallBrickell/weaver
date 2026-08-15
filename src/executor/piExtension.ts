import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionFactory,
  ProviderConfig,
  ToolDefinition,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

export const WEAVER_PI_PROVIDER_CONFIG_ENV = 'WEAVER_PI_PROVIDER_CONFIG';
export const WEAVER_PI_MCP_RELAYS_ENV = 'WEAVER_PI_MCP_RELAYS';
export const WEAVER_HARNESS_SUBMIT_URL_ENV = 'WEAVER_HARNESS_SUBMIT_URL';
export const WEAVER_HARNESS_SUBMIT_TOKEN_ENV = 'WEAVER_HARNESS_SUBMIT_TOKEN';

export interface WeaverPiProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface WeaverPiMcpRelayConfig {
  name: string;
  url: string;
  token: string;
}

interface McpToolDetails {
  kind: 'weaver-mcp-result';
  result: CallToolResult;
}

interface BridgeReply {
  text: string;
  isError?: boolean;
}

const PROVIDER_FIELDS = ['provider', 'model', 'baseUrl', 'apiKey'] as const;
const RELAY_FIELDS = ['name', 'url', 'token'] as const;
const MAX_TOOL_NAME_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactlyFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === fields.length && keys.every((key, index) => key === [...fields].sort()[index]);
}

function nonEmptyString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function httpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseProvider(raw: string | undefined): WeaverPiProviderConfig {
  let value: unknown;
  try {
    value = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    throw new Error('WEAVER_PI_PROVIDER_CONFIG is malformed');
  }
  if (!isRecord(value) || !hasExactlyFields(value, PROVIDER_FIELDS)) {
    throw new Error('WEAVER_PI_PROVIDER_CONFIG is missing or malformed');
  }
  const provider = nonEmptyString(value, 'provider');
  const model = nonEmptyString(value, 'model');
  const baseUrlValue = nonEmptyString(value, 'baseUrl');
  const apiKey = nonEmptyString(value, 'apiKey');
  const baseUrl = baseUrlValue ? httpUrl(baseUrlValue) : undefined;
  if (!provider || !model || !baseUrl || !apiKey) {
    throw new Error('WEAVER_PI_PROVIDER_CONFIG is missing or malformed');
  }
  return { provider, model, baseUrl, apiKey };
}

function parseRelays(raw: string | undefined): WeaverPiMcpRelayConfig[] {
  if (raw === undefined || raw.trim() === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('WEAVER_PI_MCP_RELAYS is malformed');
  }
  if (!Array.isArray(value)) throw new Error('WEAVER_PI_MCP_RELAYS is malformed');
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactlyFields(entry, RELAY_FIELDS)) {
      throw new Error('WEAVER_PI_MCP_RELAYS is malformed');
    }
    const name = nonEmptyString(entry, 'name');
    const urlValue = nonEmptyString(entry, 'url');
    const token = nonEmptyString(entry, 'token');
    const url = urlValue ? httpUrl(urlValue) : undefined;
    if (!name || !url || !token) throw new Error('WEAVER_PI_MCP_RELAYS is malformed');
    return { name, url, token };
  });
}

function parseSubmission(env: NodeJS.ProcessEnv): { url: string; token: string } {
  const rawUrl = env[WEAVER_HARNESS_SUBMIT_URL_ENV];
  const token = env[WEAVER_HARNESS_SUBMIT_TOKEN_ENV];
  const url = rawUrl ? httpUrl(rawUrl) : undefined;
  if (!url || !token) throw new Error('Weaver submission bridge is not configured');
  return { url: url.replace(/\/$/, ''), token };
}

function providerRegistration(config: WeaverPiProviderConfig): ProviderConfig {
  return {
    name: `Weaver run-bound ${config.provider}`,
    baseUrl: config.baseUrl,
    // The harness supplies a disposable, run-bound proxy bearer. Keeping it
    // directly in the in-memory provider registry lets us erase the aggregate
    // JSON environment variable before Pi can launch a shell tool.
    apiKey: config.apiKey,
    api: 'openai-completions',
    models: [{
      id: config.model,
      name: config.model,
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
  };
}

async function callSubmissionBridge(
  submission: { url: string; token: string },
  path: '/append-section' | '/submit-result',
  payload: unknown,
): Promise<BridgeReply> {
  let response: Response;
  try {
    response = await fetch(`${submission.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${submission.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Weaver submission bridge call failed');
  }

  let reply: unknown;
  try {
    reply = await response.json();
  } catch {
    throw new Error('Weaver submission bridge call failed');
  }
  if (!isRecord(reply) || typeof reply.text !== 'string' ||
    (reply.isError !== undefined && typeof reply.isError !== 'boolean')) {
    throw new Error('Weaver submission bridge call failed');
  }
  if (!response.ok || reply.isError === true) throw new Error(reply.text);
  return { text: reply.text };
}

function submissionTools(submission: { url: string; token: string }): ToolDefinition[] {
  return [{
    name: 'weaver_append_section',
    label: 'Append Weaver section',
    description: 'Append one ordered section to the current Weaver assignment deliverable.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', minLength: 1 } },
      required: ['content'],
      additionalProperties: false,
    } as ToolDefinition['parameters'],
    async execute(_toolCallId, args) {
      const reply = await callSubmissionBridge(submission, '/append-section', args);
      return { content: [{ type: 'text', text: reply.text }], details: {} };
    },
  }, {
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
    } as ToolDefinition['parameters'],
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const reply = await callSubmissionBridge(submission, '/submit-result', args);
      // submit_result is terminal for this disposable worker. Abort the current
      // agent loop only after Weaver accepted the durable proposal, so Pi cannot
      // spend one more provider turn merely to say it is finished.
      ctx.abort();
      return { content: [{ type: 'text', text: reply.text }], details: {} };
    },
  }];
}

function safeNameComponent(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'unnamed';
}

function allocateToolName(relayName: string, upstreamName: string, used: Set<string>): string {
  const full = `mcp__${safeNameComponent(relayName)}__${safeNameComponent(upstreamName)}`;
  for (let occurrence = 1; ; occurrence += 1) {
    const suffix = occurrence === 1 ? '' : `__${occurrence}`;
    const candidate = `${full.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function mcpContent(result: CallToolResult): AgentToolResult<McpToolDetails>['content'] {
  const content: AgentToolResult<McpToolDetails>['content'] = result.content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') {
      return { type: 'image', data: block.data, mimeType: block.mimeType };
    }
    return { type: 'text', text: JSON.stringify({ mcpContent: block }) };
  });
  if (result.structuredContent !== undefined) {
    content.push({
      type: 'text',
      text: JSON.stringify({ mcpStructuredContent: result.structuredContent }),
    });
  }
  return content;
}

function isMcpToolDetails(value: unknown): value is McpToolDetails {
  return isRecord(value) && value.kind === 'weaver-mcp-result' &&
    isRecord(value.result) && Array.isArray(value.result.content);
}

function relayTool(
  relay: WeaverPiMcpRelayConfig,
  upstream: Tool,
  client: Client,
  name: string,
): ToolDefinition {
  return {
    name,
    label: `${relay.name}: ${upstream.title ?? upstream.name}`,
    description: upstream.description ?? `Call ${upstream.name} on the ${relay.name} MCP server.`,
    // Pi 0.84.2's validator deliberately accepts plain JSON Schema in addition
    // to TypeBox schemas. Cloning the MCP schema preserves every constraint.
    parameters: structuredClone(upstream.inputSchema) as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, args, signal) {
      try {
        const raw = await client.callTool(
          { name: upstream.name, arguments: args as Record<string, unknown> },
          CallToolResultSchema,
          signal ? { signal } : undefined,
        );
        const result = CallToolResultSchema.parse(raw);
        return {
          content: mcpContent(result),
          details: { kind: 'weaver-mcp-result', result: structuredClone(result) },
        };
      } catch {
        // Transport errors can contain the authenticated URL or request
        // headers. The host relay already redacts valid tool results.
        throw new Error('configured MCP tool call failed');
      }
    },
  };
}

async function discoverRelays(
  pi: ExtensionAPI,
  relays: WeaverPiMcpRelayConfig[],
  clients: Client[],
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const relay of relays) {
    const client = new Client({ name: 'weaver-pi-extension', version: '0.1.0' });
    clients.push(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(relay.url), {
        requestInit: { headers: { Authorization: `Bearer ${relay.token}` } },
      }));
      const catalog = await client.listTools();
      for (const tool of catalog.tools) {
        const name = allocateToolName(relay.name, tool.name, names);
        pi.registerTool(relayTool(relay, tool, client, name));
      }
    } catch {
      throw new Error('failed to discover configured MCP relay');
    }
  }
  return names;
}

/**
 * The sole Pi extension loaded for a disposable Weaver worker run. All model,
 * submission, and operator-tool capabilities come from explicit run-bound
 * environment values; this extension performs no ambient discovery.
 */
export function createWeaverPiExtension(env: NodeJS.ProcessEnv = process.env): ExtensionFactory {
  return async (pi) => {
    const provider = parseProvider(env[WEAVER_PI_PROVIDER_CONFIG_ENV]);
    const relays = parseRelays(env[WEAVER_PI_MCP_RELAYS_ENV]);
    const submission = parseSubmission(env);

    // Pi's bash tool inherits process.env at execution time. Retain each
    // bearer only in the extension/provider closures after initial parsing.
    delete env[WEAVER_PI_PROVIDER_CONFIG_ENV];
    delete env[WEAVER_PI_MCP_RELAYS_ENV];
    delete env[WEAVER_HARNESS_SUBMIT_URL_ENV];
    delete env[WEAVER_HARNESS_SUBMIT_TOKEN_ENV];

    const clients: Client[] = [];
    let closePromise: Promise<void> | undefined;
    const close = () => {
      closePromise ??= Promise.allSettled(clients.map((client) => client.close())).then(() => undefined);
      return closePromise;
    };

    try {
      pi.registerProvider(provider.provider, providerRegistration(provider));
      for (const tool of submissionTools(submission)) pi.registerTool(tool);
      const mcpToolNames = await discoverRelays(pi, relays, clients);

      pi.on('tool_result', (event: ToolResultEvent) => {
        if (!mcpToolNames.has(event.toolName) || !isMcpToolDetails(event.details)) return;
        return { isError: event.details.result.isError === true };
      });
      pi.on('session_shutdown', async () => {
        await close();
      });
    } catch (error) {
      await close();
      throw error;
    }
  };
}

export default createWeaverPiExtension();
