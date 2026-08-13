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

export function workerModel(): string {
  return process.env.WEAVER_WORKER_MODEL ?? 'sonnet';
}

export function workerExecutorName(): string {
  return process.env.WEAVER_EXECUTOR ?? 'local-sdk';
}

export function providerFromModel(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

export function coordinatorCapacityTarget(model = coordinatorModel()): CapacityTarget {
  return { executor: 'local-sdk', provider: 'anthropic', model };
}

export function workerCapacityTarget(
  model = workerModel(),
  executor = workerExecutorName(),
): CapacityTarget {
  if (executor === 'local-sdk') return { executor, provider: 'anthropic', model };
  return { executor, provider: providerFromModel(model) ?? 'unknown', model };
}

/** A legacy coordinator always ran through the local Claude Agent SDK. A
 * legacy worker might have run through any configured executor, so guessing
 * its provider would risk blocking or clearing the wrong pool. */
export function targetOfWait(wait: InfrastructureWait): CapacityTarget | null {
  if (wait.executor && wait.provider) {
    return { executor: wait.executor, provider: wait.provider, model: wait.model };
  }
  return wait.source === 'coordinator' ? coordinatorCapacityTarget(wait.model) : null;
}
