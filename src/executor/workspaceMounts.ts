import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executorSecretsPath } from '../secrets.js';
import { weaverHome } from '../store.js';

export const OPENHANDS_WORKSPACE = '/workspace';

/** The checkout this Weaver process runs from (src/executor/../..). */
const WEAVER_INSTALLATION = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The persistent root that holds every neutral per-workstream workspace
 * (`WEAVER_WORKSPACE_ROOT`, default `~/.weaver/workspaces`). It is the one
 * subtree of a protected root (below) a worker may be handed: Weaver itself
 * creates it as worker context, and the Docker/Railway layout deliberately
 * places it inside `WEAVER_HOME`.
 */
export function workerWorkspaceRoot(): string {
  const configuredRoot = process.env.WEAVER_WORKSPACE_ROOT?.trim();
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error('WEAVER_WORKSPACE_ROOT must be an absolute path');
  }
  return configuredRoot || join(homedir(), '.weaver', 'workspaces');
}

/** A worker directory that would hand a model process state or credentials. */
export class WorkerDirectoryRefusedError extends Error {
  override name = 'WorkerDirectoryRefusedError';
  constructor(
    readonly directory: string,
    readonly detail: string,
  ) {
    super(`'${directory}' ${detail}`);
  }
}

interface ProtectedPath {
  /** Canonical (symlink-resolved) host path. */
  path: string;
  label: string;
  /** The filesystem root and the home directory are refused themselves (and
   * so is anything containing them), but ordinary work lives beneath them. */
  descendantsAllowed?: boolean;
}

/**
 * Resolve every symlink in `input`, including a dangling link and an
 * existing ancestor of a path that does not exist yet. A worker directory is
 * often created at launch (a scratch clone target), so the non-existent tail
 * is kept literally; only an existing component can redirect it.
 */
export function canonicalHostPath(input: string, depth = 0): string {
  const absolute = resolve(input);
  try {
    return realpathSync(absolute);
  } catch {
    // Missing or dangling somewhere below; resolve the parent and look again.
  }
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const candidate = join(canonicalHostPath(parent, depth), basename(absolute));
  let link: string | null = null;
  try {
    if (lstatSync(candidate).isSymbolicLink()) link = readlinkSync(candidate);
  } catch {
    return candidate;
  }
  if (link === null) return candidate;
  if (depth >= 40) throw new Error(`too many symbolic links resolving ${input}`);
  return canonicalHostPath(resolve(dirname(candidate), link), depth + 1);
}

