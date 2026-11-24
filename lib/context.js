/**
 * Context for the daily plan: today's classes (data/timetable.json, filled by you)
 * and Rang Board projects (read-only; this file never writes to the Rang Board).
 */
const fs = require('fs');
const path = require('path');

const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMETABLE = process.env.MYDAY_TIMETABLE_FILE || path.join(__dirname, '..', 'data', 'timetable.json');
const RANG_BOARD = path.join(__dirname, '..', '..', 'projects-data.js');

function classesFor(date = new Date(), file = TIMETABLE) {
  let tt;
  try { tt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { configured: false, classes: [] }; }
  const day = DAY_KEYS[date.getDay()];
  const list = Array.isArray(tt[day]) ? tt[day] : [];
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/;
  const classes = list
    .filter(c => c && ok.test(c.start) && ok.test(c.end) && c.what)
    .map(c => ({ start: c.start, end: c.end, what: String(c.what).slice(0, 120), room: c.room ? String(c.room).slice(0, 40) : '' }))
    .sort((a, b) => a.start.localeCompare(b.start));
  return { configured: true, classes };
}

function projects(cfg) {
  const file = (cfg && cfg.myDay && cfg.myDay.rangBoardFile) || RANG_BOARD;
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const a = txt.indexOf('{'); const b = txt.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  let data;
  try { data = JSON.parse(txt.slice(a, b + 1)); } catch (e) { return []; }
  const active = ['planning', 'building', 'ongoing', 'live'];
  return (data.projects || [])
    .filter(p => active.includes(p.stage))
    .map(p => ({ name: String(p.name || p.id).slice(0, 60), stage: p.stage, next: String(p.next || '').slice(0, 200), due: p.due || '' }))
    .sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999'))
    .slice(0, 12);
}

module.exports = { classesFor, projects, DAY_KEYS };
