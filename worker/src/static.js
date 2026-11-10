// Static pages bundled into the Worker (no separate asset upload).
import indexHtml from '../public/index.html';
import privacyHtml from '../public/privacy.html';
import notFoundHtml from '../public/404.html';
import manifest from '../public/manifest.json.txt';
import serviceWorker from '../public/sw.js.txt';
import icon192 from '../public/icon-192.png';
import icon512 from '../public/icon-512.png';
import ogImage from '../public/og-image.png';
import logo from '../public/logo.png';
import appleIcon from '../public/apple-touch-icon.png';
import favicon from '../public/favicon.png';

const HTML = 'text/html; charset=utf-8';
const PAGE_CACHE = 'public, max-age=0, must-revalidate';
const IMAGE_CACHE = 'public, max-age=86400';

const FILES = {
  '/': [indexHtml, HTML, PAGE_CACHE],
  '/index.html': [indexHtml, HTML, PAGE_CACHE],
  '/privacy': [privacyHtml, HTML, PAGE_CACHE],
  '/privacy.html': [privacyHtml, HTML, PAGE_CACHE],
  '/manifest.json': [manifest, 'application/manifest+json', PAGE_CACHE],
  '/sw.js': [serviceWorker, 'text/javascript; charset=utf-8', 'no-cache'],
  '/icon-192.png': [icon192, 'image/png', IMAGE_CACHE],
  '/icon-512.png': [icon512, 'image/png', IMAGE_CACHE],
  '/og-image.png': [ogImage, 'image/png', IMAGE_CACHE],
  '/logo.png': [logo, 'image/png', IMAGE_CACHE],
  '/apple-touch-icon.png': [appleIcon, 'image/png', IMAGE_CACHE],
  '/favicon.png': [favicon, 'image/png', IMAGE_CACHE],
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
};

export function serveStatic(request, path) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  const file = FILES[path || '/'];
  const [body, type, cache] = file || [notFoundHtml, HTML, 'no-store'];
  return new Response(request.method === 'HEAD' ? null : body, {
    status: file ? 200 : 404,
    headers: { 'content-type': type, 'cache-control': cache, ...SECURITY_HEADERS },
  });
}
