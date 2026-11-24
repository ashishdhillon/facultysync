/**
 * Shared sync state manager for FacultySync.
 * Stores per-channel cursors atomically in data/sync_state.json.
 */
const fs = require('fs');
const path = require('path');

// FACULTYSYNC_STATE_FILE lets tests (or advanced users) use a different cursor file.
const DEFAULT_STATE_FILE = process.env.FACULTYSYNC_STATE_FILE || path.join(__dirname, '..', 'data', 'sync_state.json');

function defaultState() {
  return {
    whatsapp: { lastSync: null },
    gmail: { lastSync: null, historyOrAfter: null },
    outlook: { lastSync: null, deltaToken: null }
  };
}

function loadSyncState(filePath = DEFAULT_STATE_FILE) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultState();
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Object.assign(defaultState(), data);
  } catch (err) {
    return defaultState();
  }
}

function saveSyncState(state, filePath = DEFAULT_STATE_FILE) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function getChannelState(channel, filePath = DEFAULT_STATE_FILE) {
  const state = loadSyncState(filePath);
  return state[channel] || { lastSync: null };
}

function updateChannelState(channel, updates, filePath = DEFAULT_STATE_FILE) {
  const state = loadSyncState(filePath);
  state[channel] = Object.assign({}, state[channel] || {}, updates);
  saveSyncState(state, filePath);
  return state[channel];
}

module.exports = {
  DEFAULT_STATE_FILE,
  loadSyncState,
  saveSyncState,
  getChannelState,
  updateChannelState
};
