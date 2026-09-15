/**
 * Run the local Claude Agent SDK worker INSIDE the same rootless Docker seam
 * OpenHands workers use, so a credential-bearing host can put its Claude
 * subscription first for ordinary work without handing a model-driven process
 * the controller's secret store.
 *
 * Why this exists: until 2026-09-15 the hosted fleet's ordinary workers were
 * OpenHands-on-OpenRouter only. The host refuses every host-process worker
 * route because a process sharing the `weaver` UID can read absolute
 * credential paths (executor-secrets.env: GitHub App key, Pilot bearer,
 * OpenRouter key, the setup-token itself), so the subscription — the seat the
 * founder pays for and wants used first — was reachable only by the
 * coordinator. When the single OpenRouter account ran dry, all 194 worker
 * attempts in a day parked on `usage_limit` and every intake routine went
 * blind while the subscription sat idle.
 *
 * What the boundary is here: the SDK's `spawnClaudeCodeProcess` hook lets the
 * harness decide HOW the Claude Code process starts. This spawner starts it as
 * `docker run -i --rm` in the pinned worker image, with exactly three kinds of
 * host state visible — the SDK's own native binary directory (read-only), the
 * assignment's working directory (read-write) and its declared read-only
 * directories, all at their host paths so every path in the briefing stays
 * valid — and an ALLOWLISTED environment: the registered Claude identity, the
 * assignment's declared worker secrets (loopback hosts rewritten to the host
 * gateway, as OpenHands does), and the SDK's own CLAUDE_CODE_* / ANTHROPIC_*
 * protocol variables. Nothing else from the runner's environment (WEAVER_STORE,
 * DOCKER_HOST, OPENROUTER_API_KEY, the GitHub App identity) can reach it, and
 * /home/weaver/state is not mounted. The SDK's in-process `weaver` MCP server
 * (submit_result / append_section) and the harness's stdio control protocol
 * ride the container's stdin/stdout unchanged.
 *
 * Secret values never appear in the container's argv: they travel in the
 * docker CLI's own environment and are forwarded by NAME (`--env NAME`).
 *
 * The container runs as uid 0, which under rootless Docker IS the `weaver`
 * user on the host: files the worker writes come out owned by the runner, the
 * way a host-process worker's would. Claude Code refuses
 * `--dangerously-skip-permissions` as root unless IS_SANDBOX=1 says the root
 * is a sandbox's; it is.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { OPENHANDS_AGENT_SERVER_IMAGE, rewriteLoopbackHostsForContainer } from './openHands.js';

export interface ClaudeContainerConfig {
  /** Image the worker runs in. Defaults to the pinned OpenHands worker image,
   * which already carries the toolchain hosted workers are given. */
  image: string;
  dockerCommand: string;
  /** The VM's private IPv4, advertised as host.docker.internal (same rule as
   * OpenHands: rootless Docker's generic host-gateway is its inner bridge). */
  hostGatewayIp?: string;
}

export const CLAUDE_CONTAINER_LABEL = 'weaver.executor=local-sdk-container';

/** Inside the container the worker's HOME is the image root's: writable, empty
 * of any operator settings, and gone with the container. */
const CONTAINER_HOME = '/root';

/**
 * Container mode is an explicit host decision (`WEAVER_LOCAL_SDK_CONTAINER=1`),
 * never inferred from the presence of Docker: on an operator laptop the
 * host-process worker is the intended route.
 */
export function claudeContainerFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeContainerConfig | undefined {
  if (env.WEAVER_LOCAL_SDK_CONTAINER !== '1') return undefined;
  return {
    image: env.WEAVER_LOCAL_SDK_CONTAINER_IMAGE || OPENHANDS_AGENT_SERVER_IMAGE,
    dockerCommand: env.WEAVER_LOCAL_SDK_CONTAINER_DOCKER || 'docker',
    ...(env.WEAVER_OPENHANDS_HOST_GATEWAY_IP ? { hostGatewayIp: env.WEAVER_OPENHANDS_HOST_GATEWAY_IP } : {}),
  };
}

export interface ContainerRunRequest {
  assignmentId: string;
  /** The assignment's working directory — mounted read-write at its host path. */
  cwd: string;
  /** Declared read-only source directories — mounted read-only at their host paths. */
  additionalDirectories: readonly string[];
  /** The assignment's exact declared worker secrets (never the ambient env). */
  workerVisibleEnv: Record<string, string>;
}

export interface PlannedContainerRun {
  command: string;
  args: string[];
  /** Environment for the docker CLI process — the source `--env NAME` copies from. */
  env: Record<string, string>;
  containerName: string;
}

/** Names the SDK sets for its own protocol, and the Claude identity/provider
 * names sdkEnv resolved for this run. Everything else stays on the host. */
const FORWARDED_NAME = /^(CLAUDE_CODE_|CLAUDE_AGENT_SDK_|ANTHROPIC_)/;
const NEVER_FORWARDED = new Set(['CLAUDE_CONFIG_DIR']);

function assertEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`container worker environment contains an invalid name ${JSON.stringify(name)}`);
  }
}

function safeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (safe || 'assignment').slice(0, 40);
}

