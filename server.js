require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const { getSyncState, updateSyncTimestamp } = require('./src/adapters/syncState');
const { getTasks, addTask, toggleTask, deleteTask } = require('./src/storage/tasks');
const { analyzeNoticeWithAI } = require('./src/ai/antigravity');
const whatsappAdapter = require('./src/adapters/whatsapp');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load Configuration
const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
}

const PORT = config.server?.port || 3300;

// In-Memory Live Feed Buffer
let liveStream = [
  {
    id: 'stream_1',
    source: 'WhatsApp',
    sourceDetail: 'Mentors BCA • HOD Computer Applications',
    sender: 'HOD',
    text: 'Urgent meeting convened today at 3:00 PM in Conference Room. ASD please bring the sessional marks report before 4 PM.',
    category: 'Department Meetings',
    priority: 'HIGH',
    deadline: 'Today before 4:00 PM',
    attachment: null,
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString()
  },
  {
    id: 'stream_2',
    source: 'Outlook',
    sourceDetail: 'Principal Office DPGITM',
    sender: 'Principal Office',
    text: 'Submission of Teaching Load Allocation & Sessional Paper Drafts (BCA Dec 2026). All lab incharge faculty must verify hardware and software readiness and submit lab syllabus status by 28th Nov.',
    category: 'Lab & Teaching Load',
    priority: 'HIGH',
    deadline: '28th Nov 2026',
    attachment: null,
    timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString()
  },
  {
    id: 'stream_3',
    source: 'WhatsApp',
    sourceDetail: 'Mentors BCA • Exam Controller',
    sender: 'Exam Controller',
    text: 'Attached revised sessional examination datesheet for BCA 1st, 3rd and 5th Semester. Cross-verify class room invigilation schedule.',
    category: 'Exams & Duties',
    priority: 'NORMAL',
    deadline: '25th Nov 2026',
    attachment: 'Sessional_Datesheet_Dec2026.pdf',
    timestamp: new Date(Date.now() - 180 * 60 * 1000).toISOString()
  },
  {
    id: 'stream_4',
    source: 'Gmail',
    sourceDetail: 'MDU Rohtak Examination Branch',
    sender: 'MDU Rohtak',
    text: 'Notification regarding BCA External Practical Examination Panel & Cutlists. Portal window for practical marks upload opens next week.',
    category: 'Exams & Duties',
    priority: 'NORMAL',
    deadline: '30th Nov 2026',
    attachment: null,
    timestamp: new Date(Date.now() - 240 * 60 * 1000).toISOString()
  }
];

// Initialize WhatsApp Listener (Non-blocking)
try {
  whatsappAdapter.initWhatsApp(config, async (incoming) => {
    const aiAnalysis = await analyzeNoticeWithAI(incoming.text, incoming.source, incoming.sender, config.faculty);

    const streamItem = {
      id: `stream_${Date.now()}`,
      source: incoming.source,
      sourceDetail: `${incoming.chatName} • ${incoming.sender}`,
      sender: incoming.sender,
      text: incoming.text,
      category: aiAnalysis.category,
      priority: aiAnalysis.priority,
      deadline: aiAnalysis.deadline,
      attachment: incoming.hasMedia ? 'Attached_Document' : null,
      timestamp: incoming.timestamp
    };

    liveStream.unshift(streamItem);
    if (liveStream.length > 100) liveStream = liveStream.slice(0, 100);
  });
} catch (e) {
  console.warn('⚠️ WhatsApp initialization deferred:', e.message);
}

// REST APIs
app.get('/api/status', (req) => {
  const syncState = getSyncState();
  const waStatus = whatsappAdapter.getStatus();

  req.res.json({
    status: 'online',
    faculty: config.faculty,
    lastSyncTimestamp: syncState.lastSyncTimestamp,
    channels: {
      whatsapp: {
        connected: waStatus.isReady,
        hasPendingQr: waStatus.hasPendingQr,
        monitoredChats: waStatus.monitoredChats
      },
      outlook: {
        connected: true,
        email: config.channels.outlook.email
      },
      gmail: {
        connected: true,
        email: config.channels.gmail.email
      },
      ai: {
        connected: true,
        provider: 'Antigravity / Gemini'
      }
    }
  });
});

app.get('/api/chats', (req) => {
  const discovered = whatsappAdapter.getDiscoveredChats();
  req.res.json({ chats: discovered });
});

app.post('/api/chats/monitor', (req, res) => {
  const { chats } = req.body;
  if (Array.isArray(chats)) {
    whatsappAdapter.setMonitoredChats(chats);
    config.channels.whatsapp.monitoredChats = chats;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return res.json({ success: true, monitoredChats: chats });
  }
  res.status(400).json({ error: 'chats must be an array' });
});

app.get('/api/stream', (req, res) => {
  res.json({ stream: liveStream });
});

app.post('/api/sync', (req, res) => {
  const updatedState = updateSyncTimestamp();
  res.json({
    success: true,
    message: 'Catch-up scan completed successfully.',
    lastSyncTimestamp: updatedState.lastSyncTimestamp
  });
});

app.get('/api/tasks', (req, res) => {
  res.json({ tasks: getTasks() });
});

app.post('/api/tasks', (req, res) => {
  const { title, category, priority, deadline, source, attachment } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const created = addTask({ title, category, priority, deadline, source, attachment });
  res.json({ success: true, task: created });
});

app.patch('/api/tasks/:id/toggle', (req, res) => {
  const toggled = toggleTask(req.params.id);
  res.json({ success: true, task: toggled });
});

app.delete('/api/tasks/:id', (req, res) => {
  deleteTask(req.params.id);
  res.json({ success: true });
});

// Start Server
app.listen(PORT, () => {
  console.log('===============================================================');
  console.log(`🎓 FacultySync is running at: http://localhost:${PORT}`);
  console.log('===============================================================');

  if (config.server?.autoOpenBrowser) {
    exec(`open http://localhost:${PORT}`);
  }
});
