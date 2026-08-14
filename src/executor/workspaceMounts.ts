import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

export const OPENHANDS_WORKSPACE = '/workspace';

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
