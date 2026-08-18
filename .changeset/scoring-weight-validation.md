---
"@benchsdk/runner": minor
---

`score()` now validates that a scoring spec's declared metric weights (`weights.median + weights.p95 + weights.p99`, summed across every metric in `onScore`'s returned `metrics` array) total 1.0, throwing the newly-exported `ScoringSpecError` if they don't — previously a misconfigured spec would silently produce a `compositeScore` that had drifted off its advertised 0-100 scale.

`bench run` now fails when this happens: `runner.ts`'s `onScore`/`submitRunSummary` catch block re-throws `ScoringSpecError` specifically, so a benchmark with a broken weight sum fails its own run/CI job instead of the error being swallowed into a warning. Every other error in that path (a transient `submitRunSummary` failure, a network blip) keeps the existing warn-and-continue behavior, unchanged.

Also exports `validateScoringSpec(spec)` directly, so the check can be run standalone (e.g. in a test) without a full `BenchmarkRunOutcome`.
