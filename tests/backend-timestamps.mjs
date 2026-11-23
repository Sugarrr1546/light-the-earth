import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVisitTimestamps, ValidationError } from '../lib/validation.ts';

const now = '2026-10-23T04:00:00.000Z';

test('import timestamps are normalized across timezones before comparison', () => {
  assert.deepEqual(validateVisitTimestamps({ createdAt: '2020-02-29T09:00:00+08:00', updatedAt: '2020-02-29T02:00:00Z' }, now), {
    createdAt: '2020-02-29T01:00:00.000Z', updatedAt: '2020-02-29T02:00:00.000Z',
  });
  assert.throws(() => validateVisitTimestamps({ createdAt: '2020-02-29T09:00:00-08:00', updatedAt: '2020-02-29T02:00:00Z' }, now), ValidationError);
});

test('absent timestamp fields independently use the same server clock', () => {
  assert.deepEqual(validateVisitTimestamps({}, now), { createdAt: now, updatedAt: now });
  assert.deepEqual(validateVisitTimestamps({ createdAt: '2018-01-01T00:00:00Z' }, now), {
    createdAt: '2018-01-01T00:00:00.000Z', updatedAt: now,
  });
  assert.throws(() => validateVisitTimestamps({ updatedAt: '2018-01-01T00:00:00Z' }, now), ValidationError);
});

test('invalid calendar dates and incomplete timestamps are rejected', () => {
  for (const value of [null, 123, '', '2019-02-29T00:00:00Z', '2020-04-31T00:00:00Z',
    '2020-01-01', '2020-01-01T01:00:00', '2020-01-01T25:00:00Z', '2020-01-01T00:00:00+99:00']) {
    assert.throws(() => validateVisitTimestamps({ createdAt: value }, now), ValidationError);
  }
});

test('timestamp order compares instants when an offset crosses a calendar-year boundary', () => {
  assert.throws(() => validateVisitTimestamps({
    createdAt: '9999-12-31T23:30:00-01:00', updatedAt: '9999-12-31T23:45:00Z',
  }, now), ValidationError);
});
