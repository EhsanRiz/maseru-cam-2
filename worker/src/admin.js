// Admin: usage statistics and the account list, for 4DCS staff only.
//
// Access: a normal signed-in session whose email is listed in the
// ADMIN_EMAILS setting (comma-separated; set it as a Worker secret so it is
// not in the repository). Admins see accounts and aggregate numbers; they
// never see anyone's locations or routes.

import { getSessionUser, isAdmin } from './auth.js';

const DAY_MS = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, message) => json({ success: false, message }, status);


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
  const where = q ? "WHERE lower(u.email) LIKE ? OR lower(coalesce(u.name, '')) LIKE ? OR coalesce(u.phone, '') LIKE ?" : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const now = iso(Date.now());
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...args).first()).n;
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.name, u.phone, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM journeys j WHERE j.history_hash = u.history_hash AND j.expires_at > ?) AS journeys,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
     FROM users u ${where}
     ORDER BY coalesce(u.last_login_at, u.created_at) DESC LIMIT ? OFFSET ?`,
  ).bind(now, now, ...args, per, (page - 1) * per).all();
  return json({ success: true, total, page, per_page: per, users: results });
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
  if (!isAdmin(env, user)) return fail(403, 'This page is for 4DCS staff only.');
  if (p === '/api/admin/stats' && m === 'GET') return stats(env);
  if (p === '/api/admin/users' && m === 'GET') return listUsers(request, env);
  if (p === '/api/admin/users.csv' && m === 'GET') return exportUsersCsv(env);
  return fail(404, 'Not found');
}
