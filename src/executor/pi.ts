import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ExecutorTelemetry,
  ExecutorUsage,
  SubmitSurface,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
  WorkerExecutor,
} from './types.js';
import { loadExecutorSecrets, redactSecrets } from '../secrets.js';
import { startMcpRelay, type McpRelay } from './mcpRelay.js';
import {
  startProviderProxy,
  type ProviderProxy,
  type ProviderProxyOptions,
} from './providerProxy.js';
import {
  startExtensionSubmitBridge,
  type ExtensionSubmitBridge,
} from './extensionSubmitBridge.js';

const EXTENSION_PATH = resolve(import.meta.dirname, 'piExtension.ts');
const PRIME_RPC_ENTRY_PATH = resolve(import.meta.dirname, 'primeAgentRpcEntry.mjs');
const PI_RPC_ENTRY_PATH = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
const PI_RUNTIME_VERSION = (() => {
  const manifest = JSON.parse(
    readFileSync(resolve(dirname(PI_RPC_ENTRY_PATH), '../package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error('packaged Pi runtime has no version');
  return manifest.version;
})();
const NULL_USAGE: ExecutorUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
};

const PROVIDER_CREDENTIALS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  'azure-openai': ['AZURE_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  google: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'prime-inference': ['PRIME_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding': ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  'amazon-bedrock': [
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
  ],
};
const ALL_PROVIDER_CREDENTIALS = new Set([
  ...Object.values(PROVIDER_CREDENTIALS).flat(),
  // Keep newly configured credentials fail-closed even when the selected
  // provider has no mapping in this adapter epoch.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'PRIME_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZHIPU_API_KEY',
]);

interface PiProviderConfiguration {
  apiKey: string;
  apiKeyNames: readonly string[];
  upstreamBaseUrl: string;
}

const PI_PROVIDERS: Record<string, Omit<PiProviderConfiguration, 'apiKey'>> = {
  openrouter: {
    apiKeyNames: ['OPENROUTER_API_KEY'],
    upstreamBaseUrl: 'https://openrouter.ai/api/v1',
  },
  zai: {
    apiKeyNames: ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
    upstreamBaseUrl: 'https://api.z.ai/api/paas/v4',
  },
  'zai-coding-plan': {
    apiKeyNames: ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
    upstreamBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  },
  'prime-inference': {
    apiKeyNames: ['PRIME_API_KEY'],
    upstreamBaseUrl: 'https://api.pinference.ai/api/v1',
  },
};

interface NamedMcpRelay {
  name: string;
  relay: McpRelay;
}

interface RpcRecord {
  type?: unknown;
  id?: unknown;
  success?: unknown;
  data?: unknown;
  error?: unknown;
  message?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

interface AssistantMessage {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: unknown;
}

interface RpcState {
  sessionId: string | null;
  provider: string | null;
  model: string | null;
}

export interface PiRpcRunResult {
  providerResolved: string | null;
  modelResolved: string | null;
  usage: ExecutorUsage;
  costUsd: number | null;
  /** True only when Pi reported an aborted agent turn, not a provider error. */
  aborted?: boolean;
  error: string | null;
}

export interface PiRpcRuntime {
  readonly harnessVersion: string;
  readonly sessionId: string | null;
  run(prompt: string, signal: AbortSignal): Promise<PiRpcRunResult>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface StartPiRpcRuntimeInput {
  command: 'pi' | 'prime-agent';
  cwd: string;
  provider: string;
  model: string;
  systemPrompt: string;
  maxTurns: number;
  env: Record<string, string>;
  extensionPath: string;
}

export type StartPiRpcRuntime = (input: StartPiRpcRuntimeInput) => Promise<PiRpcRuntime>;

export interface PiExecutorDependencies {
  startRuntime?: StartPiRpcRuntime;
  startBridge?: (
    submit: SubmitSurface,
    options: { redactionSecrets: Record<string, string> },
  ) => Promise<ExtensionSubmitBridge>;
  startProviderProxy?: (options: ProviderProxyOptions) => Promise<ProviderProxy>;
  startMcpRelay?: typeof startMcpRelay;
  loadExecutorSecrets?: typeof loadExecutorSecrets;
  /** Deterministic test override; production reloads from disk per attempt. */
  executorSecrets?: Record<string, string>;
  now?: () => number;
  /** Test seam for the isolated-root removal (ENOTEMPTY race simulation). */
  removeDirectory?: (path: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); }
  catch { return String(error); }
}

export function splitPiModel(target: string): { provider: string; model: string } {
  const slash = target.indexOf('/');
  if (slash <= 0 || slash === target.length - 1) {
    throw new Error(`Pi/Prime targets require a provider-qualified model (provider/model), got '${target}'`);
  }
  return { provider: target.slice(0, slash), model: target.slice(slash + 1) };
}

export function validatePiRpcState(
  input: Pick<StartPiRpcRuntimeInput, 'command' | 'provider' | 'model'>,
  data: unknown,
): RpcState {
  if (!isRecord(data)) throw new Error(`${input.command} get_state returned no data`);
  const model = isRecord(data.model) ? data.model : {};
  const state: RpcState = {
    sessionId: optionalString(data.sessionId),
    provider: optionalString(model.provider),
    model: optionalString(model.id) ?? optionalString(model.model),
  };
  if (state.provider !== input.provider || state.model !== input.model) {
    throw new Error(
      `${input.command} selected ${state.provider ?? 'unknown'}/${state.model ?? 'unknown'} ` +
      `instead of requested ${input.provider}/${input.model}`,
    );
  }
  if (input.command === 'prime-agent' && isRecord(data.goal) && data.goal.active === true) {
    throw new Error('Prime Agent started with an active goal; refusing non-disposable eval state');
  }
  return state;
}

function stringEnv(env: WorkerExecutionRequest['env']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function scopedEnvironment(
  req: WorkerExecutionRequest,
  executorSecrets: Record<string, string>,
): { env: Record<string, string>; redactionSecrets: Record<string, string> } {
  const env = stringEnv(req.env);
  for (const name of ALL_PROVIDER_CREDENTIALS) {
    delete env[name];
  }
  const redactionSecrets: Record<string, string> = { ...executorSecrets };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('WEAVER_INTERNAL_MCP_')) continue;
    redactionSecrets[name] = value;
    delete env[name];
  }
  return { env, redactionSecrets };
}

function findExecutable(command: string, env: Record<string, string>): string {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`cannot find ${command} on PATH`);
}

