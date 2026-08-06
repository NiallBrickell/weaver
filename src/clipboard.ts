/**
 * Copy plain text to the host clipboard without involving a shell, temporary
 * files, or terminal escape sequences. Linux clipboard tools are optional, so
 * each known implementation is tried in order and failure is reported only
 * after every candidate has been exhausted.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 2_000;

interface ClipboardCandidate {
  command: string;
  args: string[];
  label: string;
}

export type ClipboardSpawnRunner = (
  command: string,
  args: readonly string[],
  text: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface ClipboardDeps {
  platform?: NodeJS.Platform;
  spawnRunner?: ClipboardSpawnRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function candidatesFor(platform: NodeJS.Platform): ClipboardCandidate[] {
  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [], label: 'macOS clipboard' }];
  }
  if (platform === 'win32') {
    return [{ command: 'clip.exe', args: [], label: 'Windows clipboard' }];
  }
  if (platform === 'linux') {
    return [
      { command: 'wl-copy', args: [], label: 'Wayland clipboard' },
      { command: 'xclip', args: ['-selection', 'clipboard'], label: 'X11 clipboard (xclip)' },
      { command: 'xsel', args: ['--clipboard', '--input'], label: 'X11 clipboard (xsel)' },
    ];
  }
  return [];
}

/** Run one clipboard command with the complete report on stdin. */
const runClipboardProcess: ClipboardSpawnRunner = (command, args, text, timeoutMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('clipboard copy cancelled')); return; }
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      hardKill = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`timed out after ${timeoutMs}ms`));
      }, 250);
    }, timeoutMs);
    const onAbort = () => {
      if (cancelled || settled) return;
      cancelled = true;
      child.kill();
      hardKill = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('clipboard copy cancelled'));
      }, 250);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (cancelled) finish(new Error('clipboard copy cancelled'));
      else if (timedOut) finish(new Error(`timed out after ${timeoutMs}ms`));
      else if (code === 0) finish();
      else finish(new Error(code === null ? `terminated by ${signal ?? 'unknown signal'}` : `exited ${code}`));
    });
    child.stdin.once('error', (error) => finish(error));
    if (signal?.aborted) onAbort();
    child.stdin.end(text);
  });

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy `text` and return the human-facing name of the copier that succeeded.
 * Throws one aggregate, content-free error only when no platform candidate
 * succeeds.
 */
export async function copyToClipboard(text: string, deps: ClipboardDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const candidates = candidatesFor(platform);
  if (!candidates.length) {
    throw new Error(`clipboard copy is not supported on platform '${platform}'`);
  }

  const run = deps.spawnRunner ?? runClipboardProcess;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (deps.signal?.aborted) throw new Error('clipboard copy cancelled');
    try {
      await run(candidate.command, candidate.args, text, timeoutMs, deps.signal);
      return candidate.label;
    } catch (error) {
      failures.push(`${candidate.command}: ${failureMessage(error)}`);
    }
  }

  throw new Error(`could not copy to clipboard; ${failures.join('; ')}`);
}
