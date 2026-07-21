import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.dax.ts
//
// Note: dax mode doesn't accept a custom `task` — it always runs its own fixed
// disk/CPU/pause-resume probes (see sandbox/dax-benchmark.ts), so this config
// can't embed sandbox code the way example.self-contained.ts does. Setting
// `name` here is the one piece of the self-contained format that still
// applies: it's what shows up as the benchmark's title on the dashboard,
// independent of `benchmarkSlug` (see prior discussion — slug is the stable
// identity key, name is just the display title, and both are settable here).
export default defineBenchmark({
  mode: 'dax',
  providers: ['e2b', 'modal', 'tensorlake'],
  iterations: 5,
  report: { benchmarkSlug: 'sandbox-dax-local', name: 'Dax sandbox benchmark (local)' },
});
