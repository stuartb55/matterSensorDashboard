# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Mobile-first temperature/humidity dashboard for a house, reading from InfluxDB 3
and served over Tailscale behind Caddy. Fastify API + React/uPlot SPA in one
repo, one `package.json`, one origin. See `README.md` for
the deployment topology (Caddy on a separate tailnet node) and the sensor
inventory.

## Commands

```bash
npm install
npm run dev:server   # API on :8090 via `node --env-file=.env`; serves web/dist if built
npm run dev:web      # Vite on :5174, proxies /api and /health to :8090
npm run build        # Vite build -> web/dist
npm start            # production entry; expects the token already in the environment

docker compose pull && docker compose up -d   # deploy the published image
docker compose up -d --build                 # build locally instead
```

Typical loop is both dev servers at once — `dev:server` alone is API-only until
something has run `build` (it logs a warning and skips static serving).

There is no test suite, linter, or formatter configured. Don't invent commands
for them; verify changes by running the app against the live database.

CI (`.github/workflows/ci.yml`) is the only automated check: build the frontend,
boot the server against a closed port and assert the four things that hold
without InfluxDB, then build the image. Reproduce it locally with `npm run build`
plus the smoke block from that file. If you add a job, add its `name` to the
required checks in the `main` ruleset or Renovate will merge past it.

Pushes to `main` publish the image to `ghcr.io/stuartb55/mattersensordashboard`
(`latest` and `sha-<commit>`); pull requests build it without pushing. The
image job `needs: build`, so an image is only published once the smoke test has
passed. It is built for `linux/amd64` and `linux/arm64` — the deployment host
is Apple silicon, and dropping either one makes `docker compose pull` fail with
"no matching manifest" on that architecture.

`.env` supplies `influxdb_token` and `INFLUX_URL` and is gitignored and
dockerignored; `.env.example` shows the shape. Keep hostnames, tailnet IPs and
LAN addresses out of committed files — the repository is public.
`server/influx.js` accepts either `INFLUX_TOKEN` or `influxdb_token` and throws
at startup if neither is set.

## Architecture

**The sensor registry is the spine.** `server/sensors.js` holds `SOURCES` (the
two upstream schemas) and `SENSORS` (eleven devices). Everything else — SQL
generation, response shaping, staleness, battery units, the public `/api/sensors`
payload — derives from it. Adding a sensor from an existing source is a one-line
change there and nothing else. `publicRegistry()` is the boundary that keeps
database names and column names off the wire.

**The browser never sends SQL.** `server/queries.js` builds every statement from
registry values and the `RANGES` allowlist (`1h`/`6h`/`24h`/`7d`/`30d`); the only
client input reaching a query is a range key and a list of sensor ids matched
against the registry. `server/influx.js` is the sole holder of the token and the
only module that talks to InfluxDB. Keep that split.

**Two databases, merged in the backend.** `ruuvi` and `matter` cannot be joined,
so both are queried in parallel and normalised into one shape. `fetchLatest()`
returns a row for every registered sensor, with nulls and `stale: true` for ones
that have gone quiet — sensors never vanish from the UI.

**The history contract.** `fetchHistory()` returns
`{ range, bucketSec, t[], series[] }`, where `t` is an evenly spaced,
epoch-anchored axis (matching `date_bin`) and every series is padded to its full
length with **nulls, not zeros**. Each climate series also carries `bridgeSec`
— the longest silence that is normal for that sensor. Door contacts are
event-driven state, not climate series, so they are deliberately excluded.
The whole frontend assumes this shared axis; charts, sparklines and tables index
into it directly.

**Frontend state lives in `App.jsx`.** It owns the selected range and both
polling loops (latest every 30s, history every 120s), pauses them on
`visibilitychange`, and passes slices down. Components are presentational.
`api.js` duplicates the range list for the button row — keep it in step with
`RANGES` in `server/queries.js`.

## Invariants that are easy to break

These come from the real behaviour of the upstream data, each confirmed against
the live database.

- **Matter writes temperature and humidity as separate rows**, ~2 ms apart, so
  "most recent row per node" gives one populated field and one null.
  `latestMatter()` ranks each field independently with `row_number()`. This is
  the most likely thing to break when touching the latest-value query.
- **Ruuvi columns are camelCase and must stay double-quoted** (`"batteryVoltage"`)
  or DataFusion lowercases them and the query fails.
- **InfluxDB returns naive UTC timestamps.** Always go through `parseInfluxTime`;
  bare `Date.parse` reads them as local time.
- **Staleness thresholds are per-source, not global** — Ruuvi 120s, Matter 2700s
  (measured Matter gaps reach 29 min in normal operation).
- **Matter history is much shorter than Ruuvi's**, so on 7d/30d those series
  legitimately start partway along the axis.
- **Hot Water is `kind: "equipment"`** — it sits near 47 °C and must stay off any
  shared room scale, or every room curve flattens.

## Charting and presentation rules

- One measure per plot. Temperature and humidity get separate charts; never two
  y-scales on one plot.
- Colour follows the entity. `palette.js` maps each sensor id to a fixed
  categorical slot (`--series-1`…`--series-8` in `theme.css`, validated for
  colour-blind separation in both themes), so filtering never repaints the
  survivors. Eight rooms, eight slots — no cycling or generated hues. Status
  colours are reserved for state and never used for a series.
- `bridgeGaps()` output is for **drawing only**. Statistics, tooltips and table
  views always read the raw series, so no interpolated value is ever shown as a
  reading. Every chart has a table view, and identity is never carried by colour
  alone.
- uPlot needs explicit pixel dimensions and only binds mouse events; `TimeChart`
  handles both (ResizeObserver, plus touch forwarding for the crosshair).

## Deployment notes

- The container reaches InfluxDB at `INFLUX_URL` from `.env` (compose refuses to
  start without it); `localhost:8181` would resolve to the dashboard container
  itself.
- `docker-compose.yml` carries both `image:` (the GHCR package, `pull_policy:
  always`) and `build:`. Plain `up -d` deploys what CI published; `--build`
  builds the checkout and tags it with the same name. GHCR image names must be
  lowercase, hence `mattersensordashboard`, not `matterSensorDashboard`.
- `/health` runs `SELECT 1` rather than InfluxDB's `/ping`, which needs a
  system-level token this one doesn't have. Its probe timeout (4s) is
  deliberately under the container healthcheck timeout (5s).
- The service worker caches the app shell only; `/api/*` and `/health` are always
  network-first so stale temperatures are never displayed as current.
- No authentication of its own — Tailscale plus Caddy is the boundary.
