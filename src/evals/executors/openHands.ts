/**
 * Eval-suite wrapper over the production OpenHands executor. The runtime lives
 * in src/executor/openHands.ts (a real WorkerExecutor selectable in production
 * via WEAVER_EXECUTOR=openhands); this wrapper adds nothing to the run and only
 * narrows the telemetry `executor` label to the bakeoff candidate enum so the
 * EvalExecutor contract is satisfied.
 */

import { OpenHandsExecutor } from '../../executor/openHands.js';
import type { EvalExecutionTelemetry, EvalExecutor } from '../types.js';

export {
  OPENHANDS_AGENT_SERVER_IMAGE,
  type CommandResult,
  type CommandRunner,
  type OpenHandsExecutorOptions,
} from '../../executor/openHands.js';

export class OpenHandsEvalExecutor extends OpenHandsExecutor implements EvalExecutor {
  override lastTelemetry(): EvalExecutionTelemetry | null {
    const telemetry = super.lastTelemetry();
    return telemetry ? { ...telemetry, executor: 'openhands' } : null;
  }
}
