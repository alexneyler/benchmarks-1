/**
 * Workloads are uploaded to a fresh sandbox and executed with `node <file>.js`.
 * Every workload must `console.log` a single WorkloadResult JSON line as
 * its LAST line of stdout — the runner parses only the last line.
 *
 * This helper guarantees the line stays last even if intermediate logging
 * happens (e.g. status updates).
 *
 * Pure CommonJS — no transpile step runs inside ComputeSDK sandboxes, so we
 * intentionally avoid `import`/`export` and TypeScript syntax here. The TS
 * counterpart of this file is `stdout.ts` in the same directory, which the
 * build pipeline does NOT upload; only this `.js` is shipped with each suite.
 */

function emitWorkloadResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { emitWorkloadResult };
