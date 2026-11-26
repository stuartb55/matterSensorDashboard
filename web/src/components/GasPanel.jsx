import { useMemo, useState } from 'react';
import DailyBars from './DailyBars.jsx';
import { meanSeries } from '../format.js';
import { comparePeriods, dayCost, dayMeans, gasDays, withWeather } from '../gas.js';

const fmtDay = (sec) =>
  new Date(sec * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShortDay = (sec) => new Date(sec * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });
const fmtKwh = (v) => (v == null ? '—' : v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString());

function fmtMoney(amount, tariff) {
  if (amount == null || !tariff) return null;
  return `${tariff.currency}${amount < 100 ? amount.toFixed(2) : Math.round(amount).toLocaleString()}`;
}

function fmtChange(now, before) {
  if (now == null || before == null || before <= 0) return null;
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 0.5) return 'same as the week before';
  return `${pct < 0 ? '↓' : '↑'} ${Math.abs(pct).toFixed(0)}% on the week before`;
}

/**
 * Heating gas per calendar day from the smart meter, with what it cost and a
 * weather-adjusted figure (gas per degree of indoor-outdoor difference) that
 * shows whether a change to the heating worked. Gas is not a sensor, so it
 * draws in neutral ink rather than a categorical slot.
 */
export default function GasPanel({ gas, daily, weather }) {
  const [showTable, setShowTable] = useState(false);

  const days = useMemo(() => {
    if (!gas?.t?.length) return [];
    const base = gasDays(gas.t, gas.kwh);
    const rooms = (daily?.series ?? []).filter((s) => s.kind === 'room');
    const inside = rooms.length ? dayMeans(daily.t, meanSeries(rooms.map((s) => s.temp))) : new Map();
    const outside = weather?.hourly?.t?.length
      ? dayMeans(weather.hourly.t, weather.hourly.temp)
      : new Map();
    return withWeather(base, inside, outside);
  }, [gas, daily, weather]);

  if (!days.some((d) => d.kwh != null)) return null;

  const tariff = gas.tariff;
  const recentDays = days.slice(-30);
  const lastFull = [...days].reverse().find((d) => !d.partial && d.kwh != null) ?? null;
  const { recent, before } = comparePeriods(days, 7);
  const hasPerDegree = recentDays.some((d) => d.perDegree != null);

  const bars = recentDays.map((d) => ({
    key: d.key,
    label: fmtShortDay(d.startSec),
    value: d.kwh,
    partial: d.partial,
  }));
  const degreeBars = recentDays.map((d) => ({
    key: d.key,
    label: fmtShortDay(d.startSec),
    value: d.perDegree,
    partial: false,
  }));

  const ink = 'var(--text-secondary)';
  const conversion =
    gas.units === 'm3'
      ? ` The meter reads in cubic metres, converted at ${gas.kwhPerUnit} kWh per m³.`
      : '';

  return (
    <section className="panel">
      <h3 className="panel-title">Heating gas</h3>
      <p className="panel-sub">
        Gas per day from the smart meter, whose readings reach Octopus about a day late.
        Part days are drawn as outlines.{conversion}
      </p>
      <DailyBars
        bars={bars}
        unit=" kWh"
        digits={1}
        color={ink}
        ariaLabel="Heating gas per day over the last 30 days"
      />
      <dl className="stats">
        {lastFull && (
          <div className="stat">
            <dt>{fmtShortDay(lastFull.startSec)}</dt>
            <dd>
              {fmtKwh(lastFull.kwh)} kWh
              {tariff && <div className="stat-sub money">{fmtMoney(dayCost(lastFull.kwh, tariff), tariff)}</div>}
            </dd>
          </div>
        )}
        {recent && (
          <div className="stat">
            <dt>Last 7 days</dt>
            <dd>
              {fmtKwh(recent.kwh)} kWh
              {tariff && (
                <div className="stat-sub money">
                  {fmtMoney(recent.kwh * tariff.perKwh + 7 * (tariff.standingPerDay ?? 0), tariff)}
                </div>
              )}
              {before && <div className="stat-sub">{fmtChange(recent.kwh, before.kwh)}</div>}
            </dd>
          </div>
        )}
        {recent?.perDegree != null && (
          <div className="stat">
            <dt>Per degree, 7 days</dt>
            <dd>
              {recent.perDegree.toFixed(2)} kWh/°C
              {before?.perDegree != null && (
                <div className="stat-sub">{fmtChange(recent.perDegree, before.perDegree)}</div>
              )}
            </dd>
          </div>
        )}
      </dl>

      {hasPerDegree && (
        <>
          <h4 className="panel-title">Gas per degree</h4>
          <p className="panel-sub">
            Each day’s gas divided by how much warmer the rooms were than outside, which takes most
            of the weather out. Sun and wind still move it a little, so judge a change to the
            heating by a week or two of these, not one day. Days with less than 3° between inside
            and outside are left out.
          </p>
          <DailyBars
            bars={degreeBars}
            unit=" kWh/°C"
            digits={2}
            color={ink}
            ariaLabel="Heating gas per degree of indoor-outdoor difference, per day, over the last 30 days"
          />
        </>
      )}

      {tariff ? (
        <p className="panel-sub">
          Costs at {(tariff.perKwh * 100).toFixed(2)}p per kWh
          {tariff.standingPerDay != null &&
            ` plus a ${(tariff.standingPerDay * 100).toFixed(2)}p daily standing charge`}
          , including VAT{tariff.source === 'octopus' ? ', from your current Octopus tariff' : ''}.
        </p>
      ) : (
        <p className="panel-sub">Set GAS_PRICE in the server’s .env to see costs.</p>
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
            <caption className="sr-only">Heating gas per day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">kWh</th>
                {tariff && <th scope="col">Cost</th>}
                <th scope="col">Inside °C</th>
                <th scope="col">Outside °C</th>
                <th scope="col">kWh per °C</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.key}>
                  <td>
                    {fmtDay(d.startSec)}
                    {d.partial ? ' (part)' : ''}
                  </td>
                  <td>{d.kwh == null ? '—' : d.kwh.toFixed(1)}</td>
                  {tariff && <td>{fmtMoney(dayCost(d.kwh, tariff), tariff) ?? '—'}</td>}
                  <td>{d.insideC == null ? '—' : d.insideC.toFixed(1)}</td>
                  <td>{d.outsideC == null ? '—' : d.outsideC.toFixed(1)}</td>
                  <td>{d.perDegree == null ? '—' : d.perDegree.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
