// Admin: usage statistics, accounts, crossings and site settings, for 4DCS
// staff only.
//
// Access: a normal signed-in session whose email is listed in ADMIN_EMAILS
// (role 'owner') or MANAGER_EMAILS (role 'manager'). Both are comma-separated
// Worker secrets, so they are not in the repository. Managers can do
// everything except download the full user list (CSV) and read the staff
// action log. Staff see accounts, anonymous crossings and aggregate numbers;
// they never see anyone's saved routes, and the zone map only shows spots
// that at least two different phones passed through.

import { getSessionUser, adminRole, roleForEmail, issuePin, deleteUserData } from './auth.js';

const DAY_MS = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, message) => json({ success: false, message }, status);
const body = async (request) => { try { return await request.json(); } catch { return {}; } };

async function logAction(env, actor, action, detail) {
  await env.DB.prepare('INSERT INTO admin_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .bind(iso(Date.now()), actor.email, action, detail == null ? null : String(detail).slice(0, 300)).run();
}


async function stats(env) {
  const now = Date.now();
  const d1 = iso(now - DAY_MS), d7 = iso(now - 7 * DAY_MS), d30 = iso(now - 30 * DAY_MS), d14 = iso(now - 14 * DAY_MS);
  const one = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();
  const [users, new7, new30, login1, login7, sessions, crossings, crossings7, reports7, live, journeys] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM users'),
    one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', d7),
    one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', d30),
    one('SELECT COUNT(*) AS n FROM users WHERE last_login_at >= ?', d1),
    one('SELECT COUNT(*) AS n FROM users WHERE last_login_at >= ?', d7),
    one('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ?', iso(now)),
    one("SELECT COUNT(*) AS n FROM trips WHERE status = 'completed'"),
    one("SELECT COUNT(*) AS n FROM trips WHERE status = 'completed' AND crossing_ended_at >= ?", d7),
    one('SELECT COUNT(*) AS n FROM window_reports WHERE reported_at >= ?', d7),
    one("SELECT COUNT(*) AS n FROM trips WHERE status = 'active' AND last_ping_at >= ?", iso(now - 5 * 60000)),
    one('SELECT COUNT(*) AS n FROM journeys WHERE expires_at > ?', iso(now)),
  ]);
  // Live status: last finished crossing per direction, phones in the area by zone.
  const { results: lastByDir } = await env.DB.prepare(
    `SELECT direction, MAX(crossing_ended_at) AS last_at FROM trips WHERE status = 'completed' GROUP BY direction`,
  ).all();
  const { results: activeZones } = await env.DB.prepare(
    `SELECT coalesce(current_zone, 'outside') AS zone, COUNT(*) AS n FROM trips
     WHERE status = 'active' AND last_ping_at >= ? GROUP BY zone`,
  ).bind(iso(now - 5 * 60000)).all();
  const quality = await one(
    `SELECT SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS counted,
            SUM(CASE WHEN status IN ('abandoned', 'invalid') THEN 1 ELSE 0 END) AS not_counted,
            SUM(CASE WHEN flags LIKE '%parked_trimmed%' THEN 1 ELSE 0 END) AS parked_trimmed,
            SUM(CASE WHEN flags LIKE '%long_stop_unverified%' THEN 1 ELSE 0 END) AS long_stop
     FROM trips WHERE finalised_at >= ?`, d7);
  const { results: byDir } = await env.DB.prepare(
    `SELECT direction, COUNT(*) AS n, ROUND(AVG(total_minutes)) AS avg_minutes
     FROM trips WHERE status = 'completed' AND crossing_ended_at >= ? GROUP BY direction`,
  ).bind(d30).all();
  // Daily counts for the last 14 days (Lesotho/SA time, UTC+2).
  const { results: signups } = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', created_at, '+2 hours') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day`,
  ).bind(d14).all();
  const { results: daily } = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', crossing_ended_at, '+2 hours') AS day, COUNT(*) AS n FROM trips
     WHERE status = 'completed' AND crossing_ended_at >= ? GROUP BY day`,
  ).bind(d14).all();
  const { results: logins } = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', created_at, '+2 hours') AS day, COUNT(*) AS n FROM sessions WHERE created_at >= ? GROUP BY day`,
  ).bind(d14).all();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = iso(now + 2 * 3600 * 1000 - i * DAY_MS).slice(0, 10);
    const pick = (rows) => (rows.find((r) => r.day === day) || { n: 0 }).n;
    days.push({ day, signups: pick(signups), sign_ins: pick(logins), crossings: pick(daily) });
  }
  return json({
    success: true,
    generated_at: iso(now),
    users: { total: users.n, new_7d: new7.n, new_30d: new30.n, signed_in_24h: login1.n, signed_in_7d: login7.n, with_active_session: sessions.n },
    crossings: { total: crossings.n, last_7d: crossings7.n, live_now: live.n, saved_journeys: journeys.n, by_direction_30d: byDir },
    reports_7d: reports7.n,
    live: { last_crossing: lastByDir, active_by_zone: activeZones },
    quality_7d: {
      counted: quality.counted || 0, not_counted: quality.not_counted || 0,
      parked_trimmed: quality.parked_trimmed || 0, long_stop: quality.long_stop || 0,
    },
    days,
  });
}

