---
"@benchsdk/runner": minor
---

Verb-first CLI: `bench create benchmark <slug> [--name] [--kind]` and `bench create run [file] [--benchmark slug] [--iterations N]`, which prints a run id, alongside the existing `bench run <file>`.

`bench run` gains `--run-id <id>` to report into an already-open run instead of creating one — so sibling processes (one per provider, in parallel, each claiming its own worker) land in a single run whose participants are directly comparable. A joined run owns its own size, so `--iterations` is rejected alongside `--run-id`.

`--slug` is now `--benchmark` (naming the resource, not the identifier); the old spelling still works.
