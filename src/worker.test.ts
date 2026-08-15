import { strict as assert } from 'node:assert';
import { describe, it, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalSdkExecutor } from './executor/localSdk.js';
import { OpenHandsExecutor } from './executor/openHands.js';
import { CodexExecutor } from './executor/codex.js';
import {
  consumeDueWorkerInfrastructureWakes,
  finalizeWorkerRun,
  runWorker,
  selectExecutor,
  workerExceptionReason,
} from './worker.js';
import { setExecutorSecret } from './secrets.js';
import { arrive, createWorkstream, load, readArtifact } from './store.js';
import { virtualNow } from './clock.js';
import type { InfrastructureWait } from './types.js';
import type { WorkerExecutionRequest, WorkerExecutor } from './executor/types.js';

test('worker failure provenance keeps the fatal line after warnings and redacts secrets', () => {
  const reason = workerExceptionReason(
    'WARNING: proceeding, even though we could not create PATH alias.\nThe actual fatal cause appears after the old eighty-character cutoff: credential SECRET_VALUE rejected by child process.',
    { TEST_TOKEN: 'SECRET_VALUE' },
  );
  assert.match(reason, /actual fatal cause appears/);
  assert.match(reason, /«secret:TEST_TOKEN»/);
  assert.doesNotMatch(reason, /SECRET_VALUE/);
});

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

  it('openhands resolves to the containerized remote executor', () => {
    withEnv('openhands', () => assert.ok(selectExecutor() instanceof OpenHandsExecutor));
  });

  it('codex-sdk resolves to the local subscription-backed Codex executor', () => {
    withEnv('codex-sdk', () => assert.ok(selectExecutor() instanceof CodexExecutor));
  });

  it('an unknown executor fails hard, naming the variable — never a silent local fallback', () => {
    withEnv('managed-agents', () =>
      assert.throws(() => selectExecutor(), /worker executor 'managed-agents'.*WEAVER_EXECUTOR/),
    );
  });
});

