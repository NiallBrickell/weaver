import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  Codex,
  type CodexOptions,
  type RunStreamedResult,
  type ThreadEvent,
  type ThreadOptions,
  type Usage as CodexUsage,
} from '@openai/codex-sdk';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadExecutorSecrets,
  redactSecrets,
  stripClaudeCredentials,
} from '../secrets.js';
import { coordinatorEffort, effortForModel } from '../modelConfig.js';
import type { PassUsage } from '../types.js';
import { startToolBridge, type BridgeToolDefinition, type ToolBridge } from './toolBridge.js';

const CODEX_COORDINATOR_TOKEN_ENV = 'WEAVER_CODEX_COORDINATOR_TOKEN';

export interface CoordinatorExecutionRequest {
  prompt: string;
  /** Length of the prompt's leading part that changes only on a real write
   * (the fixed opening line, policies, title, §1, §2). An executor may cache
   * it across passes; it never changes the text the model reads. Absent means
   * the prompt has no stable part worth marking. */
  stablePrefixLength?: number;
  systemPrompt: string;
  model: string;
  tools: BridgeToolDefinition[];
  env: Record<string, string | undefined>;
  abort: AbortController;
  onClaudeMessage?: (message: SDKMessage) => void;
  onCodexEvent?: (event: ThreadEvent) => void;
}

export interface CoordinatorExecutionOutcome {
  costUsd: number;
  sessionId?: string;
  /** Provider-reported token anatomy; absent when the run ended before the
   * provider reported any. Provenance only. */
  usage?: PassUsage;
  error?: string;
}

export interface CoordinatorExecutor {
  readonly id: string;
  execute(req: CoordinatorExecutionRequest): Promise<CoordinatorExecutionOutcome>;
}

export const PROJECTION_CACHE_MARKER_ENV = 'WEAVER_PROJECTION_CACHE_MARKER';

/** A provider rejected the marker in this process (the Messages API allows
 * four cache breakpoints per request; Claude Code already spends three). Every
 * later pass in the process sends the projection as one block, the behaviour
 * before the marker existed, so one rejection costs one pass, not the fleet. */
let projectionCacheMarkerRejected = false;

/** Test seam: forget an in-process rejection. */
export function resetProjectionCacheMarkerRejection(): void {
  projectionCacheMarkerRejected = false;
}

/** On unless the operator sets WEAVER_PROJECTION_CACHE_MARKER=0. */
export function projectionCacheMarkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROJECTION_CACHE_MARKER_ENV]?.trim() !== '0';
}

type TextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl: '1h' } };

/**
 * The user content blocks for a pass whose stable prefix gets its own cache
 * breakpoint, or null to send the prompt as the single block it always was.
 *
 * Claude Code marks two system blocks and the end of the last message on
 * every request, so this marker is the fourth and last breakpoint the
 * Messages API allows (docs/cost-reduction-plan.md#pass-anatomy-measured-2026-09-29
 * has the captured requests), and only while its remote flags are off — the
 * caller disables them. The TTL is pinned to one hour: the prefix only
 * pays off when this workstream's next pass reads it, which is minutes to
 * hours away, and the API requires every 1h breakpoint to precede every 5m
 * one, so the caller also pins Claude Code's own markers to 1h. Only the
 * first-party Anthropic path gets it: OpenRouter seats run other providers'
 * models and cash billing, and have never been verified with it.
 */
export function projectionCacheBlocks(
  req: Pick<CoordinatorExecutionRequest, 'prompt' | 'stablePrefixLength' | 'model'>,
  env: Record<string, string | undefined>,
): TextBlock[] | null {
  if (!projectionCacheMarkerEnabled() || projectionCacheMarkerRejected) return null;
  if (req.model.startsWith('openrouter/')) return null;
  const at = req.stablePrefixLength;
  if (at === undefined || at <= 0 || at >= req.prompt.length) return null;
  // The operator turned caching off for Claude Code; a lone marker of ours
  // would turn it back on at the write price.
  const cachingDisabled = Object.entries(env).some(([name, value]) =>
    name.startsWith('DISABLE_PROMPT_CACHING') && value !== undefined && value.trim() !== '' &&
    !/^(0|false|no|off)$/i.test(value.trim()));
  if (cachingDisabled) return null;
  return [
    { type: 'text', text: req.prompt.slice(0, at), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: req.prompt.slice(at) },
  ];
}

