---
"@benchsdk/runner": minor
---

Adds `onScore` to `BenchmarkConfig`. The runner invokes `onScore(lowerIsBetter, higherIsBetter)` after a run, computes per-participant composite scores with `score(outcome, spec)`, and posts the scored summary to the platform via `BenchmarkClient.submitRunSummary`. Includes `lowerIsBetter`, `higherIsBetter`, `score`, `MetricScoring`, `ScoringSpec`, and `BenchmarkScoreResult` exports. Existing `onComplete` / legacy `latest.json` flows remain unchanged.
