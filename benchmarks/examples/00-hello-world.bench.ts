/**
 * Hello-world benchmark.
 *
 * Demonstrates the smallest possible benchSDK benchmark:
 *   - one participant
 *   - a single task with three named steps (create, exec, destroy)
 *   - a `measure()` call attached to the task record
 *   - a `log()` call written to the worker log artifact
 *
 * Run with:
 *   bench run benchmarks/examples/00-hello-world.bench.ts --iterations 3
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-hello-world',
  benchmarkName: 'Examples: Hello World',
  iterations: 3,
  concurrency: 1,
  participants: [createNoopParticipant('noop', 100)],
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  log('starting hello-world iteration');

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
