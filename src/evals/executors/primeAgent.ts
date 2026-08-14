import { PiRpcEvalExecutor, type PiRpcEvalExecutorDependencies } from './piRpc.js';

/**
 * Eval-only Prime Agent adapter. RPC mode stays invocation-local; this adapter
 * never supplies goal, autonomous, schedule, daemon, continue, or resume flags.
 */
export class PrimeAgentEvalExecutor extends PiRpcEvalExecutor {
  constructor(dependencies: PiRpcEvalExecutorDependencies = {}) {
    super('prime-agent', 'prime-agent', dependencies);
  }
}
