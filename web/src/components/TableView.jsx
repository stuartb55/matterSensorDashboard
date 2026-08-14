import { fmtTime } from '../format.js';

/**
 * The WCAG-clean twin of a chart: every plotted value reachable as text, so
 * nothing is gated behind hovering or colour perception. Newest first.
 */
export default function TableView({ t, columns, range, caption }) {
  const rows = [];
  for (let i = t.length - 1; i >= 0; i -= 1) {
    if (columns.every((c) => c.values[i] == null)) continue;
    rows.push(i);
  }

  if (!rows.length) return <p className="empty">No readings in this window.</p>;

  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {columns.map((c) => (
              <th scope="col" key={c.label}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={t[i]}>
              <td>{fmtTime(t[i], range)}</td>
              {columns.map((c) => (
                <td key={c.label}>
                  {c.values[i] == null ? '—' : c.values[i].toFixed(c.digits ?? 1)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
