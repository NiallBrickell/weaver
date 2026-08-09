import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SubmitResultArgs, SubmitSurface } from './types.js';
import { startSubmitBridge } from './submitBridge.js';

test('submit bridge authenticates MCP calls and relays both submission tools', async () => {
  const sections: string[] = [];
  const submissions: SubmitResultArgs[] = [];
  const submit: SubmitSurface = {
    async appendSection(content) {
      sections.push(content);
      return { text: `appended ${content.length}` };
    },
    async submitResult(args) {
      submissions.push(args);
      return { text: 'submission refused for the fixture', isError: true };
    },
  };
  const bridge = await startSubmitBridge(submit);
  const client = new Client({ name: 'weaver-submit-bridge-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
  });

  try {
    const unauthorized = await fetch(bridge.url, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['append_section', 'submit_result']);

    const appended = await client.callTool({
      name: 'append_section',
      arguments: { content: `credential ${bridge.token}` },
    });
    assert.deepEqual(sections, ['credential [REDACTED]']);
    assert.deepEqual(appended.content, [{ type: 'text', text: `appended ${sections[0]!.length}` }]);

    const args: SubmitResultArgs = {
      summary: `A deterministic summary without ${bridge.token}.`,
      artifact: {
        title: `Fixture ${bridge.token}`,
        kind: `report-${bridge.token}`,
        file_name: `${bridge.token}.md`,
        content: `# Fixture\n${bridge.token}\n`,
      },
    };
    const submitted = await client.callTool({
      name: 'submit_result',
      arguments: { ...args, artifact: { ...args.artifact } },
    });
    assert.deepEqual(submissions, [{
      summary: 'A deterministic summary without [REDACTED].',
      artifact: {
        title: 'Fixture [REDACTED]',
        kind: 'report-[REDACTED]',
        file_name: '[REDACTED].md',
        content: '# Fixture\n[REDACTED]\n',
      },
    }]);
    assert.equal(submitted.isError, true);
    assert.deepEqual(submitted.content, [{ type: 'text', text: 'submission refused for the fixture' }]);
  } finally {
    await client.close();
    await bridge.close();
    await bridge.close();
  }
});

test('submit bridge can advertise a container-visible host without changing its bind interface', async () => {
  const submit: SubmitSurface = {
    async appendSection() { return { text: 'ok' }; },
    async submitResult() { return { text: 'ok' }; },
  };
  const bridge = await startSubmitBridge(submit, {
    bindHost: '127.0.0.1',
    advertiseHost: 'host.docker.internal',
  });
  try {
    assert.match(bridge.url, /^http:\/\/host\.docker\.internal:\d+\/mcp$/);
  } finally {
    await bridge.close();
  }
});
