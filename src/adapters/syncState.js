const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../data/sync_state.json');

function ensureDataDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getSyncState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initialState = {
      lastSyncTimestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24 hours ago default
      syncCount: 0,
      channels: {
        whatsapp: { lastProcessedId: null, lastTimestamp: null },
        outlook: { lastProcessedId: null, lastTimestamp: null },
        gmail: { lastProcessedId: null, lastTimestamp: null }
      }
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2), 'utf8');
    return initialState;
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    return { lastSyncTimestamp: new Date().toISOString(), syncCount: 0 };
  }
}

function updateSyncTimestamp(timestamp = new Date().toISOString()) {
  const state = getSyncState();
  state.lastSyncTimestamp = timestamp;
  state.syncCount = (state.syncCount || 0) + 1;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

module.exports = {
  getSyncState,
  updateSyncTimestamp
};
