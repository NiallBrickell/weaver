/**
 * The reference executor: today's local `@anthropic-ai/claude-agent-sdk`
 * `query()` invocation, moved verbatim-in-spirit behind the WorkerExecutor
 * contract. Every load-bearing option (`tools`, `permissionMode`,
 * `persistSession`, `env`) is exactly what src/worker.ts passed before the
 * seam existed — this file is plumbing, not policy. The harness's submit
 * callbacks are wired into an SDK MCP server because that is how this
 * substrate exposes the Workstream submission API.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { providerFromModel } from '../modelConfig.js';
import { loadExecutorSecrets, redactSecrets, stripClaudeCredentials } from '../secrets.js';
import { isolatedClaudeApiHome, type PreparedClaudeApiHome } from './claudeApiHome.js';
import { containerSpawner, type ClaudeContainerConfig } from './claudeContainer.js';
import type {
  ExecutorIsolation,
  SubmitReply,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
  WorkerExecutor,
} from './types.js';

export interface LocalSdkExecutorOptions {
  /**
   * Run ORDINARY work's Claude Code process inside the rootless Docker worker
   * seam instead of as a host process (see claudeContainer.ts). A declared
   * action is never containerized: its calls are supervised live by Pilot and
   * it runs where the engine can read the effect back, exactly as before.
   */
  container?: ClaudeContainerConfig;
  /** Test seam. */
  runQuery?: typeof query;
  /** Test seam: the executor-only secret store an Anthropic-compatible
   * provider's bearer is read from. */
  loadExecutorSecrets?: typeof loadExecutorSecrets;
  /** Test seam. */
  prepareApiHome?: () => PreparedClaudeApiHome;
}

interface AnthropicCompatibleProvider {
  /** The provider's Anthropic-protocol endpoint the Claude Code binary is pointed at. */
  baseUrl: string;
  /** Executor-only secret names that hold the bearer, in preference order. */
  secretNames: readonly string[];
}

/**
 * Providers a `provider/model` worker target may name on this executor. The
 * Claude Code binary speaks the Anthropic protocol only, so a provider earns
 * an entry by publishing an Anthropic-compatible endpoint. Everything else is
 * refused rather than sent to Anthropic under the wrong name.
 *
 * Z.ai's coding plan (2026-09-16): the implementation seat the founder pays
 * for beside the Claude subscription. It is licence-restricted to coding, so
 * it reaches workers only through the reviewed `bounded-code-repair` route,
 * never a general seat; on the hosted fleet the run stays inside the same
 * worker container the subscription seat uses, with the bearer forwarded by
 * name exactly as the Claude identity is.
 */
const ANTHROPIC_COMPATIBLE_PROVIDERS: Record<string, AnthropicCompatibleProvider> = {
  'zai-coding-plan': {
    baseUrl: 'https://api.z.ai/api/anthropic',
    secretNames: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
  },
};

interface ResolvedWorkerIdentity {
  /** The model spelling the Claude Code binary is asked for. */
  model: string;
  env: Record<string, string | undefined>;
  /** Secret values that must never surface in an error or a message. */
  redactions: Record<string, string>;
  apiHome: PreparedClaudeApiHome | null;
}

/** Map a harness SubmitReply onto the SDK's MCP tool-result shape. */
function asToolResult(r: SubmitReply): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

export class LocalSdkExecutor implements WorkerExecutor {
  readonly id = 'local-sdk' as const;
  private readonly container: ClaudeContainerConfig | undefined;
  private readonly runQuery: typeof query;
  private readonly executorSecretsLoader: typeof loadExecutorSecrets;
  private readonly prepareApiHome: () => PreparedClaudeApiHome;

  /** Where the Claude Code process runs: the rootless Docker worker seam
   * when the host configured it, otherwise a process on the host itself. */
  get isolation(): ExecutorIsolation {
    return this.container ? 'managed-sandbox' : 'host-process';
  }

  constructor(options: LocalSdkExecutorOptions = {}) {
    this.container = options.container;
    this.runQuery = options.runQuery ?? query;
    this.executorSecretsLoader = options.loadExecutorSecrets ?? loadExecutorSecrets;
    this.prepareApiHome = options.prepareApiHome ?? (() => isolatedClaudeApiHome('weaver-claude-api-worker-'));
  }

