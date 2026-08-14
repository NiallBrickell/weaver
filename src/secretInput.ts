/** Read a secret without letting an interactive terminal echo it. */
export async function readSecretInput(
  input: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    let value = '';
    for await (const chunk of input) value += chunk.toString();
    return value.trim();
  }

  const wasRaw = input.isRaw ?? false;
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    let terminalEscape: false | 'start' | 'csi' = false;
    let settled = false;

    const restoreRawMode = () => {
      try { input.setRawMode!(wasRaw); }
      catch { /* The terminal may already have gone away. */ }
    };
    const cleanup = () => {
      input.off('data', onData);
      input.off('error', onError);
      process.off('exit', restoreRawMode);
      process.off('SIGHUP', onSignal);
      process.off('SIGTERM', onSignal);
      restoreRawMode();
      input.pause();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onSignal = () => finish(new Error('secret input interrupted'));
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (terminalEscape) {
          // Ignore terminal control sequences such as bracketed-paste markers
          // and arrow keys; they are interface metadata, not secret bytes.
          if (terminalEscape === 'start') {
            terminalEscape = character === '[' ? 'csi' : false;
          } else if (character >= '@' && character <= '~') {
            terminalEscape = false;
          }
          continue;
        }
        if (character === '\u001b') {
          terminalEscape = 'start';
          continue;
        }
        if (character === '\u0003') {
          finish(new Error('secret input cancelled'));
          return;
        }
        if (character === '\u0004' || character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };

    process.once('exit', restoreRawMode);
    process.once('SIGHUP', onSignal);
    process.once('SIGTERM', onSignal);
    input.on('data', onData);
    input.once('error', onError);
    try {
      input.setRawMode(true);
      input.resume();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