test('a work assignment runs as a regular full-capability Code worker with ungated read+write MCP', async () => {
  const home = workerHome();
  const readDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-research-source-'));
  let request: WorkerExecutionRequest | undefined;
  const executor: WorkerExecutor = {
    async execute(req) {
      request = req;
      req.onMessage?.({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.25,
          resetsAt: Math.floor((Date.now() + 60 * 60_000) / 1000),
        },
      } as never);
      const reply = await req.submit.submitResult({
        summary: 'Grounded evidence gathered with the regular coding-agent surface.',
        artifact: {
          title: 'Research evidence',
          kind: 'report',
          file_name: 'research-evidence.md',
          content: `# Research evidence\n\n${'Verified evidence from the declared source directory. '.repeat(6)}`,
        },
      });
      assert.equal(reply.isError, undefined);
      return { costUsd: 0.25, sessionId: 'fake-research-session' };
    },
  };

  try {
    await createWorkstream({
      slug: 'worker-research-surface',
      title: 'worker-research-surface',
      objective: 'test the complete research worker request',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
    });
    await arrive('worker-research-surface', (d) => d.assignments.push({
      id: 'asg_research',
      objective: 'inspect recorded engineering decisions',
      briefing: 'Read the declared repository and report grounded evidence.',
      kind: 'work',
      readDirs: [readDir],
      acceptanceCriteria: ['cite the source'],
      dependsOn: [],
      state: 'queued',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('worker-research-surface', 'asg_research', executor);

    assert.ok(request);
    assert.deepEqual(request.tools, { type: 'preset', preset: 'claude_code' });
    assert.deepEqual(request.systemPrompt.type, 'preset');
    assert.match(request.systemPrompt.append, /normal coding tools/);
    assert.match(request.systemPrompt.append, /Bash, file editing, web access/);
    // The freed-MCP-writes decision: a work worker is told it may use the
    // configured MCP servers read AND write, with no tool special-cased — so a
    // tracker status change is ordinary work, not a gated action. Pinned here so
    // a future prompt edit cannot silently re-forbid remote writes.
    assert.match(request.systemPrompt.append, /read AND write/);
    assert.match(request.systemPrompt.append, /IRREVERSIBLE egress/);
    assert.match(request.systemPrompt.append, /separate trigger, failed recovery, and escape/);
    assert.match(request.systemPrompt.append, /enumerate every configured attempt/);
    assert.match(request.systemPrompt.append, /missing telemetry is a finding/);
    assert.doesNotMatch(request.systemPrompt.append, /changing a remote service/);
    assert.equal(request.cwd, readDir);
    assert.deepEqual(request.additionalDirectories, [readDir]);
    assert.ok(request.prompt.includes(`- ${readDir}`));
    assert.match(request.prompt, /hard-aborted after 40 awake minutes/);
    assert.match(request.prompt, /By 30 awake minutes, stop optional investigation/);
    assert.match(request.prompt, /call append_section with the factual evidence already established/);
    assert.equal(request.permissionMode, 'bypassPermissions');
    assert.deepEqual(request.settingSources, ['user', 'project', 'local']);
    assert.equal(request.strictMcpConfig, false);
    assert.equal(request.supervise, undefined);
    assert.deepEqual(request.operatorMcpServers, {});

    const doc = await load('worker-research-surface');
    const assignment = doc.assignments[0]!;
    assert.equal(assignment.state, 'awaiting_review');
    assert.equal(assignment.adoption.state, 'proposed');
    assert.equal(assignment.attempts[0]!.costUsd, 0.25);
    assert.equal(assignment.attempts[0]!.sessionId, 'fake-research-session');
    assert.equal(assignment.attempts[0]!.executor, 'local-sdk');
    assert.equal(assignment.attempts[0]!.provider, 'anthropic');
    assert.equal(assignment.attempts[0]!.model, 'sonnet');
    assert.equal(doc.deliverables.length, 1);
    assert.equal(doc.providerCapacity?.length, 1);
    assert.equal(doc.providerCapacity?.[0]?.provider, 'anthropic');
    assert.equal(doc.providerCapacity?.[0]?.utilization, 0.25);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(readDir, { recursive: true, force: true });
  }
});

test('an OpenHands work assignment receives the applicable secured host MCP map', async () => {
  const stateHome = workerHome();
  const operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-openhands-operator-'));
  const workspace = path.join(operatorHome, 'work', 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  const credential = 'Bearer synthetic-openhands-mcp-secret';
  fs.writeFileSync(path.join(operatorHome, '.claude.json'), JSON.stringify({
    mcpServers: {
      global_tool: { command: 'synthetic-server', args: ['--stdio'] },
    },
    projects: {
      [workspace]: {
        mcpServers: {
          project_tool: {
            type: 'http',
            url: 'https://example.invalid/mcp',
            headers: { Authorization: credential },
          },
        },
      },
    },
  }));
  const previousHome = process.env.HOME;
  process.env.HOME = operatorHome;
  let request: WorkerExecutionRequest | undefined;
  const executor: WorkerExecutor = {
    id: 'openhands',
    async execute(req) {
      request = req;
      await req.submit.submitResult({
        summary: 'Used the remote worker surface and returned deterministic evidence.',
        artifact: {
          title: 'Remote surface evidence', kind: 'report', file_name: 'remote.md',
          content: `# Evidence\n\n${'Verified the secured operator MCP surface in the remote request. '.repeat(6)}`,
        },
      });
      return { costUsd: 0, sessionId: 'remote-surface-session' };
    },
  };

  try {
    await createWorkstream({
      slug: 'worker-openhands-mcp', title: 'worker-openhands-mcp',
      objective: 'carry ordinary MCP tools across the remote seam', tags: [],
      successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('worker-openhands-mcp', (d) => d.assignments.push({
      id: 'asg_remote_mcp', objective: 'use configured tools', briefing: 'Inspect the project.',
      kind: 'work', readDirs: [workspace], acceptanceCriteria: ['submit evidence'],
      dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('worker-openhands-mcp', 'asg_remote_mcp', executor);

    assert.ok(request);
    assert.deepEqual(Object.keys(request.operatorMcpServers).sort(), ['global_tool', 'project_tool']);
    assert.doesNotMatch(JSON.stringify(request.operatorMcpServers), /synthetic-openhands-mcp-secret/);
    assert.equal(request.env.WEAVER_INTERNAL_MCP_HEADER_1, credential);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.WEAVER_HOME;
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(operatorHome, { recursive: true, force: true });
  }
});

test('a malformed remote MCP map fails before an OpenHands attempt is claimed', async () => {
  const stateHome = workerHome();
  const operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-openhands-bad-mcp-'));
  const workspace = path.join(operatorHome, 'work', 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(operatorHome, '.claude.json'), '{ malformed');
  const previousHome = process.env.HOME;
  process.env.HOME = operatorHome;
  let launched = false;
  const executor: WorkerExecutor = {
    id: 'openhands',
    async execute() {
      launched = true;
      return { costUsd: 0 };
    },
  };

  try {
    await createWorkstream({
      slug: 'worker-openhands-bad-mcp', title: 'worker-openhands-bad-mcp',
      objective: 'fail closed on malformed remote MCP discovery', tags: [],
      successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('worker-openhands-bad-mcp', (d) => d.assignments.push({
      id: 'asg_remote_bad_mcp', objective: 'use configured tools', briefing: 'Inspect the project.',
      kind: 'work', readDirs: [workspace], acceptanceCriteria: ['submit evidence'],
      dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await assert.rejects(
      runWorker('worker-openhands-bad-mcp', 'asg_remote_bad_mcp', executor),
      /OpenHands could not load the operator MCP configuration/,
    );
    assert.equal(launched, false);
    const assignment = (await load('worker-openhands-bad-mcp')).assignments[0]!;
    assert.equal(assignment.state, 'queued');
    assert.equal(assignment.attempts.length, 0);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.WEAVER_HOME;
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(operatorHome, { recursive: true, force: true });
  }
});

test('generic worker capture scrubs executor-only values from every submission field', async () => {
  const home = workerHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-worker-executor-secret-'));
  const secret = 'executor-only-provider-value-987';
  setExecutorSecret('OPENROUTER_API_KEY', secret);
  const executor: WorkerExecutor = {
    async execute(req) {
      const reply = await req.submit.submitResult({
        summary: `summary ${secret}`,
        artifact: {
          title: `title ${secret}`,
          kind: `kind ${secret}`,
          file_name: `file-${secret}.md`,
          content: `# Evidence\n\n${(`content ${secret} verified. `).repeat(12)}`,
        },
      });
      assert.equal(reply.isError, undefined);
      return { costUsd: 0, sessionId: 'secret-scrub-session' };
    },
  };
  try {
    await createWorkstream({
      slug: 'worker-executor-secret',
      title: 'Worker executor secret',
      objective: 'prove all worker capture fields are scrubbed',
      tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('worker-executor-secret', (d) => d.assignments.push({
      id: 'asg_secret', objective: 'submit evidence', briefing: 'Submit the bounded evidence.',
      kind: 'work', readDirs: [workspace], acceptanceCriteria: ['submission lands'],
      dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('worker-executor-secret', 'asg_secret', executor);

    const doc = await load('worker-executor-secret');
    assert.equal(doc.assignments[0]!.state, 'awaiting_review');
    assert.doesNotMatch(JSON.stringify(doc), new RegExp(secret));
    assert.match(doc.deliverables[0]!.title, /«secret:OPENROUTER_API_KEY»/);
    const artifact = await readArtifact('worker-executor-secret', doc.deliverables[0]!.path);
    assert.doesNotMatch(artifact, new RegExp(secret));
    assert.match(artifact, /«secret:OPENROUTER_API_KEY»/);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a typed bounded repair pins the reviewed Codex route on its disposable attempt', async () => {
  const home = workerHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-routed-worker-'));
  const previousExecutor = process.env.WEAVER_EXECUTOR;
  const previousModel = process.env.WEAVER_WORKER_MODEL;
  process.env.WEAVER_EXECUTOR = 'codex-sdk';
  process.env.WEAVER_WORKER_MODEL = 'gpt-5.5';
  const executor: WorkerExecutor = {
    async execute(req) {
      assert.equal(req.model, 'gpt-5.6-sol');
      assert.deepEqual(req.operatorMcpServers, {});
      const reply = await req.submit.submitResult({
        summary: 'Applied the bounded repair and ran its deterministic verification.',
        artifact: {
          title: 'Bounded repair evidence', kind: 'report', file_name: 'repair.md',
          content: `# Repair\n\n${'Verified the bounded repair against deterministic tests. '.repeat(6)}`,
        },
      });
      assert.equal(reply.isError, undefined);
      return { costUsd: 0, sessionId: 'routed-session' };
    },
  };
  try {
    await createWorkstream({
      slug: 'routed-worker', title: 'Routed worker', objective: 'repair one defect',
      tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('routed-worker', (d) => d.assignments.push({
      id: 'asg_routed', objective: 'repair one selector', briefing: 'Fix and verify it.',
      kind: 'work',
      executionRequirements: { profile: 'bounded-code-repair', modalities: ['text'] },
      readDirs: [workspace], acceptanceCriteria: ['tests pass'], dependsOn: [],
      state: 'queued', attempts: [], adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('routed-worker', 'asg_routed', executor);
    const attempt = (await load('routed-worker')).assignments[0]!.attempts[0]!;
    assert.deepEqual({
      executor: attempt.executor, provider: attempt.provider, model: attempt.model,
    }, {
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
    });
  } finally {
    if (previousExecutor === undefined) delete process.env.WEAVER_EXECUTOR;
    else process.env.WEAVER_EXECUTOR = previousExecutor;
    if (previousModel === undefined) delete process.env.WEAVER_WORKER_MODEL;
    else process.env.WEAVER_WORKER_MODEL = previousModel;
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a declared action uses the same Code surface with Pilot supervision', async () => {
  const home = workerHome();
  const actionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-action-worker-'));
  let request: WorkerExecutionRequest | undefined;
  const executor: WorkerExecutor = {
    async execute(req) {
      request = req;
      const reply = await req.submit.submitResult({
        summary: 'The approved action was attempted and is ready for deterministic readback.',
        artifact: {
          title: 'Action report',
          kind: 'report',
          file_name: 'action-report.md',
          content: `# Action report\n\n${'Exact action execution evidence for the engine readback. '.repeat(6)}`,
        },
      });
      assert.equal(reply.isError, undefined);
      return { costUsd: 0.1, sessionId: 'fake-action-session' };
    },
  };

  try {
    await createWorkstream({
      slug: 'worker-action-surface',
      title: 'worker-action-surface',
      objective: 'test the declared action request',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
    });
    await arrive('worker-action-surface', (d) => d.assignments.push({
      id: 'asg_action',
      objective: 'perform one approved external action',
      briefing: 'Perform only the approved act and report its exact result.',
      kind: 'action',
      acceptanceCriteria: ['report exact evidence'],
      dependsOn: [],
      state: 'queued',
      attempts: [],
      adoption: { state: 'none' },
      exec: {
        cwd: actionDir,
        verify: 'true',
        approval: { by: 'human', at: new Date().toISOString() },
      },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('worker-action-surface', 'asg_action', executor);

    assert.ok(request);
    assert.deepEqual(request.tools, { type: 'preset', preset: 'claude_code' });
    assert.equal(request.permissionMode, 'default');
    assert.deepEqual(request.settingSources, []);
    assert.equal(request.strictMcpConfig, true);
    assert.equal(typeof request.supervise, 'function');
    assert.equal(request.cwd, actionDir);
    assert.match(request.systemPrompt.append, /human-approved real-world ACTION/);
    assert.match(request.systemPrompt.append, /containment only/);
    assert.match(request.systemPrompt.append, /does not fix the upstream failure/);
    const attempt = (await load('worker-action-surface')).assignments[0]!.attempts[0]!;
    assert.equal(attempt.executor, 'local-sdk');
    assert.equal(attempt.provider, 'anthropic');
    assert.equal(attempt.model, 'sonnet');

    request = undefined;
    await arrive('worker-action-surface', (d) => d.assignments.push({
      id: 'asg_human_only',
      objective: 'perform one founder-reserved external action',
      briefing: 'Do not run without founder approval.',
      kind: 'action',
      acceptanceCriteria: ['no execution under Pilot-only authority'],
      dependsOn: [],
      state: 'queued',
      attempts: [],
      adoption: { state: 'none' },
      exec: {
        cwd: actionDir,
        verify: 'true',
        approvalMode: 'human-only',
        approval: { by: 'pilot', at: new Date().toISOString() },
      },
      createdAtVirtual: virtualNow().toISOString(),
    }));
    await runWorker('worker-action-surface', 'asg_human_only', executor);
    assert.equal(request, undefined, 'wrong approval authority must fail before executor launch');
    const refused = (await load('worker-action-surface')).assignments.find((a) => a.id === 'asg_human_only')!;
    assert.equal(refused.state, 'failed');
    assert.match(refused.attempts[0]!.terminalReason ?? '', /without the required approval authority/);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(actionDir, { recursive: true, force: true });
  }
});

function workerHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-worker-capacity-'));
  process.env.WEAVER_HOME = dir;
  return dir;
}

test('a runner cannot claim an explicitly selected executor it did not declare', async () => {
  const home = workerHome();
  let executed = false;
  const executor: WorkerExecutor = {
    id: 'codex-sdk',
    async execute() {
      executed = true;
      return { costUsd: 0 };
    },
  };
  try {
    await createWorkstream({
      slug: 'worker-capability-claim',
      title: 'worker-capability-claim',
      objective: 'leave unsupported work unclaimed',
      tags: [], successCriteria: [], constraints: [],
      autonomy: { sendsRequireApproval: true },
    });
    await arrive('worker-capability-claim', (d) => d.assignments.push({
      id: 'asg_capability', objective: 'produce evidence', briefing: 'n/a', kind: 'work',
      acceptanceCriteria: ['n/a'], dependsOn: [], state: 'queued', attempts: [],
      adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    }));

    assert.equal(
      await runWorker(
        'worker-capability-claim',
        'asg_capability',
        executor,
        new Set(['local-sdk']),
      ),
      false,
    );
    const assignment = (await load('worker-capability-claim')).assignments[0]!;
    assert.equal(executed, false);
    assert.equal(assignment.state, 'queued');
    assert.deepEqual(assignment.attempts, []);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function runningWorker(slug: string, kind: 'work' | 'action' = 'work'): Promise<void> {
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
    id: 'asg_worker', objective: 'produce evidence', briefing: 'n/a', kind,
    acceptanceCriteria: ['n/a'], dependsOn: [], state: 'running',
    attempts: [{ runId: 'run_worker', startedAt: new Date().toISOString() }],
    adoption: { state: 'none' }, createdAtVirtual: virtualNow().toISOString(),
    ...(kind === 'action' ? {
      exec: {
        cwd: process.env.WEAVER_HOME!,
        verify: 'false',
        approval: { by: 'human' as const, at: new Date().toISOString() },
      },
    } : {}),
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

test('action infrastructure failure is held failed while ordinary work remains queued for retry', async () => {
  const home = workerHome();
  try {
    const infrastructure: InfrastructureWait = {
      kind: 'usage_limit',
      recovery: 'wait_or_enable_usage_credits',
      source: 'worker',
      sourceId: 'run_worker',
      model: 'sonnet',
      detectedAt: virtualNow().toISOString(),
      retryAt: new Date(virtualNow().getTime() + 60_000).toISOString(),
    };
    await runningWorker('worker-action-infra', 'action');
    await finalizeWorkerRun('worker-action-infra', 'asg_worker', 'run_worker', {
      submitted: false,
      costUsd: 0,
      infrastructure,
    });
    await runningWorker('worker-work-infra');
    await finalizeWorkerRun('worker-work-infra', 'asg_worker', 'run_worker', {
      submitted: false,
      costUsd: 0,
      infrastructure: { ...infrastructure },
    });

    const action = (await load('worker-action-infra')).assignments[0]!;
    const work = (await load('worker-work-infra')).assignments[0]!;
    assert.equal(action.state, 'failed', 'an action must be durably held before engine readback');
    assert.equal(action.attempts[0]!.terminalReason, 'infrastructure_backoff');
    assert.equal(work.state, 'queued', 'ordinary intended work retains typed infrastructure retry behavior');
    assert.equal(work.attempts[0]!.terminalReason, 'infrastructure_backoff');
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runWorker refuses a legacy queued action that already has an attempt', async () => {
  const home = workerHome();
  let executed = false;
  const executor: WorkerExecutor = {
    async execute() {
      executed = true;
      return { costUsd: 0 };
    },
  };
  try {
    await runningWorker('worker-action-one-shot', 'action');
    await arrive('worker-action-one-shot', (d) => {
      d.assignments[0]!.state = 'queued';
      d.assignments[0]!.attempts[0]!.endedAt = new Date().toISOString();
      d.assignments[0]!.attempts[0]!.terminalReason = 'crashed';
    });

    assert.equal(await runWorker('worker-action-one-shot', 'asg_worker', executor), false);
    assert.equal(executed, false);
    assert.equal((await load('worker-action-one-shot')).assignments[0]!.attempts.length, 1);
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

test('worker wall timeout is durable work failure, not provider capacity', async () => {
  const home = workerHome();
  try {
    await runningWorker('worker-wall');
    await finalizeWorkerRun('worker-wall', 'asg_worker', 'run_worker', {
      submitted: false,
      costUsd: 0,
      infrastructure: null,
      terminalReason: 'wall_timeout',
    });
    const doc = await load('worker-wall');
    assert.equal(doc.assignments[0]!.state, 'failed');
    assert.equal(doc.assignments[0]!.attempts[0]!.terminalReason, 'wall_timeout');
    assert.equal(doc.capacity, null);
    assert.equal(doc.wakes[0]!.condition.type, 'immediate');
    assert.equal(doc.wakes[0]!.infrastructure, undefined);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('worker wall preserves appended evidence as a typed, non-adoptable checkpoint', async () => {
  const home = workerHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-worker-checkpoint-'));
  const executor: WorkerExecutor = {
    async execute(req) {
      const reply = await req.submit.appendSection(
        `# Verified checkpoint\n\n${'Current-state evidence was read back and verified before the hard wall. '.repeat(8)}`,
      );
      assert.equal(reply.isError, undefined);
      await new Promise<void>((resolve, reject) => {
        // armWall intentionally unrefs its production timer so an idle runner
        // can exit cleanly. Keep this synthetic executor alive while waiting
        // for that timer; otherwise Node may end the test before the unref'd
        // wall gets a chance to fire (as the Linux CI runner correctly did).
        const guard = setTimeout(() => reject(new Error('worker wall did not fire')), 1_000);
        const onAbort = () => {
          clearTimeout(guard);
          resolve();
        };
        if (req.abort.signal.aborted) onAbort();
        else req.abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      return { costUsd: 0.1, sessionId: 'checkpoint-session' };
    },
  };

  try {
    await createWorkstream({
      slug: 'worker-checkpoint', title: 'worker-checkpoint',
      objective: 'preserve verified work at the wall', tags: [],
      successCriteria: [], constraints: [], autonomy: { sendsRequireApproval: true },
    });
    await arrive('worker-checkpoint', (d) => d.assignments.push({
      id: 'asg_checkpoint', objective: 'verify a bounded external repair',
      briefing: 'Read back the repair and return evidence.', kind: 'work',
      readDirs: [workspace], acceptanceCriteria: ['current state is verified'],
      dependsOn: [], state: 'queued', attempts: [], adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('worker-checkpoint', 'asg_checkpoint', executor, undefined, {
      wallMs: 40,
      wallTickMs: 10,
    });

    const doc = await load('worker-checkpoint');
    const assignment = doc.assignments[0]!;
    assert.equal(assignment.state, 'awaiting_review');
    assert.equal(assignment.adoption.state, 'proposed');
    assert.equal(assignment.submission?.completeness, 'checkpoint');
    assert.equal(assignment.attempts[0]!.terminalReason, 'wall_timeout_checkpoint');
    assert.equal(doc.deliverables.length, 1);
    assert.equal(doc.deliverables[0]!.kind, 'worker_checkpoint');
    const artifact = await readArtifact('worker-checkpoint', doc.deliverables[0]!.path);
    assert.match(artifact, /Current-state evidence was read back and verified/);
    assert.match(artifact, /incomplete and cannot be adopted/);
    assert.ok(doc.events.some((event) => event.type === 'worker.checkpointed'));
    assert.equal(doc.capacity, null);
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
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

test('pilot passthrough — the operator settings allow — is an allow, never a refusal', async () => {
  const http = await import('node:http');
  const { pilotSupervisor } = await import('./worker.js');
  const answers: Record<string, string> = { Edit: 'passthrough', Bash: 'deny', Write: 'gibberish' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { tool_name } = JSON.parse(raw) as { tool_name: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ decision: answers[tool_name], reason: 'matched Claude Code settings' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  process.env.WEAVER_PILOT_URL = `http://127.0.0.1:${port}`;
  try {
    const supervise = pilotSupervisor('/tmp', 'test-stream');
    assert.equal((await supervise('Edit', { file_path: '/tmp/x' })).behavior, 'allow');
    assert.equal((await supervise('Bash', { command: 'rm -rf /' })).behavior, 'deny');
    // Unknown decisions keep failing closed.
    assert.equal((await supervise('Write', { file_path: '/tmp/x' })).behavior, 'deny');
  } finally {
    delete process.env.WEAVER_PILOT_URL;
    server.close();
  }
});

test('action prompts carry the target repo agent instructions from the cwd git root', async () => {
  const os = await import('node:os');
  const { repoConventions } = await import('./worker.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-conventions-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'backend', 'svc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Label PRs that need e2e.');
  try {
    const fromSubdir = repoConventions(path.join(root, 'backend', 'svc')).join('\n');
    assert.match(fromSubdir, /Label PRs that need e2e\./);
    assert.match(fromSubdir, /bind you like the briefing/);
    assert.equal(repoConventions(fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-noconv-'))).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a work assignment whose declared workspace does not exist yet is created before launch, never crashing the spawn', async () => {
  const home = workerHome();
  // A coordinator-declared scratch workspace that does NOT exist on disk — the
  // exact shape that crashed workers with a misleading "native binary … failed
  // to launch" (spawn ENOENT on a missing cwd) before this fix. The brief tells
  // the worker to clone into it, but the worker can never start to create it if
  // the spawn cwd must already exist.
  const missing = path.join(os.tmpdir(), `weaver-missing-ws-${process.pid}-${virtualNow().getTime()}`);
  fs.rmSync(missing, { recursive: true, force: true });
  let launched = false;
  let seenCwd: string | undefined;
  const executor: WorkerExecutor = {
    async execute(req) {
      launched = true;
      seenCwd = req.cwd;
      // The directory the SDK would spawn the child into must exist by now.
      assert.ok(fs.existsSync(req.cwd!), 'the declared workspace must exist before launch');
      await req.submit.submitResult({
        summary: 'Investigated in the freshly-created workspace and reported evidence.',
        artifact: {
          title: 'Findings',
          kind: 'report',
          file_name: 'findings.md',
          content: `# Findings\n\n${'Evidence gathered in the created workspace. '.repeat(6)}`,
        },
      });
      return { costUsd: 0.1, sessionId: 'fake-missing-ws-session' };
    },
  };

  try {
    await createWorkstream({
      slug: 'worker-missing-workspace',
      title: 'worker-missing-workspace',
      objective: 'test that a declared-but-absent workspace is created before launch',
      tags: [],
      successCriteria: [],
      constraints: [],
      autonomy: { sendsRequireApproval: true },
      budget: { maxCoordinatorPasses: 5, maxCostUsd: 5 },
    });
    await arrive('worker-missing-workspace', (d) => d.assignments.push({
      id: 'asg_missing',
      objective: 'investigate in a declared workspace',
      briefing: 'Clone the relevant repo into the declared workspace and report.',
      kind: 'work',
      readDirs: [missing],
      acceptanceCriteria: ['cite evidence'],
      dependsOn: [],
      state: 'queued',
      attempts: [],
      adoption: { state: 'none' },
      createdAtVirtual: virtualNow().toISOString(),
    }));

    await runWorker('worker-missing-workspace', 'asg_missing', executor);

    assert.equal(launched, true, 'the worker must launch, not crash on a missing cwd');
    assert.equal(seenCwd, missing);
    assert.ok(fs.existsSync(missing), 'the declared workspace must have been created');
    const doc = await load('worker-missing-workspace');
    assert.equal(doc.assignments[0]!.state, 'awaiting_review');
  } finally {
    delete process.env.WEAVER_HOME;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

test('a worker with no declared directories gets a neutral per-stream workspace, never the runner cwd', async () => {
  const os = await import('node:os');
  const { neutralWorkspace } = await import('./worker.js');
  const dir = neutralWorkspace('cwd-test-stream');
  assert.ok(fs.existsSync(dir));
  assert.match(dir, /\.weaver\/workspaces\/cwd-test-stream$/);
  assert.notEqual(dir, process.cwd());
  assert.equal(neutralWorkspace('cwd-test-stream'), dir);
  fs.rmSync(path.join(os.homedir(), '.weaver', 'workspaces', 'cwd-test-stream'), { recursive: true, force: true });
});
