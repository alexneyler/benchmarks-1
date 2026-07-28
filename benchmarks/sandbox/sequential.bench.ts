/**
 * Sequential TTI benchmark: `iterations` sandboxes created one at a time
 * (concurrency 1) per provider, each measuring time-to-interactive. Config
 * lives here; all orchestration is owned by @benchsdk/cli's runBenchmark.
 *
 * Run directly:
 *   tsx benchmarks/sandbox/sequential.bench.ts
 *   tsx benchmarks/sandbox/sequential.bench.ts --iterations 5 --provider e2b,modal
 */
import '../src/env.js';
import { defineBenchmark, runBenchmark } from '@benchsdk/cli';
import { providers } from './providers.js';
import { ttiTask, logTti } from './tti-task.js';

const config = defineBenchmark({
  benchmarkSlug: 'sandbox-tti-local',
  benchmarkName: 'Sandbox TTI (local)',
  benchmarkKind: 'sandbox',
  iterations: 2,
  concurrency: 1,
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
