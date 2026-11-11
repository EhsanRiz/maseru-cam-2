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

test('simplifyRoute drops jitter, keeps ends and caps size', async () => {
  const { simplifyRoute } = await import('../src/core.js');
  const t = Date.parse('2026-11-07T08:00:00Z');
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push({ lat: -29.30 + i * 0.0001, lng: 27.45, t: t + i * 1000 });
  pts.splice(1, 0, { lat: -29.30, lng: 27.45, t: t + 500 });           // jitter next to the first point
  const r = simplifyRoute(pts, { maxPoints: 100 });
  assert.equal(r.length, 100);
  assert.deepEqual(r[0], [-29.3, 27.45, 0]);
  assert.equal(r[r.length - 1][2], 999);
  assert.deepEqual(simplifyRoute([]), []);
});

test('forecast picks the quietest upcoming hour and blends in live data', async () => {
  const { buildForecast } = await import('../src/core.js');
  // "now" = Wednesday 06:10 local (04:10 UTC). Build history: 07:00 local busy (90 min), 09:00 local quiet (20 min).
  const now = Date.parse('2026-11-11T04:10:00Z');
  const completed = [];
  for (let w = 1; w <= 4; w++) {
    const day = now - w * 7 * 86400000;
    const at = (localHour, total) => ({
      direction: 'LS_to_SA', total_minutes: total,
      crossing_ended_at: new Date(Math.floor(day / 3600000) * 3600000 + (localHour - 6) * 3600000 + total * 60000 + 600000).toISOString(),
    });
    completed.push(at(7, 90), at(9, 20));
  }
  const f = buildForecast({ direction: 'LS_to_SA', now, completed, live: null, hours: 6 });
  assert.equal(f.hours.length, 6);
  assert.equal(f.hours[0].local_hour, 6);
  assert.equal(f.hours[1].minutes, 90); assert.equal(f.hours[1].confidence, 'medium');
  assert.equal(f.hours[3].minutes, 20);
  assert.equal(f.best, 3, 'best is 09:00 local');
  assert.equal(f.based_on, 8);
  // live 120 min dominates the current hour
  const g = buildForecast({ direction: 'LS_to_SA', now, completed, live: { source: 'measured', minutes: 120 }, hours: 6 });
  assert.equal(g.hours[0].minutes, 120);
  assert.ok(g.hours[1].minutes > 90 && g.hours[1].minutes < 120);
  // no data at all
  const e = buildForecast({ direction: 'SA_to_LS', now, completed: [], live: null, hours: 3 });
  assert.equal(e.best, -1); assert.equal(e.hours[0].minutes, null);
});

test('only crossings that reach both border posts count', async () => {
  const { analyzeTrip } = await import('../src/core.js');
  // Lesotho queue -> LS post -> bridge -> SA queue (skips the SA post zone)
  const noDestPost = [[-29.3025, 27.4630, 0], [-29.2992, 27.4562, 40], [-29.2980, 27.4546, 50], [-29.2945, 27.4495, 62]];
  const r = analyzeTrip(zones, pings(noDestPost));
  assert.equal(r.status, 'abandoned'); assert.deepEqual(r.flags, ['missed_dest_post']);
  // Lesotho queue -> SA side without the LS post
  const noOriginPost = [[-29.3025, 27.4630, 0], [-29.2968, 27.4530, 53], [-29.2945, 27.4495, 62]];
  assert.deepEqual(analyzeTrip(zones, pings(noOriginPost)).flags, ['missed_origin_post']);
});

test('a long stop in the queue is detected and can be trimmed', async () => {
  const { analyzeTrip, findParkedSpell, crowdProgressed } = await import('../src/core.js');
  // Parked 60 min in the LS queue zone (no movement), then queues 20 min, then crosses.
  const path = [
    [-29.3030, 27.4640, 0], [-29.3030, 27.4640, 20], [-29.3030, 27.4640, 40], [-29.3030, 27.4640, 60],
    [-29.3020, 27.4620, 70], [-29.3010, 27.4600, 80],
    [-29.2992, 27.4562, 85], [-29.2980, 27.4546, 92], [-29.2968, 27.4530, 95], [-29.2968, 27.4530, 100],
  ];
  const r = analyzeTrip(zones, pings(path));
  assert.equal(r.status, 'completed'); assert.equal(r.total_minutes, 100);
  assert.ok(r.parked_spell, 'parked spell found');
  assert.equal(r.parked_spell.to - r.parked_spell.from, 60 * 60000);
  // Other phones moved forward meanwhile -> parking; restart the clock after the spell.
  const others = [
    { trip_id: 'a', ts: at(5), lat: -29.3035, lng: 27.4650 }, { trip_id: 'a', ts: at(50), lat: -29.3005, lng: 27.4590 },
    { trip_id: 'b', ts: at(10), lat: -29.3040, lng: 27.4660 }, { trip_id: 'b', ts: at(55), lat: -29.3012, lng: 27.4605 },
  ];
  assert.equal(crowdProgressed(others, zones.zones.find((z) => z.id === 'ls_post')), true);
  assert.equal(crowdProgressed(others.slice(0, 2), zones.zones.find((z) => z.id === 'ls_post')), false, 'one phone is not enough');
  const t = analyzeTrip(zones, pings(path), { startAfter: r.parked_spell.to });
  assert.equal(t.total_minutes, 40); assert.deepEqual(t.flags, ['parked_trimmed']);
  // A normal slow-moving queue is not flagged.
  assert.equal(analyzeTrip(zones, pings(LS_TO_SA)).parked_spell, undefined);
  assert.equal(findParkedSpell([], { lat: 0, lng: 0 }), null);
});

test('outliers are dropped before taking the median', async () => {
  const { withoutOutliers, buildEstimate } = await import('../src/core.js');
  assert.deepEqual(withoutOutliers([30, 35, 40, 400]), [30, 35, 40]);
  assert.deepEqual(withoutOutliers([30, 400]), [30, 400], 'too few to judge');
  const now = T0 + 120 * 60000;
  const done = (total) => ({ direction: 'LS_to_SA', crossing_ended_at: at(110), total_minutes: total });
  const e = buildEstimate({ direction: 'LS_to_SA', now, completed: [done(30), done(35), done(40), done(300)], active: [], windowReports: [], typical: [] });
  assert.equal(e.minutes, 35);
});
