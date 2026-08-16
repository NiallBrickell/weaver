import { PiRpcExecutor, type PiExecutorDependencies } from '../../executor/pi.js';
import type { EvalExecutionTelemetry, EvalExecutor } from '../types.js';

/**
 * Eval-only Prime Agent adapter. RPC mode stays invocation-local; this adapter
 * never supplies goal, autonomous, schedule, daemon, continue, or resume flags.
 */
export class PrimeAgentEvalExecutor extends PiRpcExecutor implements EvalExecutor {
  declare readonly id: 'prime-agent';

  constructor(dependencies: PiExecutorDependencies = {}) {
    super('prime-agent', 'prime-agent', dependencies);
  }

  override lastTelemetry(): EvalExecutionTelemetry | null {
    const telemetry = super.lastTelemetry();
    return telemetry ? { ...telemetry, executor: 'prime-agent' } : null;
  }
}
