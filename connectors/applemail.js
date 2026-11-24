/**
 * Apple Mail connector for FacultySync (macOS only).
 *
 * Reads mail that the Mail app has ALREADY downloaded (for example your Outlook / Exchange
 * or Gmail account added to Mail), so no Microsoft or Google sign-in is needed here.
 *
 * Strictly READ-ONLY: the scripts below only read message properties. They never send,
 * reply, forward, delete, move, flag, or change read status.
 * User data is passed to the scripts as ARGUMENTS (argv), never spliced into script text.
 * Stored per email: id, sender, subject, a snippet of at most 300 characters, received time,
 * and attachment file names. No full bodies.
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const syncState = require('./syncState');
const { triageMessage } = require('../triage');
const { recordNotice } = require('../checklist');
const { isAllowedSender } = require('./gmail');

const CHANNEL = 'applemail';
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const DEFAULT_SENDER_DOMAINS = ['.ac.in', '.edu', 'mdurohtak.ac.in'];
const OVERLAP_MS = 2 * 60 * 1000; // re-read a 2 minute overlap; de-duplication makes this safe

/** JXA: list accounts (name, enabled, email addresses). Read-only. */
const SCRIPT_LIST_ACCOUNTS = `
function run() {
  var Mail = Application('Mail');
  var out = Mail.accounts().map(function (a) {
    var emails = []; try { emails = a.emailAddresses(); } catch (e) {}
    return { name: a.name(), enabled: a.enabled(), emails: emails };
  });
  return JSON.stringify(out);
}`;

/**
 * JXA: new Inbox messages since a date. argv: [sinceISO, max, accountNamesJSON]
 * Fast path: ONE bulk call for all received dates (no slow `whose` search), then read
 * subject/sender/id only for the few new messages, by index.
 */
const SCRIPT_METADATA = `
function run(argv) {
  var since = new Date(argv[0]);
  var max = parseInt(argv[1], 10) || 100;
  var wanted = JSON.parse(argv[2] || '[]');
  var Mail = Application('Mail');
  var out = [];
  Mail.accounts().forEach(function (acc) {
    var accName = acc.name();
    if (wanted.length && wanted.indexOf(accName) < 0) return;
    var boxes = acc.mailboxes();
    for (var b = 0; b < boxes.length; b++) {
      var mb = boxes[b];
      if (String(mb.name()).toLowerCase() !== 'inbox') continue;
      var dates = mb.messages.dateReceived();          // one Apple Event for the whole Inbox
      var idx = [];
      for (var i = 0; i < dates.length; i++) { if (dates[i] > since) idx.push(i); }
      idx.sort(function (x, y) { return dates[x] - dates[y]; }); // oldest first
      idx = idx.slice(0, max);
      idx.forEach(function (i) {
        var m = mb.messages[i];
        out.push({ account: accName, box: b, idx: i, messageId: String(m.messageId()), subject: String(m.subject()), sender: String(m.sender()), date: dates[i].toISOString() });
      });
    }
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return JSON.stringify(out.slice(0, max));
}`;

/**
 * JXA: first 300 chars of text + attachment names, looked up by index and verified by message id.
 * argv: [accountName, itemsJSON] where items = [{box, idx, id}]
 */
const SCRIPT_DETAILS = `
function run(argv) {
  var accName = argv[0];
  var items = JSON.parse(argv[1] || '[]');
  var Mail = Application('Mail');
  var boxes = Mail.accounts.byName(accName).mailboxes();
  var result = {};
  items.forEach(function (it) {
    try {
      var m = boxes[it.box].messages[it.idx];
      if (String(m.messageId()) !== String(it.id)) return; // inbox changed since listing: skip safely
      var text = ''; try { text = String(m.content() || ''); } catch (e) {}
      var names = []; try { names = m.mailAttachments.name(); } catch (e) {}
      result[it.id] = { snippet: text.replace(/\\s+/g, ' ').trim().slice(0, 300), attachments: names.map(String) };
    } catch (e) {}
  });
  return JSON.stringify(result);
}`;

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function isSupported() { return process.platform === 'darwin'; }

