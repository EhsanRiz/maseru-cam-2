import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeTrip, buildEstimate, zoneFor, inArea, median } from '../src/core.js';

const zones = JSON.parse(readFileSync(new URL('../src/zones.json', import.meta.url)));
const T0 = Date.parse('2026-11-07T08:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const LS_TO_SA = [
  [-29.3025, 27.4630, 0], [-29.3015, 27.4610, 20], [-29.2992, 27.4562, 40], [-29.2992, 27.4562, 46],
  [-29.2980, 27.4546, 50], [-29.2968, 27.4530, 53], [-29.2968, 27.4530, 60], [-29.2945, 27.4495, 62],
];
const pings = (path) => path.map(([lat, lng, m]) => ({ lat, lng, ts: at(m), accuracy_m: 10 }));

test('zone matching prefers posts over overlapping queues', () => {
  assert.equal(zoneFor(zones, -29.2992, 27.4562).id, 'ls_post');
  assert.equal(zoneFor(zones, -29.3025, 27.4630).id, 'ls_queue');
  assert.equal(inArea(zones, -29.40, 27.60), false);
});

test('LS to SA crossing gives direction and segment times', () => {
  const r = analyzeTrip(zones, pings(LS_TO_SA));
  assert.equal(r.status, 'completed');
  assert.equal(r.direction, 'LS_to_SA');
  assert.equal(r.total_minutes, 60);
  assert.equal(r.queue_minutes, 40);
  assert.equal(r.origin_post_minutes, 6);
  assert.equal(r.bridge_minutes, 7);
  assert.equal(r.dest_post_minutes, 7);
});

test('SA to LS crossing is detected', () => {
  const rev = LS_TO_SA.map(([a, b, m]) => [a, b, 62 - m]).reverse();
  const r = analyzeTrip(zones, pings(rev));
  assert.equal(r.status, 'completed');
  assert.equal(r.direction, 'SA_to_LS');
});

test('a phone that never reaches the other side is abandoned', () => {
  const r = analyzeTrip(zones, pings(LS_TO_SA.slice(0, 3)));
  assert.equal(r.status, 'abandoned');
});

test('inaccurate fixes are ignored', () => {
  const p = pings(LS_TO_SA).map((x) => ({ ...x, accuracy_m: 500 }));
  assert.equal(analyzeTrip(zones, p).status, 'abandoned');
});

test('estimate prefers measured trips, then falls back', () => {
  const now = T0 + 120 * 60000;
  const done = (min, total) => ({ direction: 'LS_to_SA', crossing_ended_at: at(min), total_minutes: total });
  const base = { now, active: [], windowReports: [], typical: [] };
  const m = buildEstimate({ ...base, direction: 'LS_to_SA', completed: [done(100, 50), done(110, 60), done(115, 70)] });
  assert.deepEqual([m.source, m.minutes, m.sample], ['measured', 60, 3]);
  const e = buildEstimate({ ...base, direction: 'LS_to_SA', completed: [done(100, 50)] });
  assert.equal(e.source, 'early');
  const rep = buildEstimate({ ...base, direction: 'SA_to_LS', completed: [], windowReports: [{ direction: 'SA_to_LS', queue_minutes: 25 }] });
  assert.deepEqual([rep.source, rep.minutes], ['reported', 25]);
  const none = buildEstimate({ ...base, direction: 'SA_to_LS', completed: [] });
  assert.equal(none.source, 'none');
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});