/** One user turn carrying explicit content blocks. With an SDK MCP server the
 * SDK keeps stdin open until the first result, as it does for a string. */
async function* singleUserTurn(content: TextBlock[]): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

const CACHE_MARKER_REJECTION = /cache_control/i;

interface PreparedClaudeApiHome {
  path: string;
  cleanup(): void;
}

export interface ClaudeCoordinatorExecutorDependencies {
  runQuery?: typeof query;
  loadExecutorSecrets?: typeof loadExecutorSecrets;
  prepareApiHome?: () => PreparedClaudeApiHome;
}

function isolatedClaudeApiHome(): PreparedClaudeApiHome {
  const path = mkdtempSync(join(tmpdir(), 'weaver-claude-api-coordinator-'));
  return {
    path,
    cleanup() { rmSync(path, { recursive: true, force: true }); },
  };
}

export class ClaudeCoordinatorExecutor implements CoordinatorExecutor {
  readonly id = 'local-sdk' as const;

  private readonly runQuery: typeof query;
  private readonly executorSecretsLoader: typeof loadExecutorSecrets;
  private readonly prepareApiHome: () => PreparedClaudeApiHome;

  constructor(dependencies: ClaudeCoordinatorExecutorDependencies = {}) {
    this.runQuery = dependencies.runQuery ?? query;
    this.executorSecretsLoader = dependencies.loadExecutorSecrets ?? loadExecutorSecrets;
    this.prepareApiHome = dependencies.prepareApiHome ?? isolatedClaudeApiHome;
  }

