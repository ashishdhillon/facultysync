/**
 * Test Triage Engine & Local Notifications
 */
const { triageMessage } = require('./triage');
const { sendNotification } = require('./notifier');
const { recordNotice } = require('./checklist');
const os = require('os');
const path = require('path');
const fs = require('fs');
const config = JSON.parse(JSON.stringify(require('./config.json')));
// Tests write to a throw-away temp folder, never to the real Academic-DPG notices or the live log.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-bridge-test-'));
config.storage = {
  documentsDir: testDir,
  actionChecklistFile: path.join(testDir, 'ACTION_CHECKLIST.md'),
  logFile: path.join(testDir, 'notices_log.json')
};
config.notifications = Object.assign({}, config.notifications, { enabled: false });

console.log('🧪 Starting WhatsApp Local Bridge Triage Test...\n');

const testCases = [
  {
    name: '1. Casual greeting (Should be IGNORED)',
    message: {
      text: 'Good morning all 🙏 Have a great day!',
      hasMedia: false,
      chatName: 'Mentors BCA',
      sender: 'Colleague'
    },
    expectTrigger: false
  },
  {
    name: '2. Emoji reaction / simple thanks (Should be IGNORED)',
    message: {
      text: '👍👍 thank you sir',
      hasMedia: false,
      chatName: 'Mentors BCA',
      sender: 'Faculty'
    },
    expectTrigger: false
  },
  {
    name: '3. Urgent meeting with ASD mention (Should be TRIGGERED - HIGH)',
    message: {
      text: 'Urgent meeting convened today at 3:00 PM in Conference Room. ASD please bring the sessional marks report before 4 PM.',
      hasMedia: false,
      chatName: 'Mentors BCA',
      sender: 'HOD Computer Applications'
    },
    expectTrigger: true
  },
  {
    name: '4. Document attachment with exam datesheet (Should be TRIGGERED)',
    message: {
      text: 'Attached is the revised sessional exam datesheet. All faculty members ensure syllabus completion by 28th Nov.',
      hasMedia: true,
      mediaType: 'application/pdf',
      mediaFileName: 'Sessional_Exam_Dec_2026.pdf',
      chatName: 'Mentors BCA',
      sender: 'Exam Controller'
    },
    expectTrigger: true
  },
  {
    name: '5. Lab incharge and workload assignment (Should be TRIGGERED)',
    message: {
      text: 'Lab incharge duties and workload allocation list updated for BCA 5th Sem. Check your allotted hours.',
      hasMedia: false,
      chatName: 'Mentors BCA',
      sender: 'Lab Coordinator'
    },
    expectTrigger: true
  },
  {
    name: '6. Unrelated casual chat (Should be IGNORED)',
    message: {
      text: 'Is the college bus running today on route 4?',
      hasMedia: false,
      chatName: 'Mentors BCA',
      sender: 'Staff'
    },
    expectTrigger: false
  }
];

let passed = 0;
let failed = 0;

testCases.forEach((tc, idx) => {
  console.log(`--------------------------------------------------`);
  console.log(`Test Case ${idx + 1}: ${tc.name}`);
  const result = triageMessage(tc.message, config);

  if (result.triggered === tc.expectTrigger) {
    console.log(`✅ Result: ${result.triggered ? 'TRIGGERED' : 'IGNORED'} (Expected)`);
    passed++;
  } else {
    console.log(`❌ Result: ${result.triggered ? 'TRIGGERED' : 'IGNORED'} (Expected: ${tc.expectTrigger ? 'TRIGGERED' : 'IGNORED'})`);
    failed++;
  }

  if (result.triggered) {
    console.log(`   🏷️  Category: ${result.category}`);
    console.log(`   🚨 Priority: ${result.priority}`);
    console.log(`   ⏰ Deadline: ${result.deadline}`);
    console.log(`   ⚡ Action:   ${result.actionRequired}`);
    console.log(`   📌 Summary:  ${result.summary}`);
    if (result.foundKeywords.length > 0) {
      console.log(`   🔍 Keywords: ${result.foundKeywords.join(', ')}`);
    }

    // For test case 3, fire test notification and checklist entry
    if (idx === 2) {
      console.log(`\n   🔔 Triggering test macOS notification & checklist entry...`);
      if (process.env.WA_TEST_NOTIFY === '1') sendNotification({
        title: `🔔 Academic Notice [${result.priority}]`,
        subtitle: `Chat: ${result.chatName}`,
        message: `${result.summary} | Action: ${result.actionRequired}`,
        sound: config.notifications.sound
      });

      recordNotice({
        chatName: result.chatName,
        sender: tc.message.sender,
        category: result.category,
        priority: result.priority,
        summary: result.summary,
        actionRequired: result.actionRequired,
        deadline: result.deadline,
        savedFile: null,
        rawText: tc.message.text
      }, config);
    }
  } else {
    console.log(`   Reason: ${result.reason}`);
  }
});

console.log(`\n==================================================`);
console.log(`Test Summary: ${passed} Passed, ${failed} Failed`);
console.log(`==================================================\n`);
process.exit(failed ? 1 : 0);
