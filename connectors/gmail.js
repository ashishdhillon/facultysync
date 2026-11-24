/**
 * FacultySync - Read-Only Gmail Connector
 * 
 * Strict Read-Only: scope is strictly https://www.googleapis.com/auth/gmail.readonly.
 * Zero Secrets in Repo: Tokens stored in macOS Keychain under 'facultysync-gmail'.
 * Store per email only: id, channel, sender, subject, snippet (max 300 chars), received time, attachment file names.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const keychain = require('./keychain');
const syncState = require('./syncState');
const { triageMessage } = require('../triage');
const { recordNotice } = require('../checklist');

const KEYCHAIN_SERVICE = 'facultysync-gmail';
const KEYCHAIN_ACCOUNT = 'facultysync';
const CLIENT_SECRET_FILE = path.join(__dirname, '..', 'data', 'google_client.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function readJsonSafe(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return fallback;
}

function getClientCredentials() {
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId.trim(), clientSecret: envSecret.trim() };
  }

  const fileData = readJsonSafe(CLIENT_SECRET_FILE);
  const installed = fileData.installed || fileData.web || fileData;
  const clientId = installed.client_id || installed.clientId;
  const clientSecret = installed.client_secret || installed.clientSecret;

  if (clientId && clientSecret) {
    return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  }
  return null;
}

/**
 * Generates PKCE code_verifier and code_challenge
 */
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Starts loopback server and PKCE authorization flow for Gmail
 */
function startAuth(options = {}) {
  const creds = getClientCredentials();
  if (!creds) {
    return Promise.reject(new Error(
      'Google Client credentials missing. Provide GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET env variables or data/google_client.json'
    ));
  }

  const { verifier, challenge } = generatePkce();
  // Random per-attempt value: the redirect must echo it back, so stray or forged requests to the loopback port are ignored.
  const oauthState = require('crypto').randomBytes(24).toString('hex');

  return new Promise((resolve, reject) => {
    let server;
    let timer;

    server = http.createServer(async (req, res) => {
      try {
        // Only accept requests addressed to our own loopback port (blocks DNS-rebinding tricks).
        const hostOk = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`].includes(req.headers.host || '');
        if (!hostOk) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Forbidden'); }
        const reqUrl = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');
        // Ignore (but do not abort on) anything that does not carry our state value.
        if ((code || error) && reqUrl.searchParams.get('state') !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('Invalid state');
        }

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h2>Authentication error</h2><p>${escapeHtml(error)}</p>`);
          cleanup();
          return reject(new Error(`Auth denied: ${error}`));
        }

        if (code) {
          const fetchFn = options.fetchFn || fetch;
          const tokenRes = await fetchFn('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: creds.clientId,
              client_secret: creds.clientSecret,
              code,
              code_verifier: verifier,
              grant_type: 'authorization_code',
              redirect_uri: `http://127.0.0.1:${server.address().port}`
            }).toString()
          });

          const tokenData = await tokenRes.json();
          if (!tokenRes.ok || !tokenData.refresh_token) {
            const errMsg = tokenData.error_description || tokenData.error || 'Failed to exchange token';
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>Token Exchange Failed</h2><p>${escapeHtml(errMsg)}</p>`);
            cleanup();
            return reject(new Error(errMsg));
          }

          // Save refresh token to Keychain
          await keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, tokenData.refresh_token);
          syncState.updateChannelState('gmail', { reauthNeeded: false });

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#EEF6FF;color:#12306B">
            <h2 style="color:#1F6FEB">🎉 FacultySync Connected!</h2>
            <p>Gmail has been linked securely. You can close this tab and return to the dashboard.</p>
          </body></html>`);

          cleanup();
          return resolve({ success: true, email: tokenData.email || 'connected' });
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        state: oauthState,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent'
      }).toString();

      timer = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth flow timed out (120s)'));
      }, 120000);

      if (options.openBrowser !== false) {
        execFile('open', [authUrl], () => {});
      }

      if (options.onAuthUrl) {
        options.onAuthUrl(authUrl, port);
      }
    });

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (server) {
        try { server.close(); } catch (e) {}
      }
    }
  });
}

