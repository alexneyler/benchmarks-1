import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.dry-run.ts
export default defineBenchmark({
  mode: 'burst',
  providers: ['e2b', 'daytona'],
  concurrency: 5,
  dryRun: true,
});
