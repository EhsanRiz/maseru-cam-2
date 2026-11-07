// Maseru Border Times: Cloudflare Worker (API + scheduled clean-up).
// Static pages from ./public are bundled into the Worker (see static.js).

import zones from './zones.json';
import { serveStatic } from './static.js';
import {
  LIMITS, DIRECTIONS, POSTS, MODES, RETENTION_DAYS,
  inArea, zoneFor, analyzeTrip, buildEstimate, localSlot,
} from './core.js';

const ZONE_BY_ID = Object.fromEntries(zones.zones.map((z) => [z.id, z]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, message) => json({ success: false, message }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomKey(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

// Best-effort per-isolate rate limit. For hard limits add a Cloudflare WAF
// rate-limiting rule on /api/* in the dashboard.
const hits = new Map();
function limited(request, bucket, limit, windowMs) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const k = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) return true;
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

async function historyHashFrom(env, key) {
  if (!key || typeof key !== 'string' || key.length < 20 || key.length > 100) return null;
  const hash = await sha256(key);
  const row = await env.DB.prepare('SELECT key_hash FROM histories WHERE key_hash = ?').bind(hash).first();
  return row ? hash : null;
}

async function createTrip(request, env) {
  if (limited(request, 'trip', 20, 3600 * 1000)) return fail(429, 'Too many requests, slow down.');
  const b = await body(request);
  const mode = MODES.includes(b.mode) ? b.mode : 'vehicle';
  const historyHash = await historyHashFrom(env, b.history_key);
  const id = crypto.randomUUID();
  const key = randomKey();
  await env.DB.prepare(
    `INSERT INTO trips (id, key_hash, history_hash, mode, status, started_at, ping_count, zones_version)
     VALUES (?, ?, ?, ?, 'active', ?, 0, ?)`,
  ).bind(id, await sha256(key), historyHash, mode, iso(Date.now()), zones.version).run();
  return json({ success: true, trip_id: id, trip_key: key, saving_to_history: !!historyHash });
}

async function authTrip(request, env, id) {
  const key = request.headers.get('x-trip-key') || '';
  if (!UUID_RE.test(id) || !key) return null;
  const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
  if (!trip || trip.key_hash !== await sha256(key)) return null;
  return trip;
}

async function addPings(request, env, id) {
  if (limited(request, 'ping', 240, 10 * 60 * 1000)) return fail(429, 'Too many requests, slow down.');
  const trip = await authTrip(request, env, id);
  if (!trip) return fail(401, 'Unknown trip');
  if (trip.status !== 'active') return fail(409, 'Trip already ended');

  const b = await body(request);
  const input = Array.isArray(b.pings) ? b.pings.slice(0, LIMITS.MAX_PINGS_PER_BATCH) : [];
  const now = Date.now();
  const rows = [];
  for (const p of input) {
    const lat = Number(p.lat), lng = Number(p.lng), t = Number(p.t);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(t)) continue;
    if (t > now + 60000 || now - t > 6 * 3600 * 1000) continue;   // clock sanity
    if (!inArea(zones, lat, lng)) continue;                        // never store outside the geofence
    const z = zoneFor(zones, lat, lng);
    rows.push({
      ts: iso(t), lat, lng,
      acc: isFinite(Number(p.acc)) ? Number(p.acc) : null,
      spd: p.spd != null && isFinite(Number(p.spd)) ? Number(p.spd) : null,
      zone: z ? z.id : null,
    });
  }
  if (!rows.length) return json({ success: true, accepted: 0 });

  rows.sort((a, b2) => (a.ts < b2.ts ? -1 : 1));
  const last = rows[rows.length - 1];
  let direction = trip.direction;
  if (!direction) {
    const firstSided = rows.find((r) => r.zone && ['LS', 'SA'].includes(ZONE_BY_ID[r.zone].side));
    if (firstSided) direction = ZONE_BY_ID[firstSided.zone].side === 'LS' ? 'LS_to_SA' : 'SA_to_LS';
  }
  const insert = env.DB.prepare(
    'INSERT INTO pings (trip_id, ts, lat, lng, accuracy_m, speed_mps, zone) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  await env.DB.batch([
    ...rows.map((r) => insert.bind(id, r.ts, r.lat, r.lng, r.acc, r.spd, r.zone)),
    env.DB.prepare(
      'UPDATE trips SET last_ping_at = ?, current_zone = ?, ping_count = ping_count + ?, direction = ? WHERE id = ?',
    ).bind(last.ts, last.zone, rows.length, direction, id),
  ]);
  return json({ success: true, accepted: rows.length });
}

