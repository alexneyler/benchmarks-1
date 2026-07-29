# System — SQLite speedtest

Throughput-after-boot benchmark measuring ops_per_s inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `ops_per_s` (higher is better) |
| Ceiling | 35000 |
| Timeout | 120s per replicate |
| Default replicas | 3 |
| Bundle | sql-wasm |

## Running

```bash
# Local smoke test
pnpm run system:smoke

# Against a provider
pnpm run bench:system -- --provider e2b

# Generate SVG chart
pnpm run generate-system-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Higher is better: score = (value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
