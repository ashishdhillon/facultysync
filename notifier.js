const { execFile } = require('child_process');

/**
 * Escapes strings for AppleScript
 */
function escapeAppleScript(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');
}

/**
 * Sends a native macOS desktop notification
 * @param {Object} options
 * @param {string} options.title - Notification title
 * @param {string} options.subtitle - Chat or sender subtitle
 * @param {string} options.message - Body text / summary
 * @param {string} [options.sound] - System sound name (Hero, Ping, Submarine, Glass, etc.)
 * @param {boolean} [options.speak] - If true, speaks a short alert via macOS `say`
 */
function sendNotification({ title, subtitle, message, sound = 'Hero', speak = false }) {
  const safeTitle = escapeAppleScript(title || 'Academic Notice');
  const safeSubtitle = escapeAppleScript(subtitle || '');
  const safeMessage = escapeAppleScript(message || '');
  const safeSound = escapeAppleScript(sound);

  const script = `display notification "${safeMessage}" with title "${safeTitle}" subtitle "${safeSubtitle}" sound name "${safeSound}"`;

  execFile('osascript', ['-e', script], (error) => {
    if (error) {
      console.error('⚠️ [Notifier] Failed to send macOS desktop notification:', error.message);
    }
  });

  if (speak) {
    // execFile with an argument array: no shell, so chat names cannot inject commands.
    const speechText = String(subtitle ? `New notice in ${subtitle}` : 'New academic notice').replace(/[\r\n]+/g, ' ').slice(0, 200);
    execFile('say', ['-v', 'Samantha', '--', speechText], () => {});
  }
}

module.exports = {
  sendNotification,
  escapeAppleScript
};
