import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executionTargetLabel } from './executionPresentation.js';

test('human execution labels lead with provider identity, not the sandbox implementation', () => {
  assert.equal(
    executionTargetLabel({ executor: 'openhands', provider: 'openrouter', model: 'openrouter/z-ai/glm-5.2' }),
    'OpenRouter · z-ai/glm-5.2',
  );
  assert.equal(
    executionTargetLabel({ executor: 'codex-sdk', provider: 'openai', model: 'gpt-5.6-sol' }),
    'Codex subscription · gpt-5.6-sol',
  );
  assert.equal(
    executionTargetLabel({ executor: 'local-sdk', provider: 'anthropic', model: 'claude-fable-5' }),
    'Claude subscription · claude-fable-5',
  );
});
