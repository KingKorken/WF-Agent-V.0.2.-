# Workflow Automation Agent — System Architecture

## 1. High-Level Overview

The system is a B2B AI-powered workflow automation platform that learns from human demonstrations (screen recordings + events + narration) and executes complex business processes autonomously. It uses a **hybrid execution model**: reasoning happens in the cloud via LLM APIs, while execution and data remain on the client's infrastructure.

### Core Principle
> **Prototype: Fully cloud-hosted. No on-premise dependencies.**
> **Production (future): Hybrid model — reasoning in the cloud, execution and data on-premise at the customer.**
>
> The prototype runs entirely in the cloud for speed of development and because there are no customers yet to deploy on-premise. The architecture is designed so that the Execution Engine and Local Data Store can be migrated to the client's environment later without rewriting the Reasoning Engine or Dashboard.

---

## 2. Architecture Diagram

### 2.1 Prototype (Cloud + Local Agent)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER'S MACHINE                                  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │   LOCAL AGENT (Electron App — always running)                    │   │
│  │                                                                   │   │
│  │   RECORD MODE:                    EXECUTE MODE:                   │   │
│  │   • Screen Capture                • Receive commands from cloud   │   │
│  │   • Event Logger                  • Launch/switch applications    │   │
│  │   • Audio/Narration               • Simulate mouse & keyboard    │   │
│  │   • Upload to cloud               • Take & send screenshots      │   │
│  │                                   • Report app/window state      │   │
│  │                                   • Execute OS-level actions      │   │
│  │                                                                   │   │
│  │   ◄──── WebSocket (persistent connection) ────►                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │   USER'S DESKTOP ENVIRONMENT                                     │   │
│  │                                                                   │   │
│  │   • Browser (Chrome, Firefox, etc.)                              │   │
│  │   • Desktop Apps (Excel, Word, PowerPoint, etc.)                 │   │
│  │   • Any installed software                                       │   │
│  │   • File system                                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  WebSocket (bidirectional)
                                    │  • Commands down (click, type, open app)
                                    │  • Screenshots & state up
                                    │  • Recording uploads
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLOUD (Your Infrastructure)                     │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    DASHBOARD (Web App — hosted in cloud)          │   │
│  │                                                                   │   │
│  │   • New Recording    • Workflow Library    • Agent Chat           │   │
│  │   • Audit Log        • Settings            • Skill Management    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    REASONING ENGINE                               │   │
│  │                                                                   │   │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │   │
│  │  │  LLM Gateway    │  │  Workflow Parser  │  │  Skill         │  │   │
│  │  │                 │  │                   │  │  Registry       │  │   │
│  │  │  • Claude API   │  │  • Recording      │  │                │  │   │
│  │  │  • GPT-4 API    │  │    Analysis       │  │  • Pre-built   │  │   │
│  │  │  • Model        │  │  • Step           │  │    Skills      │  │   │
│  │  │    Selection    │  │    Extraction     │  │  • Skill SDK   │  │   │
│  │  │  • Fallback     │  │  • Workflow        │  │    (Phase 2)   │  │   │
│  │  │    Logic        │  │    Generation     │  │  • Marketplace │  │   │
│  │  └─────────────────┘  └──────────────────┘  │    (Phase 3)   │  │   │
│  │                                              └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    COMMAND ROUTER (Layer Selection)               │   │
│  │                                                                   │   │
│  │  Selects optimal control layer for each step, with fallback:     │   │
│  │                                                                   │   │
│  │  Priority 1: Skill/API    → Skill Runner (cloud, no UI)         │   │
│  │  Priority 2: Shell/OS     → Local Agent: exec shell command      │   │
│  │  Priority 3: CDP/Playwright → Local Agent: browser element ref   │   │
│  │  Priority 4: Accessibility → Local Agent: accessibility tree     │   │
│  │  Priority 5: Vision       → Local Agent: screenshot + coords    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    SKILL RUNNER (Layer 1 — Cloud-side)            │   │
│  │                                                                   │   │
│  │  Executes API-based skills directly from cloud (highest priority) │   │
│  │  Falls back to Local Agent layers 2-5 when no skill exists       │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    STATE & RECOVERY                               │   │
│  │                                                                   │   │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │   │
│  │  │  Checkpoint     │  │  Recovery         │  │  Progress      │  │   │
│  │  │  Manager        │  │  Manager          │  │  Tracker       │  │   │
│  │  └─────────────────┘  └──────────────────┘  └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    DATA LAYER                                     │   │
│  │                                                                   │   │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │   │
│  │  │  Database        │  │  File Storage    │  │  Audit Log     │  │   │
│  │  │  (PostgreSQL)    │  │  (S3 / Blob)     │  │  (Append-only) │  │   │
│  │  │                 │  │                   │  │                │  │   │
│  │  │  • Workflows    │  │  • Recordings     │  │  • Actions     │  │   │
│  │  │  • Checkpoints  │  │  • Frames         │  │  • Errors      │  │   │
│  │  │  • Tenant data  │  │  • Audio files    │  │  • Approvals   │  │   │
│  │  │  • Credentials  │  │                   │  │  • Timestamps  │  │   │
│  │  │    (encrypted)  │  │                   │  │                │  │   │
│  │  └─────────────────┘  └──────────────────┘  └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    PLATFORM SERVICES                              │   │
│  │                                                                   │   │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │   │
│  │  │  Auth & Tenant  │  │  Workflow         │  │  Analytics &   │  │   │
│  │  │  Management     │  │  Pattern DB       │  │  Monitoring    │  │   │
│  │  └─────────────────┘  └──────────────────┘  └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Production (Future — Hybrid On-Premise)

