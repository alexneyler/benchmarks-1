import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.sequential.ts
export default defineBenchmark({
  mode: 'sequential',
  providers: ['e2b'],
  iterations: 2,
  report: { benchmarkSlug: 'sandbox-tti-local' },
});
