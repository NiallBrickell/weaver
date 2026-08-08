import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkerExecutionOutcome, WorkerExecutionRequest } from '../executor/types.js';
import { arrive, writeArtifact } from '../store.js';
import { findEvalCase, makeImageUnderstandingCase } from './cases.js';
import { createImageTicketPng, type ImageTicketFacts } from './imageTicket.js';
import { renderHarnessEvalReport, runHarnessEvalSuite, safeEvalSegment } from './runner.js';
import type { EvalExecutionTelemetry, EvalExecutor } from './types.js';

class ScriptedExecutor implements EvalExecutor {
  readonly id = 'codex-sdk' as const;
  private telemetry: EvalExecutionTelemetry | null = null;

  lastTelemetry(): EvalExecutionTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const startedAt = new Date().toISOString();
    writeFileSync(join(req.cwd!, 'src/select.mjs'), `export function acceptedInputIds(assignments) {
  return assignments.filter((assignment) => assignment.adoption?.state === 'accepted').map((assignment) => assignment.id);
}
`);
    const reply = await req.submit.submitResult({
      summary: 'Repaired the accepted-only dependency selection and verified it with the visible Node test.',
      artifact: {
        title: 'Accepted input repair',
        kind: 'report',
        file_name: 'repair-report.md',
        content: `# Repair report\n\n${'The selector now includes only assignments whose adoption state is exactly accepted. '.repeat(4)}\n\nVerification: node --test select.test.mjs passed, including proposed and accepted coverage.`,
      },
    });
    assert.equal(reply.isError, undefined);
    this.telemetry = {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: 'openai',
      modelResolved: req.model,
      harnessVersion: 'fake',
      isolation: 'host-process',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: 5,
      startupMs: 1,
      timeToSubmissionMs: 4,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 1 },
      costUsd: null,
      sessionId: 'fresh-session',
      terminalReason: 'completed',
      error: null,
    };
    return { costUsd: 0, sessionId: 'fresh-session' };
  }
}

class ScriptedImageExecutor implements EvalExecutor {
  readonly id = 'codex-sdk' as const;
  private telemetry: EvalExecutionTelemetry | null = null;

  constructor(private readonly owner = 'MAYA') {}

  lastTelemetry(): EvalExecutionTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const startedAt = new Date().toISOString();
    const png = readFileSync(join(req.cwd!, 'linear-ticket.png'));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.toString('latin1').includes('ENG-417'), false);
    await req.submit.submitResult({
      summary: 'Extracted all requested incident fields from the supplied ticket screenshot.',
      artifact: {
        title: 'Screenshot incident report',
        kind: 'report',
        file_name: 'screenshot-report.md',
        content: JSON.stringify({
          ticketId: 'ENG-417',
          stallPercentage: 63,
          browser: 'SAFARI 18',
          owner: this.owner,
          error: 'CHUNK TIMEOUT',
          observation: 'These exact facts were visually transcribed from the supplied PNG pixels and preserved as structured incident evidence without changing the source image.'.repeat(2),
        }),
      },
    });
    const endedAt = new Date().toISOString();
    this.telemetry = {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: 'openai',
      modelResolved: req.model,
      harnessVersion: 'fake',
      isolation: 'host-process',
      startedAt,
      endedAt,
      durationMs: 5,
      startupMs: 1,
      timeToSubmissionMs: 4,
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
      costUsd: null,
      sessionId: 'fresh-image-session',
      terminalReason: 'completed',
      error: null,
    };
    return { costUsd: 0, sessionId: 'fresh-image-session' };
  }
}

class ForgingExecutor implements EvalExecutor {
  readonly id = 'codex-sdk' as const;
  private telemetry: EvalExecutionTelemetry | null = null;

  lastTelemetry(): EvalExecutionTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const startedAt = new Date().toISOString();
    writeFileSync(join(req.cwd!, 'src/select.mjs'), `export function acceptedInputIds(assignments) {
  return assignments.filter((assignment) => assignment.adoption?.state === 'accepted').map((assignment) => assignment.id);
}
`);
    const content = `# Forged result\n\n${'This candidate was written around the submit_result callback. '.repeat(5)}`;
    const artifact = await writeArtifact(req.workstreamSlug, 'forged.md', content);
    await arrive(req.workstreamSlug, (doc) => {
      const assignment = doc.assignments.find((item) => item.id === req.assignmentId)!;
      doc.deliverables.push({
        id: 'del_forged',
        title: 'Forged result',
        kind: 'report',
        path: artifact.relPath,
        contentHash: artifact.hash,
        producedByAssignment: req.assignmentId,
        createdAtVirtual: new Date().toISOString(),
      });
      assignment.submission = { summary: 'Forged outside the callback', deliverableId: 'del_forged' };
      assignment.state = 'awaiting_review';
      assignment.adoption = { state: 'proposed' };
    });
    this.telemetry = {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: 'openai',
      modelResolved: req.model,
      harnessVersion: 'fake',
      isolation: 'host-process',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: 5,
      startupMs: 1,
      timeToSubmissionMs: null,
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
      costUsd: null,
      sessionId: 'forged-session',
      terminalReason: 'completed',
      error: null,
    };
    return { costUsd: 0, sessionId: 'forged-session' };
  }
}