function primeAgentInstallation(env: Record<string, string>): {
  version: string;
  moduleUrl: string;
} {
  let directory = dirname(findExecutable('prime-agent', env));
  while (true) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === 'prime-agent' && typeof manifest.version === 'string') {
        const modulePath = join(directory, 'dist', 'index.js');
        if (!existsSync(modulePath)) {
          throw new Error(`Prime Agent ${manifest.version} does not expose its in-process SDK at ${modulePath}`);
        }
        return { version: manifest.version, moduleUrl: pathToFileURL(modulePath).href };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('installed prime-agent executable is not backed by an embeddable Node package');
}

export function summarizePiRpcUsage(
  messages: Array<{ usage?: unknown }>,
): { usage: ExecutorUsage; costUsd: number | null } {
  let sawUsage = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cost = 0;
  let sawCost = false;
  for (const message of messages) {
    if (!isRecord(message.usage)) continue;
    const nextInput = optionalNumber(message.usage.input);
    const nextOutput = optionalNumber(message.usage.output);
    const nextCacheRead = optionalNumber(message.usage.cacheRead);
    if (nextInput !== null) { input += nextInput; sawUsage = true; }
    if (nextOutput !== null) { output += nextOutput; sawUsage = true; }
    if (nextCacheRead !== null) { cacheRead += nextCacheRead; sawUsage = true; }
    if (isRecord(message.usage.cost)) {
      const nextCost = optionalNumber(message.usage.cost.total);
      if (nextCost !== null) { cost += nextCost; sawCost = true; }
    }
  }
  return {
    usage: sawUsage ? {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cacheRead,
      reasoningOutputTokens: null,
    } : { ...NULL_USAGE },
    costUsd: sawCost ? cost : null,
  };
}

