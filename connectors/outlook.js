/**
 * FacultySync - Read-Only Outlook Connector
 * 
 * Strict Read-Only: scope is strictly Mail.Read. Never marks mail as read, never modifies.
 * Zero Secrets in Repo: Tokens stored in macOS Keychain under 'facultysync-outlook'.
 * Store per email only: id, channel, sender, subject, snippet (max 300 chars), received time, attachment file names.
 * Supports Microsoft Graph delegated device-code flow, with automatic IMAP-over-TLS fallback
 * if college tenant blocks third-party apps (AADSTS65001 / AADSTS90094).
 */
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const keychain = require('./keychain');
const syncState = require('./syncState');
const { triageMessage } = require('../triage');
const { recordNotice } = require('../checklist');

const KEYCHAIN_SERVICE = 'facultysync-outlook';
const KEYCHAIN_ACCOUNT_GRAPH = 'graph-refresh-token';
const KEYCHAIN_ACCOUNT_IMAP = 'imap-app-password';
const CLIENT_SECRET_FILE = path.join(__dirname, '..', 'data', 'microsoft_client.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function readJsonSafe(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return fallback;
}

function getClientCredentials() {
  const envId = process.env.MICROSOFT_CLIENT_ID || process.env.MS_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  if (envId) {
    return { clientId: envId.trim() };
  }

  const fileData = readJsonSafe(CLIENT_SECRET_FILE);
  const clientId = fileData.client_id || fileData.clientId || fileData.appId;
  if (clientId) {
    return { clientId: clientId.trim() };
  }

  // Fallback to common multi-tenant developer app ID if present
  return null;
}

/**
 * Initiates Microsoft Graph delegated device-code flow
 */
async function startDeviceCodeFlow(options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const creds = getClientCredentials();
  if (!creds || !creds.clientId) {
    return {
      ok: false,
      error: 'Missing Microsoft Client ID. Set MICROSOFT_CLIENT_ID env variable or data/microsoft_client.json'
    };
  }

  try {
    const res = await fetchFn('https://login.microsoftonline.com/common/oauth2/v2.0/devicecode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        scope: 'offline_access https://graph.microsoft.com/Mail.Read'
      }).toString()
    });

    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error_description || data.error || 'Failed to start device code flow' };
    }

    return {
      ok: true,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval || 5,
      message: data.message
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Polls token endpoint during device-code flow
 */
async function pollDeviceCodeToken(deviceCode, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const creds = getClientCredentials();
  if (!creds || !creds.clientId) {
    return { status: 'error', error: 'Missing client credentials' };
  }

  try {
    const res = await fetchFn('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: creds.clientId,
        device_code: deviceCode
      }).toString()
    });

    const data = await res.json();
    if (!res.ok) {
      const err = data.error || '';
      const desc = data.error_description || '';

      if (err === 'authorization_pending') {
        return { status: 'pending' };
      }
      if (err === 'slow_down') {
        return { status: 'slow_down' };
      }

      // Check for tenant block: AADSTS65001 (user/admin consent required) or AADSTS90094 (admin consent required)
      if (desc.includes('AADSTS65001') || desc.includes('AADSTS90094') || err === 'access_denied') {
        syncState.updateChannelState('outlook', {
          tenantBlocked: true,
          activeRoute: 'imap_fallback'
        });
        console.log('⚠️ [Outlook] College tenant blocked Graph third-party app consent. Falling back to IMAP over TLS.');
        return {
          status: 'tenant_blocked',
          error: 'Tenant policy requires admin consent for Graph API. IMAP over TLS fallback is activated.',
          code: desc.includes('AADSTS65001') ? 'AADSTS65001' : 'AADSTS90094'
        };
      }

      if (err === 'code_expired') {
        return { status: 'expired', error: 'Device code expired' };
      }

      return { status: 'error', error: desc || err };
    }

    if (data.refresh_token) {
      await keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GRAPH, data.refresh_token);
      syncState.updateChannelState('outlook', {
        reauthNeeded: false,
        tenantBlocked: false,
        activeRoute: 'graph'
      });
      return { status: 'connected', accessToken: data.access_token };
    }

    return { status: 'error', error: 'No refresh token received' };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/**
 * Gets fresh access token from Graph refresh token
 */
