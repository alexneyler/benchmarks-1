import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HPC_SUITES, getSuite, getSuiteIds, getWorkloadBundle } from '../registry.js';
import { HPC_SUITE_IDS } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('HPC suite registry', () => {
  test('every id in HPC_SUITE_IDS is registered', () => {
    for (const id of HPC_SUITE_IDS) {
      assert.equal(getSuite(id).id, id);
    }
  });

  test('registry map size matches the spec', () => {
    assert.equal(HPC_SUITES.size, HPC_SUITE_IDS.length);
  });

  test('getSuiteIds returns the same ids in the same order', () => {
    assert.deepEqual(getSuiteIds(), HPC_SUITE_IDS);
  });

  test('every suite has a unit, ceiling, and timeout >= 15s', () => {
    for (const suite of HPC_SUITES.values()) {
      assert.ok(suite.ceiling > 0, `${suite.id}: ceiling must be > 0`);
      assert.ok(suite.timeoutMs >= 15_000, `${suite.id}: timeout must be >= 15s`);
      assert.ok(['ms', 'mb_per_s', 'gb_per_s', 'iops', 'tps', 'rtt_ms', 'ops_per_s'].includes(suite.unit));
      assert.equal(typeof suite.higherIsBetter, 'boolean');
    }
  });

  test('every suite with a workloadPath has a script on disk', () => {
    const ROOT = path.resolve(__dirname, '..');
    for (const suite of HPC_SUITES.values()) {
      const target = path.join(ROOT, suite.workloadPath);
      if (!fs.existsSync(target)) {
        throw new Error(`Suite "${suite.id}" workload script missing: ${target}`);
      }
    }
  });

  test('cpu-node and realworld share the fixture archive bundle', () => {
    assert.equal(getWorkloadBundle('cpu-node'), 'fixture-archive');
    assert.equal(getWorkloadBundle('realworld'), 'fixture-archive');
  });

  test('known id returns, unknown id throws', () => {
    assert.doesNotThrow(() => getSuite('cpu-node'));
    assert.throws(() => getSuite('nope' as any), /Unknown HPC suite/);
  });
});