```
In production, the cloud backend's State & Recovery, Data Layer, and
Skill Runner move to the customer's on-premise environment for data
sovereignty. The Reasoning Engine and Platform Services stay in the cloud.

The Local Agent remains on the user's machine in both versions — it's
the consistent execution layer that doesn't change between prototype
and production.

The Command Router becomes the key interface: in the prototype it routes
to the Local Agent over the internet; in production it routes over the
customer's local network, keeping all data on-premise.
```

---

## 3. Component Breakdown

### 3.1 Dashboard (Frontend — Web App)

**Location:** Cloud-hosted web app, accessed via browser
**Tech Stack:** TBD (React/Next.js recommended)

| Feature | Description |
|---|---|
| **New Recording** | Start a hybrid recording session. User fills in context fields (description, business rules), enables data inputs (screen, events, narration), and hits record. |
| **Workflow Library** | View, edit, and manage learned workflows. Each workflow shows its steps, required skills, and execution history. |
| **Agent Chat** | Natural language interface for triggering workflows ("Do my payroll for this month") and handling errors/interruptions. |
| **Audit Log ("Logbook")** | Complete chronological log of every action the agent has taken. Filterable by workflow, date, status. Accessible by users and auditors. |
| **Settings** | Skill management, LLM provider config, notification preferences, auth/credential management. |

---

### 3.2 Local Agent (Electron App)

**Location:** User's machine — must be installed and running
**Purpose:** The bridge between the cloud brain and the user's desktop. Operates in two modes.
**Tech:** Electron (cross-platform), with native OS automation libraries

#### Record Mode
Captures human demonstrations to teach the agent new workflows.

**Three simultaneous capture streams:**

| Stream | What It Captures | Format |
|---|---|---|
| **Screen Recording** | Continuous video of the screen | Video file (MP4/WebM) |
| **Event Logger** | Mouse clicks (with coordinates), keystrokes, window/tab switches, scroll events, copy/paste, focus changes — each with precise timestamps | Structured event log (JSON) |
| **Audio Narration** | User's spoken explanation of what they're doing and why | Audio file → Transcription (text) |

**Processing Pipeline:**
1. User completes recording
2. Event log timestamps are used to extract key frames from the video
3. Audio is transcribed and aligned with events/frames
4. Result: A time-ordered sequence of `(frame, event, narration)` tuples
5. This sequence is uploaded to the cloud for workflow parsing

#### Execute Mode
Receives commands from the cloud and performs actions on the user's desktop.
Uses a **priority-based, multi-layered control system** — pixel clicking is eliminated in favor of deterministic, reliable methods.

**Control Layer Hierarchy (highest priority first):**

| Priority | Layer | How It Works | Speed | Accuracy | When Used |
|---|---|---|---|---|---|
| **1 (Best)** | **Skill/API Calls** | Direct API integration, no UI involved at all | Instant | 100% | When a pre-built skill exists for the target application |
| **2** | **Shell/OS Commands** | Execute system commands (`open -a "Excel"`, `mv`, `osascript`) | Instant | 100% | App launching, file operations, system control, window management |
| **3** | **CDP/Playwright** | Communicate directly with browser engine via Chrome DevTools Protocol. Interact with elements by reference ID (`click e12`), not coordinates | Milliseconds | 99%+ | All browser-based web application interaction |
| **4** | **Accessibility APIs** | Read and interact with desktop app UI elements via OS accessibility tree. Find "Save Button" by its accessibility label, not pixel position | Fast | 95%+ | Desktop apps (Excel, Word, etc.) that expose accessibility tree |
| **5 (Last Resort)** | **Vision-Based Automation** | Screenshot → LLM identifies element → coordinates. Only when no other method works | Slow | ~85% | Legacy apps with no CLI, no API, no accessibility support |

**Layer 1: Skill/API Calls (Cloud-side)**
```
Example: Read employee hours from TimeTracker
→ Skill calls TimeTracker REST API directly
→ Returns structured JSON: { employee: "Maria", hours: 168 }
→ No UI interaction needed at all
```

