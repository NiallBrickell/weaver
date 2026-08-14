import {
  createSdkMcpServer,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  Codex,
  type CodexOptions,
  type RunStreamedResult,
  type ThreadEvent,
  type ThreadOptions,
} from '@openai/codex-sdk';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startToolBridge, type BridgeToolDefinition, type ToolBridge } from './toolBridge.js';

const CODEX_COORDINATOR_TOKEN_ENV = 'WEAVER_CODEX_COORDINATOR_TOKEN';

export interface CoordinatorExecutionRequest {
  prompt: string;
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
  error?: string;
}

export interface CoordinatorExecutor {
  readonly id: string;
  execute(req: CoordinatorExecutionRequest): Promise<CoordinatorExecutionOutcome>;
}

export class ClaudeCoordinatorExecutor implements CoordinatorExecutor {
  readonly id = 'local-sdk' as const;

  async execute(req: CoordinatorExecutionRequest): Promise<CoordinatorExecutionOutcome> {
    const server = createSdkMcpServer({
      name: 'weaver',
      version: '0.1.0',
      tools: req.tools,
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
          env: req.env,
          abortController: req.abort,
        },
      })) {
        req.onClaudeMessage?.(message);
        if (message.type === 'result') {
          sessionId = message.session_id;
          costUsd = 'total_cost_usd' in message ? message.total_cost_usd : 0;
          if (message.is_error) error = 'Claude coordinator result reported an error';
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      costUsd,
      ...(sessionId ? { sessionId } : {}),
      ...(error ? { error } : {}),
    };
  }
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
        if (event.type === 'turn.completed') completed = true;
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
      error = caught instanceof Error ? caught.message : String(caught);
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
      ...(error ? { error } : {}),
    };
  }
}

export function selectCoordinatorExecutor(name: string): CoordinatorExecutor {
  if (name === 'local-sdk') return new ClaudeCoordinatorExecutor();
  if (name === 'codex-sdk') return new CodexCoordinatorExecutor();
  throw new Error(
    `unknown coordinator executor '${name}' — supported: local-sdk, codex-sdk`,
  );
}
