import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { LocalSdkExecutor } from './executor/localSdk.js';
import {
  isReadOnlyMcpTool,
  isReadOnlyShellCommand,
  operatorMcpCapability,
  selectExecutor,
} from './worker.js';

describe('executor selection', () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.WEAVER_EXECUTOR;
    if (value === undefined) delete process.env.WEAVER_EXECUTOR;
    else process.env.WEAVER_EXECUTOR = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.WEAVER_EXECUTOR;
      else process.env.WEAVER_EXECUTOR = prev;
    }
  };

  it('unset and local-sdk both resolve to the local SDK reference executor', () => {
    withEnv(undefined, () => assert.ok(selectExecutor() instanceof LocalSdkExecutor));
    withEnv('local-sdk', () => assert.ok(selectExecutor() instanceof LocalSdkExecutor));
  });

  it('an unknown executor fails hard, naming the variable — never a silent local fallback', () => {
    withEnv('managed-agents', () =>
      assert.throws(() => selectExecutor(), /WEAVER_EXECUTOR 'managed-agents'/),
    );
  });
});

describe('operator MCP capability', () => {
  it('preserves global and applicable project servers with referenced environment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-mcp-capability-'));
    const configPath = path.join(root, '.claude.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          langfuse: {
            type: 'http',
            url: 'https://example.invalid/langfuse',
            headers: { Authorization: 'Bearer ${LANGFUSE_TOKEN}' },
          },
        },
        projects: {
          [root]: {
            mcpServers: {
              magpie: { command: 'magpie-mcp', env: { TOKEN: '${MAGPIE_TOKEN}' } },
            },
          },
          '/somewhere/else': { mcpServers: { unrelated: { command: 'nope' } } },
        },
      }),
    );

    const capability = operatorMcpCapability([path.join(root, 'repo')], configPath, {
      LANGFUSE_TOKEN: 'synthetic-langfuse-token',
      MAGPIE_TOKEN: 'synthetic-magpie-token',
      UNRELATED_HOST_SECRET: 'must-not-cross',
    });

    assert.deepEqual(Object.keys(capability.servers).sort(), ['langfuse', 'magpie']);
    assert.deepEqual(capability.env, {
      LANGFUSE_TOKEN: 'synthetic-langfuse-token',
      MAGPIE_TOKEN: 'synthetic-magpie-token',
    });
  });

  it('treats a missing config as empty but fails loudly on malformed config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-mcp-capability-'));
    const configPath = path.join(root, '.claude.json');
    assert.deepEqual(operatorMcpCapability([], configPath, {}), { servers: {}, env: {} });
    fs.writeFileSync(configPath, '{ malformed');
    assert.throws(
      () => operatorMcpCapability([], configPath, {}),
      /invalid inherited MCP configuration/,
    );
  });

  it('fails rather than overwrite an inherited server colliding with the harness surface', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-mcp-capability-'));
    const configPath = path.join(root, '.claude.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { weaver: { command: 'operator-owned-server' } } }),
    );
    assert.throws(
      () => operatorMcpCapability([], configPath, {}),
      /server name 'weaver' is reserved/,
    );
  });
});

describe('read-only MCP gate', () => {
  it('allows retrieval methods across naming styles', () => {
    for (const name of [
      'mcp__axiom__queryDataset',
      'mcp__axiom__getDatasetFields',
      'mcp__axiom__listDashboards',
      'mcp__axiom__checkMonitors',
      'mcp__axiom__exportDashboard',
      'mcp__sentry__search_issues',
      'mcp__sentry__find_organizations',
      'mcp__sentry__get_sentry_resource',
      'mcp__posthog__query', // bare verb, no suffix
      'mcp__claude_ai_Gmail__search_emails', // server name containing underscores
    ]) {
      assert.equal(isReadOnlyMcpTool(name), true, name);
    }
  });

  it('denies mutating and ambiguous methods', () => {
    for (const name of [
      'mcp__axiom__createMonitor',
      'mcp__axiom__updateDashboard',
      'mcp__axiom__deleteNotifier',
      'mcp__sentry__update_issue',
      'mcp__sentry__execute_sentry_tool', // dispatcher that can reach writes
      'mcp__claude_ai_Gmail__send_email',
      'mcp__claude_ai_Attio__authenticate',
      'mcp__anything__gettysburg_address', // read verb as a mere prefix
    ]) {
      assert.equal(isReadOnlyMcpTool(name), false, name);
    }
  });

  it('denies non-MCP tool names outright', () => {
    assert.equal(isReadOnlyMcpTool('Bash'), false);
    assert.equal(isReadOnlyMcpTool('Write'), false);
    assert.equal(isReadOnlyMcpTool('mcp__broken'), false);
  });
});

describe('read-only shell gate', () => {
  it('allows plain history-reading commands', () => {
    for (const cmd of [
      'git log --oneline -20',
      'git log -S chain_0 -- backend/middleware/',
      'git -C /Users/niall/work/erdo/erdo show 439519e1b',
      'git --no-pager diff HEAD~3 -- docs/',
      'git blame backend/middleware/middleware.go -L 100,140',
      'git grep -n handleError',
      'gh pr view 1683 --comments',
      'gh pr list --state merged --search axiom',
      'gh issue view 42',
      'gh search prs error chain --repo erdoai/erdo',
      'gh run view 123456',
    ]) {
      assert.equal(isReadOnlyShellCommand(cmd), true, cmd);
    }
  });

  it('denies mutation, chaining, redirection, and output flags', () => {
    for (const cmd of [
      'git push origin main',
      'git commit -m x',
      'git checkout -b evil',
      'gh pr merge 5 --squash',
      'gh pr create --title x',
      'gh api -X POST /repos/x/y/issues',
      'git log; rm -rf /',
      'git log && git push',
      'git log | tee /tmp/x',
      'git log > /tmp/x',
      'git log $(whoami)',
      'git log `whoami`',
      'git format-patch --output=/tmp/x HEAD~1',
      'rm -rf /',
      'curl https://example.com',
    ]) {
      assert.equal(isReadOnlyShellCommand(cmd), false, cmd);
    }
  });
});