/** Runs osascript with a JXA script and argv. Injectable for tests via options.runner. */
function defaultRunner(script, args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args],
      { timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { const e = new Error((stderr || err.message || '').trim()); e.stderr = stderr; return reject(e); }
        resolve(String(stdout).trim());
      });
  });
}

function friendlyError(err) {
  const msg = String((err && (err.stderr || err.message)) || err || '');
  if (/-1743|not authorized|not allowed to send apple events|erraeeventnotpermitted/i.test(msg)) {
    return { status: 'permission_needed', error: 'macOS blocked access. Open System Settings > Privacy & Security > Automation, and allow Terminal to control Mail, then try again.' };
  }
  if (/-600|isn.t running|application can.t be found|-10814/i.test(msg)) {
    return { status: 'error', error: 'The Mail app could not be opened. Open Mail once, then try again.' };
  }
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(msg)) {
    return { status: 'error', error: 'Mail took too long to answer. Try again when Mail has finished syncing.' };
  }
  return { status: 'error', error: msg.slice(0, 300) || 'Unknown Mail error' };
}

function parseJson(text, what) {
  try { return JSON.parse(text); } catch (e) { throw new Error(`Unexpected reply from Mail (${what})`); }
}

async function listAccounts(options = {}) {
  const runner = options.runner || defaultRunner;
  return parseJson(await runner(SCRIPT_LIST_ACCOUNTS, []), 'accounts');
}

/** One-time connect: probes Mail (this triggers the macOS permission prompt) and saves the result. */
async function connect(options = {}) {
  if ((options.platform || process.platform) !== 'darwin') {
    return { ok: false, status: 'unsupported', error: 'Apple Mail is only available on macOS.' };
  }
  try {
    const accounts = (await listAccounts(options)).filter(a => a.enabled !== false);
    if (!accounts.length) return { ok: false, status: 'error', error: 'No accounts found in Mail. Add your Outlook or Gmail account in Mail first.' };
    syncState.updateChannelState(CHANNEL, { connected: true, permissionNeeded: false, accounts: accounts.map(a => a.name) });
    return { ok: true, status: 'connected', accounts: accounts.map(a => ({ name: a.name, emails: a.emails })) };
  } catch (err) {
    const f = friendlyError(err);
    if (f.status === 'permission_needed') syncState.updateChannelState(CHANNEL, { permissionNeeded: true });
    return Object.assign({ ok: false }, f);
  }
}

function getStatus() {
  if (!isSupported() && !process.env.APPLEMAIL_ASSUME_DARWIN) return 'not_connected';
  const st = syncState.getChannelState(CHANNEL);
  if (st.permissionNeeded) return 'reauth_needed';
  return st.connected ? 'connected' : 'not_connected';
}

