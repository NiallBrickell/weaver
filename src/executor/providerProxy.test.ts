import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { startProviderProxy } from './providerProxy.js';

describe('provider proxy', () => {
  it('holds the durable key on the host and exposes only a per-run inference bearer', async () => {
    const upstreamCalls: Array<{ url: string; init: RequestInit }> = [];
    const proxy = await startProviderProxy({
      upstreamBaseUrl: 'https://provider.example/api/v1/',
      upstreamApiKey: 'durable-provider-key',
      allowedModels: ['openrouter/moonshotai/kimi-k3'],
      maxRequests: 1,
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      token: 'ephemeral-run-key',
      fetch: (async (input, init = {}) => {
        upstreamCalls.push({ url: String(input), init });
        return new Response(JSON.stringify({
          id: 'completion-1',
          model: 'moonshotai/kimi-k3',
          accidental_echo: 'durable-provider-key',
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            ETag: 'stale-after-redaction',
          },
        });
      }) as typeof globalThis.fetch,
    });

    try {
      const unauthorized = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(upstreamCalls.length, 0);

      const unsupported = await fetch(`${proxy.url}/models`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxy.token}` },
        body: '{}',
      });
      assert.equal(unsupported.status, 404);
      assert.equal(upstreamCalls.length, 0);

      const wrongModel = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxy.token}` },
        body: JSON.stringify({ model: 'another/expensive-model' }),
      });
      assert.equal(wrongModel.status, 403);
      assert.equal(upstreamCalls.length, 0);

      const response = await fetch(`${proxy.url}/chat/completions?trace=1`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proxy.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'openrouter/moonshotai/kimi-k3' }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(response.headers.get('Content-Encoding'), null);
      assert.equal(response.headers.get('ETag'), null);
      assert.ok(!text.includes('durable-provider-key'));
      assert.match(text, /\[REDACTED\]/);
      assert.equal(proxy.modelResolved(), 'moonshotai/kimi-k3');
      assert.equal(upstreamCalls.length, 1);
      assert.equal(
        upstreamCalls[0]!.url,
        'https://provider.example/api/v1/chat/completions?trace=1',
      );
      assert.equal(
        new Headers(upstreamCalls[0]!.init.headers).get('Authorization'),
        'Bearer durable-provider-key',
      );
      assert.ok(!JSON.stringify(upstreamCalls[0]!.init).includes('ephemeral-run-key'));

      const overBudget = await fetch(`${proxy.url}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxy.token}` },
        body: JSON.stringify({ model: 'openrouter/moonshotai/kimi-k3' }),
      });
      assert.equal(overBudget.status, 409);
      assert.equal(upstreamCalls.length, 1);
    } finally {
      await proxy.close();
      await proxy.close();
    }
  });

  it('reads actual model identity from an upstream streaming response', async () => {
    const proxy = await startProviderProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'durable-provider-key',
      allowedModels: ['moonshotai/kimi-k3'],
      maxRequests: 1,
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      token: 'ephemeral-run-key',
      fetch: (async () => new Response(
        'data: {"id":"chunk-1","model":"moonshotai/kimi-k3"}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof globalThis.fetch,
    });

    try {
      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxy.token}` },
        body: JSON.stringify({ model: 'moonshotai/kimi-k3' }),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(proxy.modelResolved(), 'moonshotai/kimi-k3');
    } finally {
      await proxy.close();
    }
  });

  it('aborts an active upstream request before closing the run proxy', async () => {
    let started!: () => void;
    const upstreamStarted = new Promise<void>((resolvePromise) => { started = resolvePromise; });
    let upstreamAborted = false;
    const proxy = await startProviderProxy({
      upstreamBaseUrl: 'https://provider.example/v1',
      upstreamApiKey: 'durable-provider-key',
      allowedModels: ['moonshotai/kimi-k3'],
      maxRequests: 1,
      bindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      token: 'ephemeral-run-key',
      fetch: (async (_input, init = {}) => new Promise<Response>((_resolve, reject) => {
        started();
        init.signal?.addEventListener('abort', () => {
          upstreamAborted = true;
          const error = new Error('upstream aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })) as typeof globalThis.fetch,
    });

    const pending = fetch(`${proxy.url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model: 'moonshotai/kimi-k3' }),
    });
    await upstreamStarted;
    await proxy.close();
    const response = await pending;

    assert.equal(upstreamAborted, true);
    assert.equal(response.status, 502);
  });
});
