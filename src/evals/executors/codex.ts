/**
 * Eval-suite wrapper over the production Codex executor. The runtime lives in
 * src/executor/codex.ts; this wrapper adds nothing to the run and only narrows
 * the telemetry executor label to the bakeoff candidate enum.
 */

import { CodexExecutor } from '../../executor/codex.js';
import type { EvalExecutionTelemetry, EvalExecutor } from '../types.js';

export { type CodexExecutorDependencies } from '../../executor/codex.js';

export class CodexEvalExecutor extends CodexExecutor implements EvalExecutor {
  override lastTelemetry(): EvalExecutionTelemetry | null {
    const telemetry = super.lastTelemetry();
    return telemetry ? { ...telemetry, executor: 'codex-sdk' } : null;
  }
}
