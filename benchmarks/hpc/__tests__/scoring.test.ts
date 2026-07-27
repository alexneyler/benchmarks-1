/**
 * Unit tests for the HPC scoring formula.
 *
 * Cross-checked against hand-computed values:
 *   - scoreMetric: linear 0-100 against the suite ceiling, clamped both ends
 *   - computeHpcStats: median/min/max/p95/p99/scoreBeforeReliability/
 *     compositeScore = scoreBeforeReliability × successRate, with 2σ trim
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { computeHpcStats, scoreMetric } from '../scoring.js';
import type { HpcSuite, WorkloadResult } from '../types.js';

const lowerSuite: HpcSuite = {
  id: 'cpu-node',
  label: 'cpu-node',
  unit: 'ms',
  higherIsBetter: false,
  ceiling: 60_000,
  defaultReplicas: 3,
  workloadPath: 'workload/cpu-node.js',
  timeoutMs: 300_000,
  bundle: 'fixture-archive',
};

const higherSuite: HpcSuite = {
  id: 'memory',
  label: 'memory',
  unit: 'mb_per_s',
  higherIsBetter: true,
  ceiling: 5_000,
  defaultReplicas: 3,
  workloadPath: 'workload/memory.js',
  timeoutMs: 60_000,
  bundle: 'none',
};

function ok(value: number, suite: HpcSuite): WorkloadResult {
  return {
    ok: true,
    suite: suite.id,
    metric: { value, unit: suite.unit, higherIsBetter: suite.higherIsBetter },
    meta: {},
  };
}

function fail(suite: HpcSuite): WorkloadResult {
  return { ok: false, suite: suite.id, reason: 'error', error: 'x', meta: {} };
}

describe('scoreMetric (lower-is-better)', () => {
  test('zero value → 0 (guard); 1 ms → near 100', () => {
    assert.equal(scoreMetric(0, lowerSuite), 0);
    assert.ok(Math.abs(scoreMetric(1, lowerSuite) - 100) < 0.01);
  });
  test('ceiling → 0', () => {
    assert.ok(Math.abs(scoreMetric(60_000, lowerSuite) - 0) < 0.01);
  });
  test('half ceiling → 50', () => {
    assert.ok(Math.abs(scoreMetric(30_000, lowerSuite) - 50) < 0.01);
  });
  test('above ceiling → clamped to 0', () => {
    assert.ok(Math.abs(scoreMetric(120_000, lowerSuite) - 0) < 0.01);
  });
  test('negative → 0', () => {
    assert.ok(Math.abs(scoreMetric(-5, lowerSuite) - 0) < 0.01);
  });
});

describe('scoreMetric (higher-is-better)', () => {
  test('zero → 0', () => {
    assert.ok(Math.abs(scoreMetric(0, higherSuite) - 0) < 0.01);
  });
  test('ceiling → 100', () => {
    assert.ok(Math.abs(scoreMetric(5_000, higherSuite) - 100) < 0.01);
  });
  test('half ceiling → 50', () => {
    assert.ok(Math.abs(scoreMetric(2_500, higherSuite) - 50) < 0.01);
  });
  test('above ceiling → capped at 100', () => {
    assert.ok(Math.abs(scoreMetric(50_000, higherSuite) - 100) < 0.01);
  });
});

describe('computeHpcStats', () => {
  test('all failed → successRate 0', () => {
    const s = computeHpcStats([fail(lowerSuite), fail(lowerSuite), fail(lowerSuite)], lowerSuite);
    assert.equal(s.n, 0);
    assert.equal(s.successRate, 0);
    assert.equal(s.compositeScore, 0);
  });

  test('mixed ok/fail → successRate × score', () => {
    const s = computeHpcStats([ok(30_000, lowerSuite), fail(lowerSuite)], lowerSuite);
    assert.equal(s.n, 1);
    assert.equal(s.successRate, 0.5);
    assert.ok(Math.abs(s.scoreBeforeReliability - 50) < 0.01);
    assert.ok(Math.abs(s.compositeScore - 25.0) < 0.5);
  });

  test('median is mid of sorted values (lower-is-better)', () => {
    const s = computeHpcStats(
      [ok(20_000, lowerSuite), ok(40_000, lowerSuite), ok(60_000, lowerSuite)],
      lowerSuite,
    );
    assert.equal(s.median, 40_000);
    assert.equal(s.min, 20_000);
    assert.equal(s.max, 60_000);
    const expected = 100 * (1 - 40_000 / 60_000);
    assert.ok(Math.abs(s.scoreBeforeReliability - expected) < 0.01);
    assert.ok(Math.abs(s.compositeScore - expected) < 0.5);
  });

  test('median is mid of sorted values (higher-is-better)', () => {
    const s = computeHpcStats(
      [ok(2_500, higherSuite), ok(5_000, higherSuite), ok(1_000, higherSuite)],
      higherSuite,
    );
    assert.equal(s.median, 2_500);
    assert.ok(Math.abs(s.scoreBeforeReliability - 50) < 0.01);
    assert.ok(Math.abs(s.compositeScore - 50.0) < 0.5);
  });

  test('outlier 2σ trim — main cluster score dominates', () => {
    const values = [
      ok(100, lowerSuite),
      ok(101, lowerSuite),
      ok(99, lowerSuite),
      ok(102, lowerSuite),
      ok(50_000, lowerSuite),
    ];
    const s = computeHpcStats(values, lowerSuite);
    assert.ok(s.compositeScore > 95, `expected composite > 95, got ${s.compositeScore}`);
  });

  test('single sample', () => {
    const s = computeHpcStats([ok(10_000, lowerSuite)], lowerSuite);
    assert.equal(s.n, 1);
    assert.equal(s.min, 10_000);
    assert.equal(s.max, 10_000);
    assert.equal(s.median, 10_000);
    const expected = 100 * (1 - 10_000 / 60_000);
    assert.ok(Math.abs(s.compositeScore - expected) < 0.5);
  });
});