**Layer 2: Shell/OS Commands**
```
Example: Open Excel with a specific file
→ macOS:  osascript -e 'tell application "Microsoft Excel" to open "/path/file.xlsx"'
→ Windows: Start-Process "excel.exe" "/path/file.xlsx"
→ Instant, deterministic, never fails

Example: Minimize current window
→ macOS:  osascript -e 'tell application "System Events" to keystroke "m" using command down'
→ Windows: powershell -c "(Get-Process -Name 'excel').MainWindowHandle | ForEach-Object { ... }"

Example: Switch between applications
→ macOS:  osascript -e 'tell application "Google Chrome" to activate'
→ Windows: AppActivate("Google Chrome")
```

**Layer 3: CDP/Playwright (Browser Web Apps)**
```
Example: Enter salary into a web-based payroll system
→ Agent connects to browser via CDP (Chrome DevTools Protocol)
→ Gets structured element snapshot:
    input "Gross Salary" [ref=e7]
    button "Save" [ref=e12]
    dropdown "Employee" [ref=e3]
→ Commands: select e3 "Maria González" → type e7 "4200" → click e12
→ Elements identified by reference ID, not pixel coordinates
→ Works even if the page layout changes
```

**Layer 4: Accessibility APIs (Desktop Apps)**
```
Example: Enter a value into Excel cell B3
→ macOS: Use Accessibility API to find Excel's active worksheet
→ Navigate to cell B3 via accessibility tree or keyboard shortcuts (Ctrl+G → "B3")
→ Type value using keyboard input
→ Elements identified by role/label, not pixel position

Example: Click "Save As" in Word
→ Query accessibility tree for menu items
→ Find element with role "menuItem" and label "Save As"
→ Trigger action on that element
→ Works regardless of where the button is positioned on screen
```

**Layer 5: Vision-Based (Absolute Last Resort)**
```
Example: Interact with a legacy desktop app with no accessibility support
→ Take screenshot → Send to LLM
→ LLM identifies: "The submit button is at approximately (342, 198)"
→ Click at coordinates
→ ONLY used when all other layers are unavailable
→ Includes verification step: take another screenshot to confirm action worked
```

**The Reasoning Engine decides which layer to use for each step.** During workflow parsing, it identifies each application and maps it to the best available control method. During execution, if a higher-priority layer fails, it falls back to the next layer automatically.

**Desktop Automation Libraries (by OS):**

| OS | Shell Commands | Accessibility API | Fallback Input |
|---|---|---|---|
| **macOS** | AppleScript, `osascript`, `open` command | AXUIElement API (NSAccessibility) | CGEvent (CoreGraphics) for raw input |
| **Windows** | PowerShell, `cmd`, `Start-Process` | UI Automation API (UIA) | SendInput API for raw input |
| **Linux** | bash, `xdg-open`, `wmctrl` | AT-SPI (Assistive Technology) | xdotool for raw input |

**Browser Control Stack:**

| Component | Purpose |
|---|---|
| **Playwright** | High-level browser automation (navigate, click, type, screenshot) |
| **Chrome DevTools Protocol (CDP)** | Low-level browser communication, element inspection |
| **Element Snapshots** | Structured map of interactive elements with reference IDs — replaces pixel coordinates |
| **Isolated Browser Profile** | Separate from user's personal browser, safe for automation |

**Communication:** Maintains a persistent WebSocket connection to the cloud. Commands come down, screenshots and state go up. Connection auto-reconnects on network issues.

---

### 3.3 Reasoning Engine (Cloud — stays cloud in both prototype and production)

**Location:** Cloud-hosted
**Purpose:** All LLM-based intelligence — understanding recordings, planning workflows, making decisions during execution.

**Critical data boundary:** The Reasoning Engine receives only:
- Abstracted screen descriptions (not raw sensitive data where possible)
- Workflow structure and step logic
- Error descriptions and decision requests
- It does NOT receive raw credentials, full financial records, or PII in bulk

#### 3.3.1 LLM Gateway
- Routes reasoning requests to the configured LLM provider (Claude, GPT-4, etc.)
- Handles model selection, rate limiting, fallback logic
- Manages prompt construction and response parsing

#### 3.3.2 Workflow Parser
- Receives processed recording data (frames + events + narration)
- Uses the LLM to understand the workflow: what apps are used, what data flows where, what decisions are made
- **Maps each application to its optimal control layer** (Skill → Shell → CDP → Accessibility → Vision)
- Identifies which steps use browser apps (→ Layer 3: CDP) vs desktop apps (→ Layer 4: Accessibility) vs system actions (→ Layer 2: Shell)
- Outputs a structured **Workflow Definition** — a reusable, executable plan with control layers pre-assigned

#### 3.3.3 Skill Registry
- Maintains catalog of available skills (pre-built and SDK-built)
- When the Workflow Parser identifies an application, it checks if a skill exists
- Recommends skills to the user for better execution reliability

---

### 3.4 Execution Engine (Cloud + Local Agent)

**Purpose:** Orchestrates workflow execution. The cloud decides WHAT to do and selects the best control layer, the Local Agent executes it.

The Execution Engine is split across two locations:

