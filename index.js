const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const { triageMessage, isChatMonitored } = require('./triage');
const { sendNotification } = require('./notifier');
const { recordNotice } = require('./checklist');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Watch config.json for live changes without restarting process
fs.watchFile(configPath, (curr, prev) => {
  try {
    console.log('🔄 [Config] config.json updated. Reloading settings live...');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('✅ [Config] Monitored chats now:', config.monitoredChats);
  } catch (err) {
    console.error('⚠️ [Config] Error reloading config.json:', err.message);
  }
});

// Ensure directories
if (!fs.existsSync(config.storage.documentsDir)) {
  fs.mkdirSync(config.storage.documentsDir, { recursive: true });
}

console.log('===============================================================');
console.log('        ☀️  MY DAY · WHATSAPP BRIDGE (LIVE, READ-ONLY)          ');
console.log('===============================================================');
console.log(`📁 Target Notices Dir:   ${config.storage.documentsDir}`);
console.log(`📋 Action Checklist:    ${config.storage.actionChecklistFile}`);
console.log(`🎯 Monitored Chats:     ${JSON.stringify(config.monitoredChats)}`);
console.log('===============================================================\n');

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    executablePath: config.puppeteer?.executablePath || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: config.puppeteer?.headless !== false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

client.on('qr', (qr) => {
  console.log('\n===============================================================');
  console.log('📱 SCAN THIS QR CODE FROM WHATSAPP (Settings > Linked Devices):');
  console.log('===============================================================');
  qrcode.generate(qr, { small: true });
  console.log('Waiting for phone pairing...\n');
});

client.on('authenticated', () => {
  console.log('✅ [Auth] WhatsApp session authenticated successfully! Saved to .wwebjs_auth.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ [Auth] WhatsApp authentication failed:', msg);
});

client.on('ready', async () => {
  console.log('\n===============================================================');
  console.log('🚀 WhatsApp Bridge is ONLINE & Actively Listening!');
  console.log('===============================================================\n');

  try {
    const chats = await client.getChats();
    console.log(`📋 Discovered ${chats.length} active chats on this WhatsApp account:`);
    console.log('---------------------------------------------------------------');
    
    // List up to 15 recent group chats to help user configure config.json
    const groupChats = chats.filter(c => c.isGroup);
    console.log(`Found ${groupChats.length} group chats. Recent groups:`);
    groupChats.slice(0, 15).forEach((c, idx) => {
      console.log(`  ${idx + 1}. "${c.name}" (ID: ${c.id._serialized})`);
    });
    console.log('---------------------------------------------------------------');
    console.log('💡 TIP: To attach your chats, copy their exact names into');
    console.log('   `config.json` -> "monitoredChats".\n');
  } catch (err) {
    console.log('⚠️ Could not list existing chats:', err.message);
  }
  await catchUp();
});

// ---------------------------------------------------------------- de-duplication + catch-up cursor
// Read-only: the bridge only READS messages. It never sends, never marks chats as read.
const CURSOR_FILE = path.join(__dirname, 'data', 'wa_cursor.json');
const seenIds = new Set();
try {
  const logPath = config.storage && config.storage.logFile;
  const prior = logPath && fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
  prior.forEach(n => { if (n && typeof n.messageId === 'string' && n.messageId.startsWith('wa:')) seenIds.add(n.messageId); });
} catch (e) { /* empty log is fine */ }
function readCursor() { try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).lastMessageAt || 0; } catch (e) { return 0; } }
function writeCursor(epochSec) {
  try {
    if (epochSec <= readCursor()) return;
    fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
    const tmp = CURSOR_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastMessageAt: epochSec, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, CURSOR_FILE);
  } catch (e) { console.error('⚠️ [Cursor] could not save:', e.message); }
}

