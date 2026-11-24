/**
 * Tests for the Apple Mail connector using a FAKE Mail (mocked osascript runner).
 * Nothing touches your real Mail, Keychain, notices log, or sync cursor.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'facultysync-applemail-'));
process.env.NODE_ENV = 'test';
process.env.APPLEMAIL_ASSUME_DARWIN = '1';
process.env.FACULTYSYNC_STATE_FILE = path.join(tmp, 'sync_state.json');

const syncState = require('./connectors/syncState');
const am = require('./connectors/applemail');

const baseCfg = JSON.parse(JSON.stringify(require('./config.example.json')));
baseCfg.storage = {
  documentsDir: tmp,
  actionChecklistFile: path.join(tmp, 'ACTION_CHECKLIST.md'),
  logFile: path.join(tmp, 'notices_log.json')
};
baseCfg.notifications = { enabled: false };
baseCfg.appleMail = { accounts: [], senderDomains: ['.ac.in', '.edu', 'mdurohtak.ac.in'], extraSenders: ['me@example.com'], maxPerSync: 100 };

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✅ ' + name); passed++; }
function reset() {
  fs.rmSync(process.env.FACULTYSYNC_STATE_FILE, { force: true });
  fs.rmSync(baseCfg.storage.logFile, { force: true });
}
const log = () => { try { return JSON.parse(fs.readFileSync(baseCfg.storage.logFile, 'utf8')); } catch (e) { return []; } };

// A fake Mail: answers the three scripts
function fakeMail(messages, opts = {}) {
  const calls = [];
  const runner = async (script, args) => {
    calls.push({ script, args });
    if (opts.fail) { const e = new Error(opts.fail); e.stderr = opts.fail; throw e; }
    if (script === am.SCRIPT_LIST_ACCOUNTS) return JSON.stringify([{ name: 'DPGITM Outlook', enabled: true, emails: ['a@dpgitm.ac.in'] }]);
    if (script === am.SCRIPT_METADATA) {
      const since = new Date(args[0]);
      const max = parseInt(args[1], 10);
      return JSON.stringify(messages.filter(m => new Date(m.date) > since).sort((a, b) => a.date < b.date ? -1 : 1).slice(0, max)
        .map(m => ({ account: 'DPGITM Outlook', box: 0, idx: messages.indexOf(m), messageId: m.messageId, subject: m.subject, sender: m.sender, date: m.date })));
    }
    if (script === am.SCRIPT_DETAILS) {
      const items = JSON.parse(args[1]); const out = {};
      items.forEach(it => { const m = messages[it.idx]; if (m && m.messageId === it.id) out[it.id] = { snippet: m.snippet || '', attachments: m.attachments || [] }; });
      return JSON.stringify(out);
    }
    throw new Error('unexpected script');
  };
  return { runner, calls };
}

(async () => {
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();

  console.log('--- Suite 1: Read-only and injection safety of the scripts ---');
  const allScripts = [am.SCRIPT_LIST_ACCOUNTS, am.SCRIPT_METADATA, am.SCRIPT_DETAILS].join('\n');
  ok('Scripts contain no send/delete/move/reply/forward/read-status commands',
    !/\b(send|delete|move|reply|forward|redirect|bounce|make new|set\s+\w+\s+of|readStatus|junkMailStatus|flaggedStatus)\b/i.test(allScripts.replace(/\/\/.*$/gm, '')));
  ok('Scripts never assign to message properties', !/\.\w+\s*=\s*(true|false)\b/.test(allScripts));

  console.log('--- Suite 2: connect() ---');
  reset();
  let r = await am.connect({ platform: 'linux', runner: fakeMail([]).runner });
  ok('Refuses on non-macOS with a clear message', r.ok === false && r.status === 'unsupported');
  r = await am.connect({ platform: 'darwin', runner: fakeMail([]).runner });
  ok('Connects on macOS and lists accounts', r.ok === true && r.accounts[0].name === 'DPGITM Outlook');
  ok('Status becomes connected', am.getStatus() === 'connected');
  reset();
  r = await am.connect({ platform: 'darwin', runner: fakeMail([], { fail: 'execution error: Not authorized to send Apple events to Mail. (-1743)' }).runner });
  ok('macOS permission denial is explained, not a crash', r.ok === false && r.status === 'permission_needed' && /Automation/.test(r.error));
  ok('Status shows permission needed', am.getStatus() === 'reauth_needed');

  console.log('--- Suite 3: Sync filtering, triage, de-duplication ---');
  reset();
  await am.connect({ platform: 'darwin', runner: fakeMail([]).runner });
  const msgs = [
    { messageId: '<a1@x>', subject: 'MDU datesheet - submit marks by 28th Nov', sender: 'Exam Cell <exam@mdurohtak.ac.in>', date: iso(30), snippet: 'Please submit internal marks.', attachments: ['datesheet.pdf'] },
    { messageId: '<s1@x>', subject: '50% OFF exam prep sale', sender: 'Deals <promo@shop.com>', date: iso(20), snippet: 'Buy now' },
    { messageId: '<c1@x>', subject: 'Lunch?', sender: 'Friend <me@example.com>', date: iso(10), snippet: 'See you at noon' }
  ];
  const fm = fakeMail(msgs);
  r = await am.syncAppleMail({ config: baseCfg, runner: fm.runner });
  ok('Sync succeeds', r.ok === true);
  const l1 = log();
  ok('Academic exam mail is recorded as an Outlook-channel notice', l1.some(n => n.subject.includes('MDU datesheet') && n.channel === 'outlook' && n.source === 'applemail'));
  ok('Non-academic sender is ignored', !l1.some(n => /50% OFF/.test(n.subject)));
  ok('Casual mail from an allowed sender is not triaged as a notice', !l1.some(n => n.subject === 'Lunch?'));
  ok('Attachment name captured, snippet capped at 300', l1[0].savedFile === 'datesheet.pdf' && (l1[0].snippet || '').length <= 300);
  const n1 = l1.length;
  r = await am.syncAppleMail({ config: baseCfg, runner: fm.runner });
  ok('Second sync adds nothing (de-duplicated by message id)', r.ok && log().length === n1);

  console.log('--- Suite 4: Cursor safety ---');
  reset();
  await am.connect({ platform: 'darwin', runner: fakeMail([]).runner });
  const before = syncState.getChannelState('applemail').cursor || null;
  r = await am.syncAppleMail({ config: baseCfg, runner: fakeMail([], { fail: 'boom' }).runner });
  ok('Failed sync reports an error', r.ok === false);
  ok('Cursor is NOT moved after a failed sync', (syncState.getChannelState('applemail').cursor || null) === before);
  r = await am.syncAppleMail({ config: baseCfg, runner: fakeMail([], { fail: 'Not authorized (-1743)' }).runner });
  ok('Permission error during sync marks permission needed', r.status === 'permission_needed' && am.getStatus() === 'reauth_needed');

  console.log('--- Suite 5: More mail than the limit loses nothing ---');
  reset();
  await am.connect({ platform: 'darwin', runner: fakeMail([]).runner });
  const many = [];
  for (let i = 0; i < 5; i++) many.push({ messageId: `<m${i}@x>`, subject: `Exam notice ${i}: submit marks urgent`, sender: 'Office <office@college.ac.in>', date: iso(100 - i * 10), snippet: 'urgent exam marks' });
  const cfgSmall = JSON.parse(JSON.stringify(baseCfg)); cfgSmall.appleMail.maxPerSync = 2;
  const fm2 = fakeMail(many);
  r = await am.syncAppleMail({ config: cfgSmall, runner: fm2.runner });
  ok('First batch is limited to 2 and flags more available', r.newCount <= 2 && r.moreAvailable === true);
  for (let k = 0; k < 6; k++) await am.syncAppleMail({ config: cfgSmall, runner: fm2.runner });
  const got = new Set(log().map(n => n.messageId));
  ok('After repeated syncs all 5 messages arrive, none skipped', many.every(m => got.has('mail:' + m.messageId)));

  console.log('--- Suite 6: User data is passed as arguments, not script text ---');
  reset();
  await am.connect({ platform: 'darwin', runner: fakeMail([]).runner });
  const evil = { messageId: '<x"; do shell script "touch /tmp/pwned" ; "@x>', subject: 'Exam datesheet urgent', sender: 'A <a@college.ac.in>', date: iso(5), snippet: 'exam' };
  const fm3 = fakeMail([evil]);
  await am.syncAppleMail({ config: baseCfg, runner: fm3.runner });
  const detailCall = fm3.calls.find(c => c.script === am.SCRIPT_DETAILS);
  ok('Message id travels only inside argv', detailCall && detailCall.args[1].includes('do shell script') && !detailCall.script.includes('do shell script'));
  ok('Script text is the fixed constant', fm3.calls.every(c => [am.SCRIPT_LIST_ACCOUNTS, am.SCRIPT_METADATA, am.SCRIPT_DETAILS].includes(c.script)));

  console.log(`\nApple Mail Test Summary: ${passed}/${passed} Passed`);
  process.exit(0);
})().catch(e => { console.error('❌ Apple Mail test failed:', e.message); process.exit(1); });
