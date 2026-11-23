# 🎓 Academic-DPG WhatsApp Local Bridge (Method 1: Linked Device)

A lightweight, real-time local background companion for **Ashish Dhillon (ASD)** that links as a WhatsApp Web device, monitors specific academic & department chats, filters out casual chatter, downloads incoming notices/documents directly into `Academic-DPG`, and raises instant macOS desktop notifications with action checklists.

---

## ⚡ Quick Start

### 0. Configuration Setup
Run `cp config.example.json config.json` and then edit it.

### 1. Launch the Bridge
In Terminal:
```bash
cd "/Users/ashishdhillon/ai-company/Dashboard/whatsapp-bridge"
npm start
```
*Or simply double-click `start.command` in Finder.*

### 2. One-Time WhatsApp QR Scan
1. Open WhatsApp on your phone.
2. Go to **Settings > Linked Devices** (or 3 dots on Android > Linked Devices).
3. Tap **Link a Device** and scan the ASCII QR code printed in the terminal.
4. Once scanned, your session is saved locally in `.wwebjs_auth`—you will **not** need to scan again on restarts.

---

## 🎯 How to Attach Your 3 Chats

The bridge configuration lives in `config.json`. **You do not need to restart the bridge when changing chats; it hot-reloads live!**

Open [config.json](file:///Users/ashishdhillon/ai-company/Dashboard/whatsapp-bridge/config.json):
```json
{
  "monitoredChats": [
    "Mentors BCA",
    "REPLACE_WITH_CHAT_NAME_2",
    "REPLACE_WITH_CHAT_NAME_3"
  ]
}
```
Replace the placeholder names with your exact chat names (e.g. `DPGITM BCA Faculty`, `Exam Cell 2026`).

> [!TIP]
> If you're not sure of the exact WhatsApp group title, run `npm run list-chats` or look at the terminal output upon connection—the bridge lists all group chat names found on your account.

---

## 🧠 Triage Engine & Filtering Rules

### 🚫 Ignored Casual Chatter
The bridge automatically suppresses casual noise:
- Morning / Evening greetings (`"Good morning"`, `"GM"`, `"Happy Birthday"`)
- Emoji-only messages (`👍`, `🙏`, `💐`, etc.)
- Acknowledgment phrases (`"Thank you"`, `"Noted sir"`, `"Done ma'am"`, `"OK"`)
- General non-academic questions

### 🚨 Alert Triggers
The bridge triggers whenever:
1. **Any document arrives** (PDF, Excel, Word doc, CSV, PPTX) in a monitored chat.
2. **Academic keywords appear**, including:
   `"lab"`, `"incharge"`, `"load"`, `"syllabus"`, `"exam"`, `"datesheet"`, `"sessional"`, `"meeting"`, `"attendance"`, `"defaulter"`, `"marks"`, `"result"`, `"notice"`, `"circular"`, `"urgent"`
3. **ASD / Ashish is mentioned**: Immediately triggers **🔴 HIGH Priority** alert with direct action instructions.

---

## 📂 Where Output Goes

1. **Saved Documents:**
   Downloaded automatically to:
   `/Users/ashishdhillon/Academic-DPG/Department Desk/Notices/`
   Saved with sanitized names and timestamp tags (e.g., `Datesheet_Dec_20261123143000.pdf`).

2. **Action Checklist:**
   Automatically logged to:
   [ACTION_CHECKLIST.md](file:///Users/ashishdhillon/Academic-DPG/Department%20Desk/Notices/ACTION_CHECKLIST.md)
   Contains a markdown checklist of what was announced, action required from you, deadlines, and direct file links.

3. **macOS Desktop Notification:**
   Native banner popup displaying:
   - Title: `🔔 Academic Notice [HIGH/NORMAL]`
   - Subtitle: `Chat Name (Sender)`
   - Message: `Summary | Action: What is required from ASD`
   - Sound: `Hero` (macOS chime)

---

## 🧪 Testing

To test the triage rules, keyword triggers, and desktop notifications without waiting for live WhatsApp messages:
```bash
npm run test-triage
```
This runs 6 test cases verifying casual filtering, keyword detection, document parsing, and triggers a sample notification.

---

## 🛠️ Management Commands

| Command | Action |
|---|---|
| `npm start` | Start live background bridge |
| `npm run test-triage` | Run mock message triage test |
| `npm run list-chats` | Fetch and print all WhatsApp chats on account |
| `npm run reset-session` | Delete session tokens to link a different phone |