function within(child: string, parent: string): boolean {
  const nested = relative(parent, child);
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

function dockerSocketPath(dockerHost: string | undefined): string | null {
  if (!dockerHost) return '/var/run/docker.sock';
  return dockerHost.startsWith('unix://') ? dockerHost.slice('unix://'.length) : null;
}

/**
 * Every host path an ordinary worker must never be given as a working or
 * source directory, canonicalized for this execution host. Container
 * executors bind-mount worker directories read-write, so each of these would
 * put the executor-only secret store (GitHub App key, model credentials,
 * Pilot bearer), the runner's service configuration, an operator login, or
 * control of the host's Docker inside a model-driven process.
 */
function protectedWorkerPaths(): ProtectedPath[] {
  const home = homedir();
  const candidates: Array<{ path: string | null | undefined; label: string; descendantsAllowed?: boolean }> = [
    { path: '/', label: 'the filesystem root', descendantsAllowed: true },
    { path: home, label: "the runner user's home directory", descendantsAllowed: true },
    { path: weaverHome(), label: "Weaver's state directory (WEAVER_HOME)" },
    { path: dirname(executorSecretsPath()), label: 'the directory holding the executor-only secret store' },
    { path: '/etc/weaver', label: "the hosted runner's service configuration" },
    // Writing the runner's own source is running as the runner: the next
    // restart (the self-updater restarts on a moved HEAD) executes it with
    // every credential. Work on Weaver itself uses a worktree or clone.
    { path: WEAVER_INSTALLATION, label: "the running Weaver installation (the runner's own code)" },
    { path: join(home, '.ssh'), label: "the runner user's SSH keys" },
    { path: join(home, '.config'), label: "the runner user's tool logins (~/.config)" },
    { path: join(home, '.weaver'), label: "the runner user's Weaver directory (~/.weaver)" },
    { path: join(home, '.claude'), label: "the runner user's Claude Code login (~/.claude)" },
    { path: process.env.CLAUDE_CONFIG_DIR, label: "the runner's Claude Code login (CLAUDE_CONFIG_DIR)" },
    { path: join(home, '.codex'), label: "the runner user's Codex login (~/.codex)" },
    { path: process.env.CODEX_HOME, label: "the runner's Codex login (CODEX_HOME)" },
    { path: dockerSocketPath(process.env.DOCKER_HOST), label: "the runner's Docker socket" },
    { path: '/proc', label: "the host's process table (every process's environment)" },
  ];
  const seen = new Set<string>();
  const out: ProtectedPath[] = [];
  for (const candidate of candidates) {
    if (!candidate.path || !isAbsolute(candidate.path)) continue;
    const path = canonicalHostPath(candidate.path);
    const key = `${path}\u0000${candidate.descendantsAllowed ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, label: candidate.label, ...(candidate.descendantsAllowed ? { descendantsAllowed: true } : {}) });
  }
  return out;
}

/**
 * Why `directory` may not be handed to a worker, or null when it may. A
 * directory is refused when it is, contains, or sits under a protected path.
 * The one carve-out is the neutral workspace root: a descendant of it is not
 * refused merely because the root itself was placed inside a protected
 * directory — it is still refused if it CONTAINS one.
 */
export function workerDirectoryRefusal(directory: string): string | null {
  if (!isAbsolute(directory)) return 'is not an absolute path';
  let canonical: string;
  try {
    canonical = canonicalHostPath(directory);
  } catch {
    return 'cannot be resolved to a real directory (a symbolic link loop)';
  }
  const via = canonical === resolve(directory) ? '' : ` (it resolves to ${canonical})`;
  let workspaceRoot: string | null;
  try {
    workspaceRoot = canonicalHostPath(workerWorkspaceRoot());
  } catch {
    // A misconfigured root earns no carve-out; the check only gets stricter.
    workspaceRoot = null;
  }
  for (const guarded of protectedWorkerPaths()) {
    if (within(guarded.path, canonical)) {
      const relation = guarded.path === canonical ? 'is' : 'contains';
      return `${relation} ${guarded.label}, ${guarded.path}${via}`;
    }
    if (guarded.descendantsAllowed || !within(canonical, guarded.path)) continue;
    if (
      workspaceRoot !== null
      && workspaceRoot !== guarded.path
      && within(workspaceRoot, guarded.path)
      && within(canonical, workspaceRoot)
    ) {
      continue;
    }
    return `sits under ${guarded.label}, ${guarded.path}${via}`;
  }
  return null;
}

/** Refuse, before any mount or launch, a worker directory that would expose
 * Weaver state or a credential store. Symlinks are resolved first, so a link
 * cannot smuggle a protected directory in under an innocent name. */
export function assertWorkerDirectoriesAllowed(directories: readonly string[]): void {
  for (const directory of directories) {
    const refusal = workerDirectoryRefusal(directory);
    if (refusal) throw new WorkerDirectoryRefusedError(directory, refusal);
  }
}

export interface WorkspacePathMapping {
  hostPath: string;
  containerPath: string;
}

export interface WorkspaceMountPlan {
  /** Bind mounts expressed as individual Docker spawn arguments (never shell text). */
  dockerArgs: string[];
  /** Canonical host directories that Docker must bind, all read-write. */
  mounts: WorkspacePathMapping[];
  /** Every recognized host spelling as the agent should address it in-container. */
  pathMappings: WorkspacePathMapping[];
  prompt: string;
  workingDirectory: typeof OPENHANDS_WORKSPACE;
}

export interface WorkspaceMountRequest {
  cwd: string;
  additionalDirectories: readonly string[];
  prompt: string;
}

interface SourceDirectory {
  requestedPath: string;
  canonicalPath: string;
}

/**
 * Plan the complete host/container filesystem boundary for one OpenHands run.
 * The caller can splice `dockerArgs` directly into child_process.spawn args.
 */
export function planWorkspaceMounts(request: WorkspaceMountRequest): WorkspaceMountPlan {
  const cwd = sourceDirectory(request.cwd, 'working directory');
  const additional = request.additionalDirectories.map((directory) =>
    sourceDirectory(directory, 'additional source'),
  );
  // Defence in depth behind the assignment-creation and worker-launch checks:
  // every source below is bound read-write, so the exact canonical paths
  // Docker will receive are checked here, immediately before planning.
  assertWorkerDirectoriesAllowed([cwd.canonicalPath, ...additional.map((source) => source.canonicalPath)]);

  const mounts: WorkspacePathMapping[] = [{
    hostPath: cwd.canonicalPath,
    containerPath: OPENHANDS_WORKSPACE,
  }];
  const canonicalTargets = new Map<string, string>([
    [cwd.canonicalPath, OPENHANDS_WORKSPACE],
  ]);

  for (const source of additional) {
    if (canonicalTargets.has(source.canonicalPath)) continue;

    const nestedPath = nestedRelativePath(cwd.canonicalPath, source.canonicalPath);
    if (nestedPath !== null) {
      canonicalTargets.set(
        source.canonicalPath,
        posix.join(OPENHANDS_WORKSPACE, toPosixPath(nestedPath)),
      );
      continue;
    }

    const containerPath = `/weaver-sources/${mounts.length}`;
    canonicalTargets.set(source.canonicalPath, containerPath);
    mounts.push({ hostPath: source.canonicalPath, containerPath });
  }

  const references = new Map<string, string>();
  addReference(references, cwd.requestedPath, OPENHANDS_WORKSPACE);
  addReference(references, cwd.canonicalPath, OPENHANDS_WORKSPACE);
  for (const source of additional) {
    const containerPath = canonicalTargets.get(source.canonicalPath);
    if (containerPath === undefined) {
      throw new Error(`OpenHands workspace mapping was not planned for ${source.requestedPath}`);
    }
    addReference(references, source.requestedPath, containerPath);
    addReference(references, source.canonicalPath, containerPath);
  }

  const pathMappings = [...references].map(([hostPath, containerPath]) => ({
    hostPath,
    containerPath,
  }));
  const rewrittenPrompt = rewritePathReferences(request.prompt, pathMappings);

  return {
    dockerArgs: mounts.flatMap(({ hostPath, containerPath }) => [
      '--volume',
      `${hostPath}:${containerPath}:rw`,
    ]),
    mounts,
    pathMappings,
    prompt: appendMappingSuffix(rewrittenPrompt, pathMappings),
    workingDirectory: OPENHANDS_WORKSPACE,
  };
}

function sourceDirectory(input: string, label: string): SourceDirectory {
  const requestedPath = resolve(input);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(requestedPath);
  } catch (caught) {
    const cause = caught instanceof Error ? `: ${caught.message}` : '';
    throw new Error(`OpenHands ${label} does not exist: ${requestedPath}${cause}`);
  }

  if (!statSync(canonicalPath).isDirectory()) {
    throw new Error(`OpenHands ${label} is not a directory: ${requestedPath}`);
  }
  return { requestedPath, canonicalPath };
}

function nestedRelativePath(parent: string, candidate: string): string | null {
  const nested = relative(parent, candidate);
  if (nested === '') return '';
  if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) return null;
  return nested;
}

function toPosixPath(hostRelativePath: string): string {
  return hostRelativePath.split(sep).join(posix.sep);
}

function addReference(references: Map<string, string>, hostPath: string, containerPath: string): void {
  const existing = references.get(hostPath);
  if (existing !== undefined && existing !== containerPath) {
    throw new Error(
      `OpenHands host path ${hostPath} cannot map to both ${existing} and ${containerPath}`,
    );
  }
  references.set(hostPath, containerPath);
}

function rewritePathReferences(
  prompt: string,
  mappings: readonly WorkspacePathMapping[],
): string {
  const longestFirst = [...mappings].sort(
    (left, right) => right.hostPath.length - left.hostPath.length,
  );
  return longestFirst.reduce(
    (rewritten, mapping) => replaceExactPathReferences(
      rewritten,
      mapping.hostPath,
      mapping.containerPath,
    ),
    prompt,
  );
}

function replaceExactPathReferences(text: string, hostPath: string, containerPath: string): string {
  let cursor = 0;
  let rewritten = '';
  while (cursor < text.length) {
    const match = text.indexOf(hostPath, cursor);
    if (match === -1) return rewritten + text.slice(cursor);
    const end = match + hostPath.length;
    if (isReferenceBoundary(text[match - 1], 'before') && isReferenceBoundary(text[end], 'after')) {
      rewritten += text.slice(cursor, match) + containerPath;
      cursor = end;
    } else {
      rewritten += text.slice(cursor, end);
      cursor = end;
    }
  }
  return rewritten;
}

function isReferenceBoundary(character: string | undefined, side: 'before' | 'after'): boolean {
  if (character === undefined || /\s/u.test(character)) return true;
  if (side === 'after' && character === '/') return true;
  return side === 'before'
    ? '([<{"\'`=,:;'.includes(character)
    : ')]>}"\'`.,:;!?'.includes(character);
}

function appendMappingSuffix(
  prompt: string,
  mappings: readonly WorkspacePathMapping[],
): string {
  const separator = prompt.length === 0 ? '' : prompt.endsWith('\n') ? '\n' : '\n\n';
  const lines = mappings.map(
    ({ hostPath, containerPath }) => `- ${hostPath} → ${containerPath}`,
  );
  return [
    prompt + separator + 'OpenHands workspace path mapping (host → container):',
    ...lines,
    'Use the container paths above; host paths are not available inside this runtime.',
  ].join('\n');
}
