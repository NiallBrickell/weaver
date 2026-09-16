/**
 * A fresh, empty Claude Code config directory for one registered-identity
 * run. A headless credential (setup-token, API key, or a provider bearer on
 * an Anthropic-compatible endpoint) must never inherit the hosting user's
 * hooks, settings, or device login state, so every such run gets its own
 * CLAUDE_CONFIG_DIR and removes it afterwards. Shared by the coordinator and
 * the local-sdk worker so the boundary is defined once.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PreparedClaudeApiHome {
  path: string;
  cleanup(): void;
}

export function isolatedClaudeApiHome(prefix = 'weaver-claude-api-'): PreparedClaudeApiHome {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup() { rmSync(path, { recursive: true, force: true }); },
  };
}