  /**
   * A bare Claude model runs on the registered Claude identity sdkEnv already
   * placed in the request. A provider-qualified model swaps that identity for
   * the provider's bearer on its Anthropic-compatible endpoint: the Claude
   * credential is stripped so the run can never bill the subscription by
   * accident, the provider's own secret name is stripped so only the protocol
   * variables cross (the container forwards ANTHROPIC_* by name and nothing
   * else), and a host process gets a fresh config dir so the hosting user's
   * login cannot take precedence over the bearer.
   */
  private resolveIdentity(req: WorkerExecutionRequest, containerized: boolean): ResolvedWorkerIdentity {
    const provider = providerFromModel(req.model);
    if (provider === null) return { model: req.model, env: req.env, redactions: {}, apiHome: null };
    const compatible = ANTHROPIC_COMPATIBLE_PROVIDERS[provider];
    if (!compatible) {
      throw new Error(
        `local-sdk worker cannot run provider '${provider}' (${req.model}): the Claude Code binary reaches only ` +
          `Anthropic-compatible providers (${Object.keys(ANTHROPIC_COMPATIBLE_PROVIDERS).join(', ')})`,
      );
    }
    const model = req.model.slice(provider.length + 1);
    if (!model) throw new Error(`${provider} worker model must name a model after ${provider}/`);
    const registered = this.executorSecretsLoader();
    const secretName = compatible.secretNames.find((name) => registered[name]);
    if (!secretName) {
      throw new Error(
        `local-sdk worker on ${req.model} requires ${compatible.secretNames.join(' or ')} in executor-only secrets ` +
          '(`weaver secret set <NAME> --executor`)',
      );
    }
    const bearer = registered[secretName]!;
    const env: Record<string, string | undefined> = { ...req.env };
    stripClaudeCredentials(env);
    for (const name of compatible.secretNames) delete env[name];
    env.ANTHROPIC_BASE_URL = compatible.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = bearer;
    // Claude Code treats an absent key differently from an explicitly empty
    // one when a bearer is supplied (same rule as the OpenRouter coordinator).
    env.ANTHROPIC_API_KEY = '';
    let apiHome: PreparedClaudeApiHome | null = null;
    if (containerized) {
      // The container's HOME is the image root's, empty and discarded; the
      // host config dir never crosses (claudeContainer.ts NEVER_FORWARDED).
      delete env.CLAUDE_CONFIG_DIR;
    } else {
      apiHome = this.prepareApiHome();
      env.CLAUDE_CONFIG_DIR = apiHome.path;
    }
    return { model, env, redactions: { [secretName]: bearer }, apiHome };
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const containerized = this.container !== undefined && req.supervise === undefined;
    if (containerized && req.cwd === undefined) {
      throw new Error('a containerized local-sdk worker needs a working directory to mount');
    }
    const spawnClaudeCodeProcess = containerized
      ? containerSpawner(this.container!, {
          assignmentId: req.assignmentId,
          cwd: req.cwd!,
          additionalDirectories: req.additionalDirectories,
          workerVisibleEnv: req.workerVisibleEnv ?? {},
        })
      : undefined;
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
    let identity: ResolvedWorkerIdentity | null = null;
    try {
      identity = this.resolveIdentity(req, containerized);
      for await (const message of this.runQuery({
        prompt: req.prompt,
        options: {
          ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
          model: identity.model,
          systemPrompt: req.systemPrompt,
          tools: req.tools,
          env: identity.env,
          ...(req.cwd !== undefined
            ? { cwd: req.cwd, additionalDirectories: req.additionalDirectories }
            : {}),
          mcpServers: { ...req.operatorMcpServers, weaver: server } as never,
          allowedTools: req.allowedTools,
          permissionMode: req.permissionMode,
          ...(req.permissionMode === 'bypassPermissions'
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          settingSources: req.settingSources,
          strictMcpConfig: req.strictMcpConfig,
          ...(req.supervise ? { canUseTool: req.supervise as never } : {}),
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
      error = redactSecrets(e instanceof Error ? e.message : String(e), identity?.redactions ?? {});
    } finally {
      if (identity?.apiHome) {
        try { identity.apiHome.cleanup(); }
        catch (caught) {
          error = error ?? `temporary Claude API home cleanup failed: ${caught instanceof Error ? caught.message : String(caught)}`;
        }
      }
    }
    return {
      costUsd,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}
