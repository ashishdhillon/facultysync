/**
 * Tests the Gmail sign-in loopback protections: state check, host check, and that
 * a forged callback cannot abort or complete the flow. No network, no real account.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.KEYCHAIN_MOCK = '1';
process.env.GOOGLE_CLIENT_ID = 'mock-id';
process.env.GOOGLE_CLIENT_SECRET = 'mock-secret';
process.env.FACULTYSYNC_STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'facultysync-oauth-')), 'sync_state.json');

const gmail = require('./connectors/gmail');

function get(port, pathAndQuery, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, headers: { Host: host || `127.0.0.1:${port}` } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  let ok = 0;
  const check = (name, cond) => { assert.ok(cond, name); console.log('  ✅ ' + name); ok++; };
  let tokenCalls = 0;
  const fetchFn = async () => { tokenCalls++; return { ok: true, json: async () => ({ refresh_token: 'mock-refresh', email: 'x@example.com' }) }; };

  let authUrl, port;
  const flow = gmail.startAuth({ openBrowser: false, fetchFn, onAuthUrl: (u, p) => { authUrl = u; port = p; } });
  await new Promise(r => setTimeout(r, 300));
  const state = new URL(authUrl).searchParams.get('state');
  check('Auth URL carries a random state value', typeof state === 'string' && state.length >= 32);
  check('Scope is gmail.readonly only', new URL(authUrl).searchParams.get('scope') === 'https://www.googleapis.com/auth/gmail.readonly');

  check('Code without state is rejected (400)', await get(port, '/?code=forged') === 400);
  check('Code with wrong state is rejected (400)', await get(port, '/?code=forged&state=nope') === 400);
  check('Forged error without state cannot abort the flow (400)', await get(port, '/?error=access_denied') === 400);
  check('Wrong Host header is rejected (403)', await get(port, `/?code=x&state=${state}`, 'evil.com') === 403);
  check('No token exchange happened for any forged request', tokenCalls === 0);

  check('Correct state completes the flow (200)', await get(port, `/?code=realcode&state=${state}`) === 200);
  const result = await flow;
  check('Flow resolves successfully after the real callback', result && result.success === true);
  check('Exactly one token exchange occurred', tokenCalls === 1);
  console.log(`\nOAuth Test Summary: ${ok}/${ok} Passed`);
  process.exit(0);
})().catch(e => { console.error('❌ OAuth test failed:', e.message); process.exit(1); });
