// Accounts: email + 6-digit PIN sign-in, 7-day sessions, profile and preferences.
//
// Flow: POST /api/auth/start {email}
//         new account (or no PIN yet) -> a PIN is emailed, then sign in with it
//         existing account            -> sign in with the PIN they already have
//       POST /api/auth/forgot {email} -> email a new PIN that replaces the old one
//       POST /api/auth/login {email, pin} -> session token (Authorization: Bearer)
// PINs are stored as salted PBKDF2-SHA256 hashes; session tokens as SHA-256.

import { MODES } from './core.js';

const SESSION_DAYS = 7;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const PIN_EMAILS_PER_HOUR = 3;
const PBKDF2_ITERATIONS = 100000;
const DAY_MS = 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const THEMES = ['auto', 'light', 'dark'];

const iso = (ms) => new Date(ms).toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (status, message, extra = {}) => json({ success: false, message, ...extra }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function newPin() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}
async function hashPin(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256));
}
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const validPin = (p) => typeof p === 'string' && /^\d{6}$/.test(p);

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

// Best-effort per-isolate limit by IP (backed by per-account limits in D1).
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

export function parsePrefs(text) {
  let p = {};
  try { p = JSON.parse(text || '{}') || {}; } catch {}
  return {
    default_mode: MODES.includes(p.default_mode) ? p.default_mode : 'vehicle',
    theme: THEMES.includes(p.theme) ? p.theme : 'auto',
    save_journeys: p.save_journeys !== false,
    keep_screen_on: p.keep_screen_on !== false,
  };
}

// Staff who may open the admin page: ADMIN_EMAILS, comma-separated (a Worker secret).
export function isAdmin(env, user) {
  const list = String(env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!user && list.includes(String(user.email).toLowerCase());
}

function publicUser(u, retentionDays, admin = false) {
  return {
    is_admin: admin,
    id: u.id,
    email: u.email,
    name: u.name || '',
    phone: u.phone || '',
    prefs: parsePrefs(u.prefs),
    retention_days: retentionDays ?? null,
    created_at: u.created_at,
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function sendPinEmail(env, to, pin, reason) {
  if (!env.RESEND_API_KEY) {
    if (env.DEV_SHOW_PIN === 'true') return { dev_pin: pin };   // local development only
    const e = new Error('Email sign-in is not set up yet. Please try again later.');
    e.status = 503;
    throw e;
  }
  const intro = reason === 'reset'
    ? 'You asked for a new PIN for Tsela. Your old PIN no longer works.'
    : 'Welcome to Tsela. Use this PIN to sign in.';
  const text = `${intro}\n\nYour PIN: ${pin}\n\nSign in at https://traffic.4dcs.co.za with your email and this PIN. ` +
    'You can change it later in Settings.\n\nIf you did not ask for this, you can ignore this email.\n\n' +
    '4D Climate Solutions (Pty) Ltd · info@4dcs.co.za';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#1f2a24">
    <p>${intro}</p>
    <p style="font-size:14px;color:#6b5e5a;margin:20px 0 4px">Your PIN</p>
    <p style="font-size:34px;letter-spacing:8px;font-weight:bold;color:#00A54F;margin:0 0 20px">${pin}</p>
    <p>Sign in at <a href="https://traffic.4dcs.co.za">traffic.4dcs.co.za</a> with your email and this PIN.
    You can change it later in Settings.</p>
    <p style="color:#6b5e5a;font-size:13px">If you did not ask for this, you can ignore this email.</p>
    <p style="color:#6b5e5a;font-size:12px">4D Climate Solutions (Pty) Ltd · info@4dcs.co.za</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Tsela <no-reply@4dcs.co.za>',
      to: [to],
      subject: reason === 'reset' ? 'Your new Tsela PIN' : 'Your Tsela PIN',
      text,
      html,
    }),
  });
  if (!r.ok) {
    console.error('email send failed:', r.status, await r.text().catch(() => ''));
    const e = new Error('We could not send the email. Please try again in a few minutes.');
    e.status = 502;
    throw e;
  }
  return {};
}

// Issue a new PIN for a user (replacing any old one) and email it.
async function issuePin(env, user, reason) {
  const now = Date.now();
  const windowStart = user.pin_email_window_at ? Date.parse(user.pin_email_window_at) : 0;
  const inWindow = now - windowStart < 3600 * 1000;
  const sent = inWindow ? user.pin_emails_sent : 0;
  if (sent >= PIN_EMAILS_PER_HOUR) {
    const e = new Error('Too many PIN emails. Please wait an hour and try again.');
    e.status = 429;
    throw e;
  }
  const pin = newPin();
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const extra = await sendPinEmail(env, user.email, pin, reason);
  await env.DB.prepare(
    `UPDATE users SET pin_hash = ?, pin_salt = ?, pin_set_at = ?, failed_attempts = 0, locked_until = NULL,
       pin_emails_sent = ?, pin_email_window_at = ? WHERE id = ?`,
  ).bind(await hashPin(pin, salt), salt, iso(now), sent + 1, inWindow ? user.pin_email_window_at : iso(now), user.id).run();
  // Sending a new PIN signs out other devices that used the old one.
  if (reason === 'reset') await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  return extra;
}

