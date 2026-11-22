import { useMemo, useState } from 'react';
import Sheet, { CloseButton } from './Sheet.jsx';
import TimeChart from './TimeChart.jsx';
import TableView from './TableView.jsx';
import DailyBars from './DailyBars.jsx';
import DailyRange from './DailyRange.jsx';
import { baseLoad, dailyEnergy, dailyHighLow } from '../daily.js';
import { heatingCycles } from '../heating.js';
import { seriesColor } from '../palette.js';
import {
  bridgeGaps,
  energyUsed,
  fmtAge,
  fmtElectrical,
  fmtEnergy,
  fmtHum,
  fmtPower,
  fmtTemp,
  fmtTime,
  fmtBattery,
  fmtDuration,
  summarise,
  timeAtOrAbove,
  absoluteHumidity,
  dewPoint,
  dewPointSeries,
  DAMP_RH,
} from '../format.js';

// Above about 1,000 ppm a room is due some fresh air; it is the level most
// ventilation guidance uses as the line between fine and stuffy.
const CO2_VENTILATE = 1000;
const CO2_GUIDES = [{ value: CO2_VENTILATE, label: '1,000 ppm' }];

/**
 * `lo` and `hi` optionally supply per-bucket extremes, so Min and Max report
 * the real lowest and highest readings rather than the extremes of averages.
 */
function Stats({ values, unit, digits = 1, lo = null, hi = null }) {
  const s = summarise(values);
  if (!s) return null;
  s.min = (lo && summarise(lo)?.min) ?? s.min;
  s.max = (hi && summarise(hi)?.max) ?? s.max;
  return (
    <dl className="stats">
      <div className="stat">
        <dt>Min</dt>
        <dd>
          {s.min.toFixed(digits)}
          {unit}
        </dd>
      </div>
      <div className="stat">
        <dt>Average</dt>
        <dd>
          {s.avg.toFixed(digits)}
          {unit}
        </dd>
      </div>
      <div className="stat">
        <dt>Max</dt>
        <dd>
          {s.max.toFixed(digits)}
          {unit}
        </dd>
      </div>
    </dl>
  );
}

function Co2History({ reading, series, drawn, t, bucketSec, range, rangeLabel, color }) {
  const above = timeAtOrAbove(series.co2Hi, CO2_VENTILATE, bucketSec);
  return (
    <section className="panel">
      <h3 className="panel-title">CO₂</h3>
      <p className="panel-sub">
        Bucket average over {rangeLabel}. The rule marks {CO2_GUIDES[0].label}, roughly where a
        room starts to feel stuffy and is worth airing.
      </p>
      <TimeChart
        t={t}
        range={range}
        unit=" ppm"
        height={180}
        ariaLabel={`CO2 for ${reading.label} over ${rangeLabel}`}
        series={[{ label: 'CO₂', values: drawn.co2, color }]}
        guides={CO2_GUIDES}
      />
      <Stats values={series.co2} hi={series.co2Hi} unit=" ppm" digits={0} />
      {above != null && (
        <p className="panel-sub">
          Peaked at or above {CO2_GUIDES[0].label} for about {fmtDuration(above)} of{' '}
          {rangeLabel}.
        </p>
      )}
    </section>
  );
}

/**
 * Dew point and damp, derived from the raw temperature and humidity of each
 * bucket. Dew point is the surface temperature at which condensation forms,
 * so a cold window or outside wall near it is where mould starts.
 */