function isWithin(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Pure planning: the exact docker argv and the docker CLI's environment for
 * one Claude Code process the SDK asked to spawn. Kept free of I/O so the
 * boundary is testable line by line.
 */
export function planContainerRun(
  spawnOptions: SpawnOptions,
  run: ContainerRunRequest,
  config: ClaudeContainerConfig,
): PlannedContainerRun {
  if (!isAbsolute(spawnOptions.command)) {
    // The SDK ships Claude Code as a native binary and spawns it by absolute
    // path; a bare runtime name would mean a JavaScript entrypoint this
    // spawner has not been taught to mount. Refuse rather than guess.
    throw new Error(
      `container worker needs the SDK's absolute Claude Code binary path, got ${JSON.stringify(spawnOptions.command)}`,
    );
  }
  if (!isAbsolute(run.cwd)) throw new Error(`container worker cwd must be absolute, got ${JSON.stringify(run.cwd)}`);

  const env: Record<string, string> = {};
  const forwardedNames: string[] = [];
  const forward = (name: string, value: string) => {
    assertEnvName(name);
    if (/[\r\n\0]/.test(value)) throw new Error(`container worker environment value for ${name} contains a newline or NUL byte`);
    env[name] = value;
    forwardedNames.push(name);
  };
  for (const [name, value] of Object.entries(spawnOptions.env)) {
    if (value === undefined || NEVER_FORWARDED.has(name) || !FORWARDED_NAME.test(name)) continue;
    forward(name, value);
  }
  for (const [name, value] of Object.entries(rewriteLoopbackHostsForContainer(run.workerVisibleEnv))) {
    if (FORWARDED_NAME.test(name)) {
      // A declared worker secret must not be able to replace the identity or
      // protocol variables the harness resolved for this run.
      throw new Error(`container worker secret ${name} collides with a reserved Claude/Anthropic name`);
    }
    forward(name, value);
  }
  // The docker CLI itself needs a PATH to be found and to run; nothing else
  // from the runner's environment is part of the plan.
  const cliEnv: Record<string, string> = { ...env, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  if (process.env.DOCKER_HOST) cliEnv.DOCKER_HOST = process.env.DOCKER_HOST;

  const binaryDir = dirname(spawnOptions.command);
  const containerName = `weaver-claude-${safeName(run.assignmentId)}-${randomBytes(6).toString('hex')}`;
  const args = [
    'run',
    '--rm',
    '--interactive',
    '--name', containerName,
    '--label', CLAUDE_CONTAINER_LABEL,
    '--label', `weaver.owner_pid=${process.pid}`,
    '--user', '0',
    '--add-host', `host.docker.internal:${config.hostGatewayIp ?? 'host-gateway'}`,
    '--volume', `${binaryDir}:${binaryDir}:ro`,
    '--volume', `${run.cwd}:${run.cwd}`,
    '--workdir', run.cwd,
  ];
  const mounted = new Set<string>([resolve(run.cwd)]);
  for (const directory of run.additionalDirectories) {
    if (!isAbsolute(directory)) throw new Error(`container worker source directory must be absolute, got ${JSON.stringify(directory)}`);
    const canonical = resolve(directory);
    if (mounted.has(canonical) || isWithin(run.cwd, canonical)) continue;
    mounted.add(canonical);
    args.push('--volume', `${canonical}:${canonical}:ro`);
  }
  args.push('--env', `HOME=${CONTAINER_HOME}`, '--env', 'IS_SANDBOX=1');
  for (const name of forwardedNames) args.push('--env', name);
  // The worker image has an entrypoint of its own (the OpenHands agent server,
  // a Python CLI that swallowed the binary path as its own arguments on the
  // first live proof). The Claude Code binary IS the entrypoint here.
  args.push('--entrypoint', spawnOptions.command, config.image, ...spawnOptions.args);
  return { command: config.dockerCommand, args, env: cliEnv, containerName };
}

/** How much container stderr is kept to explain a failed run. */
const STDERR_TAIL_BYTES = 4096;

/**
 * The `spawnClaudeCodeProcess` implementation for one assignment. Returns
 * Node's ChildProcess for the docker CLI, which satisfies the SDK's
 * SpawnedProcess contract. `docker run` proxies SIGTERM to the container's
 * main process and `--rm` removes it on exit; a detached CLI (the SDK's abort
 * kills the client, not the daemon's container) is covered by an explicit
 * best-effort `docker rm -f` once the CLI has gone.
 */
export function containerSpawner(
  config: ClaudeContainerConfig,
  run: ContainerRunRequest,
  spawnImpl: typeof spawn = spawn,
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const plan = planContainerRun(options, run, config);
    const child = spawnImpl(plan.command, plan.args, {
      cwd: options.cwd,
      env: plan.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    });
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.once('exit', (code, signal) => {
      if (code !== 0 && stderrTail.trim()) {
        process.stderr.write(
          `[local-sdk container] ${plan.containerName} exited (${code ?? signal}); stderr tail:\n${stderrTail.trimEnd()}\n`,
        );
      }
      // The client is gone; make sure the daemon's container is too. Errors
      // (already removed by --rm) are the expected case and are ignored.
      const reaper = spawnImpl(plan.command, ['rm', '--force', plan.containerName], {
        env: plan.env,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      reaper.on('error', () => {});
      reaper.unref();
    });
    // An 'error' (docker not found, spawn failure) with no listener would end
    // the runner; the SDK attaches its own, this is the floor.
    child.on('error', () => {});
    return child as unknown as SpawnedProcess;
  };
}
