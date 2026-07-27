import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkloadResult } from '../util/parse-stdout.js';
import type { HpcSuiteId } from '../types.js';

const SUITE: HpcSuiteId = 'cpu-node';

describe('parseWorkloadResult', () => {
  test('parses the last JSON line when followed by trailing whitespace', () => {
    const stdout = `[fixture] loaded 64 MiB
[fixture] running 4 phases
{"ok":true,"suite":"cpu-node","metric":{"value":1234,"unit":"ms","higherIsBetter":false},"meta":{}}
`;
    const r = parseWorkloadResult(stdout, SUITE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.metric.value, 1234);
  });

  test('handles CRLF line endings', () => {
    const stdout = `prefix\r\n{"ok":true,"suite":"cpu-node","metric":{"value":42,"unit":"ms","higherIsBetter":false},"meta":{}}\r\n`;
    const r = parseWorkloadResult(stdout, SUITE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.metric.value, 42);
  });

  test('returns gap when no JSON line is present', () => {
    const r = parseWorkloadResult('garbage\nmore garbage', SUITE);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'unexpected');
      assert.equal(r.suite, SUITE);
    }
  });

  test('picks the LAST JSON line (last wins)', () => {
    const stdout = `{"ok":false,"suite":"cpu-node","reason":"error","meta":{}}
{"ok":true,"suite":"cpu-node","metric":{"value":7,"unit":"ms","higherIsBetter":false},"meta":{}}`;
    const r = parseWorkloadResult(stdout, SUITE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.metric.value, 7);
  });

  test('ignores JSON-shaped strings that are not WorkloadResults', () => {
    const stdout = `{"foo":"bar"}
{"ok":true,"suite":"cpu-node","metric":{"value":1,"unit":"ms","higherIsBetter":false},"meta":{}}`;
    const r = parseWorkloadResult(stdout, SUITE);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.metric.value, 1);
  });

  test('rejects malformed JSON without panicking', () => {
    const stdout = `{not valid json}`;
    const r = parseWorkloadResult(stdout, SUITE);
    assert.equal(r.ok, false);
  });

  test('rejects JSON with unknown suite id', () => {
    const stdout = `{"ok":true,"suite":"not-a-real-suite","metric":{"value":1,"unit":"ms","higherIsBetter":false},"meta":{}}`;
    const r = parseWorkloadResult(stdout, SUITE);
    assert.equal(r.ok, false);
  });
});