async function getGraphAccessToken(fetchFn = fetch) {
  const refreshToken = await keychain.getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GRAPH);
  if (!refreshToken) {
    return { token: null, status: 'not_connected' };
  }

  const creds = getClientCredentials();
  if (!creds || !creds.clientId) {
    return { token: null, status: 'error', error: 'Missing client credentials' };
  }

  try {
    const res = await fetchFn('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: creds.clientId,
        refresh_token: refreshToken,
        scope: 'offline_access https://graph.microsoft.com/Mail.Read'
      }).toString()
    });

    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'invalid_grant') {
        syncState.updateChannelState('outlook', { reauthNeeded: true });
        return { token: null, status: 'reauth_needed', error: 'invalid_grant' };
      }
      return { token: null, status: 'error', error: data.error_description || data.error };
    }

    if (data.refresh_token) {
      // Azure tokens can rotate
      await keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GRAPH, data.refresh_token);
    }
    syncState.updateChannelState('outlook', { reauthNeeded: false });
    return { token: data.access_token, status: 'connected' };
  } catch (err) {
    return { token: null, status: 'error', error: err.message };
  }
}

/**
 * Checks overall Outlook status and active route
 */
async function getStatus() {
  const state = syncState.getChannelState('outlook');
  if (state.reauthNeeded) return 'reauth_needed';

  // Check Graph
  const graphToken = await keychain.getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_GRAPH);
  if (graphToken && !state.tenantBlocked) {
    return 'connected';
  }

  // Check IMAP
  const imapPass = await keychain.getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_IMAP);
  if (imapPass) {
    return 'connected';
  }

  return 'not_connected';
}

function getActiveRouteDescription() {
  const state = syncState.getChannelState('outlook');
  if (state.activeRoute === 'imap_fallback' || state.tenantBlocked) {
    return 'IMAP over TLS (outlook.office365.com:993) [Graph blocked by tenant policy]';
  }
  return 'Microsoft Graph API (Delegated Device Code)';
}

/**
 * Configure IMAP app password in Keychain
 */
async function setupImapPassword(password, email) {
  if (!password) throw new Error('Password required');
  await keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_IMAP, password);
  syncState.updateChannelState('outlook', {
    activeRoute: 'imap_fallback',
    reauthNeeded: false,
    imapEmail: email || undefined
  });
  console.log('✅ [Outlook] Stored IMAP app password in Keychain for IMAP TLS route.');
  return { ok: true, route: 'imap_fallback' };
}

/**
 * Academic sender filter
 */
function isAllowedSender(senderStr, senderDomains = [], extraSenders = []) {
  if ((!senderDomains || senderDomains.length === 0) && (!extraSenders || extraSenders.length === 0)) {
    return true;
  }

  const emailMatch = (senderStr || '').match(/<([^>]+)>/);
  const email = (emailMatch ? emailMatch[1] : senderStr || '').trim().toLowerCase();

  if (Array.isArray(extraSenders) && extraSenders.some(s => s.toLowerCase() === email)) {
    return true;
  }

  if (Array.isArray(senderDomains)) {
    return senderDomains.some(domain => {
      const d = domain.trim().toLowerCase();
      if (!d) return false;
      return email.endsWith(d) || email.includes(`@${d}`) || email.includes(d);
    });
  }

  return false;
}

/**
 * Sync using Microsoft Graph
 */
