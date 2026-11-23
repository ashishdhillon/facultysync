/**
 * Local dashboard server for the WhatsApp bridge.
 * Serves bridge-dashboard.html and the real notices from data/notices_log.json.
 * Binds to 127.0.0.1 only. Read-only apart from data/dashboard_state.json
 * (last-seen time and which tasks are ticked) and "open notices folder".
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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

const server = http.createServer((req, res) => {
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
    const dir = config().storage && config().storage.documentsDir;   // from config only, never from the request
    if (!dir || !fs.existsSync(dir)) return send(res, 404, { error: 'notices folder not found' });
    return execFile('open', [dir], (err) => send(res, err ? 500 : 200, { ok: !err }));
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`WhatsApp bridge dashboard: http://127.0.0.1:${PORT}`));
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (dashboard may already be running).` : e.message); process.exit(1); });
