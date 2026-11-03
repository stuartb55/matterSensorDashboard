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

The Floor plan section draws each floor of the house and pins every sensor's
live reading where it is. Tap a sensor to open its detail sheet.

The plan is drawn in the browser as SVG from a JSON layout of rooms, doors,
windows and stairs, so changing a colour or adding a room is an edit to that
file, not a new image. Colours come from the theme (`--plan-room`,
`--plan-wall`, `--plan-window` and friends in `web/src/theme.css`), so the plan
follows light and dark mode, and any room can take its own `fill`.

A layout of the house identifies it, so the real one never goes in this
repository. The server reads `floorplan.json` from a `floorplan/` folder next to
`docker-compose.yml` (gitignored, mounted read-only at `/app/floorplan`; set
`FLOORPLAN_DIR` to read it from elsewhere when running without Docker). Until
that file exists, the generic example in `server/floorplan-example/` is shown,
which is also the best starting point for your own.

```json
{
  "floors": [
    {
      "id": "ground",
      "label": "Ground floor",
      "width": 800,
      "height": 500,
      "rooms": [
        { "name": "Kitchen", "rect": [400, 20, 380, 280] },
        { "name": "Garage", "rect": [440, 300, 340, 180], "fill": "var(--plan-outbuilding)" },
        { "name": "Bay room", "points": [[20, 60], [60, 20], [360, 20], [400, 60], [400, 300], [20, 300]] }
      ],
      "doors": [{ "from": [780, 40], "to": [780, 100] }],
      "windows": [{ "from": [480, 20], "to": [700, 20] }],
      "stairs": [{ "rect": [180, 400, 110, 70], "steps": 8, "along": "x" }],
      "markers": { "kitchen": { "x": 580, "y": 150 } }
    }
  ]
}
```

- Units are whatever you like (pixels, centimetres): `width` and `height` set
  the drawing's size and everything else is in the same units, with `0, 0` at
  the top left. Leave a margin round the outside walls.
- A room is a `rect` (`[x, y, width, height]`) or a polygon of `points`. Its
  `name` is centred unless `label: [x, y]` places it; `labelSize` scales it for
  small rooms. Rooms are drawn in order, so a cupboard listed after the landing
  sits on top of it. `fill` takes a hex colour, a colour name or `var(--token)`.
- Doors are gaps cut into a wall and windows are panes drawn over it, each a
  segment from `from` to `to` along the wall. `barriers` are low walls,
  banisters and other half-height partitions, drawn thinner than a wall, in the
  same `from`/`to` form.
- `markers` maps sensor ids from `server/sensors.js` to where they sit; unknown
  ids are ignored. The easiest way to set them is **Edit positions** in the
  dashboard: drag each sensor into place (tap one in the list, then the plan, to
  add one that isn't placed), then **Copy floorplan.json** or **Download** and
  replace the file. Unsaved edits stay in the browser until exported or
  discarded; the server never writes the file itself.

The file is re-read on every page load, so no restart is needed.

## Hue lights

Philips Hue lights are read live from the Hue Bridge's local API and shown
view-only: one card per room set up in the Hue app, with each bulb's on/off
state and brightness. Nothing is written to the bridge. Lights skip InfluxDB, so
there is no history, only what is on now.

Set two values in `.env` (see `.env.example`):

- `HUE_BRIDGE`: the bridge's LAN address.
- `HUE_APP_KEY`: press the round link button on the bridge, then within 30
  seconds run
  `curl -k -X POST https://<bridge-address>/api -d '{"devicetype":"sensordashboard#server","generateclientkey":true}'`
  and use the `username` it returns.

Without them the Lights section is hidden. A bulb switched off at the wall shows
as unreachable rather than off. Each Hue room can also go on the floor plan:
it appears in **Edit positions** as "<room> lights" and is stored in
`floorplan.json` under the id `lights:<room_name>` (lowercase, underscores).

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
| `GET /api/floorplan` | Floor layouts and sensor positions |
| `GET /api/lights` | Hue lights grouped by room, 10s server-side cache |

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
