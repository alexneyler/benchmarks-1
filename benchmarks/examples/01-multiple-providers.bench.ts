/**
 * Multi-provider benchmark.
 *
 * Demonstrates running the same task against several participants. The runner
 * filters out any participants whose `requiredEnvVars` are missing and then
 * executes the task once per selected provider.
 *
 * Run with all providers:
 *   bench run benchmarks/examples/01-multiple-providers.bench.ts --iterations 5 --concurrency 2
 *
 * Run with a subset:
 *   bench run benchmarks/examples/01-multiple-providers.bench.ts --iterations 5 --provider alpha,beta
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { exampleProviders } from './participants.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-multiple-providers',
  benchmarkName: 'Examples: Multiple Providers',
  iterations: 5,
  concurrency: 2,
  participants: exampleProviders,
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  log(`running on ${participant.name}`);

  const compute = participant.createCompute();
  const start = performance.now();

  const sandbox = await step('create', () => compute.sandbox.create());
  try {
    const result = await step('exec', () => sandbox.runCommand('node -v'));
    measure({ ttiMs: performance.now() - start, exitCode: result.exitCode });
  } finally {
    await step('destroy', () => sandbox.destroy(), { reportConcurrency: false });
  }
});
