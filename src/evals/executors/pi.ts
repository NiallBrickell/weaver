import { PiRpcEvalExecutor, type PiRpcEvalExecutorDependencies } from './piRpc.js';

/** Eval-only Pi adapter. Production worker selection deliberately cannot see it. */
export class PiEvalExecutor extends PiRpcEvalExecutor {
  constructor(dependencies: PiRpcEvalExecutorDependencies = {}) {
    super('pi', 'pi', dependencies);
  }
}
