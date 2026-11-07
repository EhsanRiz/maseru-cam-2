// End-to-end check against a running Worker (wrangler dev). Usage: node test/e2e.mjs http://localhost:8787
import assert from 'node:assert/strict';
const BASE = process.argv[2] || 'http://localhost:8787';
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: await r.json() };
};
const PATH = [
  [-29.3025, 27.4630, 0], [-29.3015, 27.4610, 20], [-29.2992, 27.4562, 40], [-29.2992, 27.4562, 46],
  [-29.2980, 27.4546, 50], [-29.2968, 27.4530, 53], [-29.2968, 27.4530, 60], [-29.2945, 27.4495, 62],
];
async function crossing({ minAgo, historyKey, mode = 'vehicle', reverse = false }) {
  const t = await call('POST', '/trips', { mode, history_key: historyKey });
  assert.equal(t.status, 200);
  const { trip_id: id, trip_key: key } = t.j;
  const start = Date.now() - minAgo * 60000;
  const path = reverse ? PATH.map(([a, b, m]) => [a, b, 62 - m]).reverse() : PATH;
  const pings = path.map(([lat, lng, m]) => ({ lat, lng, t: start + m * 60000, acc: 10 }));
  pings.push({ lat: -29.40, lng: 27.60, t: start + 60000, acc: 10 });   // outside area
  const p = await call('POST', `/trips/${id}/pings`, { pings }, { 'X-Trip-Key': key });
  assert.equal(p.j.accepted, path.length, 'outside-area ping must be dropped');
  assert.equal((await call('POST', `/trips/${id}/pings`, { pings }, { 'X-Trip-Key': 'wrong' })).status, 401);
  const e = await call('POST', `/trips/${id}/end`, {}, { 'X-Trip-Key': key });
  const again = (await call('POST', `/trips/${id}/end`, {}, { 'X-Trip-Key': key })).j.result;
  assert.equal(again.saved_to_history, undefined, 'ending twice must not save twice');
  return { saving: t.j.saving_to_history, result: e.j.result };
}

// Anonymous crossings feed the estimate
for (const m of [70, 80, 75]) {
  const c = await crossing({ minAgo: m });
  assert.equal(c.result.status, 'completed'); assert.equal(c.result.total_minutes, 60); assert.equal(c.saving, false);
}

// Journey history: register, cross, list
const reg = await call('POST', '/history/register', { retention_days: 7 });
assert.equal(reg.j.retention_days, 7);
const hk = { 'X-History-Key': reg.j.history_key };
const mine = await crossing({ minAgo: 70, historyKey: reg.j.history_key, mode: 'pedestrian', reverse: true });
assert.equal(mine.saving, true); assert.equal(mine.result.saved_to_history, true);
assert.equal(mine.result.direction, 'SA_to_LS');
let h = await call('GET', '/history', null, hk);
assert.equal(h.j.journeys.length, 1);
const j0 = h.j.journeys[0];
assert.equal(j0.mode, 'pedestrian');
const days = (Date.parse(j0.expires_at) - Date.parse(j0.crossing_ended_at)) / 86400000;
assert.equal(Math.round(days), 7);

// Change retention to 90 days: expiry re-dated
assert.equal((await call('PUT', '/history/settings', { retention_days: 45 }, hk)).status, 400);
await call('PUT', '/history/settings', { retention_days: 90 }, hk);
h = await call('GET', '/history', null, hk);
assert.equal(h.j.retention_days, 90);
assert.equal(Math.round((Date.parse(h.j.journeys[0].expires_at) - Date.parse(h.j.journeys[0].crossing_ended_at)) / 86400000), 90);

// Wrong key, delete one, delete all
assert.equal((await call('GET', '/history', null, { 'X-History-Key': 'x'.repeat(32) })).status, 401);
await call('DELETE', '/history/journeys/' + j0.id, null, hk);
assert.equal((await call('GET', '/history', null, hk)).j.journeys.length, 0);
await call('DELETE', '/history', null, hk);
assert.equal((await call('GET', '/history', null, hk)).status, 401);

// Window reports
assert.equal((await call('POST', '/window-report', { direction: 'SA_to_LS', post: 'sa_departure', windows_open: 2, queue_minutes: 25 })).status, 200);
assert.equal((await call('POST', '/window-report', { direction: 'SA_to_LS', post: 'bogus' })).status, 400);

const est = (await call('GET', '/estimate')).j;
const ls = est.directions.find((d) => d.direction === 'LS_to_SA');
assert.equal(ls.source, 'measured'); assert.equal(ls.minutes, 60);
console.log(JSON.stringify(est.directions));
console.log('E2E OK');
