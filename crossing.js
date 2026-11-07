// Crossing Mode — crowd-sourced border crossing times from phone GPS.
//
// Phones send GPS fixes only while inside the outer geofence around Maseru
// Bridge. Each crossing is an anonymous "trip" keyed by a random UUID plus a
// secret write key (only its hash is stored). When a trip ends, its fixes are
// matched against the zones in crossing-zones.json to work out direction and
// segment times. Raw fixes are purged after 48 hours.

import crypto from 'crypto';
import fs from 'fs';

const PING_RETENTION_MS = 48 * 3600 * 1000;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;        // a trip is "live" if it pinged in the last 5 min
const STALE_AFTER_MS = 30 * 60 * 1000;         // finalise trips silent for 30 min
const MEASURED_WINDOW_MS = 90 * 60 * 1000;     // completed trips used for the live number
const MIN_MEASURED_TRIPS = 3;
const MAX_PINGS_PER_BATCH = 200;
const MIN_TRIP_MINUTES = 2;
const MAX_TRIP_MINUTES = 12 * 60;
const MAX_ACCURACY_M = 100;                    // ignore fixes worse than this when matching zones

const DIRECTIONS = ['LS_to_SA', 'SA_to_LS'];
const POSTS = ['ls_departure', 'sa_arrival', 'sa_departure', 'ls_arrival'];
const MODES = ['vehicle', 'pedestrian'];

// ---------------------------------------------------------------------------
// Geometry & zone matching (pure; exported for tests)
// ---------------------------------------------------------------------------

export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function inArea(zones, lat, lng) {
  const a = zones.area;
  return distanceM(a.lat, a.lng, lat, lng) <= a.radius_m;
}

// Zones are listed in priority order (small posts/bridge before big queues),
// so the first match wins where circles overlap.
export function zoneFor(zones, lat, lng) {
  for (const z of zones.zones) {
    if (distanceM(z.lat, z.lng, lat, lng) <= z.radius_m) return z;
  }
  return null;
}

const minutesBetween = (a, b) => Math.round(((b - a) / 60000) * 10) / 10;

// Work out direction and segment times from a trip's fixes.
// Returns { status: 'completed' | 'abandoned' | 'invalid', direction, ...summary }.
export function analyzeTrip(zones, pings) {
  const byId = Object.fromEntries(zones.zones.map((z) => [z.id, z]));
  const fixes = pings
    .filter((p) => p.accuracy_m == null || p.accuracy_m <= MAX_ACCURACY_M)
    .map((p) => {
      const z = p.zone ? byId[p.zone] : zoneFor(zones, p.lat, p.lng);
      return { t: new Date(p.ts).getTime(), zone: z || null };
    })
    .sort((a, b) => a.t - b.t);

  const sided = fixes.filter((f) => f.zone && (f.zone.side === 'LS' || f.zone.side === 'SA'));
  if (sided.length === 0) return { status: 'abandoned', direction: null };

  const origin = sided[0].zone.side;
  const dest = origin === 'LS' ? 'SA' : 'LS';
  const direction = origin === 'LS' ? 'LS_to_SA' : 'SA_to_LS';

  const firstDestIdx = fixes.findIndex((f) => f.zone && f.zone.side === dest);
  if (firstDestIdx === -1) return { status: 'abandoned', direction };

  const before = fixes.slice(0, firstDestIdx);
  const after = fixes.slice(firstDestIdx);
  const originFixes = before.filter((f) => f.zone && f.zone.side === origin);
  const originPost = originFixes.filter((f) => f.zone.kind === 'post');
  const destPost = after.filter((f) => f.zone && f.zone.side === dest && f.zone.kind === 'post');

  const start = originFixes[0].t;
  // End = leaving the destination post; if we never saw the post, the first
  // destination-side fix is the best we have.
  const end = destPost.length ? destPost[destPost.length - 1].t : fixes[firstDestIdx].t;

  const total = minutesBetween(start, end);
  const summary = {
    direction,
    crossing_started_at: new Date(start).toISOString(),
    crossing_ended_at: new Date(end).toISOString(),
    total_minutes: total,
    queue_minutes: originPost.length ? minutesBetween(start, originPost[0].t) : null,
    origin_post_minutes: originPost.length
      ? minutesBetween(originPost[0].t, originPost[originPost.length - 1].t) : null,
    bridge_minutes: originPost.length && destPost.length
      ? minutesBetween(originPost[originPost.length - 1].t, destPost[0].t) : null,
    dest_post_minutes: destPost.length
      ? minutesBetween(destPost[0].t, destPost[destPost.length - 1].t) : null,
  };

  if (total < MIN_TRIP_MINUTES || total > MAX_TRIP_MINUTES) {
    return { status: 'invalid', ...summary };
  }
  return { status: 'completed', ...summary };
}