function Comfort({ reading, series, t, bucketSec, range, rangeLabel, color }) {
  const dew = useMemo(() => dewPointSeries(series.temp, series.hum), [series]);
  // Bridged like the other lines, for drawing only.
  const drawnDew = useMemo(() => bridgeGaps(dew, bucketSec, series.bridgeSec), [dew, bucketSec, series]);
  const damp = timeAtOrAbove(series.hum, DAMP_RH, bucketSec);
  const dewNow = dewPoint(reading.tempC, reading.humidity);
  const absNow = absoluteHumidity(reading.tempC, reading.humidity);
  return (
    <section className="panel">
      <h3 className="panel-title">Dew point</h3>
      <p className="panel-sub">
        Surfaces colder than this collect condensation.
        {dewNow != null &&
          ` Now ${dewNow.toFixed(1)}°C, with ${absNow.toFixed(1)} g of water in each cubic metre of air.`}
      </p>
      <TimeChart
        t={t}
        range={range}
        unit="°C"
        height={160}
        ariaLabel={`Dew point for ${reading.label} over ${rangeLabel}`}
        series={[{ label: 'Dew point', values: drawnDew, color }]}
      />
      <Stats values={dew} unit="°C" />
      {damp != null && (
        <p className={`panel-sub damp-note${damp > 0 ? ' is-damp' : ''}`}>
          {damp > 0
            ? `At or above ${DAMP_RH}% humidity for about ${fmtDuration(damp)} of ${rangeLabel}. Damp that lasts for hours lets mould take hold, so air the room or run an extractor.`
            : `Never reached ${DAMP_RH}% humidity over ${rangeLabel}, the level where lasting damp starts to risk mould.`}
        </p>
      )}
    </section>
  );
}

const fmtClock = (sec) =>
  new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Lows and highs per calendar day over the last 30 days, from /api/daily and
 * independent of the selected range, plus the extremes of the whole stretch.
 * Times are the hour in which the reading fell.
 */
