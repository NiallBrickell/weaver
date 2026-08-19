import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  coordinatorFallbackCapacityTarget,
  coordinatorTargets,
  parseCapacityTargetList,
  workerFallbackTargets,
} from './modelConfig.js';

const NAMES = [
  'WEAVER_COORDINATOR_MODEL',
  'WEAVER_COORDINATOR_EXECUTOR',
  'WEAVER_COORDINATOR_FALLBACK_MODEL',
  'WEAVER_COORDINATOR_FALLBACK_EXECUTOR',
  'WEAVER_COORDINATOR_FALLBACKS',
  'WEAVER_WORKER_FALLBACKS',
] as const;

function withEnv(values: Partial<Record<(typeof NAMES)[number], string>>, fn: () => void): void {
  const previous = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of NAMES) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    fn();
  } finally {
    for (const name of NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a capacity chain splits each entry on the first colon so provider-qualified models survive', () => {
  assert.deepEqual(
    parseCapacityTargetList(
      'codex-sdk:gpt-5.6-sol, pi:zai-coding-plan/glm-5.3 ,,pi:openrouter/moonshotai/kimi-k3, ',
      'WEAVER_WORKER_FALLBACKS',
    ),
    [
      { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
      { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' },
      { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
    ],
  );
});

test('an unknown executor or a colonless entry in a chain fails hard, naming the variable', () => {
  assert.throws(
    () => parseCapacityTargetList('managed-agents:gpt-6', 'WEAVER_COORDINATOR_FALLBACKS'),
    /unknown executor 'managed-agents' in WEAVER_COORDINATOR_FALLBACKS — supported: local-sdk, codex-sdk, openhands, pi/,
  );
  assert.throws(
    () => parseCapacityTargetList('claude-opus-5', 'WEAVER_COORDINATOR_FALLBACKS'),
    /entry 'claude-opus-5' must be '<executor>:<model>'/,
  );
  assert.throws(
    () => parseCapacityTargetList('local-sdk:', 'WEAVER_COORDINATOR_FALLBACKS'),
    /must be '<executor>:<model>'/,
  );
});

test('an unset chain preserves the legacy single-fallback pair exactly', () => {
  withEnv({}, () => {
    assert.deepEqual(coordinatorTargets(), [
      { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' },
      { executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5' },
    ]);
    assert.deepEqual(coordinatorFallbackCapacityTarget(), {
      executor: 'local-sdk', provider: 'anthropic', model: 'claude-opus-5',
    });
  });
  withEnv({
    WEAVER_COORDINATOR_FALLBACK_EXECUTOR: 'codex-sdk',
    WEAVER_COORDINATOR_FALLBACK_MODEL: 'gpt-5.6-sol',
  }, () => {
    assert.deepEqual(coordinatorTargets().at(-1), {
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
    });
  });
});

test('a set chain is ordered primary-first, deduped, and makes the legacy pair inert', () => {
  withEnv({
    WEAVER_COORDINATOR_FALLBACKS:
      'codex-sdk:gpt-5.6-sol, local-sdk:claude-fable-5, codex-sdk:gpt-5.6-sol, pi:openrouter/moonshotai/kimi-k3',
    WEAVER_COORDINATOR_FALLBACK_MODEL: 'claude-opus-5',
    WEAVER_COORDINATOR_FALLBACK_EXECUTOR: 'local-sdk',
  }, () => {
    // The primary repeats inside the chain and one fallback repeats itself;
    // dedup keeps first occurrences in order, and the legacy opus pair is
    // ignored entirely once the explicit chain exists.
    assert.deepEqual(coordinatorTargets(), [
      { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' },
      { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
      { executor: 'pi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' },
    ]);
    assert.deepEqual(coordinatorFallbackCapacityTarget(), {
      executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol',
    });
  });
  // An explicitly empty chain means "no fallback": the chain is the primary.
  withEnv({ WEAVER_COORDINATOR_FALLBACKS: ' , ' }, () => {
    assert.deepEqual(coordinatorTargets(), [
      { executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' },
    ]);
    assert.deepEqual(coordinatorFallbackCapacityTarget(), {
      executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5',
    });
  });
});

test('the worker ladder is empty when unset and ordered when configured', () => {
  withEnv({}, () => {
    assert.deepEqual(workerFallbackTargets(), []);
  });
  withEnv({
    WEAVER_WORKER_FALLBACKS: 'codex-sdk:gpt-5.6-sol,pi:zai-coding-plan/glm-5.3',
  }, () => {
    assert.deepEqual(workerFallbackTargets(), [
      { executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' },
      { executor: 'pi', provider: 'zai-coding-plan', model: 'zai-coding-plan/glm-5.3' },
    ]);
  });
});