export function median(values) {
  const v = values.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Build the public estimate for one direction from already-fetched data.
export function buildEstimate({ direction, now, completed, active, windowReports, typical }) {
  const recent = completed.filter((t) =>
    t.direction === direction && now - new Date(t.crossing_ended_at).getTime() <= MEASURED_WINDOW_MS);
  const live = active.filter((t) => t.direction === direction ||
    (t.direction == null && t.current_side === (direction === 'LS_to_SA' ? 'LS' : 'SA')));
  const liveLongest = live.length
    ? Math.round(Math.max(...live.map((t) => (now - new Date(t.started_at).getTime()) / 60000)))
    : null;
  const base = { direction, live_devices: live.length, live_longest_minutes: liveLongest };

  if (recent.length >= MIN_MEASURED_TRIPS) {
    return { ...base, source: 'measured', minutes: Math.round(median(recent.map((t) => Number(t.total_minutes)))), sample: recent.length };
  }
  if (recent.length > 0) {
    const m = median(recent.map((t) => Number(t.total_minutes)));
    return { ...base, source: 'early', minutes: Math.round(Math.max(m, liveLongest || 0)), sample: recent.length };
  }
  const reports = windowReports.filter((r) => r.direction === direction && r.queue_minutes != null);
  if (reports.length) {
    return { ...base, source: 'reported', minutes: Math.round(median(reports.map((r) => Number(r.queue_minutes)))), sample: reports.length };
  }
  if (liveLongest != null) {
    return { ...base, source: 'live_lower_bound', minutes: liveLongest, sample: live.length };
  }
  const typ = typical.filter((t) => t.direction === direction);
  if (typ.length) {
    return { ...base, source: 'typical', minutes: Math.round(median(typ.map((t) => Number(t.total_minutes)))), sample: typ.length };
  }
  return { ...base, source: 'none', minutes: null, sample: 0 };
}

// ---------------------------------------------------------------------------
// Storage: Supabase when configured, otherwise in-memory (local dev).
// ---------------------------------------------------------------------------

function memoryStore() {
  const trips = new Map();
  const pings = new Map();
  const reports = [];
  return {
    async createTrip(t) { trips.set(t.id, { ...t }); pings.set(t.id, []); },
    async getTrip(id) { return trips.get(id) || null; },
    async updateTrip(id, fields) { Object.assign(trips.get(id), fields); },
    async addPings(id, rows) { pings.get(id).push(...rows); },
    async getPings(id) { return pings.get(id) || []; },
    async listActive(sinceIso) {
      return [...trips.values()].filter((t) => t.status === 'active' && t.last_ping_at && t.last_ping_at >= sinceIso);
    },
    async listStale(beforeIso) {
      return [...trips.values()].filter((t) => t.status === 'active' && (t.last_ping_at || t.started_at) < beforeIso);
    },
    async listCompleted(sinceIso) {
      return [...trips.values()].filter((t) => t.status === 'completed' && t.crossing_ended_at >= sinceIso);
    },
    async addWindowReport(r) { reports.push({ ...r, reported_at: new Date().toISOString() }); },
    async listWindowReports(sinceIso) { return reports.filter((r) => r.reported_at >= sinceIso); },
    async purgePings(beforeIso) {
      for (const [id, rows] of pings) pings.set(id, rows.filter((p) => p.ts >= beforeIso));
    },
  };
}

function supabaseStore(sb) {
  const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    async createTrip(t) { check(await sb.from('crossing_trips').insert(t)); },
    async getTrip(id) {
      return check(await sb.from('crossing_trips').select('*').eq('id', id).maybeSingle());
    },
    async updateTrip(id, fields) { check(await sb.from('crossing_trips').update(fields).eq('id', id)); },
    async addPings(id, rows) {
      check(await sb.from('crossing_pings').insert(rows.map((r) => ({ ...r, trip_id: id }))));
    },
    async getPings(id) {
      return check(await sb.from('crossing_pings').select('ts,lat,lng,accuracy_m,speed_mps,zone')
        .eq('trip_id', id).order('ts', { ascending: true }).limit(5000));
    },
    async listActive(sinceIso) {
      return check(await sb.from('crossing_trips')
        .select('id,direction,started_at,last_ping_at,current_zone,mode')
        .eq('status', 'active').gte('last_ping_at', sinceIso));
    },
    async listStale(beforeIso) {
      return check(await sb.from('crossing_trips').select('id')
        .eq('status', 'active').lt('last_ping_at', beforeIso).limit(200));
    },
    async listCompleted(sinceIso) {
      return check(await sb.from('crossing_trips')
        .select('direction,crossing_ended_at,total_minutes,mode')
        .eq('status', 'completed').gte('crossing_ended_at', sinceIso).limit(5000));
    },
    async addWindowReport(r) { check(await sb.from('crossing_window_reports').insert(r)); },
    async listWindowReports(sinceIso) {
      return check(await sb.from('crossing_window_reports').select('*').gte('reported_at', sinceIso));
    },
    async purgePings(beforeIso) { check(await sb.from('crossing_pings').delete().lt('ts', beforeIso)); },
  };
}