class CliRpcRuntime implements PiRpcRuntime {
  readonly harnessVersion: string;
  sessionId: string | null = null;
  private state: RpcState = { sessionId: null, provider: null, model: null };
  private stdoutBuffer = '';
  private stderr = '';
  private sequence = 0;
  private exited = false;
  private closing = false;
  private exitError: Error | null = null;
  private readonly pending = new Map<string, {
    resolve: (record: RpcRecord) => void;
    reject: (error: Error) => void;
  }>();
  private agentEnd: { resolve: (record: RpcRecord) => void; reject: (error: Error) => void } | null = null;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    harnessVersion: string,
  ) {
    this.harnessVersion = harnessVersion;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-32_768);
    });
    child.once('error', (error) => this.fail(error));
    child.once('close', (code, signal) => {
      this.exited = true;
      const interruptedActiveCall = this.pending.size > 0 || this.agentEnd !== null;
      if (!this.closing && (code !== 0 || interruptedActiveCall) && !this.exitError) {
        this.exitError = new Error(`RPC process exited (${code ?? signal ?? 'unknown'}): ${this.stderr.trim() || 'no stderr'}`);
      }
      if (this.exitError) this.fail(this.exitError);
    });
  }

  static async start(input: StartPiRpcRuntimeInput): Promise<CliRpcRuntime> {
    const prime = input.command === 'prime-agent' ? primeAgentInstallation(input.env) : null;
    const version = prime?.version ?? PI_RUNTIME_VERSION;
    const harnessArgs = buildPiRpcArgs(input);
    const command = process.execPath;
    const args = input.command === 'prime-agent'
      ? [PRIME_RPC_ENTRY_PATH, ...harnessArgs]
      : [PI_RPC_ENTRY_PATH, ...harnessArgs];
    const env = prime
      ? { ...input.env, WEAVER_PRIME_AGENT_MODULE_URL: prime.moduleUrl }
      : input.env;
    const child = spawn(command, args, {
      cwd: input.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const runtime = new CliRpcRuntime(child, `${input.command}@${version}-weaver.4`);
    try {
      const response = await runtime.send('get_state', { type: 'get_state' });
      runtime.state = validatePiRpcState(input, response.data);
      runtime.sessionId = runtime.state.sessionId;
      return runtime;
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  async run(prompt: string, signal: AbortSignal): Promise<PiRpcRunResult> {
    if (signal.aborted) {
      return { providerResolved: null, modelResolved: null, usage: { ...NULL_USAGE }, costUsd: null, aborted: true, error: 'RPC run was aborted before prompt' };
    }
    const ended = new Promise<RpcRecord>((resolveEnd, reject) => {
      this.agentEnd = { resolve: resolveEnd, reject };
    });
    const onAbort = () => { void this.abort(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const accepted = await this.send('prompt', { type: 'prompt', message: prompt });
      if (accepted.success !== true) throw new Error(`RPC prompt was rejected: ${errorMessage(accepted.error ?? accepted.message)}`);
      const event = await ended;
      const messages = Array.isArray(event.messages)
        ? event.messages.filter((item): item is AssistantMessage => isRecord(item) && item.role === 'assistant')
        : [];
      const last = messages.at(-1);
      const totals = summarizePiRpcUsage(messages);
      const stopReason = optionalString(last?.stopReason);
      const failure = optionalString(last?.errorMessage)
        ?? (stopReason === 'error' || stopReason === 'aborted' ? `agent stopped: ${stopReason}` : null);
      return {
        // Catalog selection is requested configuration, not evidence that the
        // provider served it. Resolve identity only from an assistant message.
        providerResolved: optionalString(last?.provider),
        modelResolved: optionalString(last?.responseModel) ?? optionalString(last?.model),
        usage: totals.usage,
        costUsd: totals.costUsd,
        aborted: stopReason === 'aborted',
        error: failure,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.agentEnd = null;
    }
  }

  async abort(): Promise<void> {
    if (this.exited) return;
    await this.send('abort', { type: 'abort' }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.exited) {
      if (this.exitError) throw this.exitError;
      return;
    }
    this.closing = true;
    this.child.stdin.end();
    if (await this.waitForExit(1_500)) return;
    this.child.kill('SIGTERM');
    if (await this.waitForExit(1_500)) {
      throw new Error('RPC process did not exit after stdin closed; terminated with SIGTERM');
    }
    this.child.kill('SIGKILL');
    if (!await this.waitForExit(1_500)) {
      throw new Error('RPC process did not exit after SIGKILL');
    }
    throw new Error('RPC process did not exit after stdin closed; terminated with SIGKILL');
  }

  private send(command: string, record: Record<string, unknown>): Promise<RpcRecord> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (this.exited) return Promise.reject(new Error('RPC process has exited'));
    const id = `weaver-${++this.sequence}`;
    return new Promise((resolveResponse, reject) => {
      this.pending.set(id, { resolve: resolveResponse, reject });
      this.child.stdin.write(JSON.stringify({ id, ...record }) + '\n', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(new Error(`${command} RPC write failed: ${error.message}`));
      });
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let record: RpcRecord;
      try { record = JSON.parse(line) as RpcRecord; }
      catch {
        this.fail(new Error(`RPC emitted non-JSON output: ${line.slice(0, 500)}`));
        continue;
      }
      if (record.type === 'session' && typeof record.id === 'string') this.sessionId = record.id;
      if (record.type === 'response' && typeof record.id === 'string') {
        const pending = this.pending.get(record.id);
        if (pending) {
          this.pending.delete(record.id);
          if (record.success === false) pending.reject(new Error(errorMessage(record.error ?? record.message)));
          else pending.resolve(record);
        }
      }
      if (record.type === 'agent_end' && this.agentEnd) this.agentEnd.resolve(record);
    }
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const pending of this.pending.values()) pending.reject(this.exitError);
    this.pending.clear();
    this.agentEnd?.reject(this.exitError);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        this.child.off('close', onClose);
        resolveWait(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timer);
        resolveWait(true);
      };
      this.child.once('close', onClose);
    });
  }
}

