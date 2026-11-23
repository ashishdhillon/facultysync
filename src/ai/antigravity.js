/**
 * Antigravity AI Engine (Powered by Gemini SDK)
 * Analyzes messy academic circulars, WhatsApp messages, and email threads
 * into structured summaries, deadlines, and actionable tasks.
 */
require('dotenv').config();
const { extractBasicDeadline, detectCategory } = require('../triage/rules');

let GoogleGenAI = null;
try {
  const genaiPkg = require('@google/genai');
  GoogleGenAI = genaiPkg.GoogleGenAI;
} catch (e) {
  // @google/genai will be loaded when npm install completes
}

async function analyzeNoticeWithAI(rawText, source = 'WhatsApp', sender = '', facultyConfig = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  // If Gemini API is available, use Antigravity intelligence
  if (apiKey && GoogleGenAI) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `
You are an expert Academic Operations Assistant for college faculty member ${facultyConfig.name || 'Faculty'} (${facultyConfig.acronym || 'ASD'}) at ${facultyConfig.institution || 'College'}.
Analyze the following academic update received via ${source} from ${sender || 'Department'}.

Input text:
"${rawText}"

Extract:
1. Short clear summary (max 12 words)
2. Academic category (Exams & Duties, Lab & Teaching Load, Department Meetings, Syllabus & Course File, Marks & Attendance, Official Circular)
3. Priority ("HIGH" if direct mention of faculty, urgent submission, or exam duty; otherwise "NORMAL")
4. Exact deadline (e.g., "Today before 4:00 PM", "28th Nov", "Not specified")
5. Concrete action required from the faculty member
6. Ready-to-assign Task Title

Respond ONLY in valid JSON matching this schema:
{
  "summary": "string",
  "category": "string",
  "priority": "HIGH" | "NORMAL",
  "deadline": "string",
  "actionRequired": "string",
  "taskTitle": "string"
}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      });

      if (response && response.text) {
        return JSON.parse(response.text);
      }
    } catch (err) {
      console.warn('⚠️ [Antigravity AI] Gemini API call fallback:', err.message);
    }
  }

  // High quality deterministic fallback when AI key is not yet configured
  const category = detectCategory(rawText);
  const deadline = extractBasicDeadline(rawText);
  const isHighPriority = /\basd\b/i.test(rawText) || /\bashish\b/i.test(rawText) || /\burgent\b/i.test(rawText) || category === 'Exams & Duties';

  const firstLine = (rawText || '').trim().split('\n')[0].trim();
  const summary = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;

  let action = 'Review notice and take necessary action for your classes.';
  let taskTitle = `Review: ${summary}`;

  if (category === 'Exams & Duties') {
    action = 'Verify datesheet schedule and prepare assigned question papers / invigilation duties.';
    taskTitle = 'Prepare exam papers / check invigilation schedule';
  } else if (category === 'Lab & Teaching Load') {
    action = 'Verify allocated lab hours and software/hardware readiness.';
    taskTitle = 'Submit lab workload & readiness status report';
  } else if (category === 'Department Meetings') {
    action = 'Note meeting agenda, time and venue.';
    taskTitle = `Attend department meeting (${deadline})`;
  }

  return {
    summary: summary || `${category} Notice`,
    category,
    priority: isHighPriority ? 'HIGH' : 'NORMAL',
    deadline,
    actionRequired: action,
    taskTitle
  };
}

module.exports = {
  analyzeNoticeWithAI
};
