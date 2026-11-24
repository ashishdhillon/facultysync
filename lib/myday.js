/**
 * My Day engine: keeps tasks in step with notices, runs the AI, writes the daily brief,
 * and runs the background schedule (auto-sync, morning brief, urgent reminders).
 */
const fs = require('fs');
const path = require('path');
const tasksLib = require('./tasks');
const ai = require('./ai');
const context = require('./context');

const BRIEF_FILE = process.env.MYDAY_BRIEF_FILE || path.join(__dirname, '..', 'data', 'brief.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'dashboard_state.json');

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp.${process.pid}`; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); }
function logFile(cfg) { return (cfg.storage && cfg.storage.logFile) || path.join(__dirname, '..', 'data', 'notices_log.json'); }
function md(cfg) { return Object.assign({ syncEveryMinutes: 15, briefTime: '08:30', remindMinutesBefore: 120, aiEnabled: true }, cfg.myDay || {}); }

let aiState = { lastError: null, lastRun: null, model: null };

/** Creates tasks for new notices (rules only, fast). */
function refreshTasks(cfg, file) {
  const store = tasksLib.load(file);
  const notices = readJson(logFile(cfg), []);
  let legacyDone = {};
  if (!store.migratedTicks) { legacyDone = (readJson(STATE_FILE, {}).done) || {}; store.migratedTicks = true; }
  const created = tasksLib.syncFromNotices(store, Array.isArray(notices) ? notices : [], { legacyDone });
  tasksLib.save(store, file);
  return { store, created };
}

/** Runs AI on tasks it has not seen yet (max 25 per run). Never throws. */
async function enrichTasks(cfg, { fetchFn, file } = {}) {
  if (!md(cfg).aiEnabled) return { ok: false, skipped: 'disabled' };
  const st = await ai.status(cfg);
  if (!st.configured) return { ok: false, skipped: 'not configured' };
  const store = tasksLib.load(file);
  const todo = store.tasks.filter(t => !t.ai && t.source !== 'manual' && t.status === 'open');
  if (!todo.length) return { ok: true, enriched: 0 };
  try {
    const { suggestions, model } = await ai.enrich(todo, { cfg, fetchFn });
    // Reload before applying, in case the user edited something meanwhile
    const fresh = tasksLib.load(file);
    let n = 0;
    for (const t of fresh.tasks) { if (suggestions[t.id]) { tasksLib.applyAi(t, suggestions[t.id], model); n++; } }
    tasksLib.save(fresh, file);
    aiState = { lastError: null, lastRun: new Date().toISOString(), model };
    return { ok: true, enriched: n, model };
  } catch (err) {
    aiState = Object.assign({}, aiState, { lastError: err.message, lastRun: new Date().toISOString() });
    return { ok: false, error: err.message };
  }
}

function todayContext(cfg, now = new Date()) {
  const store = tasksLib.load();
  const buckets = tasksLib.buckets(store.tasks, now);
  const tt = context.classesFor(now);
  const projects = context.projects(cfg);
  return { store, buckets, timetable: tt, projects };
}

/** Writes today's brief (AI if available, else rules). */
async function makeBrief(cfg, { fetchFn, force } = {}) {
  const now = new Date();
  const existing = readJson(BRIEF_FILE, null);
  const today = now.toDateString();
  if (!force && existing && existing.day === today) return existing;
  refreshTasks(cfg); // make sure new notices are tasks before planning
  const { buckets, timetable, projects } = todayContext(cfg, now);
  let brief; let source = 'rules';
  const st = await ai.status(cfg);
  if (st.configured && md(cfg).aiEnabled) {
    try { brief = await ai.brief({ cfg, buckets, classes: timetable.classes, projects, fetchFn }); source = 'ai'; }
    catch (err) { aiState = Object.assign({}, aiState, { lastError: err.message }); }
  }
  if (!brief) brief = ai.ruleBrief(buckets, timetable.classes);
  const out = Object.assign(brief, { source, day: today, generatedAt: now.toISOString() });
  writeJson(BRIEF_FILE, out);
  return out;
}

function readBrief() { return readJson(BRIEF_FILE, null); }

/** Background schedule. `deps.sync()` runs the mail connectors; `deps.notify()` shows a Mac notification. */
function startScheduler(getCfg, deps) {
  let lastSyncAt = 0; let briefDay = (readBrief() || {}).day || '';
  const reminded = new Set();
  const tick = async () => {
    const cfg = getCfg(); const m = md(cfg); const now = new Date();
    try {
      if (m.syncEveryMinutes > 0 && Date.now() - lastSyncAt >= m.syncEveryMinutes * 60000) {
        lastSyncAt = Date.now();
        await deps.sync();
      }
      // Morning brief, once a day at/after briefTime
      const [bh, bm] = String(m.briefTime || '08:30').split(':').map(Number);
      const due = new Date(now); due.setHours(bh || 8, bm || 0, 0, 0);
      if (now >= due && briefDay !== now.toDateString()) {
        const b = await makeBrief(cfg, { force: true });
        briefDay = now.toDateString();
        deps.notify('☀️ Your day is ready', b.headline || 'Open My Day to see today\'s plan');
      }
      // Reminders: open tasks due soon, once each
      const soon = Date.now() + (Number(m.remindMinutesBefore) || 120) * 60000;
      for (const t of tasksLib.load().tasks) {
        if (t.status !== 'open' || !t.dueAt || !t.dueHasTime || reminded.has(t.id)) continue;
        const d = new Date(t.dueAt).getTime();
        if (d > Date.now() && d <= soon) {
          reminded.add(t.id);
          deps.notify('⏰ Due soon', `${t.title} · ${new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`);
        }
      }
    } catch (err) { console.error('⚠️ [My Day scheduler]', err.message); }
  };
  const timer = setInterval(tick, 60000);
  setTimeout(tick, 5000);
  return () => clearInterval(timer);
}

module.exports = { refreshTasks, enrichTasks, makeBrief, readBrief, todayContext, startScheduler, aiInfo: () => aiState, md };
