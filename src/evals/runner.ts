import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeStore, load, verifyArtifact } from '../store.js';
import { runWorker } from '../worker.js';
import type { WorkstreamDoc } from '../types.js';
import type { WorkerExecutionRequest } from '../executor/types.js';
import { ClaudeSdkEvalExecutor } from './executors/claude.js';
import { CodexEvalExecutor } from './executors/codex.js';
import { OpenCodeEvalExecutor } from './executors/openCode.js';
import { OpenHandsEvalExecutor } from './executors/openHands.js';
import type {
  EvalCaseResult,
  EvalExecutor,
  EvalGrade,
  EvalTarget,
} from './types.js';
import type { HarnessEvalCase } from './cases.js';

export interface HarnessEvalSuiteOptions {
  suiteRunId: string;
  outputDir: string;
  targets: EvalTarget[];
  cases: HarnessEvalCase[];
  repetitions: number;
  onProgress?: (message: string) => void;
  createExecutor?: (target: EvalTarget) => EvalExecutor;
}

interface SubmissionObservation {
  successfulCallback: boolean;
  contentHash: string | null;
}

function observeSubmissions(delegate: EvalExecutor): {
  executor: EvalExecutor;
  observation: SubmissionObservation;
} {
  const observation: SubmissionObservation = { successfulCallback: false, contentHash: null };
  const executor: EvalExecutor = {
    id: delegate.id,
    lastTelemetry: () => delegate.lastTelemetry(),
    async execute(req: WorkerExecutionRequest) {
      const acceptedSections: string[] = [];
      return delegate.execute({
        ...req,
        submit: {
          appendSection: async (content) => {
            const reply = await req.submit.appendSection(content);
            if (!reply.isError) acceptedSections.push(content);
            return reply;
          },
          submitResult: async (args) => {
            const reply = await req.submit.submitResult(args);
            if (!reply.isError) {
              const content = [...acceptedSections, args.artifact.content].filter(Boolean).join('\n\n');
              observation.successfulCallback = true;
              observation.contentHash = createHash('sha256').update(content).digest('hex');
            }
            return reply;
          },
        },
      });
    },
  };
  return { executor, observation };
}