function DailyClimate({ reading, daily, color }) {
  const [showTable, setShowTable] = useState(false);
  const series = daily?.series.find((s) => s.id === reading.id);
  const days = useMemo(
    () => (series ? dailyHighLow(daily.t, series.tempLo, series.tempHi) : []),
    [daily, series],
  );
  const recent = days.slice(-30);
  if (!recent.some((d) => d.min != null)) return null;

  const today = recent.at(-1);
  let coldest = null;
  let warmest = null;
  for (const d of recent) {
    if (d.min && (!coldest || d.min.value < coldest.value)) coldest = d.min;
    if (d.max && (!warmest || d.max.value > warmest.value)) warmest = d.max;
  }

  return (
    <section className="panel">
      <h3 className="panel-title">Daily highs and lows</h3>
      <p className="panel-sub">
        {today.min
          ? `Today so far: low ${today.min.value.toFixed(1)}° around ${fmtClock(today.min.sec)}, high ${today.max.value.toFixed(1)}° around ${fmtClock(today.max.sec)}.`
          : 'No reading yet today.'}
      </p>
      <DailyRange
        days={recent.map((d) => ({
          key: d.key,
          label: fmtShortDay(d.startSec),
          min: d.min?.value ?? null,
          max: d.max?.value ?? null,
        }))}
        unit="°C"
        color={color}
        ariaLabel={`Daily low and high temperature for ${reading.label} over the last 30 days`}
      />
      <dl className="stats stats-2">
        <div className="stat">
          <dt>30-day low</dt>
          <dd>
            {coldest.value.toFixed(1)}°C
            <div className="stat-sub">{fmtDay(coldest.sec)}</div>
          </dd>
        </div>
        <div className="stat">
          <dt>30-day high</dt>
          <dd>
            {warmest.value.toFixed(1)}°C
            <div className="stat-sub">{fmtDay(warmest.sec)}</div>
          </dd>
        </div>
      </dl>
      <button
        type="button"
        className="link-btn"
        onClick={() => setShowTable((v) => !v)}
        aria-expanded={showTable}
      >
        {showTable ? 'Hide table' : 'View as table'}
      </button>
      {showTable && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Daily low and high for {reading.label}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Low °C</th>
                <th scope="col">High °C</th>
              </tr>
            </thead>
            <tbody>
              {[...recent].reverse().map((d) => (
                <tr key={d.key}>
                  <td>{fmtDay(d.startSec)}</td>
                  <td>{d.min ? d.min.value.toFixed(1) : '—'}</td>
                  <td>{d.max ? d.max.value.toFixed(1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * When a tank was heated over the selected range, read from its own
 * temperature: each climb, how long it took, and how long the water was hot
 * enough to use.
 */
function Heating({ reading, series, t, bucketSec, range, rangeLabel }) {
  const { minRiseC, hotC } = reading.heating;
  const cycles = useMemo(
    () => heatingCycles(t, series.temp, minRiseC),
    [t, series, minRiseC],
  );
  const hot = timeAtOrAbove(series.temp, hotC, bucketSec);
  const coldest = summarise(series.temp)?.min;
  const at = (sec) => fmtTime(sec, range === '1h' || range === '6h' ? range : '7d');

  return (
    <section className="panel">
      <h3 className="panel-title">Heating</h3>
      <p className="panel-sub">
        {cycles.length
          ? `Heated ${cycles.length} time${cycles.length === 1 ? '' : 's'} over ${rangeLabel}: a climb of ${minRiseC}° or more counts.`
          : `No climb of ${minRiseC}° or more over ${rangeLabel}.`}
      </p>
      <dl className="stats">
        <div className="stat">
          <dt>Reheats</dt>
          <dd>{cycles.length}</dd>
        </div>
        <div className="stat">
          <dt>At {hotC}°+</dt>
          <dd>{fmtDuration(hot)}</dd>
        </div>
        <div className="stat">
          <dt>Coolest</dt>
          <dd>{coldest == null ? '—' : `${coldest.toFixed(1)}°C`}</dd>
        </div>
      </dl>
      {cycles.length > 0 && (
        <ol className="event-list heating-list">
          {[...cycles].reverse().slice(0, 20).map((c) => (
            <li key={c.from}>
              <span className="event-what">{at(c.from)}</span>
              <span className="event-when">
                {c.startC.toFixed(1)} → {c.endC.toFixed(1)}°C
              </span>
              <span className="event-note">
                +{(c.endC - c.startC).toFixed(1)}° in {fmtDuration(Math.max(c.to - c.from, bucketSec))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ClimateHistory(props) {
  const { reading, series, drawn, t, range, rangeLabel, color } = props;
  return (
    <>
      <section className="panel">
        <h3 className="panel-title">Temperature</h3>
        <p className="panel-sub">
          Bucket average over {rangeLabel}. The shaded band spans the lowest and
          highest reading within each bucket, so it stays narrow while the sensor
          holds steady.
        </p>
        <TimeChart
          t={t}
          range={range}
          unit="°C"
          height={210}
          ariaLabel={`Temperature for ${reading.label} over ${rangeLabel}`}
          series={[{ label: 'Temperature', values: drawn.temp, color }]}
          band={{ lo: drawn.lo, hi: drawn.hi }}
        />
        <Stats values={series.temp} unit="°C" />
      </section>

      <section className="panel">
        <h3 className="panel-title">Humidity</h3>
        <p className="panel-sub">Relative humidity over {rangeLabel}.</p>
        <TimeChart
          t={t}
          range={range}
          unit="%"
          height={180}
          ariaLabel={`Humidity for ${reading.label} over ${rangeLabel}`}
          series={[{ label: 'Humidity', values: drawn.hum, color }]}
        />
        <Stats values={series.hum} unit="%" digits={0} />
      </section>

      {reading.heating && <Heating {...props} />}

      <DailyClimate reading={reading} daily={props.daily} color={color} />

      {reading.kind === 'room' && <Comfort {...props} />}

      {series.co2?.some((v) => v != null) && <Co2History {...props} />}
    </>
  );
}

const fmtDay = (sec) =>
  new Date(sec * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShortDay = (sec) => new Date(sec * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });

function fmtMoney(amount, tariff) {
  if (amount == null || !tariff) return null;
  return `${tariff.currency}${amount < 10 ? amount.toFixed(2) : Math.round(amount).toLocaleString()}`;
}

/**
 * Calendar-day totals from /api/daily, independent of the selected range:
 * the last 30 days as bars, today / 7 / 30-day totals, cost where a tariff is
 * set, and the always-on draw with what it costs a year.
 */
function EnergyDays({ reading, daily, color }) {
  const [showTable, setShowTable] = useState(false);
  const series = daily?.series.find((s) => s.id === reading.id);
  const days = useMemo(
    () => (series ? dailyEnergy(daily.t, series, daily.bucketSec) : []),
    [daily, series],
  );
  if (!series || !days.some((d) => d.kwh != null)) return null;

  const tariff = daily.tariff;
  const last = (n) => days.slice(-n).reduce((sum, d) => sum + (d.kwh ?? 0), 0);
  const today = days.at(-1);
  const week = last(7);
  const month = last(30);
  const anyEstimate = days.some((d) => d.estimated);
  // A week of hourly averages, so the quietest nights set the floor.
  const base = baseLoad(series.watts.slice(-7 * 24));
  const baseYearKwh = base == null ? null : (base * 24 * 365) / 1000;
  const bars = days.slice(-30).map((d) => ({
    key: d.key,
    label: fmtShortDay(d.startSec),
    value: d.kwh,
    partial: d.partial,
  }));

  return (
    <section className="panel">
      <h3 className="panel-title">Daily use</h3>
      <p className="panel-sub">
        Energy per calendar day over the last 30 days. Today and the first day are part days,
        drawn as outlines.{anyEstimate && ' Days marked ≈ are partly estimated from average power.'}
      </p>
      <DailyBars
        bars={bars}
        unit=" kWh"
        digits={2}
        color={color}
        ariaLabel={`Energy per day for ${reading.label} over the last 30 days`}
      />
      <dl className="stats">
        {[
          ['Today', today.kwh],
          ['7 days', week],
          ['30 days', month],
        ].map(([label, kwh]) => (
          <div className="stat" key={label}>
            <dt>{label}</dt>
            <dd>
              {fmtEnergy(kwh)} kWh
              {tariff && <div className="stat-sub money">{fmtMoney(kwh * tariff.perKwh, tariff)}</div>}
            </dd>
          </div>
        ))}
      </dl>
      {base != null && (
        <p className="panel-sub damp-note">
          Always-on draw about {Math.round(base)} W, which is {Math.round(baseYearKwh)} kWh a year
          {tariff ? ` (${fmtMoney(baseYearKwh * tariff.perKwh, tariff)} at ${tariff.currency}${tariff.perKwh} per kWh)` : ''}.
        </p>
      )}
      {!tariff && (
        <p className="panel-sub">Set ENERGY_PRICE in the server’s .env to see costs.</p>
      )}
      <button
        type="button"
        className="link-btn"
        onClick={() => setShowTable((v) => !v)}
        aria-expanded={showTable}
      >
        {showTable ? 'Hide table' : 'View as table'}
      </button>
      {showTable && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Energy per day for {reading.label}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">kWh</th>
                {tariff && <th scope="col">Cost</th>}
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.key}>
                  <td>
                    {fmtDay(d.startSec)}
                    {d.partial ? ' (part)' : ''}
                  </td>
                  <td>
                    {d.kwh == null ? '—' : `${d.estimated ? '≈ ' : ''}${d.kwh.toFixed(2)}`}
                  </td>
                  {tariff && <td>{d.kwh == null ? '—' : fmtMoney(d.kwh * tariff.perKwh, tariff)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PowerHistory({ reading, series, drawn, t, bucketSec, range, rangeLabel, color, daily }) {
  const used = energyUsed(series, bucketSec);
  const hasVolts = series.volts.some((v) => v != null);
  return (
    <>
      <section className="panel">
        <h3 className="panel-title">Power</h3>
        <p className="panel-sub">
          Average draw over {rangeLabel}. The shaded band reaches the highest and
          lowest reading in each bucket, so short spikes still show.
        </p>
        <TimeChart
          t={t}
          range={range}
          unit=" W"
          height={210}
          ariaLabel={`Power for ${reading.label} over ${rangeLabel}`}
          series={[{ label: 'Power', values: drawn.watts, color }]}
          band={{ lo: drawn.lo, hi: drawn.hi }}
        />
        <Stats
          values={series.watts}
          lo={series.wattsLo}
          hi={series.wattsHi}
          unit=" W"
          digits={0}
        />
      </section>

      {used && (
        <section className="panel">
          <h3 className="panel-title">Energy used</h3>
          <p className="panel-sub">
            {used.estimated
              ? `Estimated from average power over ${rangeLabel}; gaps in the data are not counted.`
              : `From the meter’s energy counter over ${rangeLabel}.`}
          </p>
          <div className="sheet-now">
            <span className="hero">
              {used.estimated ? '≈ ' : ''}
              {fmtEnergy(used.kwh)}
            </span>
            <span>kWh</span>
          </div>
        </section>
      )}

      <EnergyDays reading={reading} daily={daily} color={color} />

      {hasVolts && (
        <section className="panel">
          <h3 className="panel-title">Voltage</h3>
          <p className="panel-sub">Mains voltage at the meter over {rangeLabel}.</p>
          <TimeChart
            t={t}
            range={range}
            unit=" V"
            height={160}
            ariaLabel={`Voltage for ${reading.label} over ${rangeLabel}`}
            series={[{ label: 'Voltage', values: drawn.volts, color }]}
          />
          <Stats values={series.volts} unit=" V" />
        </section>
      )}
    </>
  );
}

/**
 * Full history for a single sensor.
 *
 * Temperature and humidity get one chart each rather than sharing a plot with
 * two y-scales — two scales on one plot invent a correlation that isn't in the
 * data.
 */
export default function DetailSheet({
  reading,
  series,
  t,
  bucketSec,
  range,
  rangeLabel,
  daily,
  onClose,
}) {
  const [showTable, setShowTable] = useState(false);
  const color = seriesColor(reading.id, getComputedStyle(document.documentElement));

  // Bridged copies are for drawing only; statistics and the table below use the
  // raw series so no interpolated value is ever reported as a reading.
  const isPower = reading.kind === 'power';
  const drawn = useMemo(() => {
    if (!series) return null;
    const b = (v) => bridgeGaps(v, bucketSec, series.bridgeSec);
    if (series.kind === 'power') {
      return { watts: b(series.watts), volts: b(series.volts), lo: b(series.wattsLo), hi: b(series.wattsHi) };
    }
    return {
      temp: b(series.temp),
      hum: b(series.hum),
      lo: b(series.tempLo),
      hi: b(series.tempHi),
      co2: series.co2 ? b(series.co2) : null,
    };
  }, [series, bucketSec]);

  const hasHistory = series && t.length > 0;
  const battery = fmtBattery(reading.battery, reading.batteryKind);
  const power = fmtPower(reading.watts);
  const historyProps = { reading, series, drawn, t, bucketSec, range, rangeLabel, color, daily };

  return (
    <Sheet label={`${reading.label} detail`} onClose={onClose}>
        <div className="sheet-head">
          <div>
            <h2>{reading.label}</h2>
            {isPower ? (
              <div className="sheet-now">
                <span className="hero">
                  {power.value} {power.unit}
                </span>
                <span>{fmtElectrical(reading.volts, reading.amps)}</span>
              </div>
            ) : (
              <div className="sheet-now">
                <span className="hero">{fmtTemp(reading.tempC)}°</span>
                <span>{fmtHum(reading.humidity)}% humidity</span>
              </div>
            )}
            <div className="card-note" style={{ marginTop: 6 }}>
              {reading.stale && <span className="dot bad" aria-hidden="true" />}
              {fmtAge(reading.ageSec)}
              {battery && ` · battery ${battery}`}
            </div>
          </div>
<CloseButton onClose={onClose} />
        </div>

        {!hasHistory ? (
          <p className="empty">No history for this sensor in the selected range.</p>
        ) : (
          <div className="stack">
            {isPower ? <PowerHistory {...historyProps} /> : <ClimateHistory {...historyProps} />}

            <div>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowTable((v) => !v)}
                aria-expanded={showTable}
              >
                {showTable ? 'Hide table' : 'View as table'}
              </button>
              {showTable && (
                <TableView
                  t={t}
                  range={range}
                  caption={`${reading.label} readings over ${rangeLabel}`}
                  columns={
                    isPower
                      ? [
                          { label: 'Power W', values: series.watts, digits: 0 },
                          { label: 'Peak W', values: series.wattsHi, digits: 0 },
                          { label: 'Current A', values: series.amps, digits: 2 },
                          { label: 'Voltage V', values: series.volts },
                        ].filter((c) => c.values.some((v) => v != null))
                      : [
                          { label: 'Temp °C', values: series.temp },
                          { label: 'Humidity %', values: series.hum, digits: 0 },
                          ...(reading.kind === 'room'
                            ? [{ label: 'Dew point °C', values: dewPointSeries(series.temp, series.hum) }]
                            : []),
                          ...(series.co2 ? [{ label: 'CO₂ ppm', values: series.co2, digits: 0 }] : []),
                        ]
                  }
                />
              )}
            </div>
          </div>
        )}
    </Sheet>
  );
}
