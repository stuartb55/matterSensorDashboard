// Table views as CSV files, built in the browser from the raw series.

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * The same rows as CSV, oldest first: an ISO UTC time column for machines,
 * a local time column for people, then each value at full precision.
 */
export function toCsv(t, columns) {
  const lines = [['time_utc', 'local_time', ...columns.map((c) => c.label)].map(csvCell).join(',')];
  t.forEach((sec, i) => {
    if (columns.every((c) => c.values[i] == null)) return;
    const d = new Date(sec * 1000);
    lines.push(
      [
        d.toISOString(),
        d.toLocaleString(),
        ...columns.map((c) => (c.values[i] == null ? '' : String(c.values[i]))),
      ]
        .map(csvCell)
        .join(','),
    );
  });
  return `${lines.join('\n')}\n`;
}

export function downloadCsv(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
