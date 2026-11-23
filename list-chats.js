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

client.on('ready', async () => {
  console.log('✅ Connected to WhatsApp! Fetching chats...\n');
  try {
    const chats = await client.getChats();
    console.log(`Found ${chats.length} total chats.\n`);

    console.log('--- 👥 GROUP CHATS ---');
    const groups = chats.filter(c => c.isGroup);
    groups.forEach((g, idx) => {
      console.log(`[${idx + 1}] "${g.name}"`);
      console.log(`    ID: ${g.id._serialized}`);
      console.log(`    Unread: ${g.unreadCount}`);
    });

    console.log('\n--- 👤 RECENT DIRECT CHATS (Top 10) ---');
    const direct = chats.filter(c => !c.isGroup).slice(0, 10);
    direct.forEach((d, idx) => {
      console.log(`[${idx + 1}] "${d.name || d.formattedTitle || d.id.user}" (ID: ${d.id._serialized})`);
    });

    console.log('\n💡 Copy the exact group chat names into `config.json` -> `monitoredChats`.');
  } catch (err) {
    console.error('Error fetching chats:', err);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.initialize();
