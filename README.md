# Home Climate dashboard

[![CI](https://github.com/stuartb55/sensorDashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/stuartb55/sensorDashboard/actions/workflows/ci.yml)

Mobile-first temperature and humidity dashboard for the house, reading from
InfluxDB 3 and served over Tailscale at `https://dashboard.example.com`.

## Sensors

Nine sensors across two databases, unified by the registry in
`server/sensors.js`:

| Room | Source | Database |
|---|---|---|
| Living Room, Bedroom, Office, Ruuvi Air | RuuviTag (~1 reading/sec) | `ruuvi.ruuvi_measurements` |
| Bathroom, Kitchen, Hallway, Closet | IKEA TIMMERFLOTTE over Matter (~6 min) | `matter.matter` |
| Hot Water | RuuviTag on the tank | `ruuvi.ruuvi_measurements` |

Hot Water is marked `kind: "equipment"`: it sits near 47 °C while rooms sit near
25 °C, so it gets its own card section and is kept off the shared room scale.

Adding a sensor is a one-line change to `SENSORS` in `server/sensors.js` — as
long as it belongs to one of the two sources already described in `SOURCES`.

## Running it

CI publishes the image to GitHub Packages, so the host pulls rather than builds:

```bash
docker compose pull && docker compose up -d
```

`docker compose up -d --build` still builds from the checkout when a change has
not been pushed yet. The package is
[`ghcr.io/stuartb55/sensordashboard`](https://github.com/stuartb55/sensorDashboard/pkgs/container/sensordashboard),
tagged `latest` plus `sha-<commit>` for every build — pin a sha tag in
`docker-compose.yml` to roll back. A private package needs
`echo $TOKEN | docker login ghcr.io -u stuartb55 --password-stdin` on the host
first, with a PAT carrying `read:packages`; making the package public removes
that step.

The container joins the existing `docker_influxdb-network` and reaches InfluxDB
by container name. `.env` supplies `influxdb_token` and is never baked into the
image.

Local development without Docker:

```bash
npm install
npm run dev:server     # API on :8090, serves web/dist if built
npm run dev:web        # Vite dev server on :5174, proxies /api to :8090
```

## CI and dependencies

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
it builds the frontend, boots the server against a closed port to check that the
registry renders, the build is served, and an unreachable InfluxDB degrades to a
503 rather than killing the process, then builds the Docker image. Pushes to
`main` publish that image to GitHub Packages with `GITHUB_TOKEN`; pull requests
build it and stop, so an unreviewed branch never becomes `:latest`. The image
job runs after the smoke test, so nothing untested is published. `linux/amd64`
only — add to `platforms` in the workflow if the deployment host ever changes.

Renovate opens the dependency PRs. Anything below a major bump merges itself
once both CI jobs pass, after a three-day soak so a yanked release never lands
unattended; majors and Node runtime bumps wait for a human. `main` requires both
checks, with a bypass for the repo admin so direct pushes still work.

## Reverse proxy

Caddy runs on a separate tailnet node (`caddy`, <caddy-tailscale-ip>), so it
reaches this machine over the tailnet:

```
dashboard.example.com {
    reverse_proxy <dashboard-tailscale-ip>:8090
}
```

HTTPS from Caddy is what makes the dashboard installable as a PWA.

## API

| Endpoint | Returns |
|---|---|
| `GET /health` | Process status and InfluxDB reachability |
| `GET /api/sensors` | Sensor registry |
| `GET /api/readings/latest` | Current reading per sensor, 10s server-side cache |
| `GET /api/history?range=24h&sensors=a,b` | Bucketed series on a shared time axis |

Ranges are allowlisted: `1h`, `6h`, `24h`, `7d`, `30d`. No SQL reaches the
backend from the browser.

## Things worth knowing before changing the queries

These are the non-obvious behaviours of the upstream data, each confirmed by
querying the live database. `server/queries.js` depends on all of them.

- **Matter writes temperature and humidity as separate rows**, about 2 ms apart.
  "The most recent row per node" therefore returns one field populated and the
  other null. The latest-value query ranks each field independently with
  `row_number()` instead. This is the most likely thing to break.
- **Ruuvi columns are camelCase and must be double-quoted** (`"batteryVoltage"`),
  or DataFusion lowercases them and the query fails.
- **The two databases cannot be joined.** Both are queried in parallel and merged
  in the backend.
- **Matter history is much shorter than Ruuvi's.** On 7d/30d ranges those series
  legitimately start partway along the axis; they are padded with nulls, not
  zeros, so they draw as a short line.
- **Ruuvi Air reports no battery voltage** (mains-powered).
- **InfluxDB returns naive UTC timestamps** with no zone suffix. `Date.parse`
  would read them as local time, so `parseInfluxTime` appends `Z`.

## Charts

- One measure per plot — temperature and humidity get separate charts rather
  than sharing two y-scales.
- Eight rooms map onto the eight fixed categorical palette slots, validated for
  colour-blind separation in both light and dark mode. Colour follows the room,
  so filtering never repaints the survivors.
- Every chart has a table view, and tooltips never gate a value.
- Series are drawn with short gaps bridged (up to each source's expected
  reporting interval) so a sensor slower than the bucket width doesn't render as
  a dashed line. Genuine outages stay visible as gaps, and **statistics and
  table views always use the raw series** — no interpolated value is ever shown
  as a reading.

## Security

The dashboard has no authentication of its own; Tailscale plus Caddy is the
boundary. Two things to be aware of:

- Publishing `8090` on `0.0.0.0` also exposes it to this machine's LAN, matching
  how InfluxDB, Frigate and MQTT already run here. For tailnet-only, change the
  port mapping in `docker-compose.yml` to `<dashboard-tailscale-ip>:8090:8090`.
- The admin token is currently used for reads. A read-only token scoped to the
  `ruuvi` and `matter` databases would be a drop-in replacement for
  `influxdb_token` in `.env`.
