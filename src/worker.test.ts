import { strict as assert } from 'node:assert';
import { describe, it, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalSdkExecutor } from './executor/localSdk.js';
import { OpenHandsExecutor } from './executor/openHands.js';
import {
  consumeDueWorkerInfrastructureWakes,
  finalizeWorkerRun,
  runWorker,
  selectExecutor,
} from './worker.js';
import { arrive, createWorkstream, load } from './store.js';
import { virtualNow } from './clock.js';
import type { InfrastructureWait } from './types.js';
import type { WorkerExecutionRequest, WorkerExecutor } from './executor/types.js';

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

  it('an unknown executor fails hard, naming the variable — never a silent local fallback', () => {
    withEnv('managed-agents', () =>
      assert.throws(() => selectExecutor(), /WEAVER_EXECUTOR 'managed-agents'/),
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
    assert.doesNotMatch(request.systemPrompt.append, /changing a remote service/);
    assert.equal(request.cwd, readDir);
    assert.deepEqual(request.additionalDirectories, [readDir]);
    assert.ok(request.prompt.includes(`- ${readDir}`));
    assert.equal(request.permissionMode, 'bypassPermissions');
    assert.deepEqual(request.settingSources, ['user', 'project', 'local']);
    assert.equal(request.strictMcpConfig, false);
    assert.equal(request.supervise, undefined);

    const doc = await load('worker-research-surface');
    const assignment = doc.assignments[0]!;
    assert.equal(assignment.state, 'awaiting_review');
    assert.equal(assignment.adoption.state, 'proposed');
    assert.equal(assignment.attempts[0]!.costUsd, 0.25);
    assert.equal(assignment.attempts[0]!.sessionId, 'fake-research-session');
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
    id: 'asg_worker', objective: 'produce evidence', briefing: 'n/a', kind: 'work',
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