test('the harness eval runs through real runWorker submission and deterministic graders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-harness-eval-'));
  try {
    const results = await runHarnessEvalSuite({
      suiteRunId: 'test-suite',
      outputDir: root,
      targets: [{ executor: 'codex-sdk', model: 'test-model', label: 'scripted:test-model' }],
      cases: [findEvalCase('code-repair')],
      repetitions: 1,
      createExecutor: () => new ScriptedExecutor(),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.submitted, true);
    assert.equal(results[0]!.adoptionState, 'proposed');
    assert.equal(results[0]!.passedHardGates, true);
    assert.ok(results[0]!.grades.every((grade) => grade.passed));
    assert.ok(results[0]!.artifactHash);
    assert.equal(existsSync(join(root, 'results.json')), true);
    assert.match(readFileSync(join(root, 'report.md'), 'utf8'), /no weighted winner score/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports retain null metrics instead of calling missing telemetry free', () => {
  const report = renderHarnessEvalReport([{
    schemaVersion: 1,
    suiteRunId: 'nulls',
    caseId: 'code-repair',
    repetition: 1,
    target: { executor: 'codex-sdk', model: 'm', label: 'codex:m' },
    startedAt: '2026-08-08T00:00:00.000Z',
    endedAt: '2026-08-08T00:00:01.000Z',
    durationMs: 1_000,
    execution: {
      executor: 'codex-sdk', modelRequested: 'm', providerResolved: null, modelResolved: null,
      harnessVersion: 'x', isolation: 'host-process', startedAt: '2026-08-08T00:00:00.000Z',
      endedAt: '2026-08-08T00:00:01.000Z', durationMs: 1_000, startupMs: null,
      timeToSubmissionMs: null, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
      costUsd: null, sessionId: null, terminalReason: 'error', error: 'missing',
    },
    submitted: false,
    adoptionState: 'none',
    grades: [{ id: 'runtime', hardGate: true, passed: false, score: null, detail: 'missing' }],
    passedHardGates: false,
    artifactPath: null,
    artifactHash: null,
    error: 'missing',
  }]);
  assert.match(report, /\| — \| —\/— \| host-process \|/);
  assert.doesNotMatch(report, /\$0\.0000/);
});

test('the screenshot case keeps facts in PNG pixels and grades exact extraction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-image-eval-'));
  const facts: ImageTicketFacts = {
    ticketId: 'ENG-417', stallPercentage: 63, browser: 'SAFARI 18', owner: 'MAYA', error: 'CHUNK TIMEOUT',
  };
  try {
    const results = await runHarnessEvalSuite({
      suiteRunId: 'image-suite',
      outputDir: root,
      targets: [{ executor: 'codex-sdk', model: 'test-model', label: 'scripted:test-model' }],
      cases: [makeImageUnderstandingCase(() => ({ facts, png: createImageTicketPng(facts) }))],
      repetitions: 1,
      createExecutor: () => new ScriptedImageExecutor(),
    });
    assert.equal(results[0]!.passedHardGates, true);
    assert.ok(results[0]!.grades.every((grade) => grade.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('long provider-qualified targets keep case and repetition identity after truncation', () => {
  const prefix = `eval-suite-opencode-openrouter-${'nested-model-family-'.repeat(5)}`;
  const first = safeEvalSegment(`${prefix}-code-repair-1`);
  const second = safeEvalSegment(`${prefix}-image-understanding-1`);
  const third = safeEvalSegment(`${prefix}-image-understanding-2`);
  assert.ok(first.length <= 48);
  assert.equal(new Set([first, second, third]).size, 3);
});

test('an image submission with one wrong structured fact fails the promotion gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-image-negative-'));
  const facts: ImageTicketFacts = {
    ticketId: 'ENG-417', stallPercentage: 63, browser: 'SAFARI 18', owner: 'MAYA', error: 'CHUNK TIMEOUT',
  };
  try {
    const results = await runHarnessEvalSuite({
      suiteRunId: 'image-negative',
      outputDir: root,
      targets: [{ executor: 'codex-sdk', model: 'test-model', label: 'scripted:test-model' }],
      cases: [makeImageUnderstandingCase(() => ({ facts, png: createImageTicketPng(facts) }))],
      repetitions: 1,
      createExecutor: () => new ScriptedImageExecutor('NOAH'),
    });
    assert.equal(results[0]!.passedHardGates, false);
    assert.equal(results[0]!.grades.find((grade) => grade.id === 'image-capability')?.passed, false);
    assert.equal(results[0]!.grades.find((grade) => grade.id === 'ticket-owner')?.passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a candidate cannot forge the submit-only gate by mutating durable state directly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weaver-forged-submission-'));
  try {
    const results = await runHarnessEvalSuite({
      suiteRunId: 'forged-submission',
      outputDir: root,
      targets: [{ executor: 'codex-sdk', model: 'test-model', label: 'scripted:test-model' }],
      cases: [findEvalCase('code-repair')],
      repetitions: 1,
      createExecutor: () => new ForgingExecutor(),
    });
    assert.equal(results[0]!.grades.find((grade) => grade.id === 'artifact-integrity')?.passed, true);
    assert.equal(results[0]!.grades.find((grade) => grade.id === 'weaver-submission')?.passed, false);
    assert.equal(results[0]!.passedHardGates, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
