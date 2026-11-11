// Pure crossing logic: geometry, zone matching, trip analysis, estimates.
// No platform APIs here, so it runs the same in Workers, Node and tests.

export const LIMITS = {
  PING_RETENTION_MS: 48 * 3600 * 1000,      // raw GPS fixes kept for 48 h
  ACTIVE_WINDOW_MS: 5 * 60 * 1000,          // a trip is "live" if it pinged in the last 5 min
  STALE_AFTER_MS: 30 * 60 * 1000,           // finalise trips silent for 30 min
  MEASURED_WINDOW_MS: 90 * 60 * 1000,       // completed trips used for the live number
  TYPICAL_LOOKBACK_MS: 8 * 7 * 24 * 3600 * 1000,
  MIN_MEASURED_TRIPS: 3,
  MAX_PINGS_PER_BATCH: 200,
  MIN_TRIP_MINUTES: 2,
  MAX_TRIP_MINUTES: 12 * 60,
  MAX_ACCURACY_M: 100,
};

export const DIRECTIONS = ['LS_to_SA', 'SA_to_LS'];
export const POSTS = ['ls_departure', 'sa_arrival', 'sa_departure', 'ls_arrival'];
export const MODES = ['vehicle', 'pedestrian'];
export const RETENTION_DAYS = [7, 30, 60, 90];

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
    .filter((p) => p.accuracy_m == null || p.accuracy_m <= LIMITS.MAX_ACCURACY_M)
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

  if (total < LIMITS.MIN_TRIP_MINUTES || total > LIMITS.MAX_TRIP_MINUTES) {
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
// Sources in order of trust: measured > early > reported > live lower bound > typical.
export function buildEstimate({ direction, now, completed, active, windowReports, typical }) {
  const recent = completed.filter((t) =>
    t.direction === direction &&
    now - new Date(t.crossing_ended_at).getTime() <= LIMITS.MEASURED_WINDOW_MS);
  const originSide = direction === 'LS_to_SA' ? 'LS' : 'SA';
  const live = active.filter((t) => t.direction === direction ||
    (t.direction == null && t.current_side === originSide));
  const liveLongest = live.length
    ? Math.round(Math.max(...live.map((t) => (now - new Date(t.started_at).getTime()) / 60000)))
    : null;
  const base = { direction, live_devices: live.length, live_longest_minutes: liveLongest };

  if (recent.length >= LIMITS.MIN_MEASURED_TRIPS) {
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

// Lesotho and South Africa are both UTC+2, so "typical" groups by local weekday/hour.
export function localSlot(ms) {
  const d = new Date(ms + 2 * 3600 * 1000);
  return { day: d.getUTCDay(), hour: d.getUTCHours() };
}

// Thin a route for storage: drop points closer than minGapM to the last kept
// point, always keep the last one, and cap the total by even sampling.
// Input: [{lat, lng, t(ms)}] sorted by time. Output: [[lat, lng, seconds_from_start]].
export function simplifyRoute(points, { minGapM = 15, maxPoints = 400 } = {}) {
  if (!points.length) return [];
  const kept = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i], last = kept[kept.length - 1];
    if (distanceM(last.lat, last.lng, p.lat, p.lng) >= minGapM || i === points.length - 1) kept.push(p);
  }
  let out = kept;
  if (out.length > maxPoints) {
    const step = (out.length - 1) / (maxPoints - 1);
    out = Array.from({ length: maxPoints }, (_, i) => kept[Math.round(i * step)]);
  }
  const t0 = out[0].t;
  return out.map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5), Math.round((p.t - t0) / 1000)]);
}

// ---------------------------------------------------------------------------
// Best time to cross: hour-by-hour forecast for the next `hours` hours.
//
// Each completed crossing is filed under the local weekday and hour it
// started (Lesotho/SA are UTC+2). For each upcoming hour we take the median
// of that weekday+hour; with too few samples we fall back to the same hour
// on any day, then to the overall median. The current live estimate is
// blended in for the next few hours, fading out as we look further ahead.
// ---------------------------------------------------------------------------
const HOUR_MS = 3600 * 1000;
const LIVE_SOURCES = ['measured', 'early', 'reported', 'live_lower_bound'];

export function buildForecast({ direction, now, completed, live, hours = 12 }) {
  const trips = completed
    .filter((t) => t.direction === direction && t.total_minutes != null)
    .map((t) => {
      const total = Number(t.total_minutes);
      const startMs = new Date(t.crossing_ended_at).getTime() - total * 60000;
      return { total, ...localSlot(startMs) };
    });
  const overall = median(trips.map((t) => t.total));
  const liveMin = live && LIVE_SOURCES.includes(live.source) && live.minutes != null ? live.minutes : null;

  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const out = [];
  for (let h = 0; h < hours; h++) {
    const startMs = hourStart + h * HOUR_MS;
    const slot = localSlot(startMs);
    const same = trips.filter((t) => t.day === slot.day && t.hour === slot.hour).map((t) => t.total);
    const sameHour = trips.filter((t) => t.hour === slot.hour).map((t) => t.total);
    let typical = null, confidence = 'none', sample = 0;
    if (same.length >= 2) { typical = median(same); sample = same.length; confidence = same.length >= 5 ? 'high' : 'medium'; }
    else if (sameHour.length >= 3) { typical = median(sameHour); sample = sameHour.length; confidence = 'low'; }
    else if (overall != null) { typical = overall; sample = trips.length; confidence = 'low'; }

    let minutes = typical;
    if (liveMin != null) {
      const w = h === 0 ? 1 : Math.exp(-h / 2.5);
      if (typical == null) minutes = h <= 2 ? liveMin : null;
      else minutes = w * liveMin + (1 - w) * typical;
      if (h <= 1 && confidence === 'none') confidence = 'low';
    }
    out.push({
      start: new Date(startMs).toISOString(),
      local_hour: slot.hour,
      minutes: minutes == null ? null : Math.round(minutes),
      confidence,
      sample,
    });
  }
  let best = -1;
  out.forEach((s, i) => {
    if (s.minutes == null) return;
    if (best === -1 || s.minutes < out[best].minutes) best = i;
  });
  return { direction, based_on: trips.length, best, hours: out };
}
