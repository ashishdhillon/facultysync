/**
 * Triage Engine for WhatsApp Academic Notices
 */

/**
 * Checks if a chat is in the monitored list
 */
function isChatMonitored(chatName, chatId, config) {
  if (!config.monitoredChats || config.monitoredChats.length === 0) {
    return true; // If no chats configured, monitor all for initial discovery
  }

  const monitored = config.monitoredChats.filter(
    c => c && !c.startsWith('REPLACE_WITH_')
  );

  if (monitored.length === 0) {
    return true; // Only placeholder chats present
  }

  const targetName = (chatName || '').trim().toLowerCase();
  const targetId = (chatId || '').trim().toLowerCase();

  return monitored.some(m => {
    const item = m.trim().toLowerCase();
    if (item === '*') return true;
    return targetName.includes(item) || targetId.includes(item);
  });
}

/**
 * Checks if a text message is casual chatter (should be ignored)
 */
function isCasualChatter(text, ignorePhrases = []) {
  if (!text || typeof text !== 'string') return false;

  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Check if string contains only emojis, spaces, and punctuation
  const emojiRegex = /^[\p{Extended_Pictographic}\s\p{P}]+$/u;
  if (emojiRegex.test(trimmed)) {
    return true;
  }

  // Check against ignore phrases
  const lower = trimmed.toLowerCase().replace(/[^\w\s]/g, '').trim();
  for (const phrase of ignorePhrases) {
    const cleanPhrase = phrase.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (lower === cleanPhrase || lower.startsWith(cleanPhrase + ' ') || lower.endsWith(' ' + cleanPhrase)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if any keyword matches in the text
 */
function findKeywords(text, keywords = []) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];

  for (const kw of keywords) {
    const cleanKw = kw.toLowerCase();
    // Match word boundaries for short acronyms like "asd"
    if (cleanKw.length <= 4) {
      const regex = new RegExp(`\\b${cleanKw}\\b`, 'i');
      if (regex.test(text)) {
        found.push(kw);
      }
    } else {
      if (lower.includes(cleanKw)) {
        found.push(kw);
      }
    }
  }

  return found;
}

/**
 * Extracts deadlines and dates from the message
 */
function extractDeadline(text) {
  if (!text) return 'Not specified / Check notice';

  // Ignore phone numbers (e.g. +91-9000012345) and attachment file names (e.g. DocScanner 29-Jul 12-20 PM.pdf)
  // so their digits are not mistaken for dates.
  text = String(text)
    .replace(/\S*\.(?:pdf|docx?|xlsx?|csv|pptx?|jpe?g|png|zip)\b/gi, ' ')
    .replace(/\+?\d[\d\s-]{7,}\d/g, ' ');

  // 1. Check relative deadlines: "by tomorrow", "by 5 PM", "by today evening", "before Friday"
  const relativeMatch = text.match(/\b(?:by|before|till|within|on or before)\s+([A-Za-z0-9\s,:-]{2,30}?)(?=[.?!,\n]|$)/i);
  if (relativeMatch && relativeMatch[1]) {
    return relativeMatch[0].trim();
  }

  // 2. Check explicit dates like 25/11/2026 or 25 Nov or 25th November
  const dateMatch = text.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{2,4})?(?:\s+(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)?/i);
  if (dateMatch) {
    return dateMatch[0].trim();
  }

  // Day/month like 25/11 or 25-11-2026: day 1-31, month 1-12, not part of a longer number.
  const slashDateMatch = text.match(/(?<![\d+])(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[0-2])(?:[/-]\d{2,4})?(?![\d])(?:\s+(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)?/i);
  if (slashDateMatch) {
    return slashDateMatch[0].trim();
  }

  // 3. Check time: "at 3:00 PM"
  const timeMatch = text.match(/\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm)\b/i);
  if (timeMatch) {
    return timeMatch[0].trim();
  }

  return 'Not specified / Immediate review';
}

/**
 * Classifies the category of the notice
 */