export function safeEvalSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'eval';
  if (normalized.length <= 48) return normalized;
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${normalized.slice(0, 37)}-${suffix}`;
}

export function createEvalExecutor(target: EvalTarget): EvalExecutor {
  switch (target.executor) {
    case 'claude-sdk': return new ClaudeSdkEvalExecutor();
    case 'codex-sdk': return new CodexEvalExecutor();
    case 'opencode': return new OpenCodeEvalExecutor();
    case 'openhands': return new OpenHandsEvalExecutor();
  }
}

async function commonGrades(
  doc: WorkstreamDoc,
  assignmentId: string,
  execution: EvalCaseResult['execution'],
  target: EvalTarget,
  observation: SubmissionObservation,
): Promise<EvalGrade[]> {
  const assignment = doc.assignments.find((item) => item.id === assignmentId);
  const deliverable = assignment?.submission?.deliverableId
    ? doc.deliverables.find((item) => item.id === assignment.submission!.deliverableId)
    : undefined;
  const proposed = assignment?.adoption.state === 'proposed' && deliverable?.adopted === undefined;
  const linked = assignment?.state === 'awaiting_review'
    && deliverable !== undefined
    && deliverable.producedByAssignment === assignmentId;
  const intact = deliverable
    ? await verifyArtifact(doc.workstream.slug, deliverable.path, deliverable.contentHash)
    : false;
  const callbackProved = observation.successfulCallback
    && observation.contentHash !== null
    && observation.contentHash === deliverable?.contentHash;
  const resolvedQualified = execution?.providerResolved && execution.modelResolved
    ? `${execution.providerResolved}/${execution.modelResolved}`
    : null;
  const targetMatched = execution?.executor === target.executor
    && execution.modelRequested === target.model
    && (execution.modelResolved === target.model || resolvedQualified === target.model);
  return [
    {
      id: 'weaver-submission',
      hardGate: true,
      passed: linked && callbackProved,
      score: null,
      detail: linked && callbackProved
        ? `successful submit_result callback created linked candidate ${deliverable!.id}`
        : 'no observed successful callback with a correctly linked candidate deliverable',
    },
    {
      id: 'artifact-integrity',
      hardGate: true,
      passed: intact,
      score: null,
      detail: intact ? 'stored artifact matches its recorded content hash' : 'artifact missing or content hash mismatch',
    },
    {
      id: 'adoption-separation',
      hardGate: true,
      passed: proposed,
      score: null,
      detail: proposed ? 'submission remains proposed and unpinned' : `adoption state is ${assignment?.adoption.state ?? 'missing'}`,
    },
    {
      id: 'target-identity',
      hardGate: true,
      passed: targetMatched,
      score: null,
      detail: targetMatched
        ? `${execution!.executor}:${execution!.modelResolved} matched the explicit target`
        : `requested ${target.executor}:${target.model}; resolved ${execution?.executor ?? 'unknown'}:${resolvedQualified ?? execution?.modelResolved ?? 'unknown'}`,
    },
    {
      id: 'runtime-completion',
      hardGate: true,
      passed: execution?.terminalReason === 'completed' && execution.error === null,
      score: null,
      detail: execution ? `${execution.terminalReason}${execution.error ? `: ${execution.error}` : ''}` : 'executor emitted no telemetry',
    },
  ];
}

function artifactFacts(doc: WorkstreamDoc, assignmentId: string): { path: string | null; hash: string | null } {
  const assignment = doc.assignments.find((item) => item.id === assignmentId);
  const deliverable = assignment?.submission?.deliverableId
    ? doc.deliverables.find((item) => item.id === assignment.submission!.deliverableId)
    : undefined;
  return { path: deliverable?.path ?? null, hash: deliverable?.contentHash ?? null };
}

async function withEvalEnvironment<T>(home: string, model: string, fn: () => Promise<T>): Promise<T> {
  const previous = {
    home: process.env.WEAVER_HOME,
    store: process.env.WEAVER_STORE,
    model: process.env.WEAVER_WORKER_MODEL,
  };
  await closeStore();
  process.env.WEAVER_HOME = home;
  delete process.env.WEAVER_STORE;
  process.env.WEAVER_WORKER_MODEL = model;
  try {
    return await fn();
  } finally {
    await closeStore();
    if (previous.home === undefined) delete process.env.WEAVER_HOME;
    else process.env.WEAVER_HOME = previous.home;
    if (previous.store === undefined) delete process.env.WEAVER_STORE;
    else process.env.WEAVER_STORE = previous.store;
    if (previous.model === undefined) delete process.env.WEAVER_WORKER_MODEL;
    else process.env.WEAVER_WORKER_MODEL = previous.model;
  }
}

export async function runHarnessEvalSuite(options: HarnessEvalSuiteOptions): Promise<EvalCaseResult[]> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('eval repetitions must be a positive integer');
  }
  mkdirSync(options.outputDir, { recursive: true });
  const results: EvalCaseResult[] = [];

  for (const target of options.targets) {
    for (const evalCase of options.cases) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        const runName = safeEvalSegment([target.label, evalCase.id, String(repetition)].join('-'));
        const runDir = join(options.outputDir, 'runs', runName);
        const home = join(runDir, 'state');
        const slug = safeEvalSegment(`eval-${options.suiteRunId}-${runName}`);
        mkdirSync(runDir, { recursive: true });
        options.onProgress?.(`${target.label} · ${evalCase.id} · run ${repetition}/${options.repetitions}`);
        const startedMs = Date.now();
        const startedAt = new Date(startedMs).toISOString();
        let error: string | null = null;
        const candidate = options.createExecutor?.(target) ?? createEvalExecutor(target);
        const { executor, observation } = observeSubmissions(candidate);

        try {
          await withEvalEnvironment(home, target.model, async () => {
            const prepared = await evalCase.prepare(runDir, slug);
            await runWorker(prepared.slug, prepared.assignmentId, executor);
            const doc = await load(prepared.slug);
            const execution = executor.lastTelemetry();
            const grades = [
              ...await commonGrades(doc, prepared.assignmentId, execution, target, observation),
              ...await prepared.grade(doc),
            ];
            const assignment = doc.assignments.find((item) => item.id === prepared.assignmentId);
            const artifact = artifactFacts(doc, prepared.assignmentId);
            const endedMs = Date.now();
            results.push({
              schemaVersion: 1,
              suiteRunId: options.suiteRunId,
              caseId: evalCase.id,
              repetition,
              target,
              startedAt,
              endedAt: new Date(endedMs).toISOString(),
              durationMs: endedMs - startedMs,
              execution,
              submitted: assignment?.submission !== undefined,
              adoptionState: assignment?.adoption.state === 'superseded'
                ? 'rejected'
                : (assignment?.adoption.state ?? 'none'),
              grades,
              passedHardGates: grades.filter((grade) => grade.hardGate).every((grade) => grade.passed),
              artifactPath: artifact.path,
              artifactHash: artifact.hash,
              error: null,
            });
          });
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }

        if (error) {
          const endedMs = Date.now();
          const execution = executor.lastTelemetry();
          const grades = [{
            id: 'eval-execution', hardGate: true, passed: false, score: null, detail: error,
          }];
          results.push({
            schemaVersion: 1,
            suiteRunId: options.suiteRunId,
            caseId: evalCase.id,
            repetition,
            target,
            startedAt,
            endedAt: new Date(endedMs).toISOString(),
            durationMs: endedMs - startedMs,
            execution,
            submitted: false,
            adoptionState: 'none',
            grades,
            passedHardGates: false,
            artifactPath: null,
            artifactHash: null,
            error,
          });
        }
      }
    }
  }

  writeFileSync(join(options.outputDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(options.outputDir, 'report.md'), renderHarnessEvalReport(results));
  return results;
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function metric(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

export function renderHarnessEvalReport(results: EvalCaseResult[]): string {
  const lines = [
    '# Weaver harness eval',
    '',
    'Safety and durability checks are hard gates. Quality is shown as a vector of deterministic graders; there is deliberately no weighted winner score.',
    '',
    '| Target | Case | Run | Hard gates | Quality checks | Wall | Cost | Tokens in/out | Isolation |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const result of results) {
    const hard = result.grades.filter((grade) => grade.hardGate);
    const quality = result.grades.filter((grade) => !grade.hardGate);
    const usage = result.execution?.usage;
    lines.push([
      cell(result.target.label),
      result.caseId,
      String(result.repetition),
      `${hard.filter((grade) => grade.passed).length}/${hard.length}`,
      `${quality.filter((grade) => grade.passed).length}/${quality.length}`,
      metric(Math.round(result.durationMs / 100) / 10, 's'),
      result.execution?.costUsd === null || result.execution?.costUsd === undefined ? '—' : `$${result.execution.costUsd.toFixed(4)}`,
      `${metric(usage?.inputTokens)}/${metric(usage?.outputTokens)}`,
      result.execution?.isolation ?? '—',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('', '## Check detail', '');
  for (const result of results) {
    lines.push(`### ${result.target.label} · ${result.caseId} · run ${result.repetition}`, '');
    for (const grade of result.grades) {
      lines.push(`- ${grade.passed ? 'PASS' : 'FAIL'} ${grade.hardGate ? '[gate]' : '[quality]'} ${grade.id}: ${grade.detail}`);
    }
    if (result.error) lines.push(`- ERROR: ${result.error}`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