/**
 * Gets a fresh access token from Keychain refresh token
 */
async function getAccessToken(fetchFn = fetch) {
  const refreshToken = await keychain.getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!refreshToken) {
    return { token: null, status: 'not_connected' };
  }

  const creds = getClientCredentials();
  if (!creds) {
    return { token: null, status: 'error', error: 'Missing client credentials' };
  }

  try {
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString()
    });

    const data = await res.json();
    if (!res.ok) {
      if (data.error === 'invalid_grant') {
        syncState.updateChannelState('gmail', { reauthNeeded: true });
        return { token: null, status: 'reauth_needed', error: 'invalid_grant' };
      }
      return { token: null, status: 'error', error: data.error_description || data.error };
    }

    syncState.updateChannelState('gmail', { reauthNeeded: false });
    return { token: data.access_token, status: 'connected' };
  } catch (err) {
    return { token: null, status: 'error', error: err.message };
  }
}

/**
 * Checks channel status
 */
async function getStatus() {
  const state = syncState.getChannelState('gmail');
  if (state.reauthNeeded) return 'reauth_needed';
  const refreshToken = await keychain.getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!refreshToken) return 'not_connected';
  return 'connected';
}

/**
 * Domain & sender filter
 */
function isAllowedSender(senderStr, senderDomains = [], extraSenders = []) {
  if ((!senderDomains || senderDomains.length === 0) && (!extraSenders || extraSenders.length === 0)) {
    return true; // No filter configured, allow all
  }

  const emailMatch = (senderStr || '').match(/<([^>]+)>/);
  const email = (emailMatch ? emailMatch[1] : senderStr || '').trim().toLowerCase();

  // Check extra senders
  if (Array.isArray(extraSenders) && extraSenders.some(s => s.toLowerCase() === email)) {
    return true;
  }

  // Check domains
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
 * Parse headers from Gmail message metadata format
 */
function parseHeaders(headersList = []) {
  const map = {};
  for (const h of headersList) {
    if (h && h.name) map[h.name.toLowerCase()] = h.value;
  }
  return map;
}

/**
 * Extract attachment filenames recursively from message parts
 */
function extractAttachmentNames(parts = []) {
  const filenames = [];
  function recurse(list) {
    if (!Array.isArray(list)) return;
    for (const part of list) {
      if (part.filename && part.filename.trim()) {
        filenames.push(part.filename.trim());
      }
      if (part.parts) recurse(part.parts);
    }
  }
  recurse(parts);
  return filenames;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Sync Gmail messages
 */
async function syncGmail(options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const cfg = options.config || readJsonSafe(CONFIG_FILE, {});
  const gmailCfg = cfg.gmail || {
    senderDomains: ['.ac.in', '.edu', 'mdurohtak.ac.in'],
    extraSenders: [],
    maxPerSync: 100
  };

  const tokenInfo = await getAccessToken(fetchFn);
  if (tokenInfo.status !== 'connected' || !tokenInfo.token) {
    return { ok: false, status: tokenInfo.status, error: tokenInfo.error || 'Not connected' };
  }

  const channelState = syncState.getChannelState('gmail');
  let afterEpoch = channelState.historyOrAfter;
  if (!afterEpoch) {
    // Default to last 7 days for initial cursor
    afterEpoch = Math.floor((Date.now() - 7 * 86400 * 1000) / 1000);
  }

  const maxResults = Math.min(Number(gmailCfg.maxPerSync) || 100, 100);
  const q = `after:${afterEpoch}`;
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`;

  const listRes = await fetchFn(listUrl, {
    headers: { Authorization: `Bearer ${tokenInfo.token}` }
  });

  if (!listRes.ok) {
    const errData = await listRes.json().catch(() => ({}));
    return { ok: false, status: 'error', error: errData.error && errData.error.message || `HTTP ${listRes.status}` };
  }

  const listData = await listRes.json();
  const messages = listData.messages || [];
  if (messages.length === 0) {
    syncState.updateChannelState('gmail', {
      lastSync: new Date().toISOString(),
      historyOrAfter: Math.floor(Date.now() / 1000)
    });
    return { ok: true, newCount: 0, totalFound: 0 };
  }

  // Read existing notices to de-duplicate on messageId
  const logFile = (cfg.storage && cfg.storage.logFile) || path.join(__dirname, '..', 'data', 'notices_log.json');
  const existingNotices = readJsonSafe(logFile, []);
  const existingMessageIds = new Set(
    existingNotices.filter(n => n.messageId).map(n => n.messageId)
  );

  let newItemsCount = 0;
  const triageConfig = Object.assign({}, cfg, { monitoredChats: ['*'] });

  for (const m of messages) {
    if (existingMessageIds.has(m.id)) {
      continue;
    }

    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
    const msgRes = await fetchFn(msgUrl, {
      headers: { Authorization: `Bearer ${tokenInfo.token}` }
    });
    if (!msgRes.ok) continue;

    const msgData = await msgRes.json();
    const headers = parseHeaders((msgData.payload && msgData.payload.headers) || []);
    const sender = headers['from'] || 'Unknown Sender';
    const subject = headers['subject'] || '(No Subject)';
    const dateStr = headers['date'] || new Date().toISOString();
    const snippet = (msgData.snippet || '').slice(0, 300);
    const attachmentNames = extractAttachmentNames(msgData.payload && msgData.payload.parts);

    // Filter sender
    if (!isAllowedSender(sender, gmailCfg.senderDomains, gmailCfg.extraSenders)) {
      continue;
    }

    // Run through triage.js with subject + snippet
    const combinedText = `${subject}\n${snippet}`.trim();
    const triaged = triageMessage({
      text: combinedText,
      hasMedia: attachmentNames.length > 0,
      mediaType: 'email/attachment',
      mediaFileName: attachmentNames[0] || '',
      chatName: `Gmail · ${sender.replace(/<.*>/, '').trim() || sender}`,
      chatId: sender,
      sender: sender
    }, triageConfig);

    if (triaged.triggered) {
      const receivedDate = new Date(dateStr);
      const noticeItem = {
        id: String(Date.now() + Math.floor(Math.random() * 1000)),
        messageId: m.id,
        channel: 'gmail',
        timestamp: !isNaN(receivedDate.getTime()) ? receivedDate.toISOString() : new Date().toISOString(),
        formattedDate: (!isNaN(receivedDate.getTime()) ? receivedDate : new Date()).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'short',
          timeStyle: 'short'
        }),
        chatName: `Gmail · ${sender.replace(/<.*>/, '').trim() || sender}`,
        sender: sender,
        subject: subject,
        category: triaged.category,
        priority: triaged.priority,
        summary: subject || triaged.summary,
        actionRequired: triaged.actionRequired,
        deadline: triaged.deadline,
        savedFile: attachmentNames.length > 0 ? attachmentNames[0] : null,
        attachmentFileNames: attachmentNames,
        snippet: snippet,
        rawText: combinedText
      };

      recordNotice(noticeItem, cfg);
      existingMessageIds.add(m.id);
      newItemsCount++;
    }
  }

  // Update cursor ONLY after fully successful fetch
  syncState.updateChannelState('gmail', {
    lastSync: new Date().toISOString(),
    historyOrAfter: Math.floor(Date.now() / 1000)
  });

  return { ok: true, newCount: newItemsCount, totalFound: messages.length };
}

module.exports = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  getClientCredentials,
  generatePkce,
  startAuth,
  getAccessToken,
  getStatus,
  isAllowedSender,
  syncGmail
};
