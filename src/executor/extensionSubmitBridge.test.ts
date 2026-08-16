import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubmitResultArgs } from './types.js';
import { startExtensionSubmitBridge } from './extensionSubmitBridge.js';

test('extension submission bridge authenticates its two routes and scrubs every persisted field and reply', async () => {
  const providerSecret = 'provider-secret-value';
  let bridgeUrl = '';
  let bridgeToken = '';
  let appended = '';
  let submitted: SubmitResultArgs | null = null;
  const bridge = await startExtensionSubmitBridge({
    async appendSection(content) {
      appended = content;
      return { text: `append accepted ${providerSecret} ${bridgeToken}` };
    },
    async submitResult(args) {
      submitted = args;
      return { text: `submit accepted ${providerSecret} ${bridgeUrl}` };
    },
  }, { redactionSecrets: { OPENROUTER_API_KEY: providerSecret } });
  bridgeUrl = bridge.url;
  bridgeToken = bridge.token;

  try {
    const unauthorized = await fetch(`${bridge.url}/submit-result`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);

    const call = (path: string, body: unknown) => fetch(`${bridge.url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const append = await call('/append-section', {
      content: `section ${providerSecret} ${bridge.token} ${bridge.url}`,
    });
    const appendReply = await append.text();
    assert.equal(append.status, 200);
    assert.equal(appended.includes(providerSecret), false);
    assert.equal(appended.includes(bridge.token), false);
    assert.equal(appended.includes(bridge.url), false);
    assert.equal(appendReply.includes(providerSecret), false);
    assert.equal(appendReply.includes(bridge.token), false);

    const dirty = `artifact ${providerSecret} ${bridge.token} ${bridge.url}`;
    const submit = await call('/submit-result', {
      summary: dirty,
      artifact: { title: dirty, kind: dirty, file_name: dirty, content: dirty },
    });
    const submitReply = await submit.text();
    assert.equal(submit.status, 200);
    assert.ok(submitted);
    assert.equal(JSON.stringify(submitted).includes(providerSecret), false);
    assert.equal(JSON.stringify(submitted).includes(bridge.token), false);
    assert.equal(JSON.stringify(submitted).includes(bridge.url), false);
    assert.equal(submitReply.includes(providerSecret), false);
    assert.equal(submitReply.includes(bridge.url), false);
  } finally {
    await bridge.close();
  }
});
