/**
 * Local dashboard server for the WhatsApp bridge.
 * Serves bridge-dashboard.html and the real notices from data/notices_log.json.
 * Binds to 127.0.0.1 only. Read-only apart from data/dashboard_state.json
 * (last-seen time and which tasks are ticked) and "open notices folder".
 *
 * Integrated Connectors:
 * - Read-only Gmail via Loopback + PKCE (Keychain 'facultysync-gmail')
 * - Read-only Outlook via Device Code & IMAP fallback (Keychain 'facultysync-outlook')
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const gmail = require('./connectors/gmail');
const outlook = require('./connectors/outlook');
const applemail = require('./connectors/applemail');
const syncState = require('./connectors/syncState');

const PORT = Number(process.env.PORT) || 8766;
const HERE = __dirname;
const CONFIG = path.join(HERE, 'config.json');
const STATE = path.join(HERE, 'data', 'dashboard_state.json');
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function config() { return readJson(CONFIG, {}); }
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function allowed(req) {
  if (!HOSTS.has(req.headers.host || '')) return false;
  const o = req.headers.origin;
  return !o || o === `http://127.0.0.1:${PORT}` || o === `http://localhost:${PORT}`;
}
function readBody(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 20000) req.destroy(); else chunks.push(c); });
  req.on('end', () => { try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(null); } });
}
function loadState() {
  const s = readJson(STATE, {});
  return { lastSeen: typeof s.lastSeen === 'string' ? s.lastSeen : '', done: s.done && typeof s.done === 'object' ? s.done : {} };
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE);
}

let syncInProgress = false;

// Mac Mail counts as the "Outlook" channel in the UI when it is connected (or needs a permission fix).
function macMailOverride(outlookStatus, state) {
  const a = applemail.getStatus();
  if (a === 'connected') {
    return { status: 'connected', lastSync: state.applemail && state.applemail.lastSync, activeRoute: 'Mac Mail (Apple Mail app)' };
  }
  if (a === 'reauth_needed' && outlookStatus !== 'connected') {
    return { status: 'reauth_needed', lastSync: state.applemail && state.applemail.lastSync, activeRoute: 'Mac Mail: allow Terminal to control Mail (System Settings > Privacy & Security > Automation)' };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return send(res, 403, { error: 'bad host or origin' });
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(HERE, 'bridge-dashboard.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url === '/api/notices') {
    const localLog = path.join(HERE, 'data', 'notices_log.json');
    const cfgLog = config().storage && config().storage.logFile;
    const list = readJson(cfgLog, null) || readJson(localLog, []);
    const cfg = config();
    return send(res, 200, {
      notices: Array.isArray(list) ? list : [],
      chats: cfg.monitoredChats || [],
      keywords: cfg.keywords || [],
      owner: typeof cfg.ownerName === 'string' ? cfg.ownerName.slice(0, 40) : '',
      state: loadState(),
      now: new Date().toISOString()
    });
  }

  if (req.method === 'GET' && url === '/api/channels') {
    try {
      const gStatus = await gmail.getStatus();
      const oStatus = await outlook.getStatus();
      const state = syncState.loadSyncState();

      return send(res, 200, {
        whatsapp: {
          status: 'connected',
          lastSync: state.whatsapp && state.whatsapp.lastSync
        },
        gmail: {
          status: gStatus,
          lastSync: state.gmail && state.gmail.lastSync
        },
        outlook: macMailOverride(oStatus, state) || {
          status: oStatus,
          lastSync: state.outlook && state.outlook.lastSync,
          activeRoute: outlook.getActiveRouteDescription()
        }
      });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url === '/api/sync') {
    return readBody(req, async (b) => {
      if (b === null) return send(res, 400, { error: 'bad json' });
      // One sync at a time: overlapping runs could fetch the same mail twice or move a cursor backwards.
      if (syncInProgress) return send(res, 409, { ok: false, error: 'A sync is already running. Try again in a moment.' });
      syncInProgress = true;
      try {
      const targetChannels = Array.isArray(b.channels) && b.channels.length > 0
        ? b.channels.filter(c => c === 'gmail' || c === 'outlook')
        : ['gmail', 'outlook'];

      const results = {};
      const cfg = config();

      for (const ch of targetChannels) {
        if (ch === 'gmail') {
          try {
            results.gmail = await gmail.syncGmail({ config: cfg });
          } catch (err) {
            results.gmail = { ok: false, error: err.message };
          }
        } else if (ch === 'outlook') {
          try {
            // If Mac Mail is connected it is the Outlook route; otherwise use Graph / IMAP.
            results.outlook = applemail.getStatus() === 'connected'
              ? await applemail.syncAppleMail({ config: cfg })
              : await outlook.syncOutlook({ config: cfg });
          } catch (err) {
            results.outlook = { ok: false, error: err.message };
          }
        }
      }

      send(res, 200, { ok: true, results });
      } finally {
        syncInProgress = false;
      }
    });
  }

  if (req.method === 'POST' && url === '/api/connect/gmail') {
    try {
      let responded = false;
      gmail.startAuth({
        openBrowser: true,
        onAuthUrl: (authUrl) => {
          if (!responded) {
            responded = true;
            send(res, 200, { ok: true, message: 'Google consent opened in browser', authUrl });
          }
        }
      }).then(() => {
        console.log('✅ [Server] Gmail linked successfully');
      }).catch((err) => {
        console.error('⚠️ [Server] Gmail sign-in error:', err.message);
      });

      setTimeout(() => {
        if (!responded) {
          responded = true;
          send(res, 200, { ok: true, message: 'Google sign-in initiated' });
        }
      }, 1000);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && url === '/api/connect/applemail') {
    try {
      const r = await applemail.connect({});
      return send(res, r.ok ? 200 : 400, r);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && url === '/api/connect/outlook') {
    return readBody(req, async (b) => {
      b = b || {};
      if (b.imapPassword) {
        try {
          await outlook.setupImapPassword(b.imapPassword, b.email);
          return send(res, 200, { ok: true, message: 'IMAP app password saved to Keychain' });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      try {
        const dcResult = await outlook.startDeviceCodeFlow();
        if (!dcResult.ok) {
          return send(res, 400, { error: dcResult.error });
        }

        if (dcResult.verificationUri) {
          execFile('open', [dcResult.verificationUri], () => {});
        }

        // Background poller
        (async () => {
          const intervalMs = (dcResult.interval || 5) * 1000;
          const deadline = Date.now() + (dcResult.expiresIn || 900) * 1000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, intervalMs));
            const pollRes = await outlook.pollDeviceCodeToken(dcResult.deviceCode);
            if (pollRes.status === 'connected' || pollRes.status === 'tenant_blocked' || pollRes.status === 'error' || pollRes.status === 'expired') {
              break;
            }
          }
        })().catch(e => console.error('⚠️ [Server] Outlook poll background error:', e.message));

        send(res, 200, {
          ok: true,
          userCode: dcResult.userCode,
          verificationUri: dcResult.verificationUri,
          message: dcResult.message,
          deviceCode: dcResult.deviceCode
        });
      } catch (err) {
        send(res, 500, { error: err.message });
      }
    });
  }

  if (req.method === 'POST' && url === '/api/connect/outlook/poll') {
    return readBody(req, async (b) => {
      if (!b || !b.deviceCode) return send(res, 400, { error: 'deviceCode required' });
      const pollRes = await outlook.pollDeviceCodeToken(b.deviceCode);
      send(res, 200, pollRes);
    });
  }

  if (req.method === 'POST' && url === '/api/state') {
    return readBody(req, (b) => {
      if (!b) return send(res, 400, { error: 'bad json' });
      const s = loadState();
      if (b.markSeen === true) s.lastSeen = new Date().toISOString();
      if (b.done && typeof b.done === 'object') {
        Object.keys(b.done).slice(0, 200).forEach(id => {
          if (/^[0-9A-Za-z_-]{1,40}$/.test(id)) { if (b.done[id]) s.done[id] = true; else delete s.done[id]; }
        });
      }
      saveState(s);
      send(res, 200, { ok: true, state: s });
    });
  }

  if (req.method === 'POST' && url === '/api/open-folder') {
    const dir = config().storage && config().storage.documentsDir;
    if (!dir || !fs.existsSync(dir)) return send(res, 404, { error: 'notices folder not found' });
    return execFile('open', [dir], (err) => send(res, err ? 500 : 200, { ok: !err }));
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`FacultySync dashboard: http://127.0.0.1:${PORT}`));
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (dashboard may already be running).` : e.message);
  process.exit(1);
});