// ---------------------------------------------------------------------------
// Simple per-IP rate limiting
// ---------------------------------------------------------------------------

function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      return res.status(429).json({ success: false, message: 'Too many requests, slow down.' });
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10000) hits.clear();
    next();
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createCrossingRouter({ express, supabase, zonesPath }) {
  const zones = JSON.parse(fs.readFileSync(zonesPath, 'utf8'));
  const store = supabase ? supabaseStore(supabase) : memoryStore();
  const router = express.Router();
  const zoneById = Object.fromEntries(zones.zones.map((z) => [z.id, z]));

  async function authTrip(req, res) {
    const id = req.params.id;
    const key = req.get('x-trip-key') || '';
    if (!UUID_RE.test(id) || !key) {
      res.status(401).json({ success: false, message: 'Missing trip credentials' });
      return null;
    }
    const trip = await store.getTrip(id);
    if (!trip || trip.key_hash !== sha256(key)) {
      res.status(401).json({ success: false, message: 'Unknown trip' });
      return null;
    }
    return trip;
  }

  async function finalise(id) {
    const rows = await store.getPings(id);
    const result = analyzeTrip(zones, rows);
    const { status, ...summary } = result;
    await store.updateTrip(id, { status, ...summary, finalised_at: new Date().toISOString() });
    return result;
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error('crossing error:', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  });

  router.get('/zones', (req, res) => res.json(zones));

  router.post('/trips', rateLimiter(20, 3600 * 1000), wrap(async (req, res) => {
    const mode = MODES.includes(req.body?.mode) ? req.body.mode : 'vehicle';
    const id = crypto.randomUUID();
    const key = crypto.randomBytes(24).toString('base64url');
    await store.createTrip({
      id, key_hash: sha256(key), mode, status: 'active',
      started_at: new Date().toISOString(), ping_count: 0, zones_version: zones.version,
    });
    res.json({ success: true, trip_id: id, trip_key: key });
  }));

  router.post('/trips/:id/pings', rateLimiter(240, 10 * 60 * 1000), wrap(async (req, res) => {
    const trip = await authTrip(req, res);
    if (!trip) return;
    if (trip.status !== 'active') return res.status(409).json({ success: false, message: 'Trip already ended' });
    const input = Array.isArray(req.body?.pings) ? req.body.pings.slice(0, MAX_PINGS_PER_BATCH) : [];
    const now = Date.now();
    const rows = [];
    for (const p of input) {
      const lat = Number(p.lat), lng = Number(p.lng), t = Number(p.t);
      if (!isFinite(lat) || !isFinite(lng) || !isFinite(t)) continue;
      if (t > now + 60000 || now - t > 6 * 3600 * 1000) continue;   // clock sanity
      if (!inArea(zones, lat, lng)) continue;                        // never store outside the geofence
      const z = zoneFor(zones, lat, lng);
      rows.push({
        ts: new Date(t).toISOString(), lat, lng,
        accuracy_m: isFinite(Number(p.acc)) ? Number(p.acc) : null,
        speed_mps: isFinite(Number(p.spd)) ? Number(p.spd) : null,
        zone: z ? z.id : null,
      });
    }
    if (rows.length) {
      rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
      await store.addPings(trip.id, rows);
      const last = rows[rows.length - 1];
      const fields = { last_ping_at: last.ts, current_zone: last.zone, ping_count: (trip.ping_count || 0) + rows.length };
      if (!trip.direction) {
        const firstSided = rows.find((r) => r.zone && ['LS', 'SA'].includes(zoneById[r.zone].side));
        if (firstSided) fields.direction = zoneById[firstSided.zone].side === 'LS' ? 'LS_to_SA' : 'SA_to_LS';
      }
      await store.updateTrip(trip.id, fields);
    }
    res.json({ success: true, accepted: rows.length });
  }));

  router.post('/trips/:id/end', wrap(async (req, res) => {
    const trip = await authTrip(req, res);
    if (!trip) return;
    if (trip.status !== 'active') return res.json({ success: true, result: { status: trip.status } });
    const result = await finalise(trip.id);
    res.json({ success: true, result });
  }));

  router.post('/window-report', rateLimiter(10, 3600 * 1000), wrap(async (req, res) => {
    const b = req.body || {};
    if (!DIRECTIONS.includes(b.direction)) return res.status(400).json({ success: false, message: 'Invalid direction' });
    if (!POSTS.includes(b.post)) return res.status(400).json({ success: false, message: 'Invalid post' });
    const num = (v, max) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return isFinite(n) && n >= 0 && n <= max ? n : undefined;
    };
    const report = {
      direction: b.direction,
      post: b.post,
      mode: MODES.includes(b.mode) ? b.mode : 'vehicle',
      windows_open: num(b.windows_open, 50),
      people_ahead: num(b.people_ahead, 2000),
      minutes_at_window: num(b.minutes_at_window, 600),
      queue_minutes: num(b.queue_minutes, 900),
      trip_id: UUID_RE.test(b.trip_id || '') ? b.trip_id : null,
    };
    if (Object.values(report).includes(undefined)) {
      return res.status(400).json({ success: false, message: 'A number is out of range' });
    }
    if (report.windows_open == null && report.people_ahead == null &&
        report.minutes_at_window == null && report.queue_minutes == null) {
      return res.status(400).json({ success: false, message: 'Report at least one value' });
    }
    await store.addWindowReport(report);
    res.json({ success: true, message: 'Thanks, your report helps everyone crossing.' });
  }));

  router.get('/estimate', wrap(async (req, res) => {
    const now = Date.now();
    const iso = (ms) => new Date(now - ms).toISOString();
    const [active, completed, windowReports] = await Promise.all([
      store.listActive(iso(ACTIVE_WINDOW_MS)),
      store.listCompleted(iso(8 * 7 * 24 * 3600 * 1000)),
      store.listWindowReports(iso(60 * 60 * 1000)),
    ]);
    const activeWithSide = active.map((t) => ({
      ...t, current_side: t.current_zone ? zoneById[t.current_zone]?.side : null,
    }));
    // "Typical" = completed trips in the same weekday and hour over the last 8 weeks.
    const d = new Date(now);
    const typical = completed.filter((t) => {
      const e = new Date(t.crossing_ended_at);
      return e.getUTCDay() === d.getUTCDay() && e.getUTCHours() === d.getUTCHours();
    });
    res.json({
      success: true,
      generated_at: new Date(now).toISOString(),
      zones_calibrated: !!zones.calibrated,
      directions: DIRECTIONS.map((direction) => buildEstimate({
        direction, now, completed, active: activeWithSide, windowReports, typical,
      })),
    });
  }));

  // Background housekeeping: finalise silent trips, purge old raw fixes.
  async function sweep() {
    try {
      const stale = await store.listStale(new Date(Date.now() - STALE_AFTER_MS).toISOString());
      for (const t of stale) await finalise(t.id);
      await store.purgePings(new Date(Date.now() - PING_RETENTION_MS).toISOString());
    } catch (e) {
      console.error('crossing sweep failed:', e.message);
    }
  }
  const timer = setInterval(sweep, 5 * 60 * 1000);
  timer.unref();

  return router;
}
