import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.dax.ts
//
// Note: dax mode doesn't accept a custom `task` — it always runs its own fixed
// disk/CPU/pause-resume probes (see sandbox/dax-benchmark.ts). This writes
// local JSON only; for platform reporting see src/benchmarks/dax.bench.ts.
export default defineBenchmark({
  mode: 'dax',
  providers: ['e2b', 'modal', 'tensorlake'],
  iterations: 5,
});
