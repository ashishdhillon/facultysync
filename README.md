# 🎓 FacultySync

> **Universal Multi-Channel Academic Triage & Task Desk for College Faculty**  
> *Seamlessly brings WhatsApp, Outlook, and Gmail into a single local, AI-powered action board with 1-click catch-up sync.*

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-v18%2B-brightgreen)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Linked%20Companion-25D366?logo=whatsapp&logoColor=white)](https://web.whatsapp.com/)
[![AI Powered](https://img.shields.io/badge/AI-Antigravity%20%2F%20Gemini-7C3AED)](https://deepmind.google/technologies/gemini/)

---

## 📌 The Problem It Solves

As university and college faculty, critical notices are constantly scattered across:
- **WhatsApp Groups:** Mentor groups, departmental faculty chats, exam cell coordination, and student committees.
- **Institutional Email (Outlook):** Official circulars, workload assignments, principal notifications, and faculty meeting schedules.
- **Personal / University Email (Gmail):** Board of Studies notifications, external university notices (e.g. MDU Rohtak, VTU, AKTU), and research deadlines.

Vital deadlines often get buried in casual greetings or message flooding. **FacultySync** runs a self-hosted, private background bridge on your laptop that filters out chatter, extracts deadlines using Antigravity AI, and sorts every actionable update into your checklist.

---

## ⚡ Features

- **📱 WhatsApp Web Companion:**
  Scan once from your phone (**Settings > Linked Devices**). Live chat discovery lets you click to select which groups to monitor directly from the web interface.
- **✉️ Multi-Channel Email Support:**
  Integrated connectors for both **Microsoft Outlook** (Office 365) and **Google Gmail**.
- **⚡ 1-Click Incremental Catch-Up Sync:**
  Open your laptop, click **"Scan Since Last Check"**, and FacultySync pulls every circular, email, and chat arrived since your last session.
- **🧠 Antigravity AI Copilot (Google Gemini):**
  Reads long circulars, syllabi, and datesheet PDFs to summarize key points, identify implicit deadlines, and generate suggested faculty tasks.
- **➕ 1-Click Task Conversion:**
  Every update card in your incoming stream has a **"➕ Convert to Task"** button that instantly logs it to your prioritized action board.
- **🎨 WhatsApp Green & White Theme with Night Mode:**
  Authentic WhatsApp Web styling with moderately thick, high-contrast borders for clear element separation, plus an instant Day ⇄ Night mode toggle.

---

## 🚀 Quick Start (For Any Faculty Member)

### 1. Clone & Install
```bash
git clone https://github.com/ashishdhillon/facultysync.git
cd facultysync
npm install
```

### 2. Configure Environment
Create a `.env` file (optional, for Gemini AI acceleration):
```bash
GEMINI_API_KEY="your-google-gemini-api-key"
```

### 3. Launch
```bash
npm start
```
*Or on macOS, double-click `scripts/start.command`.*

FacultySync will start its local server at `http://localhost:3300` and automatically open your default browser.

---

## 🖥️ How It Works

```
  WhatsApp Group Chats         Outlook Office 365         Google Gmail
          │                            │                       │
          └────────────────────────────┼───────────────────────┘
                                       ▼
                       [ FacultySync Ingestion Engine ]
                                       │
                      (Deterministic Noise Filtering)
                                       ▼
                     [ Antigravity AI Triage Engine ]
                        - Identifies deadlines
                        - Classifies categories
                        - Generates task recommendations
                                       │
                                       ▼
                       [ Faculty Action Dashboard ]
                     - 1-Click Task Promotion
                     - Priority Badges (🔴 HIGH / 🟡 NORMAL)
                     - Local Document Archive
```

---

## 🛠️ Configuration (`config.json`)

FacultySync works out-of-the-box. You can customize settings either through the GUI or by editing `config.json`:

```json
{
  "faculty": {
    "name": "Prof. Ashish Dhillon",
    "acronym": "ASD",
    "department": "Department of Computer Applications",
    "institution": "DPGITM"
  },
  "channels": {
    "whatsapp": {
      "enabled": true,
      "monitoredChats": ["Mentors BCA", "DPGITM Faculty", "Exam Cell"]
    },
    "outlook": {
      "enabled": true,
      "email": "faculty@dpgitm.ac.in"
    },
    "gmail": {
      "enabled": true,
      "email": "faculty.personal@gmail.com"
    }
  }
}
```

---

## 📄 License

MIT License &copy; 2026 Ashish Dhillon. Free for all academic faculty and educators.
