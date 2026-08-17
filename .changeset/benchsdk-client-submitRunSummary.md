---
"@benchsdk/client": minor
---

Adds `submitRunSummary(benchmarkSlug, runId, input)` to `BenchmarkClient`, plus `BenchmarkRunSummaryInput`, `BenchmarkRunSummaryRunMetadata`, `BenchmarkRunSummaryResult`, `BenchmarkRunSummaryMetric`, and `BenchmarkRunSummaryScalar` types. Posts to `POST /benchmarks/{slug}/runs/{runId}/summary`.
