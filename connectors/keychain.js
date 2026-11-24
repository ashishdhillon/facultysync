/**
 * Keychain helper for FacultySync.
 * Stores tokens securely in macOS Keychain using `security` with execFile argument arrays.
 * Never constructs shell command strings or logs credentials.
 */
const { execFile } = require('child_process');

// In-memory mock store used when testing or when running in test mode
const mockStore = new Map();

function isMock() {
  return process.env.NODE_ENV === 'test' || process.env.KEYCHAIN_MOCK === '1';
}

function getSecret(service, account = 'facultysync') {
  if (isMock()) {
    const key = `${service}:${account}`;
    return Promise.resolve(mockStore.has(key) ? mockStore.get(key) : null);
  }
  return new Promise((resolve) => {
    const args = ['find-generic-password', '-s', service];
    if (account) args.push('-a', account);
    args.push('-w');
    execFile('security', args, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

function setSecret(service, account = 'facultysync', secret) {
  if (typeof secret !== 'string' || !secret) {
    return Promise.reject(new Error('Secret must be a non-empty string'));
  }
  if (isMock()) {
    const key = `${service}:${account}`;
    mockStore.set(key, secret);
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    const args = ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret];
    execFile('security', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(true);
    });
  });
}

function deleteSecret(service, account = 'facultysync') {
  if (isMock()) {
    const key = `${service}:${account}`;
    mockStore.delete(key);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const args = ['delete-generic-password', '-s', service];
    if (account) args.push('-a', account);
    execFile('security', args, (err) => resolve(!err));
  });
}

function _clearMockStore() {
  mockStore.clear();
}

module.exports = {
  getSecret,
  setSecret,
  deleteSecret,
  _clearMockStore
};