/** Exact fresh-process contract, exported so no-resume/daemon behavior is a deterministic test. */
export function buildPiRpcArgs(input: StartPiRpcRuntimeInput): string[] {
  const builtinTools = input.command === 'pi'
    ? ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
    : ['ipython'];
  return [
    ...(input.command === 'prime-agent' ? ['--mode', 'rpc'] : []),
    '--no-session',
    '--provider', input.provider,
    '--model', input.model,
    '--append-system-prompt', input.systemPrompt,
    '--no-extensions', '--extension', input.extensionPath,
    '--no-skills', '--no-prompt-templates', '--no-themes',
    ...(input.command === 'prime-agent'
      ? [
          '--no-context-files',
          '--tools', [...builtinTools, 'weaver_append_section', 'weaver_submit_result'].join(','),
        ]
      : []),
    ...(input.command === 'prime-agent' ? ['--cwd', input.cwd] : []),
  ];
}

export const startCliPiRpcRuntime: StartPiRpcRuntime = (input) => CliRpcRuntime.start(input);

export class PiRpcExecutor implements WorkerExecutor {
  readonly id: string;
  private telemetry: ExecutorTelemetry | null = null;
  private readonly startRuntime: StartPiRpcRuntime;
  private readonly startBridge: NonNullable<PiExecutorDependencies['startBridge']>;
  private readonly providerProxyStarter: NonNullable<PiExecutorDependencies['startProviderProxy']>;
  private readonly mcpRelayStarter: NonNullable<PiExecutorDependencies['startMcpRelay']>;
  private readonly executorSecretsLoader: typeof loadExecutorSecrets;
  private readonly now: () => number;
  private readonly removeDirectory: (path: string) => void;

