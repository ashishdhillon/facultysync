/**
 * Deterministic Triage Rules & Keyword Filter
 */

function isCasualChatter(text, ignorePhrases = []) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Check emoji-only messages
  const emojiRegex = /^[\p{Extended_Pictographic}\s\p{P}]+$/u;
  if (emojiRegex.test(trimmed)) return true;

  const clean = trimmed.toLowerCase().replace(/[^\w\s]/g, '').trim();
  for (const phrase of ignorePhrases) {
    const cleanPhrase = phrase.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (clean === cleanPhrase || clean.startsWith(cleanPhrase + ' ') || clean.endsWith(' ' + cleanPhrase)) {
      return true;
    }
  }

  return false;
}

function matchKeywords(text, keywords = []) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matched = [];

  for (const kw of keywords) {
    const cleanKw = kw.toLowerCase();
    if (cleanKw.length <= 4) {
      const regex = new RegExp(`\\b${cleanKw}\\b`, 'i');
      if (regex.test(text)) matched.push(kw);
    } else {
      if (lower.includes(cleanKw)) matched.push(kw);
    }
  }

  return matched;
}

function extractBasicDeadline(text) {
  if (!text) return 'Not specified';

  const relative = text.match(/\b(?:by|before|till|within|on or before)\s+([A-Za-z0-9\s,:-]{2,30}?)(?=[.?!,\n]|$)/i);
  if (relative && relative[1]) return relative[0].trim();

  const explicitDate = text.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+\d{2,4})?/i);
  if (explicitDate) return explicitDate[0].trim();

  const slashDate = text.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/);
  if (slashDate) return slashDate[0].trim();

  return 'Immediate / Check notice';
}

function detectCategory(text, hasMedia = false) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('exam') || lower.includes('datesheet') || lower.includes('sessional') || lower.includes('duty')) {
    return 'Exams & Duties';
  }
  if (lower.includes('meeting') || lower.includes('agenda') || lower.includes('convened')) {
    return 'Department Meetings';
  }
  if (lower.includes('lab') || lower.includes('load') || lower.includes('workload') || lower.includes('incharge')) {
    return 'Lab & Teaching Load';
  }
  if (lower.includes('syllabus') || lower.includes('course file') || lower.includes('lesson plan')) {
    return 'Syllabus & Course File';
  }
  if (lower.includes('marks') || lower.includes('attendance') || lower.includes('defaulter')) {
    return 'Marks & Attendance';
  }
  if (hasMedia) return 'Official Circular / File';
  return 'General Academic';
}

module.exports = {
  isCasualChatter,
  matchKeywords,
  extractBasicDeadline,
  detectCategory
};
