import { createBenchmarkClient as createApiClient, BenchmarkApiError } from '@benchsdk/api';
import { runWorker } from '@benchsdk/worker';
import type { BenchmarkClient as BenchmarkApiClient, BenchmarkClientConfig, RunWorkerOptions, RunWorkerResult } from '@benchsdk/api';

export { BenchmarkApiError };

export type BenchmarkClient = BenchmarkApiClient & {
  runWorker(options: RunWorkerOptions): Promise<RunWorkerResult>;
};

export type { BenchmarkClientConfig } from '@benchsdk/api';

export function createBenchmarkClient(config: BenchmarkClientConfig = {}): BenchmarkClient {
  const apiClient = createApiClient(config);
  return {
    ...apiClient,
    runWorker: (options: RunWorkerOptions) => runWorker(apiClient, options),
  };
}
