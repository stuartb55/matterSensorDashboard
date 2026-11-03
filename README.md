# Home Climate dashboard

[![CI](https://github.com/stuartb55/matterSensorDashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/stuartb55/matterSensorDashboard/actions/workflows/ci.yml)

Mobile-first temperature, humidity and power dashboard for the house, reading from InfluxDB 3

## Sensors

Twelve sensors across two databases, unified by the registry in
`server/sensors.js`:

| Device | Source | Database |
|---|---|---|
| Living Room, Bedroom, Office, Ruuvi Air | RuuviTag (~1 reading/sec) | `ruuvi.ruuvi_measurements` |
| Bathroom, Kitchen, Hallway, Closet | IKEA TIMMERFLOTTE over Matter (~6 min) | `matter.matter` |
| Hot Water | RuuviTag on the tank | `ruuvi.ruuvi_measurements` |
| Garage, Back Door | IKEA MYGGBETT contact sensor over Matter | `matter.matter` |
| Network | Shelly 1PM Gen4 power meter over Matter | `matter.matter` |

Hot Water is marked `kind: "equipment"`: it sits near 47 °C while rooms sit near
25 °C, so it gets its own card section and is kept off the shared room scale.
Door contacts are marked `kind: "door"` and show their last known open/closed
state and when it last changed. Because they only report when the state changes,
an unchanged door is not treated as offline.

The Shelly 1PM Gen4 (Matter node `Network`, node ID `7`) is marked
`kind: "power"` and gets its own Energy section: the current draw, the energy
used over the selected range and the current, plus a detail sheet with a power
chart. Its column names live in `SOURCES.matter.power` (`power_w`, `current_a`,
`voltage_v`, and the lifetime counter `energy_wh`), each with a `scale` to
W/A/V/kWh. Power and current are written only when they change; energy once a
minute. This model leaves `voltage_v` empty, so the voltage chart stays hidden. Configured columns
missing from the table are skipped (looked up through `information_schema`), so
a wrong name blanks one figure rather than the dashboard. Without an energy
counter, energy used is estimated from average power and marked with "≈".

The Garage sensor is Matter node `Garage` (node ID `6`, endpoint `1`). Its
`contact_closed` field is a float: `1.0` means the garage door is shut and
`0.0` means it is open.

Adding a sensor is a one-line change to `SENSORS` in `server/sensors.js` — as
long as it belongs to one of the two sources already described in `SOURCES`.

## Running it

CI publishes the image to GitHub Packages, so the host pulls rather than builds:

```bash
docker compose pull && docker compose up -d
```

`docker compose up -d --build` still builds from the checkout when a change has
not been pushed yet. The package is
[`ghcr.io/stuartb55/mattersensordashboard`](https://github.com/stuartb55/matterSensorDashboard/pkgs/container/mattersensordashboard),
tagged `latest` plus `sha-<commit>` for every build — pin a sha tag in
`docker-compose.yml` to roll back. A private package needs
`echo $TOKEN | docker login ghcr.io -u stuartb55 --password-stdin` on the host
first, with a PAT carrying `read:packages`; making the package public removes
that step.

The container joins the existing `docker_influxdb-network`. `.env` supplies
`influxdb_token` and `INFLUX_URL` (see `.env.example`) and is never baked into
the image; `docker compose` refuses to start without `INFLUX_URL`.

Local development without Docker:

```bash
npm install
npm run dev:server     # API on :8090, serves web/dist if built
npm run dev:web        # Vite dev server on :5174, proxies /api to :8090
```

## Floor plan

The Floor plan section shows each floor's plan with every sensor's live reading
pinned where it is. Tap a sensor to open its detail sheet.

A plan of the house identifies it, so the real one never goes in this
repository. The server reads it from a `floorplan/` folder next to
`docker-compose.yml` (gitignored, mounted read-only at `/app/floorplan`; set
`FLOORPLAN_DIR` to read it from elsewhere when running without Docker). Until
that folder has a `floorplan.json`, the generic example in
`server/floorplan-example/` is shown.

To set it up on the host:

1. Save each floor's plan image (`.png`, `.jpg`, `.webp`, `.gif` or `.svg`)
   into `floorplan/`, for example `floorplan/ground.png` and
   `floorplan/first.png`. If one image holds both floors, crop it into two.
2. Copy `server/floorplan-example/floorplan.json` into `floorplan/` and change
   each floor's `image` to your file name.
3. Open the dashboard, tap **Edit positions**, drag each sensor to where it
   really is (tap a sensor in the list, then the plan, to add one that isn't
   placed yet), then **Copy floorplan.json** or **Download** and replace
   `floorplan/floorplan.json` with it.

The file is re-read on every page load, so no restart is needed. Positions are
fractions of the image's width and height (`x` 0 to 1 from the left, `y` 0 to 1
from the top), so they survive swapping in a higher resolution image. Unsaved
edits are kept in the browser until they're exported or discarded; the server
never writes the file itself.

```json
{
  "floors": [
    {
      "id": "ground",
      "label": "Ground floor",
      "image": "ground.png",
      "markers": { "kitchen": { "x": 0.72, "y": 0.3 } }
    }
  ]
}
```

Marker keys are sensor ids from `server/sensors.js`; unknown ids are ignored.

## CI and dependencies

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:
it builds the frontend, boots the server against a closed port to check that the
registry renders, the build is served, and an unreachable InfluxDB degrades to a
503 rather than killing the process, then builds the Docker image. Pushes to
`main` publish that image to GitHub Packages with `GITHUB_TOKEN`; pull requests
build it and stop, so an unreviewed branch never becomes `:latest`. The image
job runs after the smoke test, so nothing untested is published. It is a
multi-platform image (`linux/amd64` and `linux/arm64`), because a manifest
missing the host's architecture fails `docker compose pull` outright; the arm64
leg is emulated, but only for the runtime stage, since the frontend build stage
is pinned to the builder's architecture.

Renovate opens the dependency PRs. Anything below a major bump merges itself
once both CI jobs pass, after a three-day soak so a yanked release never lands
unattended; majors and Node runtime bumps wait for a human. `main` requires both
checks, with a bypass for the repo admin so direct pushes still work.

## API

| Endpoint | Returns |
|---|---|
| `GET /health` | Process status and InfluxDB reachability |
| `GET /api/sensors` | Sensor registry |
| `GET /api/readings/latest` | Current reading per sensor, 10s server-side cache |
| `GET /api/history?range=24h&sensors=a,b` | Bucketed series on a shared time axis |
| `GET /api/floorplan` | Floors, their image URLs and sensor positions |
| `GET /api/floorplan/image/:floor` | The image for one floor |

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