// ---------------------------------------------------------------------------
// Sessions & history link
// ---------------------------------------------------------------------------

export async function getSessionUser(request, env) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const now = iso(Date.now());
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256(m[1]), now).first();
  return row || null;
}

// Every account owns one history; create it on first use.
export async function ensureUserHistory(env, user) {
  if (user.history_hash) {
    const h = await env.DB.prepare('SELECT key_hash FROM histories WHERE key_hash = ?').bind(user.history_hash).first();
    if (h) return user.history_hash;
  }
  const hash = await sha256(randomToken());
  await env.DB.batch([
    env.DB.prepare('INSERT INTO histories (key_hash, retention_days, created_at, last_seen_at) VALUES (?, 30, ?, ?)')
      .bind(hash, iso(Date.now()), iso(Date.now())),
    env.DB.prepare('UPDATE users SET history_hash = ? WHERE id = ?').bind(hash, user.id),
  ]);
  user.history_hash = hash;
  return hash;
}

// A device that saved journeys before accounts existed hands over its
// history key at sign-in; its journeys move into the account.
async function claimLegacyHistory(env, user, legacyKey) {
  if (!legacyKey || typeof legacyKey !== 'string' || legacyKey.length < 20 || legacyKey.length > 100) return;
  const legacy = await sha256(legacyKey);
  const row = await env.DB.prepare('SELECT key_hash FROM histories WHERE key_hash = ?').bind(legacy).first();
  if (!row || legacy === user.history_hash) return;
  if (!user.history_hash) {
    await env.DB.prepare('UPDATE users SET history_hash = ? WHERE id = ?').bind(legacy, user.id).run();
    user.history_hash = legacy;
    return;
  }
  const target = await ensureUserHistory(env, user);
  await env.DB.batch([
    env.DB.prepare('UPDATE journeys SET history_hash = ? WHERE history_hash = ?').bind(target, legacy),
    env.DB.prepare('DELETE FROM histories WHERE key_hash = ?').bind(legacy),
  ]);
}

async function retentionFor(env, user) {
  if (!user.history_hash) return 30;
  const h = await env.DB.prepare('SELECT retention_days FROM histories WHERE key_hash = ?').bind(user.history_hash).first();
  return h ? h.retention_days : 30;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function start(request, env, forgot) {
  if (limited(request, 'auth-start', 10, 3600 * 1000)) return fail(429, 'Too many requests. Please wait a while.');
  const email = normEmail((await body(request)).email);
  if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, 'Please enter a valid email address.');

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(id, email, iso(Date.now())).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  }
  if (user.pin_hash && !forgot) {
    return json({ success: true, next: 'pin', pin_sent: false, message: 'Enter your PIN.' });
  }
  try {
    const extra = await issuePin(env, user, user.pin_hash ? 'reset' : 'new');
    return json({
      success: true, next: 'pin', pin_sent: true,
      message: `We emailed a ${user.pin_hash ? 'new ' : ''}PIN to ${email}. It can take a minute to arrive.`,
      ...extra,
    });
  } catch (e) {
    return fail(e.status || 500, e.message);
  }
}

async function login(request, env) {
  if (limited(request, 'auth-login', 30, 3600 * 1000)) return fail(429, 'Too many attempts. Please wait a while.');
  const b = await body(request);
  const email = normEmail(b.email);
  const pin = String(b.pin ?? '').trim();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user || !user.pin_hash || !validPin(pin)) return fail(401, 'Email or PIN is not correct.');
  const now = Date.now();
  if (user.locked_until && Date.parse(user.locked_until) > now) {
    const mins = Math.ceil((Date.parse(user.locked_until) - now) / 60000);
    return fail(429, `Too many wrong PINs. Try again in ${mins} min, or use Forgot PIN.`);
  }
  if (!sameString(await hashPin(pin, user.pin_salt), user.pin_hash)) {
    const failed = (user.failed_attempts || 0) + 1;
    const lock = failed >= MAX_FAILED ? iso(now + LOCK_MINUTES * 60000) : null;
    await env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(lock ? 0 : failed, lock, user.id).run();
    return fail(401, lock
      ? `Too many wrong PINs. Try again in ${LOCK_MINUTES} min, or use Forgot PIN.`
      : `Email or PIN is not correct. ${MAX_FAILED - failed} attempt${MAX_FAILED - failed === 1 ? '' : 's'} left.`);
  }

  const token = randomToken();
  const expires = iso(now + SESSION_DAYS * DAY_MS);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').bind(iso(now), user.id),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), user.id, iso(now), expires, iso(now)),
  ]);
  await claimLegacyHistory(env, user, b.history_key);
  return json({ success: true, token, expires_at: expires, user: publicUser(user, await retentionFor(env, user), isAdmin(env, user)) });
}

