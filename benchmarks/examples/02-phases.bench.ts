/**
 * Phases benchmark.
 *
 * Demonstrates `phases`: an ordered list of named segments, each with its own
 * iteration count. The runner tags every task record with `data.phase` and the
 * task receives `ctx.phase`, so the same task function can branch on the phase
 * without doing index arithmetic.
 *
 * Run with:
 *   bench run benchmarks/examples/02-phases.bench.ts --concurrency 2
 */
import '../src/env.js';
import { defineBenchmarkConfig, defineTask } from '@benchsdk/runner';
import type { NoopParticipant } from './participants.js';
import { createNoopParticipant } from './participants.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'examples-phases',
  benchmarkName: 'Examples: Phases',
  phases: [
    { name: 'cold', iterations: 2 },
    { name: 'warm', iterations: 4 },
  ],
  concurrency: 2,
  participants: [createNoopParticipant('noop', 100)],
});

export const task = defineTask<NoopParticipant>(async ({ participant, step, measure, log, phase }) => {
  log(`starting ${phase ?? 'unknown'} phase`);

  const compute = participant.createCompute();
  const start = performance.now();

  // In a real benchmark you might use a different payload per phase.
  const command = phase === 'cold' ? 'node -v' : 'node -e "console.log(1+1)"';

  const sandbox = await step('create', () => compute.sandbox.create());
  try {
    const result = await step('exec', () => sandbox.runCommand(command));
    measure({ ttiMs: performance.now() - start, exitCode: result.exitCode, ...(phase ? { phase } : {}) });
  } finally {
    await step('destroy', () => sandbox.destroy(), { reportConcurrency: false });
  }
});
