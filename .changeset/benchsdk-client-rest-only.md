---
"@benchsdk/client": minor
---

Make `@benchsdk/client` a pure REST + worker-engine package. The benchmark authoring factories `defineStep`, `defineTask`, `defineWorker`, `defineBench`, and the `runBenchmarkWorker` free function have been removed — that authoring model now lives in `@benchsdk/runner`. `client.runWorker({ task })` now accepts a raw `TaskFunction` that declares steps imperatively via `context.step(...)`. `createBenchmarkClient`, the REST methods, `BenchmarkReporter`, and the system-metrics collector are unchanged.
