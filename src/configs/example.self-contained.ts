import { defineBenchmark } from '../sandbox/bench-config.js';

// npm run bench src/configs/example.self-contained.ts
//
// A fully self-contained benchmark: config (mode/providers/iterations/report)
// and the code that runs inside each sandbox (`task`) live in this one file,
// instead of the default `node -v` liveness check baked into benchmark.ts.
export default defineBenchmark({
  mode: 'sequential',
  providers: ['e2b'],
  iterations: 2,
  report: { benchmarkSlug: 'sandbox-pip-install-local', name: 'Sandbox pip install (local)' },
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