// Analyse a trip, store its anonymous summary, copy it to the owner's
// history if they opted in, then drop the link between the two.
async function finalise(env, id) {
  const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
  if (!trip || trip.status !== 'active') return { status: trip ? trip.status : 'missing' };
  const { results: pings } = await env.DB.prepare(
    'SELECT ts, lat, lng, accuracy_m, zone FROM pings WHERE trip_id = ? ORDER BY ts',
  ).bind(id).all();
  const r = analyzeTrip(zones, pings);

  const upd = await env.DB.prepare(
    `UPDATE trips SET status = ?, direction = COALESCE(?, direction), crossing_started_at = ?, crossing_ended_at = ?,
       total_minutes = ?, queue_minutes = ?, origin_post_minutes = ?, bridge_minutes = ?, dest_post_minutes = ?,
       finalised_at = ?, history_hash = NULL
     WHERE id = ? AND status = 'active'`,
  ).bind(
    r.status, r.direction ?? null, r.crossing_started_at ?? null, r.crossing_ended_at ?? null,
    r.total_minutes ?? null, r.queue_minutes ?? null, r.origin_post_minutes ?? null,
    r.bridge_minutes ?? null, r.dest_post_minutes ?? null, iso(Date.now()), id,
  ).run();
  if (!upd.meta.changes) return { status: 'already_finalised' };   // another request got there first

  let saved = false;
  if (r.status === 'completed' && trip.history_hash) {
    const h = await env.DB.prepare('SELECT retention_days FROM histories WHERE key_hash = ?')
      .bind(trip.history_hash).first();
    if (h) {
      await env.DB.prepare(
        `INSERT INTO journeys (id, history_hash, direction, mode, crossing_started_at, crossing_ended_at,
           total_minutes, queue_minutes, origin_post_minutes, bridge_minutes, dest_post_minutes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), trip.history_hash, r.direction, trip.mode, r.crossing_started_at, r.crossing_ended_at,
        r.total_minutes, r.queue_minutes, r.origin_post_minutes, r.bridge_minutes, r.dest_post_minutes,
        iso(new Date(r.crossing_ended_at).getTime() + h.retention_days * DAY_MS),
      ).run();
      saved = true;
    }
  }
  return { ...r, saved_to_history: saved };
}

async function endTrip(request, env, id) {
  const trip = await authTrip(request, env, id);
  if (!trip) return fail(401, 'Unknown trip');
  return json({ success: true, result: await finalise(env, id) });
}

// ---------------------------------------------------------------------------
// Window reports & estimate
// ---------------------------------------------------------------------------

async function windowReport(request, env) {
  if (limited(request, 'report', 10, 3600 * 1000)) return fail(429, 'Too many reports, try again later.');
  const b = await body(request);
  if (!DIRECTIONS.includes(b.direction)) return fail(400, 'Invalid direction');
  if (!POSTS.includes(b.post)) return fail(400, 'Invalid post');
  const num = (v, max) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) && n >= 0 && n <= max ? n : undefined;
  };
  const r = {
    windows_open: num(b.windows_open, 50),
    people_ahead: num(b.people_ahead, 2000),
    minutes_at_window: num(b.minutes_at_window, 600),
    queue_minutes: num(b.queue_minutes, 900),
  };
  if (Object.values(r).includes(undefined)) return fail(400, 'A number is out of range');
  if (Object.values(r).every((v) => v == null)) return fail(400, 'Report at least one value');
  await env.DB.prepare(
    `INSERT INTO window_reports (id, reported_at, direction, post, mode, windows_open, people_ahead, minutes_at_window, queue_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), iso(Date.now()), b.direction, b.post, MODES.includes(b.mode) ? b.mode : 'vehicle',
    r.windows_open, r.people_ahead, r.minutes_at_window, r.queue_minutes,
  ).run();
  return json({ success: true, message: 'Thanks, your report helps everyone crossing.' });
}

async function estimate(env) {
  const now = Date.now();
  const [active, completed, reports] = await Promise.all([
    env.DB.prepare(`SELECT direction, started_at, current_zone FROM trips
                    WHERE status = 'active' AND last_ping_at >= ?`).bind(iso(now - LIMITS.ACTIVE_WINDOW_MS)).all(),
    env.DB.prepare(`SELECT direction, crossing_ended_at, total_minutes FROM trips
                    WHERE status = 'completed' AND crossing_ended_at >= ?`).bind(iso(now - LIMITS.TYPICAL_LOOKBACK_MS)).all(),
    env.DB.prepare('SELECT direction, queue_minutes FROM window_reports WHERE reported_at >= ?')
      .bind(iso(now - 3600 * 1000)).all(),
  ]);
  const activeRows = active.results.map((t) => ({
    ...t, current_side: t.current_zone ? ZONE_BY_ID[t.current_zone]?.side : null,
  }));
  const slot = localSlot(now);
  const typical = completed.results.filter((t) => {
    const s = localSlot(new Date(t.crossing_ended_at).getTime());
    return s.day === slot.day && s.hour === slot.hour;
  });
  return json({
    success: true,
    generated_at: iso(now),
    zones_calibrated: !!zones.calibrated,
    directions: DIRECTIONS.map((direction) => buildEstimate({
      direction, now, completed: completed.results, active: activeRows, windowReports: reports.results, typical,
    })),
  });
}

// ---------------------------------------------------------------------------
// Personal journey history (opt-in)
// ---------------------------------------------------------------------------

async function authHistory(request, env) {
  const key = request.headers.get('x-history-key') || '';
  const hash = await historyHashFrom(env, key);
  if (hash) {
    await env.DB.prepare('UPDATE histories SET last_seen_at = ? WHERE key_hash = ?').bind(iso(Date.now()), hash).run();
  }
  return hash;
}

async function registerHistory(request, env) {
  if (limited(request, 'history', 10, 3600 * 1000)) return fail(429, 'Too many requests, slow down.');
  const b = await body(request);
  const days = RETENTION_DAYS.includes(Number(b.retention_days)) ? Number(b.retention_days) : 30;
  const key = randomKey(24);
  await env.DB.prepare('INSERT INTO histories (key_hash, retention_days, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(key), days, iso(Date.now()), iso(Date.now())).run();
  return json({ success: true, history_key: key, retention_days: days });
}

async function getHistory(request, env) {
  const hash = await authHistory(request, env);
  if (!hash) return fail(401, 'History not found. It may have been deleted.');
  const h = await env.DB.prepare('SELECT retention_days, created_at FROM histories WHERE key_hash = ?').bind(hash).first();
  const { results } = await env.DB.prepare(
    `SELECT id, direction, mode, crossing_started_at, crossing_ended_at, total_minutes, queue_minutes,
            origin_post_minutes, bridge_minutes, dest_post_minutes, expires_at
     FROM journeys WHERE history_hash = ? AND expires_at > ? ORDER BY crossing_ended_at DESC LIMIT 500`,
  ).bind(hash, iso(Date.now())).all();
  return json({ success: true, retention_days: h.retention_days, created_at: h.created_at, journeys: results });
}

async function updateHistorySettings(request, env) {
  const hash = await authHistory(request, env);
  if (!hash) return fail(401, 'History not found.');
  const b = await body(request);
  const days = Number(b.retention_days);
  if (!RETENTION_DAYS.includes(days)) return fail(400, 'Choose 7, 30, 60 or 90 days');
  await env.DB.batch([
    env.DB.prepare('UPDATE histories SET retention_days = ? WHERE key_hash = ?').bind(days, hash),
    // Re-date every saved journey from its own crossing time. Shortening the
    // period removes older journeys at the next clean-up.
    env.DB.prepare(
      `UPDATE journeys SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', crossing_ended_at, '+' || ? || ' days')
       WHERE history_hash = ?`,
    ).bind(days, hash),
    env.DB.prepare('DELETE FROM journeys WHERE history_hash = ? AND expires_at <= ?').bind(hash, iso(Date.now())),
  ]);
  return json({ success: true, retention_days: days });
}

async function deleteJourney(request, env, id) {
  const hash = await authHistory(request, env);
  if (!hash) return fail(401, 'History not found.');
  if (!UUID_RE.test(id)) return fail(400, 'Invalid id');
  await env.DB.prepare('DELETE FROM journeys WHERE id = ? AND history_hash = ?').bind(id, hash).run();
  return json({ success: true });
}

async function deleteHistory(request, env) {
  const hash = await authHistory(request, env);
  if (!hash) return fail(401, 'History not found.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM journeys WHERE history_hash = ?').bind(hash),
    env.DB.prepare('UPDATE trips SET history_hash = NULL WHERE history_hash = ?').bind(hash),
    env.DB.prepare('DELETE FROM histories WHERE key_hash = ?').bind(hash),
  ]);
  return json({ success: true });
}

// ---------------------------------------------------------------------------
// Scheduled clean-up (cron)
// ---------------------------------------------------------------------------

export async function sweep(env) {
  const now = Date.now();
  const { results: stale } = await env.DB.prepare(
    `SELECT id FROM trips WHERE status = 'active' AND COALESCE(last_ping_at, started_at) < ? LIMIT 200`,
  ).bind(iso(now - LIMITS.STALE_AFTER_MS)).all();
  for (const t of stale) await finalise(env, t.id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pings WHERE ts < ?').bind(iso(now - LIMITS.PING_RETENTION_MS)),
    env.DB.prepare('DELETE FROM journeys WHERE expires_at <= ?').bind(iso(now)),
    env.DB.prepare('DELETE FROM window_reports WHERE reported_at < ?').bind(iso(now - 730 * DAY_MS)),
    // Histories nobody has opened for a year and that hold no journeys.
    env.DB.prepare(
      `DELETE FROM histories WHERE COALESCE(last_seen_at, created_at) < ?
         AND NOT EXISTS (SELECT 1 FROM journeys j WHERE j.history_hash = histories.key_hash)`,
    ).bind(iso(now - 365 * DAY_MS)),
  ]);
  return { finalised: stale.length };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  let match;

  if (p === '/api/zones' && m === 'GET') return json(zones);
  if (p === '/api/estimate' && m === 'GET') return estimate(env);
  if (p === '/api/trips' && m === 'POST') return createTrip(request, env);
  if ((match = p.match(/^\/api\/trips\/([^/]+)\/pings$/)) && m === 'POST') return addPings(request, env, match[1]);
  if ((match = p.match(/^\/api\/trips\/([^/]+)\/end$/)) && m === 'POST') return endTrip(request, env, match[1]);
  if (p === '/api/window-report' && m === 'POST') return windowReport(request, env);
  if (p === '/api/history/register' && m === 'POST') return registerHistory(request, env);
  if (p === '/api/history' && m === 'GET') return getHistory(request, env);
  if (p === '/api/history' && m === 'DELETE') return deleteHistory(request, env);
  if (p === '/api/history/settings' && m === 'PUT') return updateHistorySettings(request, env);
  if ((match = p.match(/^\/api\/history\/journeys\/([^/]+)$/)) && m === 'DELETE') return deleteJourney(request, env, match[1]);
  if (p === '/api/health') return json({ ok: true, zones_version: zones.version });
  if (p.startsWith('/api/')) return fail(404, 'Not found');
  return serveStatic(request, p);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error('request failed:', e && e.stack || e);
      return fail(500, 'Server error');
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env).catch((e) => console.error('sweep failed:', e && e.stack || e)));
  },
};
