# CPU — node-web-tooling build

Throughput-after-boot benchmark measuring ms inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `ms` (lower is better) |
| Ceiling | 45000 |
| Timeout | 300s per replicate |
| Default replicas | 3 |
| Bundle | fixture-archive |

## Running

```bash
# Local smoke test
pnpm run cpu-node:smoke

# Against a provider
pnpm run bench:cpu-node -- --provider e2b

# Generate SVG chart
pnpm run generate-cpu-node-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Lower is better: score = (1 - value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
