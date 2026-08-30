import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tuiExecutionHosts } from './tui.js';

test('terminal placement choices distinguish this Mac, exact hosted runners, and fleet-wide work', () => {
  assert.deepEqual(
    tuiExecutionHosts(['niall-mac-primary', 'weaver-fleet'], 'niall-mac-primary'),
    [
      { label: 'Any capable host', live: true },
      { runnerId: 'niall-mac-primary', label: 'This Mac · niall-mac-primary', live: true },
      { runnerId: 'weaver-fleet', label: 'Remote · weaver-fleet', live: true },
    ],
  );
});

test('a durable placement remains selectable and is marked offline after its heartbeat expires', () => {
  assert.deepEqual(
    tuiExecutionHosts([], 'niall-mac-primary', 'old-host').at(-1),
    { runnerId: 'old-host', label: 'Remote · old-host', live: false },
  );
});
