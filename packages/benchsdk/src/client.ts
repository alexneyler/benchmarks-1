import { createBenchmarkClient as createApiClient, BenchmarkApiError } from '@benchsdk/api';
import { runWorker } from '@benchsdk/worker';
import type { BenchmarkClient, BenchmarkClientConfig, RunWorkerOptions, RunWorkerResult } from './types';

export { BenchmarkApiError };

export function createBenchmarkClient(config: BenchmarkClientConfig = {}): BenchmarkClient {
  const apiClient = createApiClient(config);
  function runWorkerWrapped(options: RunWorkerOptions): Promise<RunWorkerResult> {
    return runWorker(client as any, options as unknown as any) as Promise<RunWorkerResult>;
  }
  const client = {
    ...apiClient,
    runWorker: runWorkerWrapped,
  } as BenchmarkClient;
  return client;
}
