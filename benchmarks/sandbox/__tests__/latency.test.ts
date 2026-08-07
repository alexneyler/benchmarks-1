import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, scoreMetric, SUITE_CONFIG } from '../latency.js';
import type { LatencyWorkloadResult } from '../latency.js';

describe('scoring: latency', () => {
  test('scoreMetric clamps to [0, 100] for lower-is-better', () => {
    const suite = SUITE_CONFIG;
    assert.equal(scoreMetric(0, suite), 0);
    assert.equal(scoreMetric(suite.ceiling, suite), 0);
    assert.equal(scoreMetric(suite.ceiling * 2, suite), 0);
    assert.equal(scoreMetric(suite.ceiling * 0.5, suite), 50);
  });

  test('computeStats returns zeros for empty results', () => {
    const stats = computeStats([], SUITE_CONFIG);
    assert.equal(stats.n, 0);
    assert.equal(stats.compositeScore, 0);
  });

  test('computeStats handles all-failure iterations', () => {
    const results: LatencyWorkloadResult[] = [
      { ok: false, suite: 'latency', reason: 'error', error: 'test', meta: {} },
      { ok: false, suite: 'latency', reason: 'timeout', error: 'test', meta: {} },
    ];
    const stats = computeStats(results, SUITE_CONFIG);
    assert.equal(stats.n, 0);
    assert.equal(stats.successRate, 0);
  });

  test('computeStats produces median and score for successful runs', () => {
    const suite = SUITE_CONFIG;
    const val = suite.ceiling * 0.5;
    const results: LatencyWorkloadResult[] = [
      { ok: true, suite: 'latency', metric: { value: val, unit: suite.unit, higherIsBetter: suite.higherIsBetter }, meta: {} },
      { ok: true, suite: 'latency', metric: { value: val, unit: suite.unit, higherIsBetter: suite.higherIsBetter }, meta: {} },
      { ok: true, suite: 'latency', metric: { value: val, unit: suite.unit, higherIsBetter: suite.higherIsBetter }, meta: {} },
    ];
    const stats = computeStats(results, suite);
    assert.equal(stats.n, 3);
    assert.equal(stats.median, val);
    assert.equal(stats.compositeScore, 50);
  });
});
