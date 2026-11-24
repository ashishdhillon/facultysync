/**
 * My Day task store. Every triaged notice (WhatsApp, Gmail, Outlook) becomes an editable task.
 * Tasks live in data/tasks.json. Only the dashboard server writes this file.
 * Fields the user edits are remembered in `edited` so neither the rules nor the AI overwrite them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseDeadline } = require('./deadline');

const DEFAULT_FILE = process.env.MYDAY_TASKS_FILE || path.join(__dirname, '..', 'data', 'tasks.json');
const BOILERPLATE = /^(Direct notification for ASD|Open and inspect attached document|Review attached|Review announcement)/i;
const EDITABLE = ['title', 'action', 'dueAt', 'priority', 'status', 'snoozedUntil', 'notes'];
const PRIORITIES = ['high', 'normal', 'low'];

function load(file = DEFAULT_FILE) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { tasks: Array.isArray(d.tasks) ? d.tasks : [], migratedTicks: !!d.migratedTicks };
  } catch (e) { return { tasks: [], migratedTicks: false }; }
}
function save(store, file = DEFAULT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}
function newId() { return 't_' + crypto.randomBytes(6).toString('hex'); }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80); }

function sourceOf(n) {
  if (n.channel === 'gmail') return 'gmail';
  if (n.channel === 'outlook') return 'outlook';
  return 'whatsapp';
}
function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  // Split on a sentence end, but not after titles like Dr. / Mr. / Prof., and keep short first parts together
  let cut = t.split(/(?<!\b(?:dr|mr|mrs|ms|prof|sir|st|no|vs|etc))(?<=[.!?])\s/i)[0] || t;
  if (cut.length < 40) cut = t;
  return cut.length > 140 ? cut.slice(0, 137).trimEnd() + '…' : cut;
}
/**
 * Turns chat text into a short action title without AI, e.g.
 * "Ashish, neha,divya ,Dr. payal kindly send your full papers to Mr. Humanshu, only Abstract has been sent ."
 *   -> "Send your full papers to Mr. Humanshu"
 */
