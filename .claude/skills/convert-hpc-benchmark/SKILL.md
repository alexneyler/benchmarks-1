---
name: convert-suite-benchmark
description: Convert one of the HPC sandbox suites (disk, dns, download, latency, memory, network-localhost, network-wan, pgbench, realworld, system) into a self-contained, standalone benchmark that matches the dax/cpu-node organization, wire it in, and ship its CI workflow. Use when asked to "port/convert the <suite> benchmark", "make <suite> standalone like cpu-node", "add the <suite> HPC suite to its own workflow", etc.
---

# Convert a suite bench to a standalone dax/cpu-node-style benchmark

`cpu-node` is the reference conversion. This skill reproduces exactly what was done
for it, for any of the **10 remaining HPC suites**:

```
disk  dns  download  latency  memory  network-localhost  network-wan  pgbench  realworld  system
```

## What "standalone / dax-style" means

The original suites were multi-file directories. The standalone form collapses each
suite into the dax/cpu-node shape:

| Concern | Old (HPC multi-file) | New (standalone) |
|---|---|---|
| Orchestrator + types + scoring + result writer | `benchmarks/sandbox/<suite>/{benchmark,types,scoring}.ts` | **one** file `benchmarks/sandbox/<suite>.ts` |
| Compute workload | fixture / bundle + tar upload (`util/upload-bundle.ts`) | **self-contained** `benchmarks/scripts/<suite>-workload.js` (pure stdlib CJS, no bundle/tar) |
| stdout emitter + crash handler | per-suite | `benchmarks/scripts/<suite>-stdout.js` (copy of cpu-node-stdout.js) |
| SVG | `benchmarks/sandbox/<suite>/generate-svg.ts` | `benchmarks/sandbox/generate-<suite>-svg.ts` |
| Tests | scattered | `benchmarks/sandbox/__tests__/<suite>.test.ts` |
| CI | one shared workflow | `.github/workflows/sandbox-<suite>.yml` |

**Canonical example to copy from (read these first, every time):**
[benchmarks/sandbox/cpu-node.ts](../../../benchmarks/sandbox/cpu-node.ts),
[benchmarks/scripts/cpu-node-workload.js](../../../benchmarks/scripts/cpu-node-workload.js),
[benchmarks/scripts/cpu-node-stdout.js](../../../benchmarks/scripts/cpu-node-stdout.js),
[benchmarks/sandbox/generate-cpu-node-svg.ts](../../../benchmarks/sandbox/generate-cpu-node-svg.ts),
[benchmarks/sandbox/__tests__/cpu-node.test.ts](../../../benchmarks/sandbox/__tests__/cpu-node.test.ts),
[.github/workflows/sandbox-cpu-node.yml](../../../.github/workflows/sandbox-cpu-node.yml).

Also read `benchmarks/sandbox/dax.ts` for the pattern this family follows.

## Conversion priority order

