import { useEffect, useMemo, useRef, useState } from 'react';
import TimeChart from './TimeChart.jsx';
import TableView from './TableView.jsx';
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
  fmtBattery,
  summarise,
} from '../format.js';

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

function ClimateHistory({ reading, series, drawn, t, range, rangeLabel, color }) {
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
    </>
  );
}

function PowerHistory({ reading, series, drawn, t, bucketSec, range, rangeLabel, color }) {
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
  onClose,
}) {
  const [showTable, setShowTable] = useState(false);
  const sheetRef = useRef(null);
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
    return { temp: b(series.temp), hum: b(series.hum), lo: b(series.tempLo), hi: b(series.tempHi) };
  }, [series, bucketSec]);

  // Close on Escape, and keep focus inside the sheet while it's open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    sheetRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const hasHistory = series && t.length > 0;
  const battery = fmtBattery(reading.battery, reading.batteryKind);
  const power = fmtPower(reading.watts);
  const historyProps = { reading, series, drawn, t, bucketSec, range, rangeLabel, color };

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${reading.label} detail`}
        ref={sheetRef}
        tabIndex={-1}
      >
        <div className="grabber" aria-hidden="true" />

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
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
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
                        ]
                  }
                />
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
