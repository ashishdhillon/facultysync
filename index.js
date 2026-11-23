const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const { triageMessage } = require('./triage');
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
console.log('        🎓 ACADEMIC-DPG WHATSAPP LOCAL BRIDGE (LIVE)           ');
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
});

client.on('message', async (msg) => {
  try {
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
      rawText: text
    }, config);

    // 2. Trigger macOS Desktop Notification
    if (config.notifications?.enabled) {
      sendNotification({
        title: `🔔 Academic Notice [${triageResult.priority}]`,
        subtitle: `${chatName} (${sender})`,
        message: `${triageResult.summary} | Action: ${triageResult.actionRequired}`,
        sound: config.notifications.sound || 'Hero',
        speak: config.notifications.speakNotice
      });
    }

    console.log('   ✅ Notification sent & checklist updated.\n');
  } catch (err) {
    console.error('⚠️ [Error handling message]:', err.message);
  }
});

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