function classifyCategory(text, hasMedia, mediaType) {
  const lower = (text || '').toLowerCase();

  if (lower.includes('exam') || lower.includes('datesheet') || lower.includes('sessional') || lower.includes('duty') || lower.includes('external')) {
    return 'Exam / Sessional';
  }
  if (lower.includes('meeting') || lower.includes('huddle') || lower.includes('convened') || lower.includes('agenda')) {
    return 'Department Meeting';
  }
  if (lower.includes('lab') || lower.includes('load') || lower.includes('workload') || lower.includes('incharge') || lower.includes('practical')) {
    return 'Lab & Teaching Load';
  }
  if (lower.includes('syllabus') || lower.includes('curriculum') || lower.includes('course file') || lower.includes('lesson plan')) {
    return 'Syllabus & Course File';
  }
  if (lower.includes('attendance') || lower.includes('defaulter') || lower.includes('marks') || lower.includes('internal') || lower.includes('result')) {
    return 'Attendance & Marks';
  }
  if (hasMedia) {
    return 'Official Circular / Document';
  }
  return 'General Notice';
}

/**
 * Synthesizes actionable next step for Ashish
 */
function synthesizeAction(text, category, isDirectMention, hasMedia, fileName) {
  const lower = (text || '').toLowerCase();

  if (isDirectMention) {
    return 'Direct notification for ASD: review announcement and execute required department submission/action.';
  }

  switch (category) {
    case 'Exam / Sessional':
      return hasMedia
        ? `Review attached exam schedule (${fileName || 'document'}) and cross-verify class duties/deadlines.`
        : 'Note exam/sessional schedule and prepare question papers or student records.';

    case 'Department Meeting':
      return 'Check meeting agenda, note time/venue, and prepare current status notes.';

    case 'Lab & Teaching Load':
      return hasMedia
        ? `Review attached load/lab document (${fileName || 'file'}) and verify allocated lab hours.`
        : 'Verify lab assignments and update teaching load records.';

    case 'Syllabus & Course File':
      return 'Check syllabus requirements and synchronize with Academic-DPG course files.';

    case 'Attendance & Marks':
      return 'Compile student attendance/marks list and check for defaulters.';

    case 'Official Circular / Document':
      return `Open and inspect attached document (${fileName || 'file'}) saved to Department Desk/Notices.`;

    default:
      return 'Review notice and take necessary action if applicable to your classes.';
  }
}

/**
 * Main triage analyzer
 */
function triageMessage({ text = '', hasMedia = false, mediaType = '', mediaFileName = '', chatName = '', chatId = '', sender = '' }, config) {
  // Step 1: Check chat filter
  if (!isChatMonitored(chatName, chatId, config)) {
    return {
      triggered: false,
      reason: `Chat '${chatName}' is not in monitored list.`
    };
  }

  // Step 2: Check casual chatter (only if NO media is attached)
  if (!hasMedia && isCasualChatter(text, config.ignoreCasualPhrases)) {
    return {
      triggered: false,
      reason: 'Ignored as casual chatter / emoji.'
    };
  }

  // Step 3: Check keywords and media triggers
  const foundKeywords = findKeywords(text, config.keywords);
  const isDirectMention = /\basd\b/i.test(text) || /\bashish\b/i.test(text);

  // Trigger if media is attached OR keywords found OR direct mention
  if (!hasMedia && foundKeywords.length === 0 && !isDirectMention) {
    return {
      triggered: false,
      reason: 'No monitored keywords or documents found.'
    };
  }

  // Step 4: Classify notice
  const category = classifyCategory(text, hasMedia, mediaType);
  const priority = (isDirectMention || /\burgent\b/i.test(text) || /\bimmediate\b/i.test(text) || category === 'Exam / Sessional')
    ? 'HIGH'
    : 'NORMAL';

  const deadline = extractDeadline(text);
  const actionRequired = synthesizeAction(text, category, isDirectMention, hasMedia, mediaFileName);

  // Step 5: Summary
  let summary = '';
  if (text && text.trim().length > 0) {
    const firstLine = text.trim().split('\n')[0].trim();
    summary = firstLine.length > 120 ? firstLine.substring(0, 117) + '...' : firstLine;
  } else if (hasMedia) {
    summary = `Attached document: ${mediaFileName || 'Academic file'}`;
  } else {
    summary = `${category} update in ${chatName}`;
  }

  return {
    triggered: true,
    category,
    priority,
    foundKeywords,
    isDirectMention,
    deadline,
    actionRequired,
    summary,
    chatName,
    sender
  };
}

module.exports = {
  triageMessage,
  isChatMonitored,
  isCasualChatter,
  findKeywords,
  extractDeadline,
  classifyCategory,
  synthesizeAction
};