**Cloud side — Command Router & Skill Runner:**
- Receives execution plan from Reasoning Engine
- For each step, selects the optimal control layer (Skill → Shell → CDP → Accessibility → Vision)
- Translates high-level decisions into concrete commands for the appropriate layer
- Manages the observe-decide-act loop

**Local Agent side — Multi-Layer Executor:**
- Receives commands via WebSocket specifying WHICH control layer to use
- Executes using the specified method (shell command, CDP action, accessibility action, etc.)
- Returns structured results, element snapshots, or screenshots to the cloud

**Five control layers (used per-step based on priority):**

| Priority | Layer | Where It Runs | How It Works | When Used |
|---|---|---|---|---|
| **1** | **Skill/API** | Cloud (Skill Runner) | Direct API calls, no UI | When a skill exists for the app |
| **2** | **Shell/OS Commands** | Local Agent | System commands (`open`, `osascript`, `powershell`) | App launching, file ops, window management |
| **3** | **CDP/Playwright** | Local Agent | Browser engine communication via element references | All browser-based web apps |
| **4** | **Accessibility API** | Local Agent | OS accessibility tree — find elements by role/label | Desktop apps (Excel, Word, etc.) |
| **5** | **Vision-Based** | Cloud (reasoning) + Local Agent (action) | Screenshot → LLM analysis → coordinate action | Last resort for legacy apps only |

**Execution Loop:**
```
For each step in workflow:
  1. Reasoning Engine determines the action needed
  2. Command Router selects best control layer:
     Has skill?           → Layer 1: Skill Runner calls API
     System/file action?  → Layer 2: Shell command to Local Agent
     Browser web app?     → Layer 3: CDP/Playwright command to Local Agent
     Desktop app?         → Layer 4: Accessibility command to Local Agent
     No other option?     → Layer 5: Screenshot → LLM → coordinate click
  3. Execute via selected layer
  4. Receive result (structured data, element snapshot, or screenshot)
  5. Send result to Reasoning Engine for next decision
  6. Save checkpoint to State Manager
  7. If layer fails → automatically fall back to next layer
  8. Proceed to next step
```

**Command Protocol (WebSocket messages):**

```json
// Layer 2: Shell/OS Commands
{ "type": "command", "id": "cmd_101", "layer": "shell",
  "action": "exec", "params": { "command": "open -a 'Microsoft Excel' '/path/file.xlsx'" } }
{ "type": "command", "id": "cmd_102", "layer": "shell",
  "action": "exec", "params": { "command": "osascript -e 'tell app \"Chrome\" to activate'" } }

// Layer 3: CDP/Playwright (Browser)
{ "type": "command", "id": "cmd_201", "layer": "cdp",
  "action": "navigate", "params": { "url": "https://timetracker.company.com" } }
{ "type": "command", "id": "cmd_202", "layer": "cdp",
  "action": "snapshot", "params": { "interactive": true } }
{ "type": "command", "id": "cmd_203", "layer": "cdp",
  "action": "click", "params": { "ref": "e12" } }
{ "type": "command", "id": "cmd_204", "layer": "cdp",
  "action": "type", "params": { "ref": "e7", "text": "4200" } }
{ "type": "command", "id": "cmd_205", "layer": "cdp",
  "action": "select", "params": { "ref": "e3", "value": "Maria González" } }

// Layer 4: Accessibility API (Desktop Apps)
{ "type": "command", "id": "cmd_301", "layer": "accessibility",
  "action": "find_element", "params": { "role": "cell", "label": "B3", "app": "Excel" } }
{ "type": "command", "id": "cmd_302", "layer": "accessibility",
  "action": "set_value", "params": { "elementId": "ax_42", "value": "4200" } }
{ "type": "command", "id": "cmd_303", "layer": "accessibility",
  "action": "press_button", "params": { "role": "menuItem", "label": "Save" } }
{ "type": "command", "id": "cmd_304", "layer": "accessibility",
  "action": "get_tree", "params": { "app": "Excel", "depth": 3 } }

// Layer 5: Vision-Based (Last Resort)
{ "type": "command", "id": "cmd_401", "layer": "vision",
  "action": "screenshot", "params": {} }
{ "type": "command", "id": "cmd_402", "layer": "vision",
  "action": "click_coordinates", "params": { "x": 342, "y": 198 } }

// General commands (any layer)
{ "type": "command", "id": "cmd_501", "layer": "system",
  "action": "keyboard", "params": { "keys": ["cmd", "s"] } }
{ "type": "command", "id": "cmd_502", "layer": "system",
  "action": "screenshot", "params": {} }

// Local Agent → Cloud (responses)
{ "type": "result", "id": "cmd_101", "status": "success",
  "data": { "output": "Application launched", "window": "Microsoft Excel" } }
{ "type": "result", "id": "cmd_202", "status": "success",
  "data": { "elements": [
    { "ref": "e3", "role": "dropdown", "label": "Employee" },
    { "ref": "e7", "role": "input", "label": "Gross Salary", "value": "" },
    { "ref": "e12", "role": "button", "label": "Save" }
  ] } }
{ "type": "result", "id": "cmd_304", "status": "success",
  "data": { "tree": [
    { "id": "ax_40", "role": "sheet", "label": "Sheet1", "children": [
      { "id": "ax_41", "role": "cell", "label": "A3", "value": "Maria González" },
      { "id": "ax_42", "role": "cell", "label": "B3", "value": "3800" }
    ] }
  ] } }
{ "type": "result", "id": "cmd_402", "status": "error",
  "data": { "error": "Element not found at coordinates", "fallback": "none" } }
```

