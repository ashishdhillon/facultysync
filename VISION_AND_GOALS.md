# FacultySync: Vision, Architecture & Technical Goals

> **Document Type:** System Architecture Specification & Project Roadmap  
> **Author & Project Owner:** Ashish Dhillon (ASD), Assistant Professor, Department of Computer Applications, DPGITM  
> **Repository:** [https://github.com/ashishdhillon/facultysync](https://github.com/ashishdhillon/facultysync)  
> **Primary Purpose:** Comprehensive blueprint for review, validation, and audit by external AI models (e.g. Claude, GPT-4, Gemini) and technical collaborators.

---

## 1. Executive Summary & Mission

### 1.1 The Academic Overload Problem
University and college faculty members operate in high-friction administrative and pedagogical environments. A single assistant professor or department head typically manages:
1. **Teaching & Curriculum:** Lecture delivery, syllabus completion, lesson plans, lab manuals, and course files.
2. **Examinations & Evaluation:** Sessional tests, external university exams, datesheet verification, question paper drafting, invigilation duty, and practical cutlists.
3. **Student Mentorship & Discipline:** Attendance tracking, student defaulter calling, parent communication, and mentor records.
4. **Institutional Compliance:** NAAC, NBA, NIRF documentation, workload allocation, and department meetings.

### 1.2 Channel Fragmentation & Failure Mode
Official notices and time-sensitive instructions arrive across disjointed channels:
- **WhatsApp Groups:** Mentors groups, faculty groups, exam cells. High urgency, but 90% casual chatter ("Good morning", festival wishes, emojis, conversational banter) that buries critical circulars.
- **Microsoft Outlook (Office 365):** Institutional announcements, principal directives, committee meeting invites.
- **Google Gmail:** University evaluation portals (e.g., MDU Rohtak), Board of Studies updates, external examiner appointments, research correspondence.

**The Failure Mode:** Important deadlines (e.g. submitting internal marks by 4 PM, checking datesheet clashes within 24 hours, preparing lab software) are missed simply because notices are buried in message noise.

### 1.3 The Solution: FacultySync
**FacultySync** is a privacy-first, local academic operations companion. It links to WhatsApp, Outlook, and Gmail, filters out casual chatter, uses Antigravity AI (Gemini) to extract deadlines and required actions, and presents faculty with an action-oriented checklist where any update can be promoted to a prioritized task with one click.

---

## 2. Core Architectural Philosophy

1. **Local-First & Data Sovereign:**
   All WhatsApp sessions, email tokens, student records, and downloaded documents remain strictly on the faculty member's computer. No centralized third-party servers store user messages or credentials. Fully compliant with data privacy requirements (DPDP Act 2023).
2. **Zero-Friction for Non-Technical Faculty:**
   Installation and operation must require zero coding knowledge. One command or double-clicking `start.command` launches the system, opens the browser, displays a QR code, and lets the user check off the chats they want to monitor.
3. **The Incremental "Catch-Up" Sync Paradigm:**
   Faculty members do not run 24/7 background cloud servers. When they open their laptop in the staffroom or lab, they click **"⚡ Scan Since Last Check"**. The engine inspects all messages and emails received since the last recorded timestamp cursor, triage-sorts them, and updates the task checklist.
4. **Action-Oriented Triage:**
   The UI does not display raw chat walls. Every piece of ingested information is transformed into three questions:
   - *What was announced?* (Clean summary)
   - *What action is required from me?* (Concrete faculty duty)
   - *When is the deadline?* (Normalized date/time)
5. **Utilitarian WhatsApp-Grade Design:**
   Familiar green-and-white WhatsApp styling with hairline 1px borders, compact card heights, reduced padding, and zero marketing fluff. Includes a native Day / Night mode toggle.

---

## 3. High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            MULTI-CHANNEL INGESTION                          │
├────────────────────────┬──────────────────────────┬─────────────────────────┤
│    WhatsApp Web        │   Microsoft Outlook      │      Google Gmail       │
│  (whatsapp-web.js)     │     (Office 365)         │     (IMAP / REST)       │
│  - Linked companion    │   - Circulars            │   - University exam     │
│  - Group chat filter   │   - Meeting invites      │     portal notices      │
└───────────┬────────────┴────────────┬─────────────┴────────────┬────────────┘
            │                         │                          │
            └─────────────────────────┼──────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     INCREMENTAL SYNC STATE CONTROLLER                       │
│  - Reads / Updates sync_state.json (lastSyncTimestamp cursor)               │
│  - "Scan Since Last Check" fetches only delta records                       │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DUAL-LAYER TRIAGE ENGINE                             │
├─────────────────────────────────────┴───────────────────────────────────────┤
│  Layer A: Deterministic Rule & Noise Filter                                 │
│  - Discards greetings ("Good morning", "GM", "Thanks", "OK", emojis)        │
│  - Catches priority keywords (ASD, exam, datesheet, lab, load, syllabus)    │
│  - Document detector (PDF, DOCX, XLSX, CSV)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  Layer B: Antigravity AI Engine (Google Gemini SDK)                         │
│  - Analyzes circular text & attachment metadata                             │
│  - Extracts implicit deadlines ("before 4 PM", "by 28th Nov")               │
│  - Categorizes: Exams, Labs, Meetings, Syllabus, Marks                      │
│  - Synthesizes ready-to-execute Action Items                                │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PRESENTATION & TASK CONTROL DESK                         │
├─────────────────────────────────────┬───────────────────────────────────────┤
│  Live Multi-Channel Stream          │  Action Checklist (Task Board)        │
│  - Visual source badges             │  - Interactive completion checkboxes  │
│  - Direct [➕ Convert to Task] btn   │  - Priority badges (HIGH / NORMAL)    │
│  - Attachment links to local folder │  - Deadlines & source tracking        │
└─────────────────────────────────────┴───────────────────────────────────────┘
```

---

## 4. Phase-by-Phase Roadmap

### Phase 1: Core Foundation (COMPLETED)
- [x] Node.js backend with Express & static file serving.
- [x] WhatsApp linked device bridge using `whatsapp-web.js` with `LocalAuth` session caching.
- [x] Deterministic triage rule engine (filtering casual greetings and catching academic keywords).
- [x] Document downloader saving PDFs/spreadsheets directly to local academic folders.
- [x] Native macOS desktop notification dispatch (`osascript`).
- [x] WhatsApp Green & White UI with 1px hairline borders, Day/Night mode toggle, and reduced margins.
- [x] 1-Click "Scan Since Last Check" catch-up sync trigger.
- [x] "Convert to Task" functionality promoting stream items into the action checklist.
- [x] Public GitHub repository created and deployed at `github.com/ashishdhillon/facultysync`.
- [x] Automated test suite verifying triage rules with 100% pass rate.

### Phase 2: Multi-Channel Expansion (IN PROGRESS)
- [ ] **Direct In-Browser QR Code:** Stream QR code directly onto the web interface so faculty never need to touch the terminal.
- [ ] **Dynamic WhatsApp Chat Selection:** Read all phone chats via API and allow multi-select checkbox configuration in the web GUI.
- [ ] **Microsoft Outlook Connector:** Implement OAuth2 / Graph API or IMAP integration for Office 365 institutional email.
- [ ] **Google Gmail Connector:** Implement OAuth2 read-only connector filtering academic sender domains (`.ac.in`, `.edu`).
- [ ] **Real-Time Stream Updates:** Server-Sent Events (SSE) or WebSockets to instantly push new incoming notices without manual page refreshes.

### Phase 3: AI & Workflow Integrations (PLANNED)
- [ ] **Deep Circular Analysis:** Direct text and OCR extraction from attached PDF circulars via Gemini Vision/Multimodal.
- [ ] **Calendar Synchronization:** One-click export of deadlines to Google Calendar or Apple iCal ICS.
- [ ] **Academic-DPG Course File Linking:** Automatically match syllabus or timetable updates to the corresponding subject folders in the faculty member's course repository.
- [ ] **Morning Briefing Digest:** Generate a 60-second audio or bulleted morning digest summarizing the day's commitments.
- [ ] **Cross-Platform Desktop Packaging:** Electron or Tauri bundle for single-click installation on macOS and Windows.

---

## 5. Review Prompts for External AI Evaluators

If you are an external AI system (Claude, GPT-4, etc.) auditing this project, please evaluate the following core questions:

1. **Architecture & Session Durability:**
   - How robust is `whatsapp-web.js` with `LocalAuth` across long periods of inactivity or network switching? What reconnection strategies and error boundaries are recommended?
2. **State Cursor & Incremental Catch-Up:**
   - Is storing a single `lastSyncTimestamp` sufficient for multi-channel catch-up, or should channel-specific cursors (e.g. WhatsApp message ID vs IMAP UID) be decoupled?
3. **Security & DPDP Compliance:**
   - Are local credential tokens and email tokens stored safely on multi-user operating systems? How can we best protect tokens at rest?
4. **UX / Accessibility for Academic Faculty:**
   - Is the current 1-click "Convert to Task" paradigm intuitive for non-technical educators? What interface improvements would reduce cognitive load further?

---

*Authored on November 23, 2026 by Ashish Dhillon (ASD).*
