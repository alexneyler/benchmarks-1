import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.self-contained.ts
//
// A self-contained benchmark: config (mode/providers/iterations) and the code
// that runs inside each sandbox (`task`) live in this one file, instead of
// the default `node -v` liveness check baked into benchmark.ts. Writes local
// JSON only; for platform reporting see src/benchmarks/*.bench.ts.
export default defineBenchmark({
  mode: 'sequential',
  providers: ['e2b'],
  iterations: 2,
  taskTimeoutMs: 60_000,
  task: async (sandbox) => {
    const result = await sandbox.runCommand('pip install --quiet requests && python3 -c "import requests; print(requests.__version__)"') as {
      exitCode: number;
      stdout?: string;
      stderr?: string;
    };
    if (result.exitCode !== 0) {
      throw new Error(`pip install/import failed: ${result.stderr || 'unknown error'}`);
    }
  },
});
