import { useMemo } from 'react';
import Sparkline from './Sparkline.jsx';
import { seriesVar } from '../palette.js';
import {
  bridgeGaps,
  fmtAge,
  fmtBattery,
  fmtHum,
  fmtTemp,
  batteryLow,
  trend,
} from '../format.js';

/**
 * Stat tile for one sensor: label, current value, humidity, trend and a
 * sparkline over the selected range.
 */
export default function SensorCard({ reading, history, bucketSec, rangeLabel, onOpen }) {
  const { id, label, tempC, humidity, battery, batteryKind, stale, ageSec } = reading;
  // Trend uses the raw series — never the bridged copy.
  const delta = history ? trend(history.temp) : null;
  const lowBattery = batteryLow(battery, batteryKind);

  const sparkValues = useMemo(
    () => (history ? bridgeGaps(history.temp, bucketSec, history.bridgeSec) : null),
    [history, bucketSec],
  );

  let arrow = '';
  let deltaText = null;
  if (delta != null && Math.abs(delta) >= 0.1) {
    arrow = delta > 0 ? '↑' : '↓';
    deltaText = `${arrow} ${Math.abs(delta).toFixed(1)}° over ${rangeLabel}`;
  } else if (delta != null) {
    deltaText = `steady over ${rangeLabel}`;
  }

  return (
    <button
      type="button"
      className={`card${stale ? ' is-stale' : ''}`}
      onClick={() => onOpen(id)}
      aria-label={`${label}, ${fmtTemp(tempC)} degrees, ${fmtHum(humidity)} percent humidity. Open detail.`}
    >
      <div className="card-top">
        <p className="card-label">{label}</p>
        {stale ? (
          <span className="card-note">
            <span className="dot bad" aria-hidden="true" />
            {fmtAge(ageSec)}
          </span>
        ) : lowBattery ? (
          // Status never rides on colour alone — icon plus label.
          <span className="card-note" title="Battery low">
            <span className="dot warn" aria-hidden="true" />
            {fmtBattery(battery, batteryKind)}
          </span>
        ) : null}
      </div>

      <div className="card-value">
        <span className="card-temp">{fmtTemp(tempC)}</span>
        <span className="card-unit">°C</span>
      </div>

      <div className="card-sub">
        <span>{fmtHum(humidity)}% humidity</span>
        {deltaText && <span className="delta">{deltaText}</span>}
      </div>

      {sparkValues && <Sparkline values={sparkValues} color={seriesVar(id)} />}
    </button>
  );
}
