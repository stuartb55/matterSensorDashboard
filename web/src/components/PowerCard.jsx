import { useMemo } from 'react';
import Sparkline from './Sparkline.jsx';
import { seriesVar } from '../palette.js';
import { bridgeGaps, energyUsed, fmtAge, fmtAmps, fmtEnergy, fmtPower, fmtVolts } from '../format.js';

/**
 * Stat tile for a power meter: what is being drawn right now, how much energy
 * went through it over the selected range, and the shape of the load.
 */
export default function PowerCard({ reading, history, bucketSec, rangeLabel, onOpen }) {
  const { id, label, watts, volts, amps, stale, ageSec } = reading;
  const now = fmtPower(watts);
  // Consumption reads the raw series — never the bridged copy.
  const used = useMemo(() => energyUsed(history, bucketSec), [history, bucketSec]);

  const sparkValues = useMemo(
    () => (history ? bridgeGaps(history.watts, bucketSec, history.bridgeSec) : null),
    [history, bucketSec],
  );

  const usedText = used
    ? `${used.estimated ? '≈ ' : ''}${fmtEnergy(used.kwh)} kWh over ${rangeLabel}`
    : null;

  return (
    <button
      type="button"
      className={`card${stale ? ' is-stale' : ''}`}
      onClick={() => onOpen(id)}
      aria-label={`${label}, using ${now.value} ${now.unit === 'kW' ? 'kilowatts' : 'watts'}${
        usedText ? `, ${usedText}` : ''
      }. Open detail.`}
    >
      <div className="card-top">
        <p className="card-label">{label}</p>
        {stale && (
          <span className="card-note">
            <span className="dot bad" aria-hidden="true" />
            {fmtAge(ageSec)}
          </span>
        )}
      </div>

      <div className="card-value">
        <span className="card-temp">{now.value}</span>
        <span className="card-unit">{now.unit}</span>
      </div>

      <div className="card-sub">
        {usedText && <span>{usedText}</span>}
        {(volts != null || amps != null) && (
          <span className="delta">
            {fmtVolts(volts)} V · {fmtAmps(amps)} A
          </span>
        )}
      </div>

      {sparkValues && <Sparkline values={sparkValues} color={seriesVar(id)} />}
    </button>
  );
}
