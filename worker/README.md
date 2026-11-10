# Tsela: Maseru Bridge crossing times (Cloudflare)

Live Maseru Bridge crossing times measured by travellers' phones inside a
geofence around the border. It runs as one Cloudflare Worker: static pages from
`public/` (bundled into the Worker by `src/static.js`) and a JSON API under `/api/`, with a D1 (SQLite) database and a
scheduled clean-up job. There are no cameras.

## How it works

- **Trips.** When someone taps Start inside the border area, the page creates an
  anonymous trip (random UUID plus a secret write key, of which only the hash
  is stored). It then sends GPS fixes every 20 s. The server drops any fix
  outside the outer geofence.
- **Zones.** `src/zones.json` lists circles for each side's queue, each border
  post and the bridge. When a trip ends, its fixes are matched to zones to get
  the direction and segment times (queue, first post, bridge, second post).
  **The coordinates are still a draft (`calibrated: false`).** Replace them
  using GPX tracks recorded with the page's "Record my route" option.
- **Estimate.** `GET /api/estimate` returns one number per direction, from the
  best data available: measured (3 or more crossings in the last 90 min), early
  estimate, traveller window reports, phones in the queue now, or the typical
  time for that weekday and hour.
- **My journeys (opt-in).** Users can save their own crossings for 7, 30, 60 or
  90 days. Journeys are stored under the hash of a random history key kept on
  the phone, with no name or phone number. The link between an anonymous trip
  and a history is removed as soon as the trip is finalised.
- **Route map.** The Now tab shows the zones, your position and your route on an
  OpenStreetMap map (Leaflet from cdnjs). The route is kept in the browser's
  local storage only and is never sent to the server.
- **Clean-up (cron, every 5 min).** Finalises trips silent for 30 min, deletes
  raw fixes older than 48 h, deletes journeys past their retention period, and
  deletes window reports older than 24 months.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/zones` | Geofence definition |
| GET | `/api/estimate` | Current time per direction |
| POST | `/api/trips` | `{mode, history_key?}` returns `{trip_id, trip_key}` |
| POST | `/api/trips/:id/pings` | Header `X-Trip-Key`; `{pings:[{lat,lng,t,acc,spd}]}` |
| POST | `/api/trips/:id/end` | Header `X-Trip-Key` |
| POST | `/api/window-report` | `{direction, post, windows_open?, people_ahead?, queue_minutes?, minutes_at_window?}` |
| POST | `/api/history/register` | `{retention_days}` returns `{history_key}` |
| GET | `/api/history` | Header `X-History-Key` |
| PUT | `/api/history/settings` | `{retention_days: 7 \| 30 \| 60 \| 90}` |
| DELETE | `/api/history/journeys/:id` | Delete one journey |
| DELETE | `/api/history` | Delete all journeys and the history |

## Develop

```bash
npm install
npm run db:migrate:local
npm run dev              # http://localhost:8787
npm test                 # unit tests (src/core.js)
node test/e2e.mjs http://localhost:8787   # end-to-end against wrangler dev
```

## Deploy

```bash
npx wrangler d1 create maseru-border-times   # once; put the id in wrangler.toml
npm run db:migrate:remote
npm run deploy
```

Live at https://traffic.4dcs.co.za (custom domain) and
https://maseru-border-times.sehsan-rizvi.workers.dev. D1 database
`maseru-border-times`, region WEUR.

When you add a page or image to `public/`, add it to `src/static.js` too.
`manifest.json` and `sw.js` are stored as `.txt` so they bundle as text.
