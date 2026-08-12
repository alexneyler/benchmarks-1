/**
 * Shapes benchmark.
 *
 * Demonstrates `shapes`: named variants of the same benchmark that swap the
 * platform slug/name and any stable distinguishing knob (e.g. stagger delay).
 * Scale knobs such as `iterations` and `concurrency` are still overridden from
 * the CLI, so one file can back several platform benchmarks.
 *
 * Run the quick variant:
 *   bench run benchmarks/examples/04-shapes.bench.ts --shape quick --iterations 2 --concurrency 1
 *
 * Run the thorough variant:
 *   bench run benchmarks/examples/04-shapes.bench.ts --shape thorough --iterations 10 --concurrency 3
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-shapes',
  benchmarkName: 'Examples: Shapes',
  iterations: 3,
  concurrency: 1,
  shapes: {
    quick: {
      slug: 'examples-shapes-quick',
      name: 'Examples: Shapes (Quick)',
      staggerDelayMs: 0,
    },
    thorough: {
      slug: 'examples-shapes-thorough',
      name: 'Examples: Shapes (Thorough)',
      staggerDelayMs: 250,
    },
  },
  participants: [createNoopParticipant('noop', 100)],
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log }) => {
  log('starting shaped iteration');

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
