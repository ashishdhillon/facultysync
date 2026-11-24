const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('===============================================================');
console.log('       🔍 ACADEMIC-DPG WHATSAPP CHAT DISCOVERY TOOL           ');
console.log('===============================================================\n');

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    executablePath: config.puppeteer?.executablePath || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: config.puppeteer?.headless !== false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('Scan this QR code from WhatsApp (Settings > Linked Devices):');
  qrcode.generate(qr, { small: true });
});

// Read-only: lists chat NAMES and last-activity times only. It never reads or prints message text,
// never sends anything and never marks chats as read.
const COLLEGE_HINTS = ['dpg', 'dpgitm', 'bca', 'mca', 'bba', 'b.tech', 'btech', 'computer', 'application', 'department', 'dept',
  'faculty', 'staff', 'teacher', 'mentor', 'exam', 'hod', 'principal', 'college', 'institute', 'mdu', 'academic', 'sessional',
  'admission', 'placement', 'internship', 'naac', 'nirf', 'iqac', 'lab', 'class', 'sem', 'section', 'dr.', 'dr ', 'prof', 'sir', 'mam', "ma'am"];

client.on('ready', async () => {
  console.log('✅ Connected to WhatsApp! Reading chat names (no message text)...\n');
  try {
    const chats = (await client.getChats()).filter(c => !c.isStatus && !(c.id && c.id.server === 'broadcast'));
    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const monitored = (config.monitoredChats || []).filter(m => m && !/^REPLACE_WITH/i.test(m)).map(m => m.toLowerCase());
    const nameOf = c => c.name || c.formattedTitle || (c.id && c.id.user) || '?';
    const when = c => c.timestamp ? new Date(c.timestamp * 1000).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
    const isMon = n => monitored.some(m => n.toLowerCase().includes(m));
    const looksCollege = n => COLLEGE_HINTS.some(h => n.toLowerCase().includes(h));

    console.log(`Found ${chats.length} chats.\n`);
    console.log('--- ✅ ALREADY MONITORED (matched by config.json) ---');
    chats.filter(c => isMon(nameOf(c))).forEach(c => console.log(`  ${c.isGroup ? '👥' : '👤'} "${nameOf(c)}"   last: ${when(c)}`));
    monitored.forEach(m => { if (!chats.some(c => nameOf(c).toLowerCase().includes(m))) console.log(`  ⚠️  No chat matches "${m}" - check the spelling`); });

    console.log('\n--- 🎓 LOOK COLLEGE-RELATED (suggestions, not monitored yet) ---');
    chats.filter(c => !isMon(nameOf(c)) && looksCollege(nameOf(c))).slice(0, 25)
      .forEach(c => console.log(`  ${c.isGroup ? '👥' : '👤'} "${nameOf(c)}"   last: ${when(c)}`));

    console.log('\n--- 🕒 MOST RECENT GROUPS (top 20) ---');
    chats.filter(c => c.isGroup && !isMon(nameOf(c))).slice(0, 20).forEach(c => console.log(`  👥 "${nameOf(c)}"   last: ${when(c)}`));

    console.log('\n💡 Copy exact names (or a unique part of them) into config.json -> "monitoredChats".');
  } catch (err) {
    console.error('Error fetching chats:', err.message);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.initialize();
