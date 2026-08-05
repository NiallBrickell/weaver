import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isReadOnlyMcpTool } from './worker.js';

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
