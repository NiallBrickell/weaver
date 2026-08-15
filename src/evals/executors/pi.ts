import { PiExecutor, type PiExecutorDependencies } from '../../executor/pi.js';
import type { EvalExecutionTelemetry, EvalExecutor } from '../types.js';

/** Thin eval view over the exact production Pi executor. */
export class PiEvalExecutor extends PiExecutor implements EvalExecutor {
  declare readonly id: 'pi';

  constructor(dependencies: PiExecutorDependencies = {}) {
    super(dependencies);
  }

  override lastTelemetry(): EvalExecutionTelemetry | null {
    const telemetry = super.lastTelemetry();
    return telemetry ? { ...telemetry, executor: 'pi' } : null;
  }
}
