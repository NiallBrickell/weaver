import { strict as assert } from 'node:assert';
import { describe, it, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalSdkExecutor } from './executor/localSdk.js';
import {
  consumeDueWorkerInfrastructureWakes,
  finalizeWorkerRun,
  isReadOnlyMcpTool,
  isReadOnlyShellCommand,
  selectExecutor,
} from './worker.js';
import { arrive, createWorkstream, load } from './store.js';
import { virtualNow } from './clock.js';
import type { InfrastructureWait } from './types.js';

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

function workerHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-worker-capacity-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

async function runningWorker(slug: string): Promise<void> {
  await createWorkstream({
    slug,
    title: slug,
    objective: 'test worker finalization',
    tags: [],
    successCriteria: [],
    constraints: [],
    autonomy: { sendsRequireApproval: true },
    budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
  });
  await arrive(slug, (d) => d.assignments.push({
    id: 'asg_worker', objective: 'produce evidence', briefing: 'n/a', kind: 'research',
    acceptanceCriteria: ['n/a'], dependsOn: [], state: 'running',
    attempts: [{ runId: 'run_worker', startedAt: new Date().toISOString() }],
    adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
  }));
}

test('worker infrastructure failure preserves the assignment and schedules a typed future retry', async () => {
  const home = workerHome();
  try {
    await runningWorker('worker-infra');
    const infrastructure: InfrastructureWait = {
      kind: 'usage_limit',
      recovery: 'wait_or_enable_usage_credits',
      source: 'worker',
      sourceId: 'run_worker',
      model: 'sonnet',
      detectedAt: virtualNow().toISOString(),
      retryAt: new Date(virtualNow().getTime() + 60_000).toISOString(),
    };
    await finalizeWorkerRun('worker-infra', 'asg_worker', 'run_worker', {
      submitted: false,
      costUsd: 0,
      infrastructure,
    });

    const doc = await load('worker-infra');
    const asg = doc.assignments[0]!;
    assert.equal(asg.state, 'queued');
    assert.equal(asg.attempts[0]!.terminalReason, 'infrastructure_backoff');
    assert.equal(asg.attempts[0]!.infrastructure!.kind, 'usage_limit');
    assert.equal(doc.capacity!.byModel.sonnet!.consecutiveBackoffs, 1);
    assert.equal(doc.wakes.length, 1);
    assert.equal(doc.wakes[0]!.condition.type, 'time');
    assert.equal(doc.wakes[0]!.infrastructure!.sourceId, 'run_worker');
    assert.ok(!doc.wakes.some((wake) => wake.condition.type === 'immediate'));
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ordinary no-submission remains a failed assignment with immediate reconciliation', async () => {
  const home = workerHome();
  try {
    await runningWorker('worker-ordinary');
    await finalizeWorkerRun('worker-ordinary', 'asg_worker', 'run_worker', {
      submitted: false,
      costUsd: 0,
      infrastructure: null,
    });
    const doc = await load('worker-ordinary');
    assert.equal(doc.assignments[0]!.state, 'failed');
    assert.equal(doc.assignments[0]!.attempts[0]!.terminalReason, 'no_submission');
    assert.equal(doc.wakes[0]!.condition.type, 'immediate');
    assert.equal(doc.wakes[0]!.infrastructure, undefined);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a worker retry consumes worker capacity permits but preserves coordinator wakes', async () => {
  const home = workerHome();
  try {
    await runningWorker('worker-permits');
    const due = virtualNow().toISOString();
    await arrive('worker-permits', (d) => {
      const base: InfrastructureWait = {
        kind: 'rate_limit',
        recovery: 'automatic_retry',
        source: 'worker',
        sourceId: 'run_old',
        model: 'sonnet',
        detectedAt: due,
        retryAt: due,
      };
      d.wakes.push(
        {
          id: 'wake_worker', reason: 'worker permit', condition: { type: 'time', dueAtVirtual: due },
          status: 'pending', createdAt: due, infrastructure: base,
        },
        {
          id: 'wake_coordinator', reason: 'controller commitment', condition: { type: 'time', dueAtVirtual: due },
          status: 'pending', createdAt: due,
          infrastructure: { ...base, source: 'coordinator', sourceId: 'pass_old' },
        },
      );
    });

    const doc = await load('worker-permits');
    consumeDueWorkerInfrastructureWakes(doc, 'sonnet', due);
    assert.equal(doc.wakes.find((wake) => wake.id === 'wake_worker')!.status, 'cancelled');
    assert.equal(doc.wakes.find((wake) => wake.id === 'wake_coordinator')!.status, 'pending');
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