async function syncViaGraph(options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const cfg = options.config || readJsonSafe(CONFIG_FILE, {});
  const outlookCfg = cfg.outlook || {
    senderDomains: ['.ac.in', '.edu', 'mdurohtak.ac.in'],
    extraSenders: [],
    maxPerSync: 100
  };

  const tokenInfo = await getGraphAccessToken(fetchFn);
  if (tokenInfo.status !== 'connected' || !tokenInfo.token) {
    return { ok: false, status: tokenInfo.status, error: tokenInfo.error || 'Not connected' };
  }

  const channelState = syncState.getChannelState('outlook');
  let receivedAfter = channelState.lastSync;
  if (!receivedAfter) {
    // Default to last 7 days
    receivedAfter = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  }

  const maxResults = Math.min(Number(outlookCfg.maxPerSync) || 100, 100);
  const filterQuery = `receivedDateTime ge ${receivedAfter}`;
  const graphUrl = `https://graph.microsoft.com/v1.0/me/messages?$select=id,from,subject,bodyPreview,receivedDateTime,hasAttachments&$expand=attachments($select=name)&$orderby=receivedDateTime desc&$top=${maxResults}&$filter=${encodeURIComponent(filterQuery)}`;

  const res = await fetchFn(graphUrl, {
    headers: { Authorization: `Bearer ${tokenInfo.token}` }
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    return { ok: false, status: 'error', error: (errData.error && errData.error.message) || `HTTP ${res.status}` };
  }

  const data = await res.json();
  const messages = data.value || [];

  return processOutlookMessages(messages, cfg, outlookCfg, 'graph');
}

/**
 * Lightweight IMAP over TLS client
 * Strictly uses BODY.PEEK so messages are NEVER marked as read or modified.
 */
function fetchMessagesViaImap(imapConfig, sinceDate, maxResults = 100) {
  return new Promise((resolve, reject) => {
    const { host = 'outlook.office365.com', port = 993, user, pass } = imapConfig;
    if (!user || !pass) {
      return reject(new Error('IMAP username and password required'));
    }

    const socket = tls.connect({ host, port, servername: host }, () => {
      // Connected
    });

    let buffer = '';
    let step = 'greeting';
    let seqNumbers = [];
    const messages = [];

    const dateStr = sinceDate.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

    function sendCmd(cmd) {
      socket.write(cmd + '\r\n');
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      if (step === 'greeting' && buffer.includes('* OK')) {
        buffer = '';
        step = 'login';
        const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        if (/[\r\n]/.test(user) || /[\r\n]/.test(pass)) { socket.destroy(); reject(new Error('Invalid characters in IMAP credentials')); return; }
        sendCmd(`A01 LOGIN ${q(user)} ${q(pass)}`);
        return;
      }

      if (step === 'login' && buffer.includes('A01 ')) {
        if (!buffer.includes('A01 OK')) {
          socket.end();
          return reject(new Error('IMAP authentication failed'));
        }
        buffer = '';
        step = 'select';
        sendCmd('A02 SELECT INBOX');
        return;
      }

      if (step === 'select' && buffer.includes('A02 ')) {
        if (!buffer.includes('A02 OK')) {
          socket.end();
          return reject(new Error('IMAP SELECT INBOX failed'));
        }
        buffer = '';
        step = 'search';
        sendCmd(`A03 SEARCH SINCE ${dateStr}`);
        return;
      }

      if (step === 'search' && buffer.includes('A03 ')) {
        const searchMatch = buffer.match(/\* SEARCH (.*)\r?\n/);
        buffer = '';
        if (searchMatch && searchMatch[1].trim()) {
          seqNumbers = searchMatch[1].trim().split(/\s+/).filter(Boolean);
          if (seqNumbers.length > maxResults) {
            seqNumbers = seqNumbers.slice(seqNumbers.length - maxResults);
          }
        }
        if (seqNumbers.length === 0) {
          step = 'logout';
          sendCmd('A05 LOGOUT');
          return;
        }

        step = 'fetch';
        const seqList = seqNumbers.join(',');
        // Using BODY.PEEK to keep strictly READ-ONLY (does not set \Seen flag)
        sendCmd(`A04 FETCH ${seqList} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.400>)`);
        return;
      }

      if (step === 'fetch' && buffer.includes('A04 ')) {
        // Parse fetched items from buffer
        const rawItems = buffer.split(/\* \d+ FETCH/);
        for (const item of rawItems) {
          if (!item.trim()) continue;
          const msgIdMatch = item.match(/Message-ID:\s*<([^>]+)>/i);
          const fromMatch = item.match(/From:\s*([^\r\n]+)/i);
          const subjMatch = item.match(/Subject:\s*([^\r\n]+)/i);
          const dateMatch = item.match(/Date:\s*([^\r\n]+)/i);
          const textMatch = item.match(/BODY\[TEXT\]<0>\s*\{?\d*\}?\r?\n([\s\S]*?)(?=\)|\r?\nA04|$)/i);

          if (fromMatch || subjMatch) {
            const rawText = (textMatch ? textMatch[1] : '').replace(/\r?\n/g, ' ').slice(0, 300).trim();
            messages.push({
              id: msgIdMatch ? msgIdMatch[1] : `imap_${Date.now()}_${Math.random()}`,
              from: { emailAddress: { address: fromMatch ? fromMatch[1].trim() : 'Unknown' } },
              subject: subjMatch ? subjMatch[1].trim() : '(No Subject)',
              bodyPreview: rawText,
              receivedDateTime: dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString(),
              attachments: []
            });
          }
        }

        buffer = '';
        step = 'logout';
        sendCmd('A05 LOGOUT');
        return;
      }

      if (step === 'logout') {
        socket.end();
        resolve(messages);
      }
    });

    socket.on('error', (err) => {
      reject(err);
    });

    socket.setTimeout(20000, () => {
      socket.destroy();
      reject(new Error('IMAP connection timed out'));
    });
  });
}

/**
 * Sync using IMAP fallback
 */
async function syncViaImap(options = {}) {
  const cfg = options.config || readJsonSafe(CONFIG_FILE, {});
  const outlookCfg = cfg.outlook || {
    senderDomains: ['.ac.in', '.edu', 'mdurohtak.ac.in'],
    extraSenders: [],
    maxPerSync: 100
  };

  const pass = await keychain.getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_IMAP);
  const user = (outlookCfg && outlookCfg.email) || syncState.getChannelState('outlook').imapEmail;

  if (!pass || !user) {
    return {
      ok: false,
      status: 'not_connected',
      error: 'IMAP credentials not configured. Please supply email and app password.'
    };
  }

  const channelState = syncState.getChannelState('outlook');
  const sinceDate = channelState.lastSync ? new Date(channelState.lastSync) : new Date(Date.now() - 7 * 86400 * 1000);

  const fetcher = options.imapFetcher || fetchMessagesViaImap;
  const messages = await fetcher({
    host: outlookCfg.imapHost || 'outlook.office365.com',
    port: outlookCfg.imapPort || 993,
    user,
    pass
  }, sinceDate, outlookCfg.maxPerSync || 100);

  return processOutlookMessages(messages, cfg, outlookCfg, 'imap');
}

