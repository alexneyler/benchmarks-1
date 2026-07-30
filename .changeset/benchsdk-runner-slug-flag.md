---
"@benchsdk/runner": minor
---

Add `--slug` and `--name` CLI overrides for `benchmarkSlug`/`benchmarkName`, so one `*.bench.ts` can report under several platform benchmarks (e.g. the sandbox TTI entrypoint reporting sequential/staggered/burst runs of the same workload).

Add `bench create-run <file>`, which opens a platform run and prints its id, plus a `--run-id <id>` flag for `bench run` that joins that run instead of creating one. Sibling processes — one per provider, in parallel — then land in a single run (each still claiming its own worker), so their participants are directly comparable.