function senderName(sender) {
  return (sender.replace(/<.*>/, '').replace(/"/g, '').trim()) || sender;
}

/** Sync new Inbox mail from the Mail app. */
async function syncAppleMail(options = {}) {
  const runner = options.runner || defaultRunner;
  const cfg = options.config || readJsonSafe(CONFIG_FILE, {});
  const mc = Object.assign({
    accounts: [], senderDomains: DEFAULT_SENDER_DOMAINS, extraSenders: [], maxPerSync: 100, lookbackDays: 7
  }, cfg.appleMail || {});
  if (!Array.isArray(cfg.appleMail && cfg.appleMail.senderDomains) && cfg.outlook && Array.isArray(cfg.outlook.senderDomains)) {
    mc.senderDomains = cfg.outlook.senderDomains;
  }

  const state = syncState.getChannelState(CHANNEL);
  if (!state.connected) return { ok: false, status: 'not_connected', error: 'Mac Mail is not connected yet.' };

  const startedAt = Date.now();
  const since = state.cursor
    ? new Date(new Date(state.cursor).getTime() - OVERLAP_MS)
    : new Date(startedAt - (Number(mc.lookbackDays) || 7) * 86400000);
  const max = Math.min(Number(mc.maxPerSync) || 100, 200);

  let metas;
  try {
    metas = parseJson(await runner(SCRIPT_METADATA, [since.toISOString(), String(max), JSON.stringify(mc.accounts || [])]), 'messages');
  } catch (err) {
    const f = friendlyError(err);
    if (f.status === 'permission_needed') syncState.updateChannelState(CHANNEL, { permissionNeeded: true });
    return Object.assign({ ok: false }, f); // cursor NOT moved
  }
  syncState.updateChannelState(CHANNEL, { permissionNeeded: false });

  const logFile = (cfg.storage && cfg.storage.logFile) || path.join(__dirname, '..', 'data', 'notices_log.json');
  const existing = readJsonSafe(logFile, []);
  const seen = new Set(existing.filter(n => n.messageId).map(n => n.messageId));
  const triageConfig = Object.assign({}, cfg, { monitoredChats: ['*'] });

  // metas are oldest first and at most `max`; keep only allowed, not-yet-seen senders
  const candidates = metas.filter(m => m && m.messageId && !seen.has('mail:' + m.messageId) &&
    isAllowedSender(m.sender, mc.senderDomains, mc.extraSenders));

  // Fetch snippets per account (one script call per account)
  const details = {};
  const byAccount = {};
  candidates.forEach(m => { (byAccount[m.account] = byAccount[m.account] || []).push({ box: m.box, idx: m.idx, id: m.messageId }); });
  try {
    for (const acc of Object.keys(byAccount)) {
      Object.assign(details, parseJson(await runner(SCRIPT_DETAILS, [acc, JSON.stringify(byAccount[acc])]), 'details'));
    }
  } catch (err) {
    const f = friendlyError(err);
    return Object.assign({ ok: false }, f); // cursor NOT moved
  }

  let added = 0;
  for (const m of candidates) {
    const d = details[m.messageId] || { snippet: '', attachments: [] };
    const subject = m.subject || '(No Subject)';
    const text = `${subject}\n${d.snippet}`.trim();
    const name = senderName(m.sender);
    const triaged = triageMessage({
      text,
      hasMedia: d.attachments.length > 0,
      mediaType: 'email/attachment',
      mediaFileName: d.attachments[0] || '',
      chatName: `Outlook · ${name}`,
      chatId: m.sender,
      sender: m.sender
    }, triageConfig);
    if (!triaged.triggered) continue;

    const received = new Date(m.date);
    const when = isNaN(received.getTime()) ? new Date() : received;
    recordNotice({
      id: String(Date.now() + Math.floor(Math.random() * 1000)),
      messageId: 'mail:' + m.messageId,
      channel: 'outlook',
      source: 'applemail',
      timestamp: when.toISOString(),
      formattedDate: when.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }),
      chatName: `Outlook · ${name}`,
      sender: m.sender,
      subject,
      category: triaged.category,
      priority: triaged.priority,
      summary: subject || triaged.summary,
      actionRequired: triaged.actionRequired,
      deadline: triaged.deadline,
      savedFile: d.attachments.length > 0 ? d.attachments[0] : null,
      attachmentFileNames: d.attachments,
      snippet: d.snippet,
      rawText: text
    }, cfg);
    seen.add('mail:' + m.messageId);
    added++;
  }

  // Move the cursor only after a fully successful run.
  // If more mail exists than `max`, metas holds the OLDEST `max` messages, so the cursor stops at the
  // last one we processed and the next sync continues from there (nothing is skipped).
  const truncated = metas.length >= max;
  const lastDate = metas.length ? metas[metas.length - 1].date : null;
  const newCursor = truncated && lastDate ? lastDate : new Date(startedAt).toISOString();
  syncState.updateChannelState(CHANNEL, { lastSync: new Date().toISOString(), cursor: newCursor });

  return { ok: true, newCount: added, totalFound: metas.length, moreAvailable: truncated };
}

module.exports = {
  CHANNEL, isSupported, listAccounts, connect, getStatus, syncAppleMail, friendlyError,
  SCRIPT_LIST_ACCOUNTS, SCRIPT_METADATA, SCRIPT_DETAILS
};
