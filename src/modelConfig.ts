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
  return process.env.WEAVER_COORDINATOR_MODEL ?? 'claude-fable-5-1';
}

export function coordinatorFallbackModel(): string {
  return process.env.WEAVER_COORDINATOR_FALLBACK_MODEL ?? 'claude-opus-5-5';
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Reasoning effort is pinned, not inherited. Claude Code picks a default per
 * model (measured 2026-09-29: Opus 5 and Fable 5 run at xhigh, Opus 5.5 at
 * medium, Fable 5.1 at high), so moving a seat to a newer model would
 * silently change how hard it thinks. `default` hands the choice back to
 * Claude Code; an unknown value is refused rather than guessed.
 */
function effortSetting(name: string, fallback: EffortLevel): EffortLevel | undefined {
  const setting = effortEnv(name);
  if (setting === undefined) return fallback;
  return setting === 'default' ? undefined : setting;
}

/** A pinned effort, or `default` to hand the choice back to Claude Code. */
export type EffortSetting = EffortLevel | 'default';

/** The effort an env var names, or undefined when it is unset. */
function effortEnv(name: string): EffortSetting | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'default') return 'default';
  if ((EFFORT_LEVELS as readonly string[]).includes(raw)) return raw as EffortLevel;
  throw new Error(`${name} must be one of ${EFFORT_LEVELS.join(', ')} or default (got '${raw}')`);
}

/** Effort for every live coordinator seat. A shadow seat inherits it unless
 * `WEAVER_SHADOW_EFFORT` overrides it for that seat alone. */
export function coordinatorEffort(): EffortLevel | undefined {
  return effortSetting('WEAVER_COORDINATOR_EFFORT', 'xhigh');
}

/** Effort for Claude-family workers run through the local Claude SDK. */
export function workerEffort(): EffortLevel | undefined {
  return effortSetting('WEAVER_WORKER_EFFORT', 'xhigh');
}

/** The effort to send for a model: only Anthropic models take the setting;
 * a provider-prefixed model (openrouter/…) routes to another vendor's model
 * through Claude Code and gets whatever that route supports by default. */
export function effortForModel(model: string, effort: EffortLevel | undefined): EffortLevel | undefined {
  return effort && providerFromModel(model) === null ? effort : undefined;
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

export interface ShadowCoordinatorConfig {
  target: CapacityTarget;
  /** Fraction of completed coordinator passes shadowed, in (0, 1]. */
  rate: number;
  /** `WEAVER_SHADOW_EFFORT`: the shadow seat's own reasoning effort. Absent
   * means it inherits the live coordinator effort. */
  effort?: EffortSetting;
}

/**
 * The measurement-only shadow coordinator seat (`WEAVER_SHADOW_COORDINATOR`,
 * one `executor:model`) and the fraction of completed passes it shadows
 * (`WEAVER_SHADOW_RATE`, 0–1, default 0). Null when either leaves nothing to
 * run. A shadow seat never coordinates: it sees a pass's exact projection with
 * capture-only tools and its moves are compared, never applied. It is NOT a
 * coordinator seat, so it never joins the capacity chain, the runner's
 * executor capability declaration, or published presence seats. Invalid values
 * throw; the caller swallows that so a shadow misconfiguration can never touch
 * the real pass.
 */
export function shadowCoordinatorConfig(): ShadowCoordinatorConfig | null {
  const rawSeat = process.env.WEAVER_SHADOW_COORDINATOR?.trim();
  const rawRate = process.env.WEAVER_SHADOW_RATE?.trim();
  if (!rawSeat) return null;
  const rate = rawRate ? Number(rawRate) : 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`WEAVER_SHADOW_RATE '${rawRate}' must be a number from 0 to 1`);
  }
  const targets = parseCapacityTargetList(rawSeat, 'WEAVER_SHADOW_COORDINATOR');
  if (targets.length !== 1) {
    throw new Error('WEAVER_SHADOW_COORDINATOR must name exactly one executor:model seat');
  }
  const target = targets[0]!;
  if (!SUPPORTED_COORDINATOR_EXECUTORS.has(target.executor)) {
    throw new Error(
      `WEAVER_SHADOW_COORDINATOR executor '${target.executor}' is not a coordinator executor — supported: local-sdk, codex-sdk`,
    );
  }
  const effort = effortEnv('WEAVER_SHADOW_EFFORT');
  return rate > 0 ? { target, rate, ...(effort ? { effort } : {}) } : null;
}

/**
 * The effort the shadow seat actually runs at, as sent to the executor and
 * recorded on its ShadowPassRecord, so a report never mixes efforts. Absent
 * where effort does not apply: a Codex seat ignores it, and a provider-routed
 * (openrouter/…) model gets its route's default, exactly as a live seat does.
 */
export function shadowSeatEffort(config: ShadowCoordinatorConfig): EffortSetting | undefined {
  if (config.target.executor !== 'local-sdk' || providerFromModel(config.target.model) !== null) return undefined;
  return config.effort ?? coordinatorEffort() ?? 'default';
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
