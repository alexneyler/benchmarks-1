# Database — pgbench (pglite)

Throughput-after-boot benchmark measuring tps inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `tps` (higher is better) |
| Ceiling | 1500 |
| Timeout | 300s per replicate |
| Default replicas | 3 |
| Bundle | pglite |

## Running

```bash
# Local smoke test
pnpm run pgbench:smoke

# Against a provider
pnpm run bench:pgbench -- --provider e2b

# Generate SVG chart
pnpm run generate-pgbench-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Higher is better: score = (value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
