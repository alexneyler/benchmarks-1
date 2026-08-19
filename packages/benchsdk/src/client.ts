import { createBenchmarkClient as createApiClient, BenchmarkApiError } from '@benchsdk/api';
import { runWorker } from '@benchsdk/worker';
import type { BenchmarkClient, BenchmarkClientConfig, RunWorkerOptions, RunWorkerResult } from './types';

export { BenchmarkApiError };

export function createBenchmarkClient(config: BenchmarkClientConfig = {}): BenchmarkClient {
  const apiClient = createApiClient(config);
  return {
    ...apiClient,
    runWorker(options: RunWorkerOptions): Promise<RunWorkerResult> {
      return runWorker(apiClient, options as unknown as any) as Promise<RunWorkerResult>;
    },
  } as BenchmarkClient;
}