  constructor(
    id: 'pi' | 'prime-agent',
    private readonly command: 'pi' | 'prime-agent',
    dependencies: PiExecutorDependencies = {},
  ) {
    this.id = id;
    this.startRuntime = dependencies.startRuntime ?? startCliPiRpcRuntime;
    this.startBridge = dependencies.startBridge ?? startExtensionSubmitBridge;
    this.providerProxyStarter = dependencies.startProviderProxy ?? startProviderProxy;
    this.mcpRelayStarter = dependencies.startMcpRelay ?? startMcpRelay;
    this.executorSecretsLoader = dependencies.loadExecutorSecrets ?? (
      dependencies.executorSecrets
        ? () => ({ ...dependencies.executorSecrets })
        : loadExecutorSecrets
    );
    this.now = dependencies.now ?? Date.now;
    this.removeDirectory = dependencies.removeDirectory
      ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  }

  lastTelemetry(): ExecutorTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    this.telemetry = null;
    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();
    const unsupported = (message: string): WorkerExecutionOutcome => {
      this.telemetry = this.makeTelemetry(req, startedMs, startedAt, 'unsupported', message);
      return { costUsd: 0, error: message };
    };
    if (req.supervise || req.permissionMode !== 'bypassPermissions') {
      return unsupported(`${this.id} executor does not support action-worker supervision`);
    }
    if (Object.keys(req.operatorMcpServers).some((name) => name.toLowerCase() === 'weaver')) {
      return unsupported("operator MCP server name 'weaver' is reserved for the submission surface");
    }
    if (req.abort.signal.aborted) {
      const message = `${this.id} run was aborted before launch`;
      this.telemetry = this.makeTelemetry(req, startedMs, startedAt, 'aborted', message);
      return { costUsd: 0, error: message };
    }

    let target: { provider: string; model: string };
    try { target = splitPiModel(req.model); }
    catch (error) {
      const message = errorMessage(error);
      this.telemetry = this.makeTelemetry(req, startedMs, startedAt, 'error', message);
      return { costUsd: 0, error: message };
    }

    let providerConfiguration: PiProviderConfiguration;
    const executorSecrets = this.executorSecretsLoader();
    try {
      this.validateWorkspace(req);
      providerConfiguration = this.providerConfiguration(target.provider, executorSecrets);
    }
    catch (error) { return unsupported(errorMessage(error)); }

    const scoped = scopedEnvironment(req, executorSecrets);
    const redactionSecrets = { ...scoped.redactionSecrets };
    let isolatedRoot: string;
    let isolatedHome: string;
    try {
      isolatedRoot = mkdtempSync(join(tmpdir(), `weaver-${this.id}-run-`));
      isolatedHome = join(isolatedRoot, 'home');
      mkdirSync(isolatedHome, { mode: 0o700 });
    } catch (error) {
      const message = `cannot create isolated harness home: ${errorMessage(error)}`;
      this.telemetry = this.makeTelemetry(req, startedMs, startedAt, 'error', message);
      return { costUsd: 0, error: message };
    }
    let submissionMs: number | null = null;
    const observedSubmit: SubmitSurface = {
      appendSection: (content) => req.submit.appendSection(content),
      submitResult: async (args) => {
        const reply = await req.submit.submitResult(args);
        if (!reply.isError) submissionMs ??= this.now();
        return reply;
      },
    };
    let bridge: ExtensionSubmitBridge | null = null;
    let providerProxy: ProviderProxy | null = null;
    const operatorRelays: NamedMcpRelay[] = [];
    let runtime: PiRpcRuntime | null = null;
    let startupMs: number | null = null;
    let run: PiRpcRunResult | null = null;
    let failure: string | null = null;
    let terminalReason: ExecutorTelemetry['terminalReason'] = 'completed';
    const cleanupFailures: string[] = [];