  async execute(req: CoordinatorExecutionRequest): Promise<CoordinatorExecutionOutcome> {
    const server = createSdkMcpServer({
      name: 'weaver',
      version: '0.1.0',
      tools: req.tools,
    });
    let costUsd = 0;
    let sessionId: string | undefined;
    let usage: PassUsage | undefined;
    let toolCalls = 0;
    let error: string | undefined;
    let apiHome: PreparedClaudeApiHome | null = null;
    let model = req.model;
    let env = req.env;
    let redactions: Record<string, string> = {};
    try {
      if (model.startsWith('openrouter/')) {
        model = model.slice('openrouter/'.length);
        if (!model) throw new Error('OpenRouter coordinator model must name a model after openrouter/');
        const key = this.executorSecretsLoader().OPENROUTER_API_KEY;
        if (!key) {
          throw new Error(
            'OpenRouter coordinator requires OPENROUTER_API_KEY in executor-only secrets',
          );
        }
        redactions = { OPENROUTER_API_KEY: key };
        apiHome = this.prepareApiHome();
        env = { ...req.env };
        stripClaudeCredentials(env);
        delete env.OPENROUTER_API_KEY;
        env.CLAUDE_CONFIG_DIR = apiHome.path;
        env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
        env.ANTHROPIC_AUTH_TOKEN = key;
        // Claude Code treats an absent key differently from an explicitly
        // empty one on its supported OpenRouter route.
        env.ANTHROPIC_API_KEY = '';
      } else {
        const registered = this.executorSecretsLoader();
        // A registered headless identity is distinct from the operator's local
        // Claude Code login. Give setup-tokens and API keys the same fresh,
        // empty config boundary so a service process can never inherit hooks,
        // settings, or device state from the hosting user. The setup-token
        // remains preferred, matching sdkEnv's one-principal rule.
        const setupToken = registered.CLAUDE_CODE_OAUTH_TOKEN;
        const apiKey = setupToken ? undefined : registered.ANTHROPIC_API_KEY;
        const identity = setupToken
          ? { name: 'CLAUDE_CODE_OAUTH_TOKEN' as const, value: setupToken }
          : apiKey
            ? { name: 'ANTHROPIC_API_KEY' as const, value: apiKey }
            : undefined;
        if (identity) {
          redactions = { [identity.name]: identity.value };
          apiHome = this.prepareApiHome();
          env = { ...req.env };
          stripClaudeCredentials(env);
          delete env.ANTHROPIC_BASE_URL;
          delete env.OPENROUTER_API_KEY;
          env.CLAUDE_CONFIG_DIR = apiHome.path;
          env[identity.name] = identity.value;
        }
      }
      const blocks = projectionCacheBlocks(req, env);
      if (blocks) {
        // Claude Code's remote feature flags are bucketed per config dir, and
        // a fresh one (every hosted pass) drew tengu_basalt_spur in 3 of 8
        // sessions: it marks the second-to-last message too, which with our
        // marker is five breakpoints and a 400 on every turn after the first.
        // Code defaults keep the count at four; the captured request bodies
        // were otherwise identical.
        env = { ...env, ENABLE_PROMPT_CACHING_1H: '1', DISABLE_GROWTHBOOK: '1' };
        // FORCE_PROMPT_CACHING_5M outranks ENABLE_PROMPT_CACHING_1H in Claude
        // Code and would put 5m breakpoints after our 1h one: a 400.
        delete env.FORCE_PROMPT_CACHING_5M;
      }
      // Claude Code otherwise sends each pass's whole first prompt (the full
      // projection, ~60k chars) to a small model just to title the session,
      // at every pass. A coordinator session is never browsed by title, and
      // the rest of what this switches off (telemetry, error reporting,
      // update checks) is equally nothing a controller pass needs.
      env = { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
      const effort = effortForModel(req.model, coordinatorEffort());
      for await (const message of this.runQuery({
        prompt: blocks ? singleUserTurn(blocks) : req.prompt,
        options: {
          model,
          // Pinned: see coordinatorEffort in modelConfig.
          ...(effort ? { effort } : {}),
          systemPrompt: req.systemPrompt,
          // The coordinator is a controller over typed state, not a worker.
          // Its only capabilities are the revision-checked Weaver tools.
          tools: [],
          mcpServers: { weaver: server },
          allowedTools: ['mcp__weaver__*'],
          permissionMode: 'dontAsk',
          settingSources: [],
          strictMcpConfig: true,
          maxTurns: 60,
          persistSession: false,
          env,
          abortController: req.abort,
        },
      })) {
        req.onClaudeMessage?.(message);
        if (message.type === 'assistant') {
          toolCalls += message.message.content.filter((block) => block.type === 'tool_use').length;
        }
        if (message.type === 'result') {
          sessionId = message.session_id;
          costUsd = 'total_cost_usd' in message ? message.total_cost_usd : 0;
          usage = claudePassUsage(message, toolCalls);
          if (message.is_error) {
            error = 'Claude coordinator result reported an error';
            const detail = message.subtype === 'success' ? message.result : message.errors.join('; ');
            if (blocks && CACHE_MARKER_REJECTION.test(detail)) {
              projectionCacheMarkerRejected = true;
              error = `${error}: the provider rejected the projection cache marker (${redactSecrets(detail, redactions).slice(0, 300)}); later passes in this process send the projection as one block`;
            }
          }
        }
      }
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      error = redactSecrets(raw, redactions);
    } finally {
      if (apiHome) {
        try { apiHome.cleanup(); }
        catch (caught) {
          error = error ?? `temporary Claude API home cleanup failed: ${caught instanceof Error ? caught.message : String(caught)}`;
        }
      }
    }
    return {
      costUsd,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
      ...(error ? { error } : {}),
    };
  }
}

/** The Claude result's usage is already summed across every model request in
 * the pass (Claude Code accumulates it), so it maps one-to-one. */
export function claudePassUsage(result: SDKResultMessage, toolCalls: number): PassUsage {
  const u = result.usage;
  const byTtl = u.cache_creation;
  return {
    inputTokens: u.input_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens,
    ...(byTtl
      ? {
          cacheCreation1hInputTokens: byTtl.ephemeral_1h_input_tokens,
          cacheCreation5mInputTokens: byTtl.ephemeral_5m_input_tokens,
        }
      : {}),
    outputTokens: u.output_tokens,
    modelTurns: result.num_turns,
    toolCalls,
  };
}

interface CodexThreadLike {
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<RunStreamedResult>;
}

interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

interface PreparedCodexHome {
  path: string;
  cleanup(): void;
}

export interface CodexCoordinatorExecutorDependencies {
  createCodex?: (options: CodexOptions) => CodexLike;
  startBridge?: typeof startToolBridge;
  prepareHome?: () => PreparedCodexHome;
}

function stringEnv(env: CoordinatorExecutionRequest['env']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function isolatedCodexHome(): PreparedCodexHome {
  const source = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const auth = join(source, 'auth.json');
  if (!existsSync(auth)) {
    throw new Error(`Codex coordinator requires a local ChatGPT login at ${auth}; run codex login`);
  }
  const path = mkdtempSync(join(tmpdir(), 'weaver-codex-coordinator-'));
  try {
    // Reference the ambient login without reading or copying the credential.
    // Removing this temporary directory unlinks only the link; rm never
    // follows it to the operator's real auth file.
    symlinkSync(auth, join(path, 'auth.json'));
    return {
      path,
      cleanup() { rmSync(path, { recursive: true, force: true }); },
    };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

/**
 * One fresh Codex coordinator thread over the same revision-checked tools as
 * Claude. The temporary CODEX_HOME carries only a symlink to the local
 * ChatGPT login: no user MCP servers, skills, instructions, hooks, or session
 * state enter the evaluative seat, and the link is destroyed after the pass.
 */
export class CodexCoordinatorExecutor implements CoordinatorExecutor {
  readonly id = 'codex-sdk' as const;

  private readonly createCodex: (options: CodexOptions) => CodexLike;
  private readonly startBridge: typeof startToolBridge;
  private readonly prepareHome: () => PreparedCodexHome;

  constructor(dependencies: CodexCoordinatorExecutorDependencies = {}) {
    this.createCodex = dependencies.createCodex ?? ((options) => new Codex(options));
    this.startBridge = dependencies.startBridge ?? startToolBridge;
    this.prepareHome = dependencies.prepareHome ?? isolatedCodexHome;
  }

  async execute(req: CoordinatorExecutionRequest): Promise<CoordinatorExecutionOutcome> {
    if (req.abort.signal.aborted) {
      return { costUsd: 0, error: 'Codex coordinator was aborted before launch' };
    }

    let bridge: ToolBridge | null = null;
    let home: PreparedCodexHome | null = null;
    let sessionId: string | undefined;
    let completed = false;
    let usage: PassUsage | undefined;
    let toolCalls = 0;
    let error: string | undefined;
    try {
      home = this.prepareHome();
      bridge = await this.startBridge(req.tools, {
        rejectArgumentValues: [home.path],
        rejectArgumentMessage:
          'REFUSED: this path belongs to the disposable coordinator process and will be deleted; choose a durable workspace outside the coordinator runtime',
      });
      const env = stringEnv(req.env);
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      delete env.OPENROUTER_API_KEY;
      // Registered Claude identity (sdkEnv) must not enter an OpenAI-steered
      // process — cross-principal credentials stop at the executor boundary.
      stripClaudeCredentials(env);
      env.CODEX_HOME = home.path;
      env[CODEX_COORDINATOR_TOKEN_ENV] = bridge.token;

      const codex = this.createCodex({
        env,
        config: {
          forced_login_method: 'chatgpt',
          developer_instructions: req.systemPrompt,
          include_environment_context: false,
          include_permissions_instructions: false,
          include_collaboration_mode_instructions: false,
          include_apps_instructions: false,
          history: { persistence: 'none' },
          agents: { enabled: false },
          features: {
            shell_tool: false,
            unified_exec: false,
            shell_snapshot: false,
            skill_mcp_dependency_install: false,
            apply_patch_freeform: false,
            apps: false,
            plugins: false,
            hooks: false,
            multi_agent: false,
            browser_use: false,
            computer_use: false,
            goals: false,
            image_generation: false,
            js_repl: false,
            exec_permission_approvals: false,
            request_permissions_tool: false,
            search_tool: false,
            standalone_web_search: false,
            tool_suggest: false,
          },
          web_search: 'disabled',
          mcp_servers: {
            weaver: {
              url: bridge.url,
              bearer_token_env_var: CODEX_COORDINATOR_TOKEN_ENV,
              required: true,
              enabled: true,
              enabled_tools: req.tools.map((definition) => definition.name),
              // Explicit owner approval is safe only because this isolated,
              // per-pass server exposes exactly the revision-checked Weaver
              // mutation tools listed above. `auto` can still ask a reviewer,
              // which a headless `approvalPolicy: never` run then cancels.
              default_tools_approval_mode: 'approve',
            },
          },
        },
      });
      const thread = codex.startThread({
        model: req.model,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        workingDirectory: home.path,
        skipGitRepoCheck: true,
      });
      const streamed = await thread.runStreamed(
        req.prompt,
        { signal: req.abort.signal },
      );

      for await (const event of streamed.events) {
        req.onCodexEvent?.(event);
        if (event.type === 'thread.started') sessionId = event.thread_id;
        if (event.type === 'turn.completed') {
          completed = true;
          usage = addCodexUsage(usage, event.usage);
        }
        if (event.type === 'item.completed' && event.item.type === 'mcp_tool_call') toolCalls++;
        if (event.type === 'turn.failed') error = event.error.message;
        if (event.type === 'error') error = event.message;
        if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          if (
            ['command_execution', 'file_change', 'web_search'].includes(event.item.type) ||
            (event.item.type === 'mcp_tool_call' && event.item.server !== 'weaver')
          ) {
            const capability = event.item.type === 'mcp_tool_call'
              ? `MCP server ${event.item.server}`
              : event.item.type;
            error = `Codex coordinator exposed forbidden ${capability} capability`;
            req.abort.abort(error);
          } else if (event.item.type === 'error') {
            error = event.item.message;
          }
        }
      }
      if (!completed && !error) error = 'Codex coordinator stream ended without turn.completed';
    } catch (caught) {
      // The SDK throws `Codex Exec exited with code N: <stderr>` only AFTER the
      // event stream has yielded the real failure. A usage limit arrives as a
      // `turn.failed` event whose message is the only capacity signal — stderr
      // is just "Reading prompt from stdin…", and letting the exit text clobber
      // the event diagnosis defeats infrastructure classification, burning pass
      // strikes on a provider outage. The event-reported failure wins; the exit
      // detail is only kept when the stream itself never said why.
      const thrown = caught instanceof Error ? caught.message : String(caught);
      error = error ? `${error} (stream exit: ${thrown})` : thrown;
    } finally {
      if (bridge) {
        try { await bridge.close(); }
        catch (caught) { error = error ?? `coordinator tool bridge close failed: ${caught instanceof Error ? caught.message : String(caught)}`; }
      }
      if (home) {
        try { home.cleanup(); }
        catch (caught) { error = error ?? `temporary Codex home cleanup failed: ${caught instanceof Error ? caught.message : String(caught)}`; }
      }
    }

    return {
      costUsd: 0,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage: { ...usage, toolCalls } } : {}),
      ...(error ? { error } : {}),
    };
  }
}

/** Codex reports usage per turn; a coordinator pass is one turn today, but
 * summing keeps the record honest if a pass ever spans more. OpenAI's
 * input_tokens already INCLUDES cached_input_tokens — kept as reported. */
function addCodexUsage(total: PassUsage | undefined, turn: CodexUsage): PassUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + turn.input_tokens,
    cacheReadInputTokens: (total?.cacheReadInputTokens ?? 0) + turn.cached_input_tokens,
    cacheCreationInputTokens: (total?.cacheCreationInputTokens ?? 0) + (turn.cache_write_input_tokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + turn.output_tokens,
    reasoningOutputTokens: (total?.reasoningOutputTokens ?? 0) + (turn.reasoning_output_tokens ?? 0),
    toolCalls: 0,
  };
}

export function selectCoordinatorExecutor(name: string): CoordinatorExecutor {
  if (name === 'local-sdk') return new ClaudeCoordinatorExecutor();
  if (name === 'codex-sdk') return new CodexCoordinatorExecutor();
  throw new Error(
    `unknown coordinator executor '${name}' — supported: local-sdk, codex-sdk`,
  );
}
