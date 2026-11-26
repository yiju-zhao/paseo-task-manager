const pad = (n: number) => String(n).padStart(2, '0');

export function localTime(iso: string, now = new Date()): string {
  // Storage retention reports a calendar date, not an instant at midnight UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return (iso.startsWith(String(now.getFullYear()) + '-') ? iso.slice(5) : iso).replaceAll('-', '/');
  const date = new Date(iso);
  if (Number.isNaN(+date)) return iso;
  const time = pad(date.getHours()) + ':' + pad(date.getMinutes());
  if (date.toDateString() === now.toDateString()) return time;
  const day = pad(date.getMonth() + 1) + '/' + pad(date.getDate());
  return (date.getFullYear() === now.getFullYear() ? '' : date.getFullYear() + '/') + day + ' ' + time;
}

export function preciseTime(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.replaceAll('-', '/');
  const date = new Date(iso);
  if (Number.isNaN(+date)) return iso;
  const offset = -date.getTimezoneOffset();
  return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' +
    pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + String(date.getMilliseconds()).padStart(3, '0') +
    ' UTC' + (offset < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60);
}
