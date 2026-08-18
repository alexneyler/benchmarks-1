import { describe, expect, it } from 'vitest';
import { validateScoringSpec, ScoringSpecError, lowerIsBetter, higherIsBetter } from '../scoring';
import type { ScoringSpec } from '../scoring';

describe('validateScoringSpec', () => {
  it('does not throw when declared weights sum to 1.0 across all metrics', () => {
    const spec: ScoringSpec = {
      metrics: [
        lowerIsBetter('uploadMs', { unit: 'ms', ceiling: 30000, weights: { median: 0.25, p95: 0.10, p99: 0.05 } }),
        lowerIsBetter('downloadMs', { unit: 'ms', ceiling: 30000, weights: { median: 0.35, p95: 0.15, p99: 0.05 } }),
        higherIsBetter('throughputMbps', { unit: 'mbps', floor: 1, ceiling: 1000, weights: { median: 0.05, p95: 0, p99: 0 } }),
      ],
    };
    expect(() => validateScoringSpec(spec)).not.toThrow();
  });

  it('does not throw for a single metric whose weights alone sum to 1.0', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 10000, weights: { median: 0.60, p95: 0.25, p99: 0.15 } })],
    };
    expect(() => validateScoringSpec(spec)).not.toThrow();
  });

  it('throws ScoringSpecError with a per-metric breakdown when weights sum to less than 1.0', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('ttiMs', { unit: 'ms', ceiling: 10000, weights: { median: 0.5, p95: 0.2, p99: 0.1 } })],
    };
    expect(() => validateScoringSpec(spec)).toThrow(ScoringSpecError);
    expect(() => validateScoringSpec(spec)).toThrow('Scoring spec weights sum to 0.800, expected 1.0');
    expect(() => validateScoringSpec(spec)).toThrow('ttiMs=0.800');
  });

  it('throws when weights sum to more than 1.0', () => {
    const spec: ScoringSpec = {
      metrics: [
        lowerIsBetter('a', { unit: 'ms', ceiling: 1000, weights: { median: 0.6, p95: 0.3, p99: 0.2 } }),
        lowerIsBetter('b', { unit: 'ms', ceiling: 1000, weights: { median: 0.3, p95: 0, p99: 0 } }),
      ],
    };
    expect(() => validateScoringSpec(spec)).toThrow('Scoring spec weights sum to 1.400, expected 1.0');
  });

  it('does not throw for a boundary case just inside the tolerance', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('a', { unit: 'ms', ceiling: 1000, weights: { median: 1.009, p95: 0, p99: 0 } })],
    };
    expect(() => validateScoringSpec(spec)).not.toThrow();
  });

  it('throws for a boundary case just outside the tolerance', () => {
    const spec: ScoringSpec = {
      metrics: [lowerIsBetter('a', { unit: 'ms', ceiling: 1000, weights: { median: 1.011, p95: 0, p99: 0 } })],
    };
    expect(() => validateScoringSpec(spec)).toThrow(ScoringSpecError);
  });

  it('throws for no declared metrics (weights sum to 0)', () => {
    const spec: ScoringSpec = { metrics: [] };
    expect(() => validateScoringSpec(spec)).toThrow('(no metrics declared)');
  });
});
