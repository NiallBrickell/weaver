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
  return process.env.WEAVER_COORDINATOR_FALLBACK_MODEL ?? 'claude-opus-5';
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

/** Model for harness-internal text passes (intake derivation, `weaver ask`)
 * that always run through the machine's LOCAL Claude SDK login. The worker
 * model is reused only when that SDK can run it: a provider-prefixed worker
 * model (`zai-coding-plan/…`, `openrouter/…`) belongs to another executor,
 * and handing it to the local SDK fails every pass — intake then silently
 * degrades to its deterministic word-mash fallback. */
export function localTextModel(): string {
  const w = workerModel();
  return providerFromModel(w) === null ? w : 'sonnet';
}

export function workerExecutorName(): string {
  return process.env.WEAVER_EXECUTOR ?? 'local-sdk';
}

export function providerFromModel(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

export function providerForExecutor(executor: string, model: string): string {
  if (executor === 'local-sdk' || executor === 'claude-sdk') return 'anthropic';
  if (executor === 'codex-sdk') return 'openai';
  return providerFromModel(model) ?? 'unknown';
}

export function coordinatorCapacityTarget(
  model = coordinatorModel(),
  executor = coordinatorExecutorName(),
): CapacityTarget {
  return { executor, provider: providerForExecutor(executor, model), model };
}

export function coordinatorFallbackCapacityTarget(): CapacityTarget {
  return coordinatorCapacityTarget(
    coordinatorFallbackModel(),
    coordinatorFallbackExecutorName(),
  );
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
