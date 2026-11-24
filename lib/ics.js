/** Builds an .ics calendar of open tasks that have a deadline. */
function esc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function stamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function ymd(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }

function build(tasks, name = 'My Day') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My Day//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`];
  const now = stamp(new Date());
  for (const t of tasks) {
    if (t.status === 'done' || !t.dueAt) continue;
    const d = new Date(t.dueAt);
    lines.push('BEGIN:VEVENT', `UID:${t.id}@myday.local`, `DTSTAMP:${now}`);
    if (t.dueHasTime) {
      lines.push(`DTSTART:${stamp(new Date(d.getTime() - 30 * 60000))}`, `DTEND:${stamp(d)}`);
    } else {
      const next = new Date(d); next.setDate(next.getDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${ymd(d)}`, `DTEND;VALUE=DATE:${ymd(next)}`);
    }
    lines.push(`SUMMARY:${esc((t.priority === 'high' ? '🔥 ' : '') + t.title)}`, `DESCRIPTION:${esc([t.action, t.from && 'From: ' + t.from].filter(Boolean).join('\n'))}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(l => (l.length > 74 ? l.match(/.{1,74}/g).join('\r\n ') : l)).join('\r\n') + '\r\n';
}
module.exports = { build };