/**
 * Shared normalisation and triage processor
 */
function processOutlookMessages(messages, cfg, outlookCfg, routeName) {
  const logFile = (cfg.storage && cfg.storage.logFile) || path.join(__dirname, '..', 'data', 'notices_log.json');
  const existingNotices = readJsonSafe(logFile, []);
  const existingMessageIds = new Set(
    existingNotices.filter(n => n.messageId).map(n => n.messageId)
  );

  let newItemsCount = 0;
  const triageConfig = Object.assign({}, cfg, { monitoredChats: ['*'] });

  for (const m of messages) {
    const msgId = m.id;
    if (existingMessageIds.has(msgId)) {
      continue;
    }

    const senderObj = m.from && m.from.emailAddress;
    const sender = senderObj ? (senderObj.name ? `${senderObj.name} <${senderObj.address}>` : senderObj.address) : 'Unknown Sender';
    const subject = m.subject || '(No Subject)';
    const snippet = (m.bodyPreview || '').slice(0, 300);
    const dateStr = m.receivedDateTime || new Date().toISOString();
    const attachments = Array.isArray(m.attachments) ? m.attachments.map(a => a.name).filter(Boolean) : [];

    // Filter sender
    if (!isAllowedSender(sender, outlookCfg.senderDomains, outlookCfg.extraSenders)) {
      continue;
    }

    // Run through triage.js
    const combinedText = `${subject}\n${snippet}`.trim();
    const triaged = triageMessage({
      text: combinedText,
      hasMedia: attachments.length > 0,
      mediaType: 'email/attachment',
      mediaFileName: attachments[0] || '',
      chatName: `Outlook · ${sender.replace(/<.*>/, '').trim() || sender}`,
      chatId: sender,
      sender: sender
    }, triageConfig);

    if (triaged.triggered) {
      const receivedDate = new Date(dateStr);
      const noticeItem = {
        id: String(Date.now() + Math.floor(Math.random() * 1000)),
        messageId: msgId,
        channel: 'outlook',
        timestamp: !isNaN(receivedDate.getTime()) ? receivedDate.toISOString() : new Date().toISOString(),
        formattedDate: (!isNaN(receivedDate.getTime()) ? receivedDate : new Date()).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'short',
          timeStyle: 'short'
        }),
        chatName: `Outlook · ${sender.replace(/<.*>/, '').trim() || sender}`,
        sender: sender,
        subject: subject,
        category: triaged.category,
        priority: triaged.priority,
        summary: subject || triaged.summary,
        actionRequired: triaged.actionRequired,
        deadline: triaged.deadline,
        savedFile: attachments.length > 0 ? attachments[0] : null,
        attachmentFileNames: attachments,
        snippet: snippet,
        rawText: combinedText
      };

      recordNotice(noticeItem, cfg);
      existingMessageIds.add(msgId);
      newItemsCount++;
    }
  }

  // Update cursor ONLY after fully successful fetch
  syncState.updateChannelState('outlook', {
    lastSync: new Date().toISOString(),
    activeRoute: routeName
  });

  return { ok: true, newCount: newItemsCount, totalFound: messages.length, route: routeName };
}

/**
 * Main sync entry point - tries Graph, falls back to IMAP
 */
async function syncOutlook(options = {}) {
  const state = syncState.getChannelState('outlook');

  if (state.activeRoute === 'imap_fallback' || state.tenantBlocked) {
    console.log('📬 [Outlook] Syncing via IMAP over TLS fallback...');
    return syncViaImap(options);
  }

  // Try Graph first
  const graphResult = await syncViaGraph(options);
  if (!graphResult.ok && (graphResult.error && (graphResult.error.includes('AADSTS65001') || graphResult.error.includes('AADSTS90094')))) {
    console.log('⚠️ [Outlook] Graph API blocked by tenant. Switching to IMAP over TLS fallback.');
    syncState.updateChannelState('outlook', { tenantBlocked: true, activeRoute: 'imap_fallback' });
    return syncViaImap(options);
  }

  return graphResult;
}

module.exports = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT_GRAPH,
  KEYCHAIN_ACCOUNT_IMAP,
  getClientCredentials,
  startDeviceCodeFlow,
  pollDeviceCodeToken,
  getGraphAccessToken,
  getStatus,
  getActiveRouteDescription,
  setupImapPassword,
  isAllowedSender,
  syncOutlook,
  syncViaGraph,
  syncViaImap
};
