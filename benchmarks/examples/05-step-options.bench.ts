/**
 * Step options benchmark.
 *
 * Demonstrates per-step `concurrency` and `timeoutMs`. A step can invoke its
 * function multiple times in parallel and abort any slow invocation with a
 * `step_timeout` error.
 *
 * Run with:
 *   bench run benchmarks/examples/05-step-options.bench.ts --iterations 2 --no-ingest
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

/**
 * The config is minimal: one provider, low iterations. The interesting
 * behavior is inside `ctx.step(...)` in the task.
 */
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-step-options',
  benchmarkName: 'Examples: Step Options',
  iterations: 2,
  concurrency: 1,
  participants: [createNoopParticipant('noop', 100)],
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  const compute = participant.createCompute();

  log('running three create/exec/destroy cycles in parallel inside one step');

  // `concurrency: 3` invokes the step function three times in parallel.
  // `timeoutMs: 2000` aborts any invocation that takes longer than 2s.
  // The return value is an array containing one result per invocation.
  const results = await step(
    'parallel-work',
    async () => {
      const start = performance.now();
      const sandbox = await compute.sandbox.create();
      try {
        const result = await sandbox.runCommand('node -v');
        return { exitCode: result.exitCode, ttiMs: performance.now() - start };
      } finally {
        await sandbox.destroy();
      }
    },
    { concurrency: 3, timeoutMs: 2000 },
  );

  // `results` is an array because `concurrency` was greater than 1.
  const avgTtiMs = results.reduce((sum, r) => sum + r.ttiMs, 0) / results.length;
  const maxTtiMs = Math.max(...results.map((r) => r.ttiMs));

  measure({ avgTtiMs, maxTtiMs, created: results.length });
});