async function listUsers(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const per = 50;
  // Optional filters behind the dashboard tiles.
  const filter = url.searchParams.get('filter') || '';
  const conds = [], args = [];
  if (q) {
    conds.push("(lower(u.email) LIKE ? OR lower(coalesce(u.name, '')) LIKE ? OR coalesce(u.phone, '') LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (filter === 'active7') { conds.push('u.last_login_at >= ?'); args.push(iso(Date.now() - 7 * DAY_MS)); }
  if (filter === 'new7') { conds.push('u.created_at >= ?'); args.push(iso(Date.now() - 7 * DAY_MS)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const now = iso(Date.now());
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...args).first()).n;
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.phone, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM journeys j WHERE j.history_hash = u.history_hash AND j.expires_at > ?) AS journeys,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
     FROM users u ${where}
     ORDER BY coalesce(u.last_login_at, u.created_at) DESC LIMIT ? OFFSET ?`,
  ).bind(now, now, ...args, per, (page - 1) * per).all();
  for (const u of results) u.staff_role = roleForEmail(env, u.email);
  return json({ success: true, total, page, per_page: per, users: results });
}

// Latest window reports (anonymous: no account or trip is linked to them).
async function listReports(env) {
  const { results } = await env.DB.prepare(
    `SELECT reported_at, direction, post, mode, windows_open, people_ahead, queue_minutes, minutes_at_window
     FROM window_reports ORDER BY reported_at DESC LIMIT 50`,
  ).all();
  return json({ success: true, reports: results });
}

// Recent finished trips (anonymous): what was counted and why not.
async function listCrossings(request, env) {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const show = url.searchParams.get('show') || 'all';
  const per = 30;
  const where = show === 'counted' ? "status = 'completed'"
    : show === 'not' ? "status IN ('abandoned', 'invalid')"
      : "status IN ('completed', 'abandoned', 'invalid')";
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM trips WHERE ${where}`).first()).n;
  const { results } = await env.DB.prepare(
    `SELECT substr(id, 1, 6) AS ref, status, direction, mode, flags, parked_minutes,
            started_at, crossing_started_at, crossing_ended_at, finalised_at, total_minutes,
            queue_minutes, origin_post_minutes, bridge_minutes, dest_post_minutes, ping_count
     FROM trips WHERE ${where} ORDER BY coalesce(finalised_at, started_at) DESC LIMIT ? OFFSET ?`,
  ).bind(per, (page - 1) * per).all();
  return json({ success: true, total, page, per_page: per, crossings: results });
}

// Where phones were in the last 48 h, as ~30 m squares. A square is shown only
// if at least two different phones passed through it, so no single person's
// path can be traced.
const CELL = 0.0003;
async function zoneMap(env) {
  const { results } = await env.DB.prepare(
    `SELECT CAST(ROUND(lat / ${CELL}) AS INTEGER) AS gy, CAST(ROUND(lng / ${CELL}) AS INTEGER) AS gx,
            COUNT(*) AS points, COUNT(DISTINCT trip_id) AS phones,
            SUM(CASE WHEN speed_mps IS NOT NULL AND speed_mps < 1 THEN 1 ELSE 0 END) AS slow
     FROM pings WHERE ts >= ? GROUP BY gy, gx HAVING phones >= 2`,
  ).bind(iso(Date.now() - 48 * 3600 * 1000)).all();
  const phones = (await env.DB.prepare('SELECT COUNT(DISTINCT trip_id) AS n FROM pings WHERE ts >= ?')
    .bind(iso(Date.now() - 48 * 3600 * 1000)).first()).n;
  return json({
    success: true, cell_deg: CELL, phones_48h: phones,
    cells: results.map((c) => ({ lat: +(c.gy * CELL).toFixed(5), lng: +(c.gx * CELL).toFixed(5), points: c.points, phones: c.phones, slow: c.slow })),
  });
}

