import { strict as assert } from 'node:assert';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';

import { readSecretInput } from './secretInput.js';

function ttyInput(): {
  input: NodeJS.ReadStream;
  stream: PassThrough;
  rawModes: boolean[];
} {
  const stream = new PassThrough();
  const rawModes: boolean[] = [];
  const input = stream as unknown as NodeJS.ReadStream;
  Object.defineProperties(input, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
    setRawMode: {
      value(mode: boolean) {
        rawModes.push(mode);
        Object.defineProperty(input, 'isRaw', { value: mode, writable: true });
        return input;
      },
    },
  });
  return { input, stream, rawModes };
}

test('interactive secret input is captured until Enter without terminal echo', async () => {
  const { input, stream, rawModes } = ttyInput();
  const pending = readSecretInput(input);
  stream.write(Buffer.from('\u001b[200~secret-valuX\u007fe\u001b[201~\r'));

  assert.equal(await pending, 'secret-value');
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(input.isRaw, false);
});

test('interactive cancellation restores terminal mode', async () => {
  const { input, stream, rawModes } = ttyInput();
  const pending = readSecretInput(input);
  stream.write(Buffer.from('do-not-store\u0003'));

  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(rawModes, [true, false]);
});

test('piped secret input retains the non-interactive stdin path', async () => {
  const input = Readable.from(['piped-secret\n']) as unknown as NodeJS.ReadStream;
  assert.equal(await readSecretInput(input), 'piped-secret');
});
