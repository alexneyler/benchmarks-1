# Network — edge RTT probe

Throughput-after-boot benchmark measuring rtt_ms inside ComputeSDK sandboxes.

## Configuration

| Property | Value |
|---|---|
| Unit | `rtt_ms` (lower is better) |
| Ceiling | 35 |
| Timeout | 20s per replicate |
| Default replicas | 3 |
| Bundle | none |

## Running

```bash
# Local smoke test
pnpm run latency:smoke

# Against a provider
pnpm run bench:latency -- --provider e2b

# Generate SVG chart
pnpm run generate-latency-svg
```

## Scoring

Score = ceiling normalization * success rate, clamped [0, 100].

- Lower is better: score = (1 - value / ceiling) * 100
- 2-sigma outlier trim applied to replicates
- Composite score = metric score * success rate
