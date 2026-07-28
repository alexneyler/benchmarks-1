/**
 * Burst TTI benchmark: `iterations` sandboxes all launched at once
 * (concurrency == iterations) per provider, each measuring time-to-
 * interactive. Config lives here; orchestration is owned by @benchsdk/cli's
 * runBenchmark. Keep the numbers small and raise deliberately — this launches
 * that many real sandboxes simultaneously.
 *
 * Run directly:
 *   tsx benchmarks/sandbox/burst.bench.ts
 *   tsx benchmarks/sandbox/burst.bench.ts --iterations 10 --concurrency 10 --provider e2b
 */
import '../src/env.js';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import { providers } from './providers.js';
import { ttiTask, logTti } from './tti-task.js';

const config = defineBenchmark({
  benchmarkSlug: 'sandbox-burst-local',
  benchmarkName: 'Sandbox burst TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 3,
  concurrency: 3,
  defaultProviders: ['e2b'],
  task: ttiTask,
  onResult: logTti,
});

runBenchmark(config, providers, process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
