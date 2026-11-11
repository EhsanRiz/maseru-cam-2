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

// ---------------- Accounts (needs DEV_SHOW_PIN=true in .dev.vars) ----------------
const email = `test${Date.now()}@example.com`;
let s = await call('POST', '/auth/start', { email });
assert.equal(s.j.pin_sent, true); assert.match(s.j.dev_pin, /^\d{6}$/);
const pin1 = s.j.dev_pin;
assert.equal((await call('POST', '/auth/login', { email, pin: '000000' === pin1 ? '111111' : '000000' })).status, 401);
let login = await call('POST', '/auth/login', { email, pin: pin1 });
assert.equal(login.status, 200);
const auth = { Authorization: 'Bearer ' + login.j.token };
assert.equal(login.j.user.email, email);
assert.ok(Date.parse(login.j.expires_at) - Date.now() > 6.9 * 86400000, 'session lasts 7 days');
// second start does not send a new PIN
s = await call('POST', '/auth/start', { email });
assert.equal(s.j.pin_sent, false);

// profile + prefs
let me = await call('PUT', '/me', { name: 'Test User', phone: '+266 5012 3456', prefs: { default_mode: 'pedestrian', theme: 'dark' } }, auth);
assert.equal(me.j.user.name, 'Test User'); assert.equal(me.j.user.prefs.theme, 'dark'); assert.equal(me.j.user.prefs.save_journeys, true);
assert.equal((await call('PUT', '/me', { phone: 'abc' }, auth)).status, 400);

// saved crossing with route
const t = await call('POST', '/trips', { mode: 'vehicle', save: true }, auth);
const start = Date.now() - 70 * 60000;
await call('POST', `/trips/${t.j.trip_id}/pings`, { pings: PATH.map(([lat, lng, m]) => ({ lat, lng, t: start + m * 60000, acc: 10 })) }, { 'X-Trip-Key': t.j.trip_key });
const end = await call('POST', `/trips/${t.j.trip_id}/end`, {}, { 'X-Trip-Key': t.j.trip_key });
assert.equal(end.j.result.saved_to_history, true);
const hist = await call('GET', '/history', null, auth);
assert.equal(hist.j.journeys.length, 1); assert.equal(hist.j.journeys[0].has_route, 1);
const jd = await call('GET', '/history/journeys/' + hist.j.journeys[0].id, null, auth);
assert.ok(jd.j.journey.route.length >= 5, 'route saved'); assert.deepEqual(jd.j.journey.route[0].slice(2), [0]);
assert.equal((await call('GET', '/history/journeys/' + hist.j.journeys[0].id)).status, 401, 'not visible without sign-in');

// change PIN, forgot PIN, lockout
assert.equal((await call('PUT', '/me/pin', { current_pin: '999999' === pin1 ? '888888' : '999999', new_pin: '123456' }, auth)).status, 401);
assert.equal((await call('PUT', '/me/pin', { current_pin: pin1, new_pin: '123456' }, auth)).status, 200);
assert.equal((await call('POST', '/auth/login', { email, pin: '123456' })).status, 200);
const f = await call('POST', '/auth/forgot', { email });
assert.equal(f.j.pin_sent, true);
assert.equal((await call('GET', '/me', null, auth)).status, 401, 'reset signs out other devices');
for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { email, pin: f.j.dev_pin === '000001' ? '000002' : '000001' });
assert.equal((await call('POST', '/auth/login', { email, pin: f.j.dev_pin })).status, 429, 'locked after 5 wrong PINs');

// new session via fresh account for export/delete
const email2 = `del${Date.now()}@example.com`;
const s2 = await call('POST', '/auth/start', { email: email2 });
const l2 = await call('POST', '/auth/login', { email: email2, pin: s2.j.dev_pin });
const a2 = { Authorization: 'Bearer ' + l2.j.token };
const ex = await fetch(BASE + '/api/me/export', { headers: a2 });
assert.equal(ex.status, 200); assert.equal((await ex.json()).account.email, email2);
assert.equal((await call('DELETE', '/me', null, a2)).status, 200);
assert.equal((await call('GET', '/me', null, a2)).status, 401);
assert.equal((await call('POST', '/auth/start', { email: 'not-an-email' })).status, 400);
console.log('AUTH E2E OK');

// ---------------- Parked car vs moving queue ----------------
{
  const base = Date.now() - 150 * 60000;               // 150 min ago
  const tAt = (m) => base + m * 60000;
  // two other phones moving forward in the LS queue during the parked spell
  for (const [la0, lo0, la1, lo1] of [[-29.3035, 27.4650, -29.3005, 27.4590], [-29.3040, 27.4660, -29.3012, 27.4605]]) {
    const o = await call('POST', '/trips', { mode: 'vehicle' });
    await call('POST', `/trips/${o.j.trip_id}/pings`, { pings: [
      { lat: la0, lng: lo0, t: tAt(5), acc: 8 }, { lat: la1, lng: lo1, t: tAt(50), acc: 8 }] }, { 'X-Trip-Key': o.j.trip_key });
  }
  const P = [
    [-29.3030, 27.4640, 0], [-29.3030, 27.4640, 20], [-29.3030, 27.4640, 40], [-29.3030, 27.4640, 60],
    [-29.3020, 27.4620, 70], [-29.3010, 27.4600, 80],
    [-29.2992, 27.4562, 85], [-29.2980, 27.4546, 92], [-29.2968, 27.4530, 95], [-29.2968, 27.4530, 100],
  ];
  const pk = await call('POST', '/trips', { mode: 'vehicle' });
  await call('POST', `/trips/${pk.j.trip_id}/pings`, { pings: P.map(([lat, lng, m]) => ({ lat, lng, t: tAt(m), acc: 8 })) }, { 'X-Trip-Key': pk.j.trip_key });
  const res = (await call('POST', `/trips/${pk.j.trip_id}/end`, {}, { 'X-Trip-Key': pk.j.trip_key })).j.result;
  assert.equal(res.status, 'completed');
  assert.equal(res.total_minutes, 40, 'parked hour removed');
  assert.equal(res.parked_minutes, 60);
  assert.deepEqual(res.flags, ['parked_trimmed']);

  // incomplete: never reaches the SA post -> not counted
  const ic = await call('POST', '/trips', { mode: 'vehicle' });
  await call('POST', `/trips/${ic.j.trip_id}/pings`, { pings: [[-29.3025, 27.4630, 0], [-29.2992, 27.4562, 40], [-29.2945, 27.4495, 62]]
    .map(([lat, lng, m]) => ({ lat, lng, t: tAt(m), acc: 8 })) }, { 'X-Trip-Key': ic.j.trip_key });
  const icr = (await call('POST', `/trips/${ic.j.trip_id}/end`, {}, { 'X-Trip-Key': ic.j.trip_key })).j.result;
  assert.equal(icr.status, 'abandoned'); assert.deepEqual(icr.flags, ['missed_dest_post']);
  console.log('PARKED E2E OK');
}
