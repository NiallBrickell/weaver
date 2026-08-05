import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isReadOnlyMcpTool, isReadOnlyShellCommand } from './worker.js';

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