// Site-wide announcement shown at the top of the Dashboard.
async function setAnnouncement(request, env, user) {
  const b = await body(request);
  const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const level = b.level === 'warning' ? 'warning' : 'info';
  if (!text) return clearAnnouncement(env, user);
  const value = JSON.stringify({ text, level });
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('announcement', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(value, iso(Date.now()), user.email).run();
  await logAction(env, user, 'announcement_set', text);
  return json({ success: true, announcement: { text, level } });
}
async function clearAnnouncement(env, user) {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'announcement'").run();
  await logAction(env, user, 'announcement_cleared');
  return json({ success: true, announcement: null });
}

// Account actions. Nobody can act on their own account here (use Settings),
// and managers cannot act on staff accounts.
async function targetUser(env, actor, id) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!u) return [null, fail(404, 'Account not found.')];
  if (u.id === actor.id) return [null, fail(400, 'Use Settings to change your own account.')];
  if (adminRole(env, actor) !== 'owner' && roleForEmail(env, u.email)) {
    return [null, fail(403, 'Only an owner can change staff accounts.')];
  }
  return [u, null];
}
async function adminDeleteUser(env, actor, id) {
  const [u, err] = await targetUser(env, actor, id);
  if (err) return err;
  await deleteUserData(env, u);
  await logAction(env, actor, 'account_deleted', u.id);
  return json({ success: true, message: 'Account deleted.' });
}
async function adminNewPin(env, actor, id) {
  const [u, err] = await targetUser(env, actor, id);
  if (err) return err;
  try {
    const extra = await issuePin(env, u, 'reset');
    await logAction(env, actor, 'pin_sent', u.id);
    return json({ success: true, message: `A new PIN was emailed to ${u.email}.`, ...extra });
  } catch (e) {
    return fail(e.status || 500, e.message);
  }
}

async function actionLog(env) {
  const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM admin_log ORDER BY id DESC LIMIT 50').all();
  return json({ success: true, actions: results });
}

async function exportUsersCsv(env) {
  const { results } = await env.DB.prepare(
    'SELECT email, name, phone, created_at, last_login_at FROM users ORDER BY created_at',
  ).all();
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    // Quote every cell; neutralise spreadsheet formula injection.
    return '"' + (/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
  };
  const csv = ['email,name,phone,created_at,last_login_at', ...results.map((r) =>
    [r.email, r.name, r.phone, r.created_at, r.last_login_at].map(cell).join(','))].join('\n');
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="tsela-users-${iso(Date.now()).slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

// Returns a Response for /api/admin/*, or null for other paths.
export async function adminRoutes(request, env, p, m) {
  if (!p.startsWith('/api/admin')) return null;
  const user = await getSessionUser(request, env);
  if (!user) return fail(401, 'Please sign in.');
  const role = adminRole(env, user);
  if (!role) return fail(403, 'This page is for 4DCS staff only.');
  const ownerOnly = () => fail(403, 'Only an owner can do this.');
  if (p === '/api/admin/stats' && m === 'GET') return stats(env);
  if (p === '/api/admin/users' && m === 'GET') return listUsers(request, env);
  if (p === '/api/admin/users.csv' && m === 'GET') return role === 'owner' ? exportUsersCsv(env) : ownerOnly();
  if (p === '/api/admin/reports' && m === 'GET') return listReports(env);
  if (p === '/api/admin/crossings' && m === 'GET') return listCrossings(request, env);
  if (p === '/api/admin/zonemap' && m === 'GET') return zoneMap(env);
  if (p === '/api/admin/announcement' && m === 'PUT') return setAnnouncement(request, env, user);
  if (p === '/api/admin/announcement' && m === 'DELETE') return clearAnnouncement(env, user);
  if (p === '/api/admin/log' && m === 'GET') return role === 'owner' ? actionLog(env) : ownerOnly();
  const um = p.match(/^\/api\/admin\/users\/([0-9a-f-]{36})(\/pin)?$/);
  if (um && !um[2] && m === 'DELETE') return adminDeleteUser(env, user, um[1]);
  if (um && um[2] && m === 'POST') return adminNewPin(env, user, um[1]);
  return fail(404, 'Not found');
}
