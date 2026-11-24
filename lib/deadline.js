/**
 * Turns deadline phrases from notices into a real date (local time).
 * Handles: today/tonight/EOD, tomorrow, day after tomorrow, weekdays ("by Friday"),
 * "28th Nov", "Nov 28", "28 November 2026", "25/11", "25-11-2026", "within 2 days",
 * and times like "4 PM", "4:30 pm", "16:00". Ignores phone numbers and file names.
 * Returns { dueAt: ISO string | null, hasTime: boolean, label: string }.
 */
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const DAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const END_OF_DAY = { h: 23, m: 59 };

function clean(text) {
  return String(text || '')
    .replace(/\S*\.(?:pdf|docx?|xlsx?|csv|pptx?|jpe?g|png|zip)\b/gi, ' ')
    .replace(/\+?\d[\d\s-]{7,}\d/g, ' ');
}

function findTime(t) {
  let m = t.match(/\b(\d{1,2})(?::|\.)(\d{2})\s*(am|pm|a\.m\.|p\.m\.)\b/i) || t.match(/\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i);
  if (m) {
    let h = parseInt(m[1], 10); const min = m[3] ? parseInt(m[2], 10) : (m[2] && /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : 0);
    const ap = (m[3] || m[2] || '').toLowerCase().replace(/\./g, '');
    if (h > 12 || min > 59) return null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return { h, m: min, text: m[0] };
  }
  m = t.match(/\b(?:at|by|before|till|until)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i);
  if (m) return { h: parseInt(m[1], 10), m: parseInt(m[2], 10), text: m[0] };
  if (/\b(noon|midday)\b/i.test(t)) return { h: 12, m: 0, text: 'noon' };
  if (/\b(tonight|this evening|evening)\b/i.test(t)) return { h: 18, m: 0, text: 'evening', soft: true };
  if (/\b(eod|end of (?:the )?day)\b/i.test(t)) return { h: 17, m: 0, text: 'EOD', soft: true };
  return null;
}

function at(date, time) {
  const d = new Date(date);
  const t = time || END_OF_DAY;
  d.setHours(t.h, t.m, 0, 0);
  return d;
}

function findDate(t, ref) {
  const base = new Date(ref); base.setHours(0, 0, 0, 0);
  let m;
  if (/\bday after tomorrow\b/i.test(t)) { const d = new Date(base); d.setDate(d.getDate() + 2); return { d, text: 'day after tomorrow' }; }
  if (/\b(tomorrow|tmrw|tmr|kal)\b/i.test(t)) { const d = new Date(base); d.setDate(d.getDate() + 1); return { d, text: 'tomorrow' }; }
  if (/\b(today|tonight|aaj|eod|end of (?:the )?day|this evening|immediately|asap)\b/i.test(t)) return { d: new Date(base), text: 'today' };
  if ((m = t.match(/\b(?:within|in)\s+(\d{1,2})\s+days?\b/i))) { const d = new Date(base); d.setDate(d.getDate() + parseInt(m[1], 10)); return { d, text: m[0] }; }

  // 28th Nov [2026] / 28 November
  if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s*(\d{4}|\d{2}))?\b/i))) {
    return monthDay(parseInt(m[1], 10), MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase() === 'sept' ? 4 : 3)], m[3], base, m[0]);
  }
  // Nov 28 [2026]
  if ((m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i))) {
    return monthDay(parseInt(m[2], 10), MONTHS[m[1].toLowerCase().slice(0, 3)], m[3], base, m[0]);
  }
  // 25/11[/2026] or 25-11-2026 (day first, Indian style)
  if ((m = t.match(/(?<![\d+])(0?[1-9]|[12]\d|3[01])[/.-](0?[1-9]|1[0-2])(?:[/.-](\d{4}|\d{2}))?(?!\d)/))) {
    return monthDay(parseInt(m[1], 10), parseInt(m[2], 10) - 1, m[3], base, m[0]);
  }
  // by Friday / on Monday / next Tuesday
  if ((m = t.match(/\b(?:by|before|on|till|until|this|next|coming)\s+(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/i))) {
    const want = DAYS[m[1].toLowerCase()];
    const d = new Date(base); let add = (want - d.getDay() + 7) % 7;
    if (add === 0) add = 7;
    d.setDate(d.getDate() + add);
    return { d, text: m[0] };
  }
  return null;
}

function monthDay(day, month, yearStr, base, text) {
  if (month == null || isNaN(month) || day < 1 || day > 31) return null;
  let year = base.getFullYear();
  let explicitYear = false;
  if (yearStr) { year = parseInt(yearStr, 10); if (year < 100) year += 2000; explicitYear = true; }
  const d = new Date(year, month, day);
  if (d.getMonth() !== month) return null; // e.g. 31 Feb
  // No year given and the date is more than ~2 months in the past: it means next year
  if (!explicitYear && d < new Date(base.getTime() - 60 * 86400000)) d.setFullYear(year + 1);
  return { d, text };
}

function parseDeadline(text, refDate) {
  const ref = refDate ? new Date(refDate) : new Date();
  const t = clean(text);
  const date = findDate(t, ref);
  const time = findTime(t);
  if (!date && !time) return { dueAt: null, hasTime: false, label: '' };
  let d;
  if (date) d = at(date.d, time);
  else {
    d = at(ref, time); // a time with no date means the same day the message arrived
  }
  const label = [date && date.text, time && time.text].filter(Boolean).join(' ').trim();
  return { dueAt: d.toISOString(), hasTime: Boolean(time), label };
}

module.exports = { parseDeadline };
