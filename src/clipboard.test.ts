import { test } from 'node:test';
import assert from 'node:assert/strict';

import { copyToClipboard, type ClipboardSpawnRunner } from './clipboard.js';

interface Call {
  command: string;
  args: readonly string[];
  text: string;
  timeoutMs: number;
}

test('macOS pipes the full text to pbcopy with no arguments', async () => {
  const calls: Call[] = [];
  const text = 'first line\nsecond line\n$quotes stay literal';
  const spawnRunner: ClipboardSpawnRunner = async (command, args, input, timeoutMs) => {
    calls.push({ command, args, text: input, timeoutMs });
  };

  const label = await copyToClipboard(text, {
    platform: 'darwin',
    spawnRunner,
    timeoutMs: 321,
  });

  assert.equal(label, 'macOS clipboard');
  assert.deepEqual(calls, [{ command: 'pbcopy', args: [], text, timeoutMs: 321 }]);
});

test('Windows uses clip.exe and preserves the exact stdin text', async () => {
  const calls: Call[] = [];
  const text = 'unchanged\r\nWindows text';
  const label = await copyToClipboard(text, {
    platform: 'win32',
    spawnRunner: async (command, args, input, timeoutMs) => {
      calls.push({ command, args, text: input, timeoutMs });
    },
  });

  assert.equal(label, 'Windows clipboard');
  assert.deepEqual(calls, [{ command: 'clip.exe', args: [], text, timeoutMs: 2_000 }]);
});

test('Linux falls through ENOENT and nonzero failures to xsel in order', async () => {
  const calls: Call[] = [];
  const text = 'the entire printout\nincluding its final line';
  const spawnRunner: ClipboardSpawnRunner = async (command, args, input, timeoutMs) => {
    calls.push({ command, args, text: input, timeoutMs });
    if (command === 'wl-copy') {
      const error = new Error('spawn wl-copy ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    if (command === 'xclip') throw new Error('exited 1');
  };

  const label = await copyToClipboard(text, { platform: 'linux', spawnRunner });

  assert.equal(label, 'X11 clipboard (xsel)');
  assert.deepEqual(calls, [
    { command: 'wl-copy', args: [], text, timeoutMs: 2_000 },
    { command: 'xclip', args: ['-selection', 'clipboard'], text, timeoutMs: 2_000 },
    { command: 'xsel', args: ['--clipboard', '--input'], text, timeoutMs: 2_000 },
  ]);
});

test('Linux stops after the first successful candidate', async () => {
  const commands: string[] = [];
  await copyToClipboard('report', {
    platform: 'linux',
    spawnRunner: async (command) => {
      commands.push(command);
    },
  });
  assert.deepEqual(commands, ['wl-copy']);
});

test('one honest error names every attempted copier after all candidates fail', async () => {
  const text = 'sensitive report body must not enter the error';
  await assert.rejects(
    copyToClipboard(text, {
      platform: 'linux',
      spawnRunner: async (command) => {
        throw new Error(command === 'wl-copy' ? 'spawn ENOENT' : 'exited 2');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^could not copy to clipboard;/);
      assert.match(error.message, /wl-copy: spawn ENOENT/);
      assert.match(error.message, /xclip: exited 2/);
      assert.match(error.message, /xsel: exited 2/);
      assert.ok(!error.message.includes(text));
      return true;
    },
  );
});

test('unsupported platforms fail without spawning anything', async () => {
  let called = false;
  await assert.rejects(
    copyToClipboard('report', {
      platform: 'freebsd',
      spawnRunner: async () => {
        called = true;
      },
    }),
    /clipboard copy is not supported on platform 'freebsd'/,
  );
  assert.equal(called, false);
});

test('an aborted copy does not start or fall through to another clipboard process', async () => {
  const abort = new AbortController();
  abort.abort();
  let called = false;
  await assert.rejects(copyToClipboard('report', {
    platform: 'linux',
    signal: abort.signal,
    spawnRunner: async () => { called = true; },
  }), /cancelled/);
  assert.equal(called, false);
});
