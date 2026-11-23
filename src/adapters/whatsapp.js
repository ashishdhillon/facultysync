const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

let client = null;
let currentQrCode = null;
let isReady = false;
let discoveredChats = [];
let monitoredChats = [];

function initWhatsApp(config, onMessageReceived) {
  monitoredChats = config.channels.whatsapp.monitoredChats || [];

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '../../.wwebjs_auth')
    }),
    puppeteer: {
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    currentQrCode = qr;
    isReady = false;
    console.log('\n📱 [WhatsApp] Scan QR code from phone (Settings > Linked Devices):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('✅ [WhatsApp] Session authenticated! Token saved.');
    currentQrCode = null;
  });

  client.on('ready', async () => {
    isReady = true;
    currentQrCode = null;
    console.log('🚀 [WhatsApp] Bridge connected & ready to monitor!');

    try {
      const chats = await client.getChats();
      discoveredChats = chats.map(c => ({
        id: c.id._serialized,
        name: c.name || c.formattedTitle || 'Unnamed Chat',
        isGroup: c.isGroup,
        unreadCount: c.unreadCount || 0
      }));
      console.log(`📋 [WhatsApp] Discovered ${discoveredChats.length} active chats.`);
    } catch (err) {
      console.warn('⚠️ [WhatsApp] Could not fetch chat list:', err.message);
    }
  });

  client.on('message', async (msg) => {
    if (onMessageReceived) {
      try {
        const chat = await msg.getChat();
        const chatName = chat.name || chat.formattedTitle || msg.from;

        // Check if this chat is monitored
        const isMonitored = monitoredChats.some(m => 
          chatName.toLowerCase().includes(m.toLowerCase())
        );

        if (isMonitored) {
          onMessageReceived({
            id: msg.id._serialized,
            source: 'WhatsApp',
            chatName,
            sender: msg.author || chatName,
            text: msg.body || '',
            hasMedia: Boolean(msg.hasMedia),
            timestamp: new Date(msg.timestamp * 1000).toISOString()
          });
        }
      } catch (err) {
        console.error('Error handling message:', err.message);
      }
    }
  });

  client.initialize().catch(err => {
    console.warn('⚠️ [WhatsApp] Client initialization warning:', err.message);
  });

  return client;
}

function getStatus() {
  return {
    isReady,
    hasPendingQr: Boolean(currentQrCode),
    qrCode: currentQrCode,
    monitoredChats,
    totalDiscoveredChats: discoveredChats.length
  };
}

function getDiscoveredChats() {
  return discoveredChats;
}

function setMonitoredChats(chats = []) {
  monitoredChats = chats;
  return monitoredChats;
}

module.exports = {
  initWhatsApp,
  getStatus,
  getDiscoveredChats,
  setMonitoredChats
};
