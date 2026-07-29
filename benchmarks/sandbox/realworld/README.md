# Realworld — cold install + build

Throughput-after-boot benchmark measuring ms inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `ms` (lower is better) |
| Ceiling | 300 |
| Timeout | 600s per replicate |
| Default replicas | 1 |
| Bundle | fixture-archive |

## Running

```bash
# Local smoke test
pnpm run realworld:smoke

# Against a provider
pnpm run bench:realworld -- --provider e2b

# Generate SVG chart
pnpm run generate-realworld-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Lower is better: score = (1 - value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