    try {
      providerProxy = await this.providerProxyStarter({
        upstreamBaseUrl: providerConfiguration.upstreamBaseUrl,
        upstreamApiKey: providerConfiguration.apiKey,
        allowedModels: [target.model],
        maxRequests: req.maxTurns,
      });
      redactionSecrets.WEAVER_PI_PROVIDER_PROXY_TOKEN = providerProxy.token;
      const unavailableOperatorServers: string[] = [];
      for (const [name, config] of Object.entries(req.operatorMcpServers)) {
        let relay: McpRelay;
        try {
          relay = await this.mcpRelayStarter(config, { env: req.env });
        } catch (error) {
          // An unreachable operator MCP server is a lost capability, not a
          // failed launch: codex-sdk and local-sdk workers start with the
          // server absent and the run proceeds, so a dead OAuth grant on one
          // optional server must not block every assignment on this executor.
          // Credential-substitution safety is unchanged inside startMcpRelay
          // (secrets never appear in the thrown message); degradation is
          // explicit — stderr note here, and the confined worker is told the
          // tools are absent so it cannot claim work that needed them.
          const reason = redactSecrets(
            error instanceof Error ? error.message : String(error),
            scoped.redactionSecrets,
          );
          unavailableOperatorServers.push(name);
          process.stderr.write(
            `pi executor: operator MCP server '${name}' unavailable at launch (${reason}) — proceeding without it\n`,
          );
          continue;
        }
        operatorRelays.push({ name, relay });
        redactionSecrets[`WEAVER_PI_MCP_RELAY_TOKEN_${operatorRelays.length}`] = relay.token;
      }
      bridge = await this.startBridge(observedSubmit, { redactionSecrets });
      redactionSecrets.WEAVER_HARNESS_SUBMIT_TOKEN = bridge.token;
      redactionSecrets.WEAVER_HARNESS_SUBMIT_URL = bridge.url;
      const runtimeEnv = {
        ...scoped.env,
        HOME: isolatedHome,
        XDG_CACHE_HOME: join(isolatedRoot, 'cache'),
        XDG_CONFIG_HOME: join(isolatedRoot, 'config'),
        XDG_DATA_HOME: join(isolatedRoot, 'data'),
        XDG_STATE_HOME: join(isolatedRoot, 'state'),
        PI_CODING_AGENT_DIR: join(isolatedRoot, 'pi-agent'),
        PI_CODING_AGENT_SESSION_DIR: join(isolatedRoot, 'pi-sessions'),
        PRIME_AGENT_CODING_AGENT_DIR: join(isolatedRoot, 'prime-agent'),
        PRIME_AGENT_SESSION_DIR: join(isolatedRoot, 'prime-sessions'),
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        WEAVER_HARNESS_SUBMIT_URL: bridge.url,
        WEAVER_HARNESS_SUBMIT_TOKEN: bridge.token,
        WEAVER_PI_PROVIDER_CONFIG: JSON.stringify({
          provider: target.provider,
          model: target.model,
          baseUrl: providerProxy.url,
          apiKey: providerProxy.token,
        }),
        WEAVER_PI_MCP_RELAYS: JSON.stringify(operatorRelays.map(({ name, relay }) => ({
          name,
          url: relay.url,
          token: relay.token,
        }))),
      };
      runtime = await this.startRuntime({
        command: this.command,
        cwd: req.cwd ?? process.cwd(),
        provider: target.provider,
        model: target.model,
        systemPrompt: [
          req.systemPrompt.append,
          'Submit only through weaver_append_section and weaver_submit_result. Stop after a successful submission.',
          `Stop after no more than ${req.maxTurns} provider turns.`,
          ...(unavailableOperatorServers.length
            ? [`Operator MCP servers unavailable during this run: ${unavailableOperatorServers.join(', ')}. Their tools are absent — do not claim work that required them; report the gap via submit_result.`]
            : []),
        ].join('\n\n'),
        maxTurns: req.maxTurns,
        env: runtimeEnv,
        extensionPath: EXTENSION_PATH,
      });
      startupMs = this.now() - startedMs;
      run = await runtime.run(req.prompt, req.abort.signal);
      // The production extension aborts the agent loop immediately after the
      // harness accepts submit_result. Pi reports that intentional stop as an
      // operation error on some providers, so the accepted durable submission
      // — not provider-specific abort wording — is the terminal success fact.
      if (run.error && submissionMs === null) {
        failure = redactSecrets(run.error, redactionSecrets);
        terminalReason = req.abort.signal.aborted ? 'aborted' : 'error';
        await runtime.abort();
      } else if (!providerProxy.modelResolved()) {
        failure = 'Pi provider response did not report a model identity; refusing false resolved-model provenance';
        terminalReason = 'error';
      }
    } catch (error) {
      // The intentional post-submission abort can arrive as a thrown
      // AbortError rather than run.error (the RPC promise rejects when the
      // extension stops the loop). The same rule as above applies: an
      // accepted durable submission is the terminal success fact, and the
      // abort wording is provenance, never a failure that would trigger a
      // retry of already-submitted (possibly world-changing) work.
      if (submissionMs === null) {
        failure = redactSecrets(errorMessage(error), redactionSecrets);
        terminalReason = req.abort.signal.aborted ? 'aborted' : 'error';
      }
      if (runtime) await runtime.abort().catch(() => undefined);
    } finally {
      if (runtime) {
        try { await runtime.close(); }
        catch (error) { cleanupFailures.push(`runtime close: ${redactSecrets(errorMessage(error), redactionSecrets)}`); }
      }
      if (bridge) {
        try { await bridge.close(); }
        catch (error) { cleanupFailures.push(`submit bridge close: ${redactSecrets(errorMessage(error), redactionSecrets)}`); }
      }
      for (const { name, relay } of operatorRelays.reverse()) {
        try { await relay.close(); }
        catch (error) { cleanupFailures.push(`MCP relay ${name} close: ${redactSecrets(errorMessage(error), redactionSecrets)}`); }
      }
      if (providerProxy) {
        try { await providerProxy.close(); }
        catch (error) { cleanupFailures.push(`provider proxy close: ${redactSecrets(errorMessage(error), redactionSecrets)}`); }
      }
      await this.removeIsolatedRoot(isolatedRoot, cleanupFailures, redactionSecrets);
    }
    if (cleanupFailures.length) {
      if (submissionMs === null) {
        // No accepted submission: the cleanup detail belongs on the failure
        // the attempt already is, so a leaked environment stays visible.
        failure = [failure, ...cleanupFailures].filter(Boolean).join('; ');
        terminalReason = 'error';
      } else {
        // An accepted submission is the terminal success fact; a leftover
        // temp dir must not flip submitted work into a failure that invites
        // a duplicate dispatch. Surface the leak without corrupting the
        // attempt record.
        process.stderr.write(
          `pi executor: isolated home cleanup incomplete after accepted submission (${cleanupFailures.join('; ')})\n`,
        );
      }
    }

