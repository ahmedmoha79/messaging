// Human-friendly formatting for times, sizes and durations.

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const weekdayLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dateYearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const DAY = 86400000;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function time(value) {
  return timeFmt.format(new Date(value));
}

export function fullDate(value) {
  return fullFmt.format(new Date(value));
}

/** Chat list stamp: 14:05 today, "Yesterday", weekday this week, else a date. */
export function listStamp(value) {
  if (!value) return '';
  const d = new Date(value);
  const diff = startOfDay(new Date()) - startOfDay(d);
  if (diff <= 0) return timeFmt.format(d);
  if (diff === DAY) return 'Yesterday';
  if (diff < 7 * DAY) return weekdayFmt.format(d);
  return d.getFullYear() === new Date().getFullYear() ? dateFmt.format(d) : dateYearFmt.format(d);
}

/** Separator label between message days. */
export function dayLabel(value) {
  const d = new Date(value);
  const diff = startOfDay(new Date()) - startOfDay(d);
  if (diff <= 0) return 'Today';
  if (diff === DAY) return 'Yesterday';
  if (diff < 7 * DAY) return weekdayLongFmt.format(d);
  return d.getFullYear() === new Date().getFullYear() ? dateFmt.format(d) : dateYearFmt.format(d);
}

export function sameDay(a, b) {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

/** "last seen 5 min ago" style text. */
export function lastSeen(value) {
  if (!value) return 'Offline';
  const d = new Date(value);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'Last seen just now';
  if (s < 3600) return `Last seen ${Math.floor(s / 60)} min ago`;
  const diff = startOfDay(new Date()) - startOfDay(d);
  if (diff <= 0) return `Last seen today at ${timeFmt.format(d)}`;
  if (diff === DAY) return `Last seen yesterday at ${timeFmt.format(d)}`;
  return `Last seen ${dateFmt.format(d)}`;
}

export function relative(value) {
  const s = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = [...parts[0]][0] || '?';
  const second = parts.length > 1 ? [...parts[parts.length - 1]][0] : '';
  return (first + second).toUpperCase();
}

/** Stable, readable avatar colour from an id. Hues stay in a range that works with white text. */
export function colorFor(seed) {
  let h = 0;
  for (const ch of String(seed || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hues = [152, 168, 190, 205, 222, 260, 286, 330, 14, 28, 38, 96];
  return `hsl(${hues[h % hues.length]} 48% 40%)`;
}
