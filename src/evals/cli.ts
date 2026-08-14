import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HARNESS_EVAL_CASES, findEvalCase } from './cases.js';
import {
  aggregateLedger,
  appendToLedger,
  defaultLedgerPath,
  loadLedger,
  renderLedgerHistory,
} from './ledger.js';
import { runHarnessEvalSuite } from './runner.js';
import { EVAL_EXECUTORS, type EvalCaseResult, type EvalExecutorId, type EvalTarget } from './types.js';

const USAGE = `Weaver harness eval

  yarn eval:harness --list
  yarn eval:harness --target <executor>=<model> [--target ...] [--case <id>] [--repeat N] [--out <dir>] [--ledger <path>]
  yarn eval:harness --ingest <results.json> [--ledger <path>]
  yarn eval:harness --history [--ledger <path>]

Executors: ${EVAL_EXECUTORS.join(', ')}

Examples:
  yarn eval:harness --target codex-sdk=gpt-5.6-sol --case code-repair
  yarn eval:harness --target opencode=openrouter/moonshotai/kimi-k3 --repeat 3
  yarn eval:harness --target pi=openrouter/moonshotai/kimi-k3 --repeat 3
  yarn eval:harness --target prime-agent=openrouter/z-ai/glm-5 --repeat 3
  weaver secret set OPENROUTER_API_KEY --executor
  yarn eval:harness --target openhands=openrouter/moonshotai/kimi-k3

Every target is explicit. The suite never silently substitutes a model or falls back to another executor.
Pi and Prime Agent targets require provider-qualified model names (provider/model). They run fresh,
without session persistence; Prime goals, schedules, autonomous mode, and daemon state are never used.
Every suite run also appends its case results to the durable ledger (default evals/ledger.jsonl,
checked into git); --ingest replays an existing results.json into it and --history aggregates it.`;

function values(args: string[], flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) found.push(args[index + 1]!);
  }
  return found;
}

function value(args: string[], flag: string): string | undefined {
  return values(args, flag)[0];
}

function parseTarget(raw: string): EvalTarget {
  const separator = raw.indexOf('=');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(`invalid --target '${raw}'; expected <executor>=<model>`);
  }
  const executor = raw.slice(0, separator);
  const model = raw.slice(separator + 1);
  if (!EVAL_EXECUTORS.includes(executor as EvalExecutorId)) {
    throw new Error(`unknown eval executor '${executor}' — supported: ${EVAL_EXECUTORS.join(', ')}`);
  }
  return { executor: executor as EvalExecutorId, model, label: `${executor}:${model}` };
}

function runId(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (args.includes('--list')) {
    process.stdout.write([
      'Executors:',
      ...EVAL_EXECUTORS.map((id) => `  ${id}`),
      '',
      'Cases:',
      ...HARNESS_EVAL_CASES.map((item) => `  ${item.id.padEnd(20)} ${item.description}`),
      '',
      'Production isolation is reported separately from task quality. Local host-process results never prove a production sandbox boundary.',
      '',
    ].join('\n'));
    return;
  }

  const ledgerPath = resolve(value(args, '--ledger') ?? defaultLedgerPath());

  const ingest = value(args, '--ingest');
  if (ingest) {
    const source = resolve(ingest);
    const parsed = JSON.parse(readFileSync(source, 'utf8')) as EvalCaseResult[];
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item?.suiteRunId !== 'string' || typeof item?.caseId !== 'string' || typeof item?.target?.label !== 'string')) {
      throw new Error(`${source} is not a harness eval results.json (expected an array of case results)`);
    }
    const outcome = appendToLedger(ledgerPath, parsed);
    process.stdout.write(`Ingested ${source}: ${outcome.appended} appended, ${outcome.skipped} skipped (already in ledger)\nLedger: ${ledgerPath}\n`);
    return;
  }

  if (args.includes('--history')) {
    process.stdout.write(renderLedgerHistory(aggregateLedger(loadLedger(ledgerPath))));
    return;
  }

  const targets = values(args, '--target').map(parseTarget);
  if (!targets.length) throw new Error(`at least one --target is required\n\n${USAGE}`);
  const requestedCases = values(args, '--case');
  const cases = requestedCases.length ? requestedCases.map(findEvalCase) : HARNESS_EVAL_CASES;
  const repeatRaw = value(args, '--repeat') ?? '1';
  const repetitions = Number(repeatRaw);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(`--repeat must be a positive integer, got '${repeatRaw}'`);
  }
  const suiteRunId = runId();
  const outputDir = resolve(value(args, '--out') ?? `eval-results/${suiteRunId}`);
  const results = await runHarnessEvalSuite({
    suiteRunId,
    outputDir,
    ledgerPath,
    targets,
    cases,
    repetitions,
    onProgress(message) {
      process.stderr.write(`eval: ${message}\n`);
    },
  });
  const passed = results.filter((result) => result.passedHardGates).length;
  process.stdout.write(`Harness eval complete: ${passed}/${results.length} runs passed every hard gate\n`);
  process.stdout.write(`Report: ${outputDir}/report.md\nResults: ${outputDir}/results.json\nLedger: ${ledgerPath}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
