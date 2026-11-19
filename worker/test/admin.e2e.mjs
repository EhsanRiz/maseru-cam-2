// Admin tools end-to-end against wrangler dev, with .dev.vars containing
// DEV_SHOW_PIN=true, ADMIN_EMAILS=boss@example.com, MANAGER_EMAILS=mgr@example.com.
// Usage: node test/admin.e2e.mjs http://localhost:8787  (fresh local database)
import assert from 'node:assert/strict';
const BASE = process.argv[2] || 'http://localhost:8787';
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})), r };
};
async function signIn(email) {
  const s = await call('POST', '/auth/start', { email });
  const l = await call('POST', '/auth/login', { email, pin: s.j.dev_pin });
  assert.equal(l.status, 200, 'sign in ' + email);
  return { auth: { Authorization: 'Bearer ' + l.j.token }, user: l.j.user };
}

const owner = await signIn('boss@example.com');
const mgr = await signIn('mgr@example.com');
const plain = await signIn('traveller@example.com');
const other = await signIn('other@example.com');
assert.equal(owner.user.admin_role, 'owner');
assert.equal(mgr.user.admin_role, 'manager');
assert.equal(plain.user.admin_role, null);

// Access
assert.equal((await call('GET', '/admin/stats', null, plain.auth)).status, 403);
for (const who of [owner, mgr]) {
  const st = await call('GET', '/admin/stats', null, who.auth);
  assert.equal(st.status, 200); assert.ok(st.j.live && Array.isArray(st.j.live.active_by_zone));
  assert.equal((await call('GET', '/admin/crossings?show=all', null, who.auth)).status, 200);
  const zm = await call('GET', '/admin/zonemap', null, who.auth);
  assert.equal(zm.status, 200); assert.ok(Array.isArray(zm.j.cells));
}
// CSV and log: owner only
assert.equal((await fetch(BASE + '/api/admin/users.csv', { headers: owner.auth })).status, 200);
assert.equal((await fetch(BASE + '/api/admin/users.csv', { headers: mgr.auth })).status, 403);
assert.equal((await call('GET', '/admin/log', null, mgr.auth)).status, 403);

// Users list carries ids and staff roles
const list = (await call('GET', '/admin/users', null, mgr.auth)).j.users;
const byEmail = Object.fromEntries(list.map((u) => [u.email, u]));
assert.equal(byEmail['boss@example.com'].staff_role, 'owner');
assert.equal(byEmail['traveller@example.com'].staff_role, null);
assert.ok(byEmail['traveller@example.com'].id);

// Announcement: set by manager, visible to everyone, cleared
let a = await call('PUT', '/admin/announcement', { text: '  Bridge   closed tonight  ', level: 'warning' }, mgr.auth);
assert.equal(a.status, 200); assert.equal(a.j.announcement.text, 'Bridge closed tonight');
assert.equal((await call('PUT', '/admin/announcement', { text: 'x' }, plain.auth)).status, 403);
let est = await call('GET', '/estimate');
assert.equal(est.j.announcement.text, 'Bridge closed tonight'); assert.equal(est.j.announcement.level, 'warning');
await call('DELETE', '/admin/announcement', null, owner.auth);
est = await call('GET', '/estimate');
assert.equal(est.j.announcement, null);

// New PIN: old sessions end, new PIN works
const pin = await call('POST', `/admin/users/${byEmail['traveller@example.com'].id}/pin`, null, mgr.auth);
assert.equal(pin.status, 200); assert.ok(pin.j.dev_pin);
assert.equal((await call('GET', '/me', null, plain.auth)).status, 401, 'old session signed out');
assert.equal((await call('POST', '/auth/login', { email: 'traveller@example.com', pin: pin.j.dev_pin })).status, 200);

// Protections: not yourself; manager cannot touch staff; owner can
assert.equal((await call('DELETE', `/admin/users/${mgr.user.id}`, null, mgr.auth)).status, 400);
assert.equal((await call('DELETE', `/admin/users/${owner.user.id}`, null, mgr.auth)).status, 403);
assert.equal((await call('POST', `/admin/users/${owner.user.id}/pin`, null, mgr.auth)).status, 403);
assert.equal((await call('DELETE', `/admin/users/00000000-0000-0000-0000-000000000000`, null, owner.auth)).status, 404);

// Delete an account
assert.equal((await call('DELETE', `/admin/users/${other.user.id}`, null, mgr.auth)).status, 200);
assert.equal((await call('GET', '/me', null, other.auth)).status, 401);
const after = (await call('GET', '/admin/users?q=other@', null, owner.auth)).j;
assert.equal(after.total, 0);

// Owner sees the log of what the manager did
const log = (await call('GET', '/admin/log', null, owner.auth)).j.actions.map((x) => x.action);
for (const act of ['announcement_set', 'announcement_cleared', 'pin_sent', 'account_deleted']) assert.ok(log.includes(act), act);
assert.ok((await call('GET', '/admin/log', null, owner.auth)).j.actions.some((x) => x.actor === 'mgr@example.com'));
console.log('ADMIN E2E OK');
