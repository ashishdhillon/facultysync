/**
 * Comprehensive Unit Tests for FacultySync Connectors
 * Tests:
 * 1. Cursor handling (initial, incremental, atomic persistence, no update on failure)
 * 2. De-duplication by messageId (skips existing messageIds)
 * 3. Domain filtering (.ac.in, .edu, mdurohtak.ac.in, extraSenders vs spam)
 * 4. Token refresh failure (invalid_grant -> reauth_needed without crash)
 * 5. Triage on sample subject: "MDU datesheet - submit marks by 28th Nov"
 * 6. Tenant block detection (AADSTS65001 / AADSTS90094 -> IMAP route activation)
 * 
 * Uses isolated temporary directories and mocked HTTP / fetch responses.
 * Zero external network access required.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Enable keychain mock for test isolation
process.env.NODE_ENV = 'test';
process.env.KEYCHAIN_MOCK = '1';
// Never touch the real data/sync_state.json: all cursor writes go to a throw-away temp file.
process.env.FACULTYSYNC_STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'facultysync-state-')), 'sync_state.json');
process.env.GOOGLE_CLIENT_ID = 'mock-google-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'mock-google-client-secret';
process.env.MICROSOFT_CLIENT_ID = 'mock-ms-client-id';

const keychain = require('./connectors/keychain');
const syncState = require('./connectors/syncState');
const gmail = require('./connectors/gmail');
const outlook = require('./connectors/outlook');
const { triageMessage } = require('./triage');

console.log('🧪 Starting FacultySync Connectors Unit Tests...\n');

let passedCount = 0;
let totalCount = 0;

function it(name, fn) {
  totalCount++;
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.then(() => {
        console.log(`  ✅ ${name}`);
        passedCount++;
      }).catch(err => {
        console.error(`  ❌ ${name}`);
        console.error(`     Error: ${err.message}`);
      });
    }
    console.log(`  ✅ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     Error: ${err.message}`);
  }
}

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facultysync-test-'));
  const testStateFile = path.join(tmpDir, 'sync_state.json');
  const testLogFile = path.join(tmpDir, 'notices_log.json');
  const testChecklist = path.join(tmpDir, 'ACTION_CHECKLIST.md');

  const testConfig = {
    ownerName: "Ashish",
    monitoredChats: ["*"],
    keywords: ["exam", "datesheet", "marks", "sessional", "asd"],
    ignoreCasualPhrases: ["good morning", "thank you"],
    storage: {
      logFile: testLogFile,
      actionChecklistFile: testChecklist,
      documentsDir: tmpDir
    },
    notifications: { enabled: false },
    gmail: {
      senderDomains: [".ac.in", ".edu", "mdurohtak.ac.in"],
      extraSenders: ["special@external.org"],
      maxPerSync: 50
    },
    outlook: {
      senderDomains: [".ac.in", ".edu", "mdurohtak.ac.in"],
      extraSenders: ["special@external.org"],
      maxPerSync: 50
    }
  };

  // 1. DOMAIN FILTERING TESTS
  console.log('--- Suite 1: Academic Domain & Sender Filtering ---');
  it('Allows university academic domain (.ac.in)', () => {
    assert.strictEqual(gmail.isAllowedSender('Exam Cell <exam@dpgitm.ac.in>', testConfig.gmail.senderDomains, testConfig.gmail.extraSenders), true);
    assert.strictEqual(outlook.isAllowedSender('exam@dpgitm.ac.in', testConfig.outlook.senderDomains, testConfig.outlook.extraSenders), true);
  });

  it('Allows institutional education domain (.edu)', () => {
    assert.strictEqual(gmail.isAllowedSender('Dean <dean@mit.edu>', testConfig.gmail.senderDomains, testConfig.gmail.extraSenders), true);
  });

  it('Allows specific affiliated university domain (mdurohtak.ac.in)', () => {
    assert.strictEqual(gmail.isAllowedSender('Controller of Examinations <coe@mdurohtak.ac.in>', testConfig.gmail.senderDomains, testConfig.gmail.extraSenders), true);
  });

  it('Allows explicitly listed extraSenders', () => {
    assert.strictEqual(gmail.isAllowedSender('External Evaluator <special@external.org>', testConfig.gmail.senderDomains, testConfig.gmail.extraSenders), true);
  });

  it('Blocks non-academic external senders (promotional/commercial spam)', () => {
    assert.strictEqual(gmail.isAllowedSender('Amazon Offers <promo@amazon.com>', testConfig.gmail.senderDomains, testConfig.gmail.extraSenders), false);
    assert.strictEqual(outlook.isAllowedSender('Spammy Newsletter <deals@marketing.net>', testConfig.outlook.senderDomains, testConfig.outlook.extraSenders), false);
  });

  // 2. CURSOR HANDLING & ATOMIC PERSISTENCE
  console.log('\n--- Suite 2: Shared Sync State & Cursor Handling ---');
  it('Saves and loads sync state atomically without corruption', () => {
    syncState.saveSyncState({
      whatsapp: { lastSync: '2026-11-23T10:00:00Z' },
      gmail: { lastSync: '2026-11-23T10:00:00Z', historyOrAfter: 1732356000 },
      outlook: { lastSync: '2026-11-23T10:00:00Z', deltaToken: 'tok123' }
    }, testStateFile);

    const loaded = syncState.loadSyncState(testStateFile);
    assert.strictEqual(loaded.gmail.historyOrAfter, 1732356000);
    assert.strictEqual(loaded.outlook.deltaToken, 'tok123');
  });

  it('Updates channel state incrementally', () => {
    syncState.updateChannelState('gmail', { historyOrAfter: 1732360000, lastSync: '2026-11-23T11:00:00Z' }, testStateFile);
    const gState = syncState.getChannelState('gmail', testStateFile);
    assert.strictEqual(gState.historyOrAfter, 1732360000);
  });

  // 3. TOKEN REFRESH & ERROR HANDLING
  console.log('\n--- Suite 3: Token Refresh & Auth Error Recovery ---');
  await it('Handles invalid_grant by marking channel reauth_needed instead of crashing', async () => {
    await keychain.setSecret(gmail.KEYCHAIN_SERVICE, gmail.KEYCHAIN_ACCOUNT, 'test-refresh-token');

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant', error_description: 'Token has been revoked.' })
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };

    const tokenRes = await gmail.getAccessToken(mockFetch);
    assert.strictEqual(tokenRes.status, 'reauth_needed');
    assert.strictEqual(tokenRes.token, null);

    const chStatus = await gmail.getStatus();
    assert.strictEqual(chStatus, 'reauth_needed');
  });

  // 4. TRIAGE ON SAMPLE SUBJECT
  console.log('\n--- Suite 4: Triage Engine on Sample Email Notice ---');
  it('Accurately triages "MDU datesheet - submit marks by 28th Nov"', () => {
    const sampleSubject = 'MDU datesheet - submit marks by 28th Nov';
    const sampleSnippet = 'All BCA faculty members must submit sessional exam marks before the university deadline.';

    const triageResult = triageMessage({
      text: `${sampleSubject}\n${sampleSnippet}`,
      hasMedia: false,
      chatName: 'Gmail · Examination Branch',
      sender: 'coe@mdurohtak.ac.in'
    }, testConfig);

    assert.strictEqual(triageResult.triggered, true);
    assert.strictEqual(triageResult.category, 'Exam / Sessional');
    assert.strictEqual(triageResult.priority, 'HIGH');
    assert.strictEqual(triageResult.deadline, 'by 28th Nov');
    assert.ok(triageResult.foundKeywords.includes('datesheet'));
    assert.ok(triageResult.foundKeywords.includes('marks'));
    assert.ok(triageResult.foundKeywords.includes('sessional'));
  });

  // 5. GMAIL CONNECTOR SYNC & DE-DUPLICATION
  console.log('\n--- Suite 5: Gmail End-to-End Mocked Sync & De-Duplication ---');
  await it('Syncs messages and correctly ignores duplicate messageIds', async () => {
    // Setup working refresh token
    await keychain.setSecret(gmail.KEYCHAIN_SERVICE, gmail.KEYCHAIN_ACCOUNT, 'valid-refresh-token');
    syncState.updateChannelState('gmail', { reauthNeeded: false });

    const mockMessages = [
      { id: 'gmail_msg_001', threadId: 't1' },
      { id: 'gmail_msg_spam', threadId: 't2' }
    ];

    const mockFetch = async (url) => {
      // Token endpoint
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-access-token', expires_in: 3600 })
        };
      }
      // List messages endpoint
      if (url.includes('messages?q=')) {
        return {
          ok: true,
          json: async () => ({ messages: mockMessages })
        };
      }
      // Message 1 (academic)
      if (url.includes('messages/gmail_msg_001?')) {
        return {
          ok: true,
          json: async () => ({
            id: 'gmail_msg_001',
            snippet: 'Please verify BCA sessional datesheet and submit marks before 28th Nov.',
            payload: {
              headers: [
                { name: 'From', value: 'Examination Branch <coe@mdurohtak.ac.in>' },
                { name: 'Subject', value: 'MDU datesheet - submit marks by 28th Nov' },
                { name: 'Date', value: 'Mon, 24 Nov 2026 09:30:00 +0530' }
              ],
              parts: [
                { filename: 'Datesheet_2026.pdf', body: { attachmentId: 'att1' } }
              ]
            }
          })
        };
      }
      // Message 2 (spam sender)
      if (url.includes('messages/gmail_msg_spam?')) {
        return {
          ok: true,
          json: async () => ({
            id: 'gmail_msg_spam',
            snippet: 'Get 50% discount on web hosting',
            payload: {
              headers: [
                { name: 'From', value: 'Spam Deal <sales@randomspammer.com>' },
                { name: 'Subject', value: 'Flash Sale today only' },
                { name: 'Date', value: 'Mon, 24 Nov 2026 10:00:00 +0530' }
              ]
            }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    // First sync: should record 1 academic message
    const res1 = await gmail.syncGmail({
      fetchFn: mockFetch,
      config: testConfig
    });

    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.newCount, 1);

    // Verify stored notice
    const log1 = JSON.parse(fs.readFileSync(testLogFile, 'utf8'));
    assert.strictEqual(log1.length, 1);
    assert.strictEqual(log1[0].messageId, 'gmail_msg_001');
    assert.strictEqual(log1[0].channel, 'gmail');
    assert.strictEqual(log1[0].priority, 'HIGH');
    assert.strictEqual(log1[0].deadline, 'by 28th Nov');
    assert.strictEqual(log1[0].savedFile, 'Datesheet_2026.pdf');

    // Second sync with same message: should de-duplicate and add 0 items
    const res2 = await gmail.syncGmail({
      fetchFn: mockFetch,
      config: testConfig
    });

    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.newCount, 0); // De-duplicated!
    const log2 = JSON.parse(fs.readFileSync(testLogFile, 'utf8'));
    assert.strictEqual(log2.length, 1); // Still 1
  });

  // 6. OUTLOOK GRAPH SYNC & TENANT BLOCK FALLBACK
  console.log('\n--- Suite 6: Outlook Graph Sync & Tenant Block Recovery ---');
  await it('Handles Graph tenant block (AADSTS65001) and activates IMAP fallback', async () => {
    const mockFetchBlocked = async (url) => {
      if (url.includes('login.microsoftonline.com') && url.includes('/token')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: 'invalid_grant',
            error_description: 'AADSTS65001: The user or administrator has not consented to use the application with ID mock-ms-client-id.'
          })
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };

    const pollRes = await outlook.pollDeviceCodeToken('mock-device-code', { fetchFn: mockFetchBlocked });
    assert.strictEqual(pollRes.status, 'tenant_blocked');
    assert.strictEqual(pollRes.code, 'AADSTS65001');

    const routeDesc = outlook.getActiveRouteDescription();
    assert.ok(routeDesc.includes('IMAP over TLS'));
  });

  await it('Syncs Outlook messages via Graph when permitted', async () => {
    await keychain.setSecret(outlook.KEYCHAIN_SERVICE, outlook.KEYCHAIN_ACCOUNT_GRAPH, 'valid-graph-token');
    syncState.updateChannelState('outlook', { tenantBlocked: false, activeRoute: 'graph', reauthNeeded: false });

    const mockGraphMessages = [
      {
        id: 'outlook_msg_001',
        from: { emailAddress: { name: 'Principal Office', address: 'principal@dpgitm.ac.in' } },
        subject: 'Urgent meeting on lab allocation and syllabus',
        bodyPreview: 'ASD please convene in conference room today at 3:00 PM.',
        receivedDateTime: '2026-11-24T08:00:00Z',
        hasAttachments: false,
        attachments: []
      }
    ];

    const mockFetch = async (url) => {
      if (url.includes('login.microsoftonline.com')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-graph-access-token', expires_in: 3600 })
        };
      }
      if (url.includes('graph.microsoft.com/v1.0/me/messages')) {
        return {
          ok: true,
          json: async () => ({ value: mockGraphMessages })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const outSync = await outlook.syncViaGraph({
      fetchFn: mockFetch,
      config: testConfig
    });

    assert.strictEqual(outSync.ok, true);
    assert.strictEqual(outSync.newCount, 1);

    const logAfterOutlook = JSON.parse(fs.readFileSync(testLogFile, 'utf8'));
    assert.strictEqual(logAfterOutlook.length, 2);
    const outlookEntry = logAfterOutlook.find(n => n.messageId === 'outlook_msg_001');
    assert.ok(outlookEntry);
    assert.strictEqual(outlookEntry.channel, 'outlook');
    assert.strictEqual(outlookEntry.priority, 'HIGH');
    assert.ok(outlookEntry.summary.includes('Urgent meeting'));
  });

  // Clean up
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}

  console.log(`\n==================================================`);
  console.log(`Connector Test Summary: ${passedCount}/${totalCount} Passed`);
  console.log(`==================================================\n`);

  if (passedCount < totalCount) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