async function processMessage(msg, opts = {}) {
  try {
    const waId = msg.id && msg.id._serialized ? 'wa:' + msg.id._serialized : null;
    if (waId && seenIds.has(waId)) return false;
    if (waId) seenIds.add(waId);
    if (msg.timestamp && !opts.catchUp) writeCursor(msg.timestamp);
    const chat = await msg.getChat();
    const chatName = chat.name || chat.formattedTitle || msg.from;
    const chatId = chat.id ? chat.id._serialized : msg.from;
    const text = msg.body || '';
    const hasMedia = Boolean(msg.hasMedia);
    let sender = 'Unknown';

    if (msg.author) {
      const contact = await msg.getContact();
      sender = contact.pushname || contact.name || msg.author.replace(/@.+/, '');
    } else {
      sender = chatName;
    }

    let mediaFileName = '';
    let mediaType = '';

    // Check triage rules before heavy downloading
    const triageResult = triageMessage({
      text,
      hasMedia,
      mediaType,
      mediaFileName,
      chatName,
      chatId,
      sender
    }, config);

    if (!triageResult.triggered) {
      // Message ignored per filter rules
      return;
    }

    console.log('\n🔔 [TRIAGE ALERT] Matched Academic Notice!');
    console.log(`   Chat:     ${chatName}`);
    console.log(`   Sender:   ${sender}`);
    console.log(`   Category: ${triageResult.category}`);
    console.log(`   Priority: ${triageResult.priority}`);
    console.log(`   Deadline: ${triageResult.deadline}`);
    console.log(`   Action:   ${triageResult.actionRequired}`);

    let savedFilePath = null;

    // Download document / media if attached
    if (hasMedia && config.downloadDocuments) {
      try {
        console.log('   📥 Downloading attached document/media...');
        const media = await msg.downloadMedia();
        if (media && media.data) {
          mediaType = media.mimetype;
          const extension = (getExtensionFromMime(media.mimetype) || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
          const originalName = media.filename ? path.parse(media.filename).name : 'Notice';
          const cleanName = originalName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const dateTag = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const finalFileName = `${cleanName}_${dateTag}.${extension}`;

          savedFilePath = path.join(config.storage.documentsDir, finalFileName);
          fs.writeFileSync(savedFilePath, Buffer.from(media.data, 'base64'));
          console.log(`   💾 Document saved: ${savedFilePath}`);
        }
      } catch (mediaErr) {
        console.error('   ⚠️ Failed to download media:', mediaErr.message);
      }
    }

    // 1. Update Action Checklist in Academic-DPG
    recordNotice({
      chatName,
      sender,
      category: triageResult.category,
      priority: triageResult.priority,
      summary: triageResult.summary,
      actionRequired: triageResult.actionRequired,
      deadline: triageResult.deadline,
      savedFile: savedFilePath,
      rawText: text,
      channel: 'whatsapp',
      messageId: waId || undefined,
      timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString()
    }, config);

    // 2. Trigger macOS Desktop Notification
    if (config.notifications?.enabled && !opts.catchUp) {
      sendNotification({
        title: `🔔 Academic Notice [${triageResult.priority}]`,
        subtitle: `${chatName} (${sender})`,
        message: `${triageResult.summary} | Action: ${triageResult.actionRequired}`,
        sound: config.notifications.sound || 'Hero',
        speak: config.notifications.speakNotice
      });
    }

    console.log('   ✅ Notification sent & checklist updated.\n');
    return true;
  } catch (err) {
    console.error('⚠️ [Error handling message]:', err.message);
    return false;
  }
}

client.on('message', (msg) => { processMessage(msg); });

/** On start: read recent messages from monitored chats that arrived while the bridge was off. */
async function catchUp() {
  const real = (config.monitoredChats || []).filter(c => c && !/^REPLACE_WITH/i.test(c));
  if (!real.length) { console.log('ℹ️ [Catch-up] No monitored chats configured; skipping.'); return; }
  const maxHours = Math.min(Number(config.myDay && config.myDay.whatsappCatchUpHours) || 24, 72);
  const floor = Math.floor(Date.now() / 1000) - maxHours * 3600;
  const since = Math.max(readCursor(), floor);
  console.log(`🔎 [Catch-up] Reading messages since ${new Date(since * 1000).toLocaleString('en-IN')} in ${real.length} watched chats...`);
  let found = 0; let newest = 0; let ok = false;
  try {
    const chats = (await client.getChats()).filter(c => isChatMonitored(c.name || c.formattedTitle || '', c.id && c.id._serialized, config));
    for (const chat of chats) {
      let msgs = [];
      try { msgs = await chat.fetchMessages({ limit: 50 }); } catch (e) { console.log(`   ⚠️ ${chat.name}: ${e.message}`); continue; }
      const fresh = msgs.filter(m => !m.fromMe && m.timestamp && m.timestamp > since).sort((a, b) => a.timestamp - b.timestamp);
      for (const m of fresh) { if (await processMessage(m, { catchUp: true })) found++; newest = Math.max(newest, m.timestamp); }
    }
    ok = true;
  } catch (err) { console.error('⚠️ [Catch-up] failed:', err.message); }
  if (ok && newest) writeCursor(newest); // only after a complete pass
  console.log(`✅ [Catch-up] Done. ${found} new notice${found === 1 ? '' : 's'} from messages received while the bridge was off.`);
  if (found && config.notifications && config.notifications.enabled) {
    sendNotification({ title: 'My Day', subtitle: 'WhatsApp catch-up', message: `${found} new notice${found === 1 ? '' : 's'} while you were away`, sound: config.notifications.sound || 'Hero' });
  }
}

client.on('disconnected', (reason) => {
  console.warn('⚠️ [WhatsApp] Disconnected:', reason);
  console.log('Reconnecting client in 5 seconds...');
  setTimeout(() => {
    client.initialize();
  }, 5000);
});

// Helper for MIME extension mapping
function getExtensionFromMime(mimeType) {
  if (!mimeType) return 'bin';
  const map = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'text/csv': 'csv',
    'text/plain': 'txt'
  };
  return map[mimeType] || mimeType.split('/')[1] || 'bin';
}

// Graceful termination
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down WhatsApp Bridge...');
  await client.destroy();
  process.exit(0);
});

// Initialize client
client.initialize();