---

### 3.5 State Manager & Failure Recovery

**Location:** Cloud (prototype) → Client machine on-premise (production)
**Purpose:** Tracks execution progress, enables recovery from failures.

#### Checkpoint System
- After every completed step, saves:
  - Current position in workflow (e.g., "Employee 29 of 50, Step 4 of 12")
  - What has been completed successfully
  - Current application states
  - Any data read/written so far
- Checkpoints stored locally in the Local Data Store

#### Failure Recovery Flow
```
INTERRUPTION DETECTED (crash, network loss, app error)
  │
  ▼
Agent detects last successful checkpoint
  │
  ▼
Conditions restored? (network back, app reopened)
  │
  ▼
System message to user:
"Completed payroll 1-29 successfully.
 Lost connection during payroll 29, but state is fully recovered.
 Would you like to continue with payroll 30?"
  │
  ▼
User confirms → Agent resumes from checkpoint
User declines → Agent stays paused, state preserved
```

#### Error Handling Flow
```
UNEXPECTED ERROR DETECTED (data anomaly, unknown UI state, missing input)
  │
  ▼
Agent stops immediately — does NOT guess
  │
  ▼
Error message to user with full context:
"Employee Maria González — monthly wage is €4,200,
 but last month it was €3,800. I'm unsure if this is correct."
  │
  ▼
Two resolution paths:
  Option A: Agent proposes solution → "Could be a raise. Proceed with €4,200?"
  Option B: User provides instruction → "She went full-time, use €4,200"
  │
  ▼
Resolution logged in audit trail
Agent continues from this point
```

---

### 3.6 Audit Log System ("Logbook")

**Location:** Cloud database (prototype) → Stored locally on client machine (production), viewable in Dashboard
**Purpose:** Complete, immutable record of every agent action for compliance and trust.

#### What Gets Logged

| Category | Examples |
|---|---|
| **Actions** | "Read cell B3 from Excel: value €4,200", "Entered €4,200 into Payroll field Gross Salary" |
| **Decisions** | "Used skill API for TimeTracker instead of UI automation" |
| **Interruptions** | "Connection lost at 14:32. Resumed at 14:35 after user confirmation." |
| **Errors & Resolutions** | "Wage discrepancy flagged for Maria González. User confirmed: employment status change." |
| **Human Approvals** | "User approved payroll batch: 47 employees, total €182,340" |
| **Timestamps** | Every entry has a precise timestamp |
| **Data References** | Which data was read from where, which data was written where |

#### Log Properties
- **Immutable:** Entries cannot be edited or deleted (append-only)
- **Exportable:** Can be exported as PDF/CSV for auditors
- **Filterable:** By date, workflow, employee, status, error type
- **Searchable:** Full-text search across all log entries

---

### 3.7 Data Layer

**Location:** Cloud (prototype) → Client machine on-premise (production)
**Purpose:** All operational data. In prototype, stored in cloud infrastructure. In production, migrates to customer's environment.

| Data Type | Description | Prototype Storage |
|---|---|---|
| **Recordings & Frames** | Raw screen recordings, extracted frames, event logs, transcribed narration | Cloud blob storage (S3) |
| **Workflow Definitions** | The structured, executable workflows parsed from recordings | PostgreSQL |
| **Execution State** | Current checkpoints, progress tracking, pending items | PostgreSQL |
| **Audit Logs** | Complete action history (append-only) | PostgreSQL |
| **Credentials** | Auth tokens and credentials for target applications (encrypted at rest) | PostgreSQL (encrypted) |
| **Skill Configurations** | API keys and settings for installed skills | PostgreSQL (encrypted) |

**Database:** PostgreSQL for prototype (cloud-hosted, production-ready, easy to migrate later).

---

### 3.8 Skill System

**Phased Rollout:**

| Phase | What | Description |
|---|---|---|
| **Phase 1 (Prototype)** | Pre-built Skills | Built by you for common HR/Accounting tools: Excel, Google Sheets, popular time trackers, payroll systems |
| **Phase 2 (Post-prototype)** | Skill SDK | Developer toolkit for third parties to build integrations |
| **Phase 3 (Growth)** | Marketplace | Discoverable, rated, installable skill catalog |

