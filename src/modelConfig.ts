import type { InfrastructureWait } from './types.js';

export interface CapacityTarget {
  executor: string;
  provider: string;
  model: string;
}

export function coordinatorModel(): string {
  // The coordinator is the evaluative seat. It runs rarely, at the moments
  // that decide whether work is actually acceptable, so it gets the most
  // capable configured model; volume work stays on the worker model.
  return process.env.WEAVER_COORDINATOR_MODEL ?? 'claude-fable-5';
}

export function coordinatorFallbackModel(): string {
  return process.env.WEAVER_COORDINATOR_FALLBACK_MODEL ?? 'claude-opus-4-8';
}

export function coordinatorExecutorName(): string {
  return process.env.WEAVER_COORDINATOR_EXECUTOR ?? 'local-sdk';
}

export function coordinatorFallbackExecutorName(): string {
  return process.env.WEAVER_COORDINATOR_FALLBACK_EXECUTOR ?? coordinatorExecutorName();
}

export function workerModel(): string {
  return process.env.WEAVER_WORKER_MODEL ?? 'sonnet';
}

/** Model for work declared `complexity: 'high'` — the operator's stronger
 * worker seat on the SAME configured executor. Unset, high-complexity work
 * simply runs on the standard worker model. */
export function workerModelComplex(): string {
  return process.env.WEAVER_WORKER_MODEL_COMPLEX ?? workerModel();
}

/** Model for harness-internal text passes (intake derivation, `weaver ask`)
 * that always run through the machine's LOCAL Claude SDK login. An explicit
 * ask model wins. Otherwise the worker model is reused only when the worker
 * itself uses that SDK and names a Claude-family model; an unprefixed Codex
 * model is no more Claude-runnable than a provider-prefixed OpenRouter one. */
export function localTextModel(): string {
  const configured = process.env.WEAVER_ASK_MODEL?.trim();
  if (configured) return configured;
  if (workerExecutorName() !== 'local-sdk') return 'sonnet';
  const w = workerModel();
  const claudeFamily = /^(?:claude-|sonnet(?:$|-)|opus(?:$|-)|haiku(?:$|-))/i.test(w);
  return providerFromModel(w) === null && claudeFamily ? w : 'sonnet';
}

export function workerExecutorName(): string {
  return process.env.WEAVER_EXECUTOR ?? 'local-sdk';
}

export function providerFromModel(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

export function providerForExecutor(executor: string, model: string): string {
  if (executor === 'local-sdk' || executor === 'claude-sdk') {
    return providerFromModel(model) ?? 'anthropic';
  }
  if (executor === 'codex-sdk') return 'openai';
  return providerFromModel(model) ?? 'unknown';
}

/** The executors a capacity chain may name. One list, shared with the runner
 * capability declaration, so a typo fails identically everywhere. */
export const SUPPORTED_EXECUTORS: readonly string[] = ['local-sdk', 'codex-sdk', 'openhands', 'pi'];
const SUPPORTED_COORDINATOR_EXECUTORS = new Set(['local-sdk', 'codex-sdk']);

/**
 * Parse an ordered, comma-separated `executor:model` list (a capacity chain).
 * Each entry splits on the FIRST colon only — models are provider-qualified
 * and contain slashes (`pi:openrouter/moonshotai/kimi-k3`). Whitespace is
 * trimmed, empty entries are ignored, and an unknown executor fails hard:
 * a silently skipped seat would make a misconfigured chain look healthy.
 */
export function parseCapacityTargetList(raw: string, envName: string): CapacityTarget[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colon = entry.indexOf(':');
      const executor = colon > 0 ? entry.slice(0, colon).trim() : '';
      const model = colon > 0 ? entry.slice(colon + 1).trim() : '';
      if (!executor || !model) {
        throw new Error(`${envName} entry '${entry}' must be '<executor>:<model>'`);
      }
      if (!SUPPORTED_EXECUTORS.includes(executor)) {
        throw new Error(
          `unknown executor '${executor}' in ${envName} — supported: ${SUPPORTED_EXECUTORS.join(', ')}`,
        );
      }
      return { executor, provider: providerForExecutor(executor, model), model };
    });
}

function dedupeTargets(targets: CapacityTarget[]): CapacityTarget[] {
  return targets.filter((target, index) =>
    targets.findIndex((candidate) =>
      candidate.executor === target.executor &&
      candidate.provider === target.provider &&
      candidate.model === target.model,
    ) === index,
  );
}

export function coordinatorCapacityTarget(
  model = coordinatorModel(),
  executor = coordinatorExecutorName(),
): CapacityTarget {
  return { executor, provider: providerForExecutor(executor, model), model };
}

/**
 * The coordinator's ordered fallback seats, tried after the primary.
 * `WEAVER_COORDINATOR_FALLBACKS` (comma-separated `executor:model`) is the
 * operator's explicit chain; when it is unset, the legacy single-fallback pair
 * `WEAVER_COORDINATOR_FALLBACK_MODEL`/`_EXECUTOR` (and its defaults) supplies
 * exactly one fallback as before. When set, the legacy pair is ignored.
 */
export function coordinatorFallbackTargets(): CapacityTarget[] {
  const raw = process.env.WEAVER_COORDINATOR_FALLBACKS;
  if (raw !== undefined) return parseCapacityTargetList(raw, 'WEAVER_COORDINATOR_FALLBACKS');
  return [coordinatorCapacityTarget(coordinatorFallbackModel(), coordinatorFallbackExecutorName())];
}

/** The full coordinator capacity chain: primary first, then the configured
 * fallbacks in order, deduped by executor+provider+model. */
export function coordinatorTargets(): CapacityTarget[] {
  const targets = dedupeTargets([coordinatorCapacityTarget(), ...coordinatorFallbackTargets()]);
  for (const target of targets) {
    if (!SUPPORTED_COORDINATOR_EXECUTORS.has(target.executor)) {
      throw new Error(
        `unknown coordinator executor '${target.executor}' — supported: local-sdk, codex-sdk`,
      );
    }
  }
  return targets;
}

/** First fallback in the chain — retained for call sites that still need a
 * single "the fallback"; prefer walking coordinatorTargets(). */
export function coordinatorFallbackCapacityTarget(): CapacityTarget {
  return coordinatorFallbackTargets()[0] ?? coordinatorCapacityTarget();
}

/**
 * The worker's ordered capacity ladder from `WEAVER_WORKER_FALLBACKS`, tried
 * after the configured `WEAVER_EXECUTOR`/`WEAVER_WORKER_MODEL` seat when
 * earlier targets are capacity-parked. Operator-owned machine config, the same
 * trust class as WEAVER_EXECUTOR itself.
 */
export function workerFallbackTargets(): CapacityTarget[] {
  const raw = process.env.WEAVER_WORKER_FALLBACKS;
  return raw === undefined ? [] : parseCapacityTargetList(raw, 'WEAVER_WORKER_FALLBACKS');
}

export function workerCapacityTarget(
  model = workerModel(),
  executor = workerExecutorName(),
): CapacityTarget {
  return { executor, provider: providerForExecutor(executor, model), model };
}

/** A legacy coordinator always ran through the local Claude Agent SDK. A
 * legacy worker might have run through any configured executor, so guessing
 * its provider would risk blocking or clearing the wrong pool. */
export function targetOfWait(wait: InfrastructureWait): CapacityTarget | null {
  if (wait.executor && wait.provider) {
    return { executor: wait.executor, provider: wait.provider, model: wait.model };
  }
  return wait.source === 'coordinator'
    ? { executor: 'local-sdk', provider: 'anthropic', model: wait.model }
    : null;
}
