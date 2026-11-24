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
function titleFromNotice(n) {
  if (n.subject) return String(n.subject).slice(0, 140);
  return firstSentence(n.rawText || n.summary) || 'Notice';
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
      ai: null
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

module.exports = { DEFAULT_FILE, load, save, syncFromNotices, update, add, remove, applyAi, buckets, titleFromNotice };