**Skill Structure (each skill provides):**
- **Metadata:** Name, description, supported application, version
- **Capabilities:** What actions it can perform (read data, write data, trigger actions)
- **Authentication:** How to connect (API key, OAuth, etc.)
- **Interface:** Standardized input/output format so the Execution Engine can call any skill uniformly

**Automatic Skill Suggestion:**
When the Workflow Parser detects an application in a recording, it checks the Skill Registry. If a skill exists, it notifies the user: "A TimeTracker skill is available. Installing it will make this step faster and more reliable. Enable?"

---

### 3.9 Platform Services (Cloud)

**Purpose:** Operational infrastructure for running the B2B platform.

| Service | Description |
|---|---|
| **Auth & Tenant Management** | User authentication, company accounts, licensing, role-based access. Strict tenant isolation — Company A's data never touches Company B. |
| **Workflow Pattern DB** | Anonymized workflow patterns collected (with consent) for improving the agent over future versions. Contains NO customer PII or financial data. |
| **Analytics & Monitoring** | Usage metrics, error rates, performance tracking. Used by you to improve the product. |

---

## 4. Data Flow Diagrams

### 4.1 Recording a New Workflow

```
User clicks "New Recording" in Dashboard
  │
  ▼
User fills context fields:
  • Description: "Monthly payroll processing"
  • Business rules: "Overtime after 40hrs at 1.5x"
  • Enables: Screen + Events + Narration
  │
  ▼
User clicks "Start Recording"
  │
  ▼
Hybrid Recorder activates all three streams
  │
  ▼
User performs the workflow naturally, narrating as they go
  │
  ▼
User clicks "Stop Recording"
  │
  ▼
Processing Pipeline (Local):
  1. Event log extracted with timestamps
  2. Key frames extracted from video at event timestamps
  3. Audio transcribed and aligned
  4. Sequence of (frame, event, narration) tuples created
  │
  ▼
Sent to Reasoning Engine (Cloud):
  • Frames (with sensitive data masked where possible)
  • Event sequence
  • Narration text
  • User-provided context
  │
  ▼
Workflow Parser (Cloud) uses LLM to:
  1. Understand the workflow logic
  2. Identify applications used
  3. Extract decision points and business rules
  4. Check Skill Registry for available skills
  5. Generate structured Workflow Definition
  │
  ▼
Workflow Definition returned to client
  │
  ▼
Stored in Local Data Store
Visible in Dashboard → Workflow Library
```

### 4.2 Executing a Workflow

```
User: "Do my payroll for this month"
  │
  ▼
Agent Chat sends request to Reasoning Engine
  │
  ▼
Reasoning Engine:
  1. Identifies the payroll workflow
  2. Creates execution plan
  3. Maps each step to optimal control layer
  4. Returns plan to Command Router
  │
  ▼
Command Router + Execution Engine begins:
  │
  ▼
┌─── FOR EACH EMPLOYEE ──────────────────────────────────────────┐
│                                                                  │
│  Step 1: Get employee data from Excel                           │
│    → Layer 1: Skill available? YES → Skill API reads Excel      │
│    → Save checkpoint                                            │
│                                                                  │
│  Step 2: Get hours from TimeTracker (web app)                   │
│    → Layer 1: Skill available? NO                               │
│    → Layer 2: N/A (not a shell task)                            │
│    → Layer 3: CDP/Playwright — connect to browser               │
│      → snapshot: finds dropdown [ref=e3], hours field [ref=e8]  │
│      → select e3 "Maria González"                               │
│      → read value from e8: "168 hours"                          │
│    → Save checkpoint                                            │
│                                                                  │
│  Step 3: Calculate pay                                          │
│    → Send to Reasoning Engine for calculation                    │
│    → Reasoning Engine returns result: €4,200                     │
│    → Save checkpoint                                            │
│                                                                  │
│  Step 4: Enter data in Payroll System (desktop app)             │
│    → Layer 1: Skill available? NO                               │
│    → Layer 2: Shell — launch payroll app if not open            │
│    → Layer 4: Accessibility API — find salary input field       │
│      → get_tree: finds field [role=textbox, label="Gross Pay"]  │
│      → set_value: enters "4200"                                 │
│      → press_button: [role=button, label="Save"]                │
│    → Save checkpoint                                            │
│                                                                  │
│  ✓ Log all actions to Audit Log (with control layer used)       │
│  ✓ If error → Stop, notify user, wait for input                 │
│  ✓ If layer fails → Auto-fallback to next layer                 │
│  ✓ If interruption → Save state, notify on recovery             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
  │
  ▼
All employees processed
  │
  ▼
Agent presents summary for human approval:
"Payroll complete for 47 employees.
 Total disbursement: €182,340.
 1 exception flagged: Maria González (wage change).
 Review and approve?"
  │
  ▼
User approves → Agent finalizes
User requests changes → Agent adjusts
```

---

## 5. Repository Structure (Proposed)