    const endedMs = this.now();
    // The run-bound custom provider intentionally carries no pricing catalog.
    // Any Pi-family computed zero is therefore not a bill or evidence of free
    // usage, including the eval-only Prime adapter on the same proxy seam.
    const costUsd = null;
    const resolvedModel = providerProxy?.modelResolved() ?? null;
    // Pi's opaque fresh-run id is useful adapter provenance. Prime session
    // machinery is deliberately not Workstream memory, even as telemetry.
    const durableSessionId = this.command === 'prime-agent' ? null : runtime?.sessionId ?? null;
    this.telemetry = {
      executor: this.id,
      providerRequested: target.provider,
      modelRequested: req.model,
      providerResolved: resolvedModel ? target.provider : null,
      modelResolved: resolvedModel,
      harnessVersion: runtime?.harnessVersion ?? 'unknown',
      isolation: 'host-process',
      startedAt,
      endedAt: new Date(endedMs).toISOString(),
      durationMs: endedMs - startedMs,
      startupMs,
      timeToSubmissionMs: submissionMs === null ? null : submissionMs - startedMs,
      usage: run?.usage ?? { ...NULL_USAGE },
      costUsd,
      sessionId: durableSessionId,
      terminalReason,
      error: failure,
    };
    return {
      costUsd,
      ...(durableSessionId ? { sessionId: durableSessionId } : {}),
      ...(failure ? { error: failure } : {}),
    };
  }

  /** Removing the isolated root races the dying RPC child on macOS
   * (ENOTEMPTY while the process's last writes land). A bounded retry clears
   * the race; a persistent failure is recorded for the caller to price —
   * as attempt error detail when nothing was submitted, or as a stderr leak
   * note once an accepted submission is the terminal fact. */
  private async removeIsolatedRoot(
    isolatedRoot: string,
    cleanupFailures: string[],
    redactionSecrets: Record<string, string>,
  ): Promise<void> {
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        this.removeDirectory(isolatedRoot);
        return;
      } catch (error) {
        if (attempt === attempts) {
          cleanupFailures.push(`isolated home cleanup: ${redactSecrets(errorMessage(error), redactionSecrets)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  private providerConfiguration(
    provider: string,
    executorSecrets: Record<string, string>,
  ): PiProviderConfiguration {
    const known = PI_PROVIDERS[provider];
    if (!known) {
      throw new Error(
        `Pi provider '${provider}' has no executor-only proxy configuration`,
      );
    }
    const apiKeyName = known.apiKeyNames.find((name) => executorSecrets[name]);
    const apiKey = apiKeyName ? executorSecrets[apiKeyName] : undefined;
    if (!apiKey) {
      throw new Error(
        `Pi executor requires ${known.apiKeyNames.join(' or ')} in executor-only secrets ` +
          '(`weaver secret set <NAME> --executor`)',
      );
    }
    return { ...known, apiKey };
  }

  private validateWorkspace(req: WorkerExecutionRequest): void {
    for (const [label, directory] of [
      ['working directory', req.cwd ?? process.cwd()],
      ...req.additionalDirectories.map((item) => ['additional directory', item]),
    ] as Array<[string, string]>) {
      let stat;
      try { stat = statSync(directory); }
      catch { throw new Error(`Pi ${label} does not exist: ${directory}`); }
      if (!stat.isDirectory()) throw new Error(`Pi ${label} is not a directory: ${directory}`);
    }
  }

  private makeTelemetry(
    req: WorkerExecutionRequest,
    startedMs: number,
    startedAt: string,
    terminalReason: ExecutorTelemetry['terminalReason'],
    error: string,
  ): ExecutorTelemetry {
    const endedMs = this.now();
    return {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: null,
      modelResolved: null,
      harnessVersion: 'unknown',
      isolation: 'host-process',
      startedAt,
      endedAt: new Date(endedMs).toISOString(),
      durationMs: endedMs - startedMs,
      startupMs: null,
      timeToSubmissionMs: null,
      usage: { ...NULL_USAGE },
      costUsd: null,
      sessionId: null,
      terminalReason,
      error,
    };
  }
}

/** Production API-backed worker. One fresh Pi RPC process is created and
 * destroyed for every assignment; its session id is provenance only. */
export class PiExecutor extends PiRpcExecutor {
  constructor(dependencies: PiExecutorDependencies = {}) {
    super('pi', 'pi', dependencies);
  }
}
