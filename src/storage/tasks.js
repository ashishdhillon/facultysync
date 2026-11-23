const fs = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, '../../data/tasks.json');

function ensureDataDir() {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTasks() {
  ensureDataDir();
  if (!fs.existsSync(TASKS_FILE)) {
    // Seed with realistic academic tasks for first launch
    const initialTasks = [
      {
        id: 'task_1',
        title: 'Submit BCA sessional marks report to HOD',
        category: 'Exams & Duties',
        priority: 'HIGH',
        deadline: 'before 4 PM',
        source: 'WhatsApp (Mentors BCA)',
        attachment: null,
        done: false,
        createdAt: new Date().toISOString()
      },
      {
        id: 'task_2',
        title: 'Verify BCA Lab software/hardware readiness and submit syllabus report',
        category: 'Lab & Teaching Load',
        priority: 'HIGH',
        deadline: '28th Nov',
        source: 'Outlook (Principal)',
        attachment: null,
        done: false,
        createdAt: new Date().toISOString()
      },
      {
        id: 'task_3',
        title: 'Review BCA sessional datesheet & cross-verify invigilation duty dates',
        category: 'Exams & Duties',
        priority: 'NORMAL',
        deadline: '25th Nov',
        source: 'WhatsApp (Mentors BCA)',
        attachment: 'Sessional_Datesheet.pdf',
        done: false,
        createdAt: new Date().toISOString()
      }
    ];
    fs.writeFileSync(TASKS_FILE, JSON.stringify(initialTasks, null, 2), 'utf8');
    return initialTasks;
  }

  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

function addTask(task) {
  const tasks = getTasks();
  const newTask = {
    id: `task_${Date.now()}`,
    title: task.title,
    category: task.category || 'General',
    priority: task.priority || 'NORMAL',
    deadline: task.deadline || 'Immediate',
    source: task.source || 'Manual',
    attachment: task.attachment || null,
    done: false,
    createdAt: new Date().toISOString()
  };
  tasks.unshift(newTask);
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  return newTask;
}

function toggleTask(id) {
  const tasks = getTasks();
  const task = tasks.find(t => t.id === id);
  if (task) {
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : null;
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  }
  return task;
}

function deleteTask(id) {
  let tasks = getTasks();
  tasks = tasks.filter(t => t.id !== id);
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
  return true;
}

module.exports = {
  getTasks,
  addTask,
  toggleTask,
  deleteTask
};