```
/workflow-agent
│
├── /dashboard                       # Frontend web application (cloud-hosted)
│   ├── /src
│   │   ├── /components              # UI components
│   │   ├── /pages                   # Dashboard pages
│   │   │   ├── recordings.tsx       # New recording page
│   │   │   ├── workflows.tsx        # Workflow library
│   │   │   ├── chat.tsx             # Agent chat interface
│   │   │   ├── audit-log.tsx        # Logbook / audit trail
│   │   │   └── settings.tsx         # Configuration
│   │   └── /services                # API clients
│   └── package.json
│
├── /local-agent                     # Electron app (runs on user's machine)
│   ├── /src
│   │   ├── main.ts                  # Electron main process
│   │   ├── /recorder                # Record mode
│   │   │   ├── screen-capture.ts    # Screen recording module
│   │   │   ├── event-logger.ts      # Mouse/keyboard/window event capture
│   │   │   ├── audio-capture.ts     # Narration recording
│   │   │   ├── frame-extractor.ts   # Extract frames at event timestamps
│   │   │   └── upload.ts            # Upload recordings to cloud
│   │   ├── /executor                # Execute mode (multi-layer)
│   │   │   ├── layer-router.ts      # Route commands to correct layer
│   │   │   ├── /shell               # Layer 2: Shell/OS commands
│   │   │   │   ├── shell-executor.ts    # Execute system commands
│   │   │   │   ├── app-launcher.ts      # Launch/switch/close applications
│   │   │   │   └── file-manager.ts      # File system operations
│   │   │   ├── /cdp                 # Layer 3: CDP/Playwright (browser)
│   │   │   │   ├── browser-manager.ts   # Manage isolated browser profile
│   │   │   │   ├── cdp-client.ts        # Chrome DevTools Protocol connection
│   │   │   │   ├── element-snapshot.ts  # Get interactive element refs
│   │   │   │   └── browser-actions.ts   # Click, type, select by element ref
│   │   │   ├── /accessibility       # Layer 4: Accessibility APIs
│   │   │   │   ├── ax-tree.ts           # Read accessibility tree from apps
│   │   │   │   ├── ax-actions.ts        # Interact with elements by role/label
│   │   │   │   ├── macos-ax.ts          # macOS AXUIElement implementation
│   │   │   │   └── windows-uia.ts       # Windows UI Automation implementation
│   │   │   ├── /vision              # Layer 5: Vision-based (last resort)
│   │   │   │   ├── screenshot.ts        # On-demand screen capture & send
│   │   │   │   └── coordinate-click.ts  # Click at LLM-determined coordinates
│   │   │   └── window-manager.ts    # Window management (minimize, maximize, resize)
│   │   ├── /connection              # Cloud communication
│   │   │   ├── websocket-client.ts  # Persistent WebSocket to cloud
│   │   │   ├── command-handler.ts   # Parse & route incoming commands
│   │   │   └── reconnect.ts        # Auto-reconnect on network issues
│   │   └── /ui                      # Local agent tray/window UI
│   │       ├── tray.ts              # System tray icon & menu
│   │       └── status-window.ts     # Connection status, current task display
│   └── package.json
│
├── /server                          # Cloud backend (API + all services)
│   ├── /api                         # REST/WebSocket API layer
│   │   ├── routes.ts                # API route definitions
│   │   ├── websocket.ts             # WebSocket server for Local Agent
│   │   └── middleware.ts            # Auth, tenant isolation, rate limiting
│   │
│   ├── /reasoning-engine            # LLM-based intelligence
│   │   ├── llm-gateway.ts           # LLM provider routing
│   │   ├── workflow-parser.ts       # Recording → Workflow Definition
│   │   ├── planner.ts               # Execution planning & decisions
│   │   └── error-resolver.ts        # Error analysis & suggestions
│   │
│   ├── /command-router              # Translates decisions to commands
│   │   ├── router.ts                # Route to Local Agent or Skill Runner
│   │   ├── command-builder.ts       # Build command payloads
│   │   └── response-handler.ts      # Process Local Agent responses
│   │
│   ├── /skill-runner                # Cloud-side skill execution
│   │   ├── runner.ts                # Execute API-based skills
│   │   └── result-parser.ts         # Normalize skill results
│   │
│   ├── /state-manager               # Failure recovery & checkpoints
│   │   ├── checkpoint.ts            # Save/load execution state
│   │   ├── recovery.ts              # Failure detection & recovery
│   │   └── progress-tracker.ts      # Track workflow progress
│   │
│   ├── /audit-log                   # Logbook system
│   │   ├── logger.ts                # Append-only log writer
│   │   ├── exporter.ts              # Export to PDF/CSV
│   │   └── query.ts                 # Search & filter logs
│   │
│   ├── /skills                      # Skill system
│   │   ├── /registry                # Skill catalog & discovery
│   │   ├── /pre-built               # Phase 1: Built-in skills
│   │   │   ├── excel-skill/
│   │   │   ├── google-sheets-skill/
│   │   │   ├── timetracker-skill/
│   │   │   └── payroll-skill/
│   │   └── /sdk                     # Phase 2: Developer SDK
│   │
│   └── /platform                    # B2B platform services
│       ├── auth.ts                  # Authentication & tenant management
│       ├── workflow-pattern-db.ts   # Anonymized pattern storage
│       └── analytics.ts            # Usage monitoring
│
├── /database                        # Database management
│   ├── migrations/                  # Schema migrations
│   ├── seeds/                       # Test data
│   └── schema.ts                    # Database schema definitions
│
├── /shared                          # Shared types, utilities, constants
│   ├── types.ts                     # TypeScript type definitions
│   ├── command-protocol.ts          # Command/response types for WebSocket
│   ├── constants.ts                 # Shared constants
│   └── utils.ts                     # Common utilities
│
├── /docs                            # Documentation
│   ├── architecture.md              # This document
│   ├── api-reference.md
│   ├── command-protocol.md          # Local Agent command reference
│   └── skill-development-guide.md
│
└── README.md
```

