# Static download probe

Throughput-after-boot benchmark measuring mb_per_s inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `mb_per_s` (higher is better) |
| Ceiling | 40 |
| Timeout | 30s per replicate |
| Default replicas | 3 |
| Bundle | none |

## Running

```bash
# Local smoke test
pnpm run download:smoke

# Against a provider
pnpm run bench:download -- --provider e2b

# Generate SVG chart
pnpm run generate-download-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Higher is better: score = (value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
