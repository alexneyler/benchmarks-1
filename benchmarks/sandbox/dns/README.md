# DNS resolution probe

Throughput-after-boot benchmark measuring ms inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `ms` (lower is better) |
| Ceiling | 10 |
| Timeout | 20s per replicate |
| Default replicas | 3 |
| Bundle | none |

## Running

```bash
# Local smoke test
pnpm run dns:smoke

# Against a provider
pnpm run bench:dns -- --provider e2b

# Generate SVG chart
pnpm run generate-dns-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Lower is better: score = (1 - value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
