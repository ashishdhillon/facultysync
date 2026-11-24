const fs = require('fs');
const path = require('path');

/**
 * Ensures a directory exists synchronously
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Initializes ACTION_CHECKLIST.md if it doesn't already exist
 */
function initChecklistFile(filePath) {
  if (!fs.existsSync(filePath)) {
    ensureDir(path.dirname(filePath));
    const header = `# Academic Notice Action Checklist

> **Purpose:** Live action items, official notices, and document submissions parsed from department WhatsApp chats for **Ashish Dhillon (ASD)**.
> **Auto-Updated By:** WhatsApp Bridge Triage Engine.

---

## 📌 Active / Pending Actions

| Status | Priority | Date | Chat | Summary | Action Required | Deadline | File |
| :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |

---

## 📋 Detailed Notice History

`;
    fs.writeFileSync(filePath, header, 'utf8');
  }
}

/**
 * Appends a triaged notice to ACTION_CHECKLIST.md and the JSON log
 */
function recordNotice(noticeData, config) {
  const {
    id = Date.now().toString(),
    timestamp = new Date().toISOString(),
    chatName = 'Unknown Chat',
    sender = 'Unknown Sender',
    category = 'General',
    priority = 'NORMAL',
    summary = '',
    actionRequired = '',
    deadline = 'Not specified',
    savedFile = null,
    rawText = ''
  } = noticeData;

  const checklistPath = config.storage.actionChecklistFile;
  const logPath = config.storage.logFile;

  ensureDir(path.dirname(checklistPath));
  initChecklistFile(checklistPath);

  const formattedDate = new Date(timestamp).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'short',
    timeStyle: 'short'
  });

  const priorityBadge = priority === 'HIGH' ? '🔴 HIGH' : '🟡 NORMAL';
  const fileLink = savedFile ? `[${path.basename(savedFile)}](file://${savedFile})` : 'None';

  // 1. Update ACTION_CHECKLIST.md
  try {
    let content = fs.readFileSync(checklistPath, 'utf8');

    // Add row to table under "## 📌 Active / Pending Actions"
    const tableRow = `| [ ] | ${priorityBadge} | ${formattedDate} | ${chatName} | ${summary.replace(/\|/g, '-')} | ${actionRequired.replace(/\|/g, '-')} | ${deadline} | ${fileLink} |\n`;

    const tableMarker = '| Status | Priority | Date | Chat | Summary | Action Required | Deadline | File |\n| :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |\n';

    if (content.includes(tableMarker)) {
      content = content.replace(tableMarker, tableMarker + tableRow);
    } else {
      content += `\n${tableRow}`;
    }

    // Add detailed block under "## 📋 Detailed Notice History"
    const detailedBlock = `
### [ ] ${priorityBadge} ${formattedDate} - ${chatName}
- **Summary:** ${summary}
- **Category:** ${category}
- **Action Required:** ${actionRequired}
- **Deadline / Next Step:** ${deadline}
- **Sender:** ${sender}
- **Document / Media:** ${fileLink}
- **Raw Message:**
  > ${rawText ? rawText.split('\n').join('\n  > ') : '_No message text_'}

---
`;

    content += detailedBlock;
    fs.writeFileSync(checklistPath, content, 'utf8');
    console.log(`📝 [Checklist] Updated ${checklistPath}`);
  } catch (err) {
    console.error('⚠️ [Checklist] Error updating markdown file:', err.message);
  }

  // 2. Append to JSON log
  try {
    ensureDir(path.dirname(logPath));
    let logs = [];
    if (fs.existsSync(logPath)) {
      try {
        logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      } catch (e) {
        logs = [];
      }
    }
    logs.unshift(Object.assign({
      id,
      timestamp,
      formattedDate,
      chatName,
      sender,
      category,
      priority,
      summary,
      actionRequired,
      deadline,
      savedFile,
      rawText
    }, noticeData));
    // Keep max 500 entries in log
    if (logs.length > 500) logs = logs.slice(0, 500);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('⚠️ [Checklist] Error updating JSON log:', err.message);
  }
}

module.exports = {
  recordNotice,
  initChecklistFile
};
