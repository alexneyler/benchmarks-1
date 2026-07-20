import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.dax.ts
export default defineBenchmark({
  mode: 'dax',
  providers: ['e2b', 'modal', 'tensorlake'],
  iterations: 5,
  report: { benchmarkSlug: 'sandbox-dax-local' },
});
