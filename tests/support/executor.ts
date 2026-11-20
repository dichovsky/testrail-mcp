import type { Configuration } from '../../src/config/environment.js';
import { assembleOperationExecutor, type ExecutorDependencies } from '../../src/execution/executor.js';

/** Real executor with a test driver/clock and read-only capacity observation. */
export function createTestExecutor({ configuration, ...dependencies }: ExecutorDependencies & { configuration: Configuration }) {
  const { executor, stats } = assembleOperationExecutor(configuration, dependencies);
  return { ...executor, stats };
}

export type TestExecutor = ReturnType<typeof createTestExecutor>;