Pick the suite to convert next from the table below. Rank sums three axes: **no external
deps** (every provider has it), **no egress / no tool guards beyond `'which node'`**
(CI-stable), and **smallest surface area** (closest 1:1 with cpu-node's workload shape).
Egress-flaky suites go last because their CI runs will produce noisy false negatives
that pollute score calibration.

| Rank | Suite | Workload LOC (orig) | External deps / risk | Why this rank |
|---|---|---|---|---|
| 1 | **disk** | 143 | none — pure `fs` IO | Closest shape to cpu-node; fully deterministic; classic baseline. Start here. |
| 2 | memory | 116 | none — Float64 STREAM in Node | Pure stdlib; deterministic; differentiates on memory subsystem. |
| 3 | network-localhost | 127 | none (loopback) | Self-binds HTTP server; bounded payload; no external hosts. |
| 4 | pgbench | 130 | pglite (wasm) | In-process but needs a tool-style guard; bigger lift. |
| 5 | realworld | 106 | tied to existing scripts | Useful but coupled to backend helpers — convert after the deterministic trio. |
| 6 | system | 153 | sql.js (already a dep) | Largest workload; deterministic but longest. |
| 7 | network-wan | 139 | **external CDN hosts** | Hardcoded Cloudflare/S3/R2 endpoints; region-bound. |
| 8 | download | 112 | **external CDN hosts** | Egress-dependent; per-call network variance. |
| 9 | dns | 88 | **egress** | Authoritative DNS lookups; region-bound. |
| 10 | latency | 99 | **egress + TLS** | `tls.connect` to fixed endpoints; region-bound. |

**Operating rule:** convert ranks 1 → 3 first to validate the wiring end-to-end against
the deterministic trio, then 4 → 6 for in-process but heavier suites, then 7 → 10 only
once the CI signal is stable enough to absorb egress noise.

## 0. Get the original suite's logic

The old multi-file source is on the **starsling-benchmarks** branch under
`benchmarks/sandbox/<suite>/`. Read (do not merge) the original workload/scoring so you
preserve the actual measurement:

```bash
git show origin/starsling-benchmarks:benchmarks/sandbox/<suite>/benchmark.ts
git show origin/starsling-benchmarks:benchmarks/sandbox/<suite>/scoring.ts
git show origin/starsling-benchmarks:benchmarks/sandbox/<suite>/types.ts
git ls-tree -r --name-only origin/starsling-benchmarks | grep "sandbox/<suite>/"
# the compute lived in a fixture/bundle referenced by util/build-shell-cmd.ts + util/upload-bundle.ts
```

Note the suite's **metric** (unit, higher-vs-lower-is-better), what the shell command
actually ran inside the sandbox, and how the score was calibrated.

## 1. Write the self-contained workload — `benchmarks/scripts/<suite>-workload.js`

Start from `cpu-node-workload.js`. Rules:

- **Pure CommonJS, Node stdlib only** — no `import`/`export`, no `node_modules`, no
  native bindings, no TypeScript. It runs via `node <file>.js` inside a fresh sandbox
  with no transpile step.
- Inline the compute directly (no external fixture/bundle/tar). If the old suite shelled
  out to a tool (`pgbench`, `dd`, `dig`, `curl`, ...), guard for it first (see the
  `which node` check in cpu-node-workload.js) and emit `reason: 'no_tool'`/`'gap'` if
  missing.
- Time the work with `process.hrtime.bigint()` and emit **exactly one** WorkloadResult
  JSON line as the LAST stdout line via `require('./stdout.js').emitWorkloadResult(...)`:
  ```js
  emitWorkloadResult({ ok: true, suite: '<suite>', metric: { value, unit, higherIsBetter }, meta: { workloadMs } });
  ```
- On any inability to run: `emitWorkloadResult({ ok: false, suite: '<suite>', reason, error, meta })` then `process.exit(0)`.

> ⚠️ **Watch for unbounded-loop / OOM bugs when generating synthetic input.** The
> cpu-node corpus generator originally bounded its loop by a string that got reset to
> `''` periodically, so it never terminated and grew memory until OOM. Bound generation
> loops by a **cumulative counter**, not by a value you also mutate/reset.

## 2. Copy the stdout helper — `benchmarks/scripts/<suite>-stdout.js`

Copy `cpu-node-stdout.js` verbatim (it's suite-agnostic; it reads `process.env.BENCH_SUITE`
for the crash-handler fallback). The uploaded copy is always named `stdout.js` in-sandbox.

## 3. Write the orchestrator — `benchmarks/sandbox/<suite>.ts`

Copy `cpu-node.ts` and adjust:

- `SUITE_CONFIG`: `id`, `label`, `unit`, `higherIsBetter`, `ceiling`, `defaultReplicas`,
  `workloadPath: '<suite>-workload.js'`, `timeoutMs`.
- `BENCH_SCRIPT_PATH` / `BENCH_STDOUT_PATH` → the `<suite>-*.js` files.
- Rename exported types/functions (`CpuNode*` → `<Suite>*`,
  `runCpuNodeBenchmark`/`writeCpuNodeResultsJson`).
- In `parseWorkloadResult`, the `parsed.suite !== '<suite>'` guard must match your id.
- Keep everything else identical: single-`runCommand` heredoc upload
  (`buildSingleCommand`), unconditional `sandbox.destroy()`, 2-sigma trim in
  `computeStats`, `scoreMetric` (respect `higherIsBetter`), the `missingVars` skip path.

`scoreMetric` maps against `ceiling`: lower-is-better → `100*(1 - value/ceiling)`,
higher-is-better → `100*(value/ceiling)`, clamped `[0,100]`. **Calibrate `ceiling`** from
the smoke/CI medians so scores land ~50-70 for typical providers (see §9).

## 4. SVG generator — `benchmarks/sandbox/generate-<suite>-svg.ts`

Copy `generate-cpu-node-svg.ts`; change the import to `./<suite>.js`, the results dir to
`results/<suite_underscored>` (dashes → underscores), and the output filename to
`<suite_underscored>.svg`. The `main()` guard checks `process.argv[1].endsWith('generate-<suite>-svg.ts')`.

## 5. Unit test — `benchmarks/sandbox/__tests__/<suite>.test.ts`

Copy `cpu-node.test.ts`, import from `../<suite>.js`, keep the 4 scoring assertions
(clamp, empty, all-failure, successful median). `test:benchmarks` globs
`benchmarks/sandbox/__tests__/*.test.ts`, so no script change needed.

## 6. Wire into the runner — `benchmarks/src/run.ts`

- Import: `import { run<Suite>Benchmark, write<Suite>ResultsJson, SUITE_CONFIG as <SUITE>_CONFIG } from '../sandbox/<suite>.js';`
- Add the id to `const BENCHMARK_SUITE_IDS = ['cpu-node', '<suite>'];`
- Add a `run<Suite>BenchmarkSuite(toRun)` fn mirroring `runCpuNodeBenchmarkSuite`
  (results dir via `perfModeToDir(suite.id)` = id with dashes→underscores; writes
  `<date>.json` + `latest.json`; spawns `generate-<suite>-svg.ts`).
- In the benchmark dispatch loop add `else if (suiteId === '<suite>') await run<Suite>BenchmarkSuite(toRun);`

## 7. Wire the merge step — `benchmarks/src/merge-results.ts`

Add the id to `const BENCHMARK_SUITE_IDS = ['cpu-node', '<suite>'];`. The `--mode benchmark`
handler (`mainHpc`) already picks up any `results/<id_underscored>/` dir via
`BENCHMARK_DIR_NAMES`.

> ⚠️ Do **not** re-introduce a local `type BenchmarkResult` — the file already has one
> named `GenericBenchmarkResult` (the imported `BenchmarkResult` from `../sandbox/types.js`
> belongs to the TTI path). Reuse `GenericBenchmarkResult`.

## 8. package.json scripts + smoke

Add next to the cpu-node scripts:

```jsonc
"bench:<suite>": "tsx benchmarks/src/run.ts --mode <suite>",
"generate-<suite>-svg": "tsx benchmarks/sandbox/generate-<suite>-svg.ts",
"smoke:<suite>": "tsx benchmarks/scripts/smoke.ts --suite=<suite>",
```

`benchmarks/scripts/smoke.ts` currently hardcodes the cpu-node import. Generalize it to
dynamically import `../sandbox/${suite}.js` and its `<suite>-stdout.js`, keyed off
`--suite`, so one harness serves every suite.

## 9. CI workflow — `.github/workflows/sandbox-<suite>.yml`

Copy `sandbox-cpu-node.yml` and change, consistently:

- `name: Sandbox <Suite> Benchmark` — **match the sibling convention** (Title-case,
  `Sandbox … Benchmark`). GitHub reads the display name from the **default branch**, so
  the label only updates once this lands on `master`.
- `paths:` triggers → the new `<suite>.ts` / `<suite>-workload.js` / `<suite>-stdout.js` /
  `generate-<suite>-svg.ts` files.
- `concurrency.group: <suite>-benchmark`.
- Run step `--mode <suite>`; SVG step `pnpm run generate-<suite>-svg`; artifact/commit
  paths → `<suite_underscored>.svg`; ingest `--type <suite>`.
- Keep the 23-provider matrix, the `load-vault-secrets.sh` regex, and the collect job
  (`merge-results.ts --input artifacts --mode benchmark`) unchanged.

## 10. Verify locally (all must pass before pushing)

```bash
pnpm tsc --noEmit
pnpm run test:benchmarks
pnpm run smoke:<suite>          # runs the workload locally, no cloud
```

## 11. Register + run CI, then evaluate

- A `workflow_dispatch` uses the workflow file from the **default branch** to validate
  inputs, so the workflow must exist on `master` before it can be dispatched (that's what
  the "register workflows" commits did). Get the file onto master, then:
  ```bash
  gh workflow run sandbox-<suite>.yml --ref <your-branch> -f replicas=3
  gh run list --workflow=sandbox-<suite>.yml --branch <your-branch> --limit 3
  ```
- After it finishes, pull the collect commit and evaluate `results/<suite_underscored>/latest.json`:
  count valid vs zero-score providers, and **separate "slow-but-working" from "failed."**
  If working providers exceed `ceiling` and score 0 (indistinguishable from real
  failures), raise the ceiling and re-calibrate.

## Gotchas (learned from cpu-node)

- **Self-contained only.** No fixture/bundle/tar/manifest, no `build:bundles` step. The
  workload is uploaded inline via a single heredoc `runCommand`.
- **Last line is the result.** The runner parses only the last JSON stdout line; the
  crash handler in `stdout.js` guarantees a parseable failure line even on early crash.
- **Root `package.json` is `"type":"module"`,** but the uploaded `*-workload.js` runs from
  `/tmp/bench` (outside the project tree) so Node treats it as CommonJS. Do **not** add a
  `scripts/package.json` — it breaks the ESM `.ts` scripts that use `import.meta`.
- **Tool guards.** Suites that need `pgbench`/`dig`/`dd`/network egress must probe first
  and emit `no_tool`/`gap` rather than a bogus number, so providers lacking the tool are
  distinguishable from slow ones.
- **Don't leak artifacts into history.** Generated `<suite>.svg` and `results/<suite>/*`
  are produced by CI; keep them out of feature-branch commits unless asked.

## Final check

`git status` should show exactly: `benchmarks/sandbox/<suite>.ts`,
`benchmarks/sandbox/generate-<suite>-svg.ts`, `benchmarks/sandbox/__tests__/<suite>.test.ts`,
`benchmarks/scripts/<suite>-workload.js`, `benchmarks/scripts/<suite>-stdout.js`,
`benchmarks/scripts/smoke.ts` (generalized), `benchmarks/src/run.ts`,
`benchmarks/src/merge-results.ts`, `package.json`, and
`.github/workflows/sandbox-<suite>.yml` — nothing else.