async function logout(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/);
  if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(m[1])).run();
  return json({ success: true });
}

async function me(request, env, user) {
  return json({ success: true, user: publicUser(user, await retentionFor(env, user), isAdmin(env, user)) });
}

async function updateMe(request, env, user) {
  const b = await body(request);
  const name = b.name == null ? user.name : String(b.name).trim().slice(0, 80);
  const phone = b.phone == null ? user.phone : String(b.phone).trim();
  if (phone && !/^\+?[0-9 ()-]{6,20}$/.test(phone)) return fail(400, 'Please enter a valid phone number, e.g. +266 5012 3456.');
  const prefs = b.prefs ? parsePrefs(JSON.stringify({ ...parsePrefs(user.prefs), ...b.prefs })) : parsePrefs(user.prefs);
  await env.DB.prepare('UPDATE users SET name = ?, phone = ?, prefs = ? WHERE id = ?')
    .bind(name || null, phone || null, JSON.stringify(prefs), user.id).run();
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  return json({ success: true, user: publicUser(fresh, await retentionFor(env, fresh), isAdmin(env, fresh)) });
}

async function changePin(request, env, user) {
  const b = await body(request);
  const current = String(b.current_pin ?? ''), next = String(b.new_pin ?? '');
  if (!validPin(next)) return fail(400, 'Your new PIN must be 6 digits.');
  if (!validPin(current) || !sameString(await hashPin(current, user.pin_salt), user.pin_hash)) {
    return fail(401, 'Your current PIN is not correct.');
  }
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare('UPDATE users SET pin_hash = ?, pin_salt = ?, pin_set_at = ? WHERE id = ?')
    .bind(await hashPin(next, salt), salt, iso(Date.now()), user.id).run();
  return json({ success: true, message: 'PIN changed.' });
}

async function exportData(request, env, user) {
  const journeys = user.history_hash
    ? (await env.DB.prepare(
      `SELECT direction, mode, crossing_started_at, crossing_ended_at, total_minutes, queue_minutes,
              origin_post_minutes, bridge_minutes, dest_post_minutes, expires_at, route
       FROM journeys WHERE history_hash = ? ORDER BY crossing_ended_at DESC`,
    ).bind(user.history_hash).all()).results.map((j) => ({ ...j, route: j.route ? JSON.parse(j.route) : null }))
    : [];
  return new Response(JSON.stringify({
    exported_at: iso(Date.now()),
    account: publicUser(user, await retentionFor(env, user)),
    journeys,
  }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="maseru-border-times-my-data.json"',
      'cache-control': 'no-store',
    },
  });
}

async function deleteAccount(request, env, user) {
  const stmts = [];
  if (user.history_hash) {
    stmts.push(env.DB.prepare('DELETE FROM journeys WHERE history_hash = ?').bind(user.history_hash));
    stmts.push(env.DB.prepare('UPDATE trips SET history_hash = NULL WHERE history_hash = ?').bind(user.history_hash));
  }
  stmts.push(env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id));
  stmts.push(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id));
  if (user.history_hash) stmts.push(env.DB.prepare('DELETE FROM histories WHERE key_hash = ?').bind(user.history_hash));
  await env.DB.batch(stmts);
  return json({ success: true, message: 'Your account and saved journeys were deleted.' });
}

// Returns a Response for /api/auth/* and /api/me*, or null for other paths.
export async function authRoutes(request, env, p, m) {
  if (p === '/api/auth/start' && m === 'POST') return start(request, env, false);
  if (p === '/api/auth/forgot' && m === 'POST') return start(request, env, true);
  if (p === '/api/auth/login' && m === 'POST') return login(request, env);
  if (p === '/api/auth/logout' && m === 'POST') return logout(request, env);
  if (p === '/api/me' || p.startsWith('/api/me/')) {
    const user = await getSessionUser(request, env);
    if (!user) return fail(401, 'Please sign in.');
    if (p === '/api/me' && m === 'GET') return me(request, env, user);
    if (p === '/api/me' && m === 'PUT') return updateMe(request, env, user);
    if (p === '/api/me' && m === 'DELETE') return deleteAccount(request, env, user);
    if (p === '/api/me/pin' && m === 'PUT') return changePin(request, env, user);
    if (p === '/api/me/export' && m === 'GET') return exportData(request, env, user);
    return fail(404, 'Not found');
  }
  return null;
}

export function authSweep(env, now) {
  return [env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(iso(now))];
}