const POLITE = /\b(?:kindly|please|pls|plz|request(?:ed)?\s+(?:you\s+)?to|you\s+are\s+requested\s+to|all\s+are\s+requested\s+to|are\s+requested\s+to|make\s+sure\s+to|ensure\s+to)\s+/i;
const OPENERS = /^(?:(?:dear|respected|hello|hi|good\s+(?:morning|afternoon|evening))\s+(?:all|sir|ma'?am|mam|madam|everyone|faculty|team|colleagues)?[\s,!.:-]*)+/i;
function cleanTitle(text) {
  let t = String(text || '').replace(/[￼​-‏﻿]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/^\S[^\n]*\.(pdf|docx?|xlsx?|csv|pptx?|jpe?g|png)$/i.test(t)) {   // only a shared file
    const f = t.replace(/_\d{6}_\d{6}(?=\.)/, '');
    return 'Check the shared document: ' + (f.length > 50 ? f.slice(0, 47) + '…' : f);
  }
  t = t.replace(OPENERS, '');
  const m = t.slice(0, 400).match(POLITE);                            // the part that asks you to do something
  if (m) t = t.slice(m.index + m[0].length);
  t = firstSentence(t.replace(/^[\s,:;-]+/, ''));
  t = t.replace(/\s+([.,!?])/g, '$1').replace(/[\s.,;:!-]+$/, '');
  const aside = t.search(/,\s+(?:only|as|which|since|because|so that|but|else|otherwise|thanks|thank you)\b/i);
  if (aside > 15) t = t.slice(0, aside);                              // drop a trailing aside
  if (t.length > 80) { const c = t.indexOf(', ', 30); if (c > 0 && c < 90) t = t.slice(0, c); }
  if (t.length > 100) t = t.slice(0, 97).replace(/\s+\S*$/, '') + '…';
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}
function titleFromNotice(n) {
  if (n.subject) return String(n.subject).slice(0, 140);
  return cleanTitle(n.rawText || n.summary) || 'Notice';
}
const FILE_RX = /\.(pdf|docx?|xlsx?|csv|pptx?|jpe?g|png)\b/i;
/** Short reasons shown under a task: why My Day thinks this needs you. */
function whyOf(n, opts = {}) {
  const text = `${n.subject || ''} ${n.rawText || n.summary || ''}`;
  const low = text.toLowerCase();
  const why = [];
  const names = (opts.names || []).map(x => String(x).toLowerCase()).filter(Boolean);
  if (names.some(x => new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(low))) why.push('Mentions you');
  const kws = (opts.keywords || []).filter(k => k && k.length > 2 && !names.includes(String(k).toLowerCase()));
  const hit = kws.filter(k => low.includes(String(k).toLowerCase())).slice(0, 3);
  if (hit.length) why.push('Words: ' + hit.join(', '));
  if (n.savedFile || FILE_RX.test(text)) why.push('Has a document');
  if (n.priority === 'HIGH') why.push('Marked urgent');
  return why;
}
function actionFromNotice(n) {
  const a = String(n.actionRequired || '').trim();
  return a && !BOILERPLATE.test(a) ? a : '';
}
function fromOf(n) {
  const s = String(n.sender || '').replace(/<.*>/, '').replace(/"/g, '').trim();
  return s || n.chatName || '';
}

/** Creates tasks for notices that do not have one yet. Returns number of tasks created. */
function syncFromNotices(store, notices, options = {}) {
  // One-time upgrade of older tasks: cleaner titles (only if you never edited it and AI has not rewritten it) and reasons
  const byNotice = {}; notices.forEach(n => { byNotice[String(n.id)] = n; });
  for (const t of store.tasks) {
    const n = byNotice[String((t.noticeIds || [])[0])];
    if (!n) continue;
    if (!t.titleV && !t.edited.title && !t.ai && !n.subject) { const c = titleFromNotice(n); if (c) t.title = c; }
    t.titleV = 2;
    if (!t.why) t.why = whyOf(n, options);
    if (t.dueAt && t.why && !t.why.includes('Has a deadline')) t.why.push('Has a deadline');
  }
  const linked = new Set();
  store.tasks.forEach(t => (t.noticeIds || []).forEach(id => linked.add(String(id))));
  const legacyDone = options.legacyDone || {};
  let created = 0;
  const ordered = notices.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const n of ordered) {
    const nid = String(n.id);
    if (linked.has(nid)) continue;
    const title = titleFromNotice(n);
    const received = n.timestamp || new Date().toISOString();
    // Same notice forwarded in another chat or by email within 3 days: attach to the existing task
    const dup = store.tasks.find(t => t.status !== 'done' && norm(t.title) === norm(title) &&
      Math.abs(new Date(t.createdAt) - new Date(received)) < 3 * 86400000);
    if (dup) { dup.noticeIds.push(nid); dup.sources = Array.from(new Set([...(dup.sources || []), sourceOf(n)])); linked.add(nid); continue; }

    const dl = parseDeadline(`${n.subject || ''}\n${n.rawText || n.summary || ''}`, received);
    const task = {
      id: newId(),
      noticeIds: [nid],
      source: sourceOf(n),
      sources: [sourceOf(n)],
      title,
      action: actionFromNotice(n),
      from: fromOf(n),
      chat: n.chatName || '',
      snippet: String(n.rawText || n.snippet || n.summary || '').replace(/[\uFFFC\u200B-\u200F\uFEFF]/g, '').slice(0, 300),
      receivedAt: received,
      dueAt: dl.dueAt,
      dueHasTime: dl.hasTime,
      dueLabel: dl.label,
      priority: n.priority === 'HIGH' ? 'high' : 'normal',
      status: legacyDone[nid] ? 'done' : 'open',
      doneAt: legacyDone[nid] ? new Date().toISOString() : null,
      snoozedUntil: null,
      notes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      edited: {},
      ai: null,
      titleV: 2,
      why: whyOf(n, options).concat(dl.dueAt ? ['Has a deadline'] : [])
    };
    store.tasks.push(task);
    linked.add(nid);
    created++;
  }
  return created;
}

function validDate(v) { if (v === null || v === '') return null; const d = new Date(v); return isNaN(d.getTime()) ? undefined : d.toISOString(); }

/** User edit. Only whitelisted fields; values are validated. Returns the task or null. */
function update(store, id, patch) {
  const t = store.tasks.find(x => x.id === id);
  if (!t || !patch || typeof patch !== 'object') return null;
  for (const k of Object.keys(patch)) {
    if (!EDITABLE.includes(k)) continue;
    let v = patch[k];
    if (k === 'title' || k === 'action' || k === 'notes') { v = String(v == null ? '' : v).slice(0, k === 'notes' ? 1000 : 300); if (k === 'title' && !v.trim()) continue; }
    if (k === 'priority' && !PRIORITIES.includes(v)) continue;
    if (k === 'status') { if (!['open', 'done'].includes(v)) continue; t.doneAt = v === 'done' ? new Date().toISOString() : null; }
    if (k === 'dueAt' || k === 'snoozedUntil') { const d = validDate(v); if (d === undefined) continue; v = d; if (k === 'dueAt') { t.dueHasTime = Boolean(d && patch.dueHasTime !== false); t.dueLabel = ''; } }
    t[k] = v;
    if (k !== 'status' && k !== 'snoozedUntil') t.edited[k] = true;
  }
  t.updatedAt = new Date().toISOString();
  return t;
}

function add(store, input) {
  const title = String((input && input.title) || '').trim().slice(0, 300);
  if (!title) return null;
  const dl = input.dueAt ? { dueAt: validDate(input.dueAt) || null, hasTime: input.dueHasTime !== false } : parseDeadline(title, new Date());
  const t = {
    id: newId(), noticeIds: [], source: 'manual', sources: ['manual'], title, action: '', from: 'You', chat: '',
    snippet: '', receivedAt: new Date().toISOString(), dueAt: dl.dueAt || null, dueHasTime: !!dl.hasTime, dueLabel: dl.label || '',
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal', status: 'open', doneAt: null,
    snoozedUntil: null, notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    edited: { title: true, dueAt: !!input.dueAt, priority: !!input.priority }, ai: null
  };
  store.tasks.push(t);
  return t;
}

function remove(store, id) {
  const i = store.tasks.findIndex(x => x.id === id && x.source === 'manual');
  if (i < 0) return false;
  store.tasks.splice(i, 1); return true;
}

/** Applies AI suggestions without touching fields the user edited. */
function applyAi(task, s, model) {
  if (!s || typeof s !== 'object') return;
  if (!task.edited.title && typeof s.title === 'string' && s.title.trim()) task.title = s.title.trim().slice(0, 140);
  if (!task.edited.action && typeof s.action === 'string') task.action = s.action.trim().slice(0, 300);
  if (!task.edited.priority && PRIORITIES.includes(s.priority)) task.priority = s.priority;
  if (!task.edited.dueAt && s.due !== undefined) {
    const d = s.due ? validDate(s.due) : null;
    if (d !== undefined) { task.dueAt = d; task.dueHasTime = Boolean(d && s.dueHasTime); task.dueLabel = ''; }
  }
  // Information-only notices stay visible (never auto-closed) but drop to low priority unless the user set it.
  task.infoOnly = s.isTask === false;
  if (task.infoOnly && !task.edited.priority) task.priority = 'low';
  task.ai = { model, at: new Date().toISOString() };
  task.updatedAt = new Date().toISOString();
}

/** Buckets for the Today view, relative to `now` (local time). */
function buckets(tasks, now = new Date()) {
  const sod = new Date(now); sod.setHours(0, 0, 0, 0);
  const eod = new Date(sod); eod.setDate(eod.getDate() + 1);
  const eow = new Date(sod); eow.setDate(eow.getDate() + 7);
  const out = { overdue: [], today: [], week: [], later: [], noDate: [], snoozed: [], doneToday: [] };
  for (const t of tasks) {
    if (t.status === 'done') { if (t.doneAt && new Date(t.doneAt) >= sod) out.doneToday.push(t); continue; }
    if (t.snoozedUntil && new Date(t.snoozedUntil) > now) { out.snoozed.push(t); continue; }
    if (!t.dueAt) { out.noDate.push(t); continue; }
    const d = new Date(t.dueAt);
    if (d < now && (t.dueHasTime || d < sod)) out.overdue.push(t);
    else if (d < eod) out.today.push(t);
    else if (d < eow) out.week.push(t);
    else out.later.push(t);
  }
  const rank = { high: 0, normal: 1, low: 2 };
  const byDue = (a, b) => (new Date(a.dueAt) - new Date(b.dueAt)) || (rank[a.priority] - rank[b.priority]);
  ['overdue', 'today', 'week', 'later'].forEach(k => out[k].sort(byDue));
  out.noDate.sort((a, b) => (rank[a.priority] - rank[b.priority]) || (new Date(b.receivedAt) - new Date(a.receivedAt)));
  return out;
}

module.exports = { cleanTitle, whyOf, DEFAULT_FILE, load, save, syncFromNotices, update, add, remove, applyAi, buckets, titleFromNotice };