---

## 6. Tech Stack (Recommended for Prototype)

| Layer | Technology | Rationale |
|---|---|---|
| **Dashboard Frontend** | React + TypeScript (Next.js or Vite) | Industry standard, large ecosystem, fast development |
| **Backend / API** | Node.js / TypeScript | Same language as frontend and Local Agent, good for async/WebSocket |
| **Local Agent** | Electron + TypeScript | Cross-platform desktop app, full OS access, same TypeScript stack |
| **Layer 2: Shell/OS** | Node.js `child_process`, AppleScript (macOS), PowerShell (Windows) | Instant, deterministic app launching and system control |
| **Layer 3: CDP/Playwright** | Playwright + Chrome DevTools Protocol | Element-reference-based browser control, no pixel guessing |
| **Layer 4: Accessibility** | macOS AXUIElement API, Windows UI Automation API, Linux AT-SPI | Find and control desktop app elements by role/label, not coordinates |
| **Layer 5: Vision (fallback)** | Screenshot + LLM analysis | Only for legacy apps with no other interface |
| **Screen Recording** | Electron desktopCapturer API | Built into Electron, captures screen and audio |
| **Audio Transcription** | Whisper API (cloud) | Simpler for prototype, high accuracy |
| **WebSocket** | `ws` (Node.js) or Socket.io | Real-time bidirectional communication between cloud and Local Agent |
| **Database** | PostgreSQL (cloud-hosted) | Production-ready, easy to migrate to on-premise later |
| **File Storage** | S3 or equivalent blob storage | For recordings, frames, audio files |
| **Cloud Reasoning** | Claude API (primary), GPT-4 (fallback) | Best reasoning capabilities for complex workflows |
| **Cloud Hosting** | TBD (AWS/GCP/Azure) | Standard cloud hosting |
| **Skill APIs** | REST / GraphQL | Standard integration patterns |

---

## 7. Key Design Decisions Summary

| Decision | Choice | Reason |
|---|---|---|
| **Execution model** | Cloud reasoning + Local Agent for desktop control | Need to control actual desktop apps (Excel, Word, etc.) for prototype demos. Cloud handles intelligence, Local Agent handles actions. |
| **Computer control** | 5-layer priority system: Skill → Shell → CDP → Accessibility → Vision | Matches industry standard (OpenClaw approach). Pixel-based clicking eliminated except as absolute last resort. Deterministic, fast, and accurate. |
| **Browser control** | CDP/Playwright with element reference IDs | Click by element ref (`e12`), not coordinates. Survives UI layout changes. Millisecond response times. |
| **Desktop app control** | Accessibility APIs (macOS AXUIElement, Windows UIA) | Find elements by role/label ("Save button"), not pixel position. Reliable across screen sizes and resolutions. |
| **App launching** | Shell/OS commands | `open -a "Excel"` is instant and 100% accurate. Never click icons on screen. |
| **Local Agent** | Electron app with dual modes (record + execute) | Cross-platform, full OS access, same TypeScript stack, single install for the user |
| **Recording approach** | Hybrid (screen + events + narration) | Events provide precision, screen provides context, narration provides meaning |
| **Cloud ↔ Local communication** | WebSocket (persistent, bidirectional) with layer-aware command protocol | Real-time command/response needed for execution loop; commands specify which control layer to use |
| **Failure recovery** | Checkpoint per step, manual resume trigger | Transparency and user trust |
| **Error handling** | Stop + explain + two resolution paths | Financial data requires zero guessing |
| **Layer fallback** | Automatic fallback to next layer on failure | If CDP fails, try Accessibility. If Accessibility fails, try Vision. Maximizes reliability. |
| **Audit logging** | Append-only, every action logged (including control layer used) | Compliance requirement for HR/Accounting |
| **Workflow pattern DB** | Opt-in, anonymized, with consent | Enables product improvement without compromising privacy |
| **Multi-tenant isolation** | Strict tenant separation | B2B requirement — no cross-company data leakage |
