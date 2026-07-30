---
"@benchsdk/runner": minor
---

Verb-first CLI: `bench create benchmark <slug> [--name] [--kind]` and `bench create run [--benchmark slug] [--iterations N] [file]`, which prints a run id (no size needed — the run takes its total from the providers that join it), alongside the existing `bench run <file>`.

`bench run` gains `--run-id <id>` to report into an already-open run instead of creating one — so sibling processes (one per provider, in parallel, each claiming its own worker) land in a single run whose participants are directly comparable. A run created *with* a size owns it, so an `--iterations` that disagrees with it is rejected.

`--slug` is now `--benchmark` (naming the resource, not the identifier); the old spelling still works.
