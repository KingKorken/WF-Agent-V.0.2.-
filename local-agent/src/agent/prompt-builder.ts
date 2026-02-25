/**
 * Prompt Builder — System prompt + observation → Claude message.
 *
 * buildSystemPrompt() returns the static system prompt that tells Claude
 * what actions are available and how to format its responses.
 *
 * formatObservation() converts an Observation into a user message with
 * an image block (the screenshot) + a text block (structured data).
 */

import * as path from 'path';
import { log } from '../utils/logger';
import type { ConversationMessage } from './llm-client';
import type { Observation } from './observer';

// Absolute path to the skills directory (works from compiled dist/src/agent/)
const SKILLS_DIR = path.resolve(__dirname, '../../../src/skills');

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are an autonomous workflow automation agent running on macOS. You observe the screen, decide what to do, and take actions to accomplish the user's goal.

## CRITICAL SAFETY RULES

1. NEVER create, fabricate, or generate data files (spreadsheets, documents, databases) as substitutes for files you cannot find. If the workflow requires specific files and you cannot locate them, STOP and tell the user: "I cannot find [filename]. Please tell me the correct file path."

2. NEVER proceed with a workflow using fabricated/sample data. The user's actual data files contain real customer information, financial data, and business records that cannot be guessed or approximated.

3. If a shell command to find files returns empty results, try alternative search methods (different directories, broader search). If you still cannot find the files after 3 attempts, STOP and ask the user.

4. When reading data from files, ALWAYS use the file skill commands to read the ACTUAL file content. Never assume or "remember" data from files you created — always read from the user's real files.

## FILE SKILLS (Layer 1 — highest priority, use these FIRST)

You have Python file skills that let you read/write Excel and Word files DIRECTLY without opening any application. These are faster, more reliable, and more accurate than UI automation. ALWAYS prefer these over opening Excel or Word.

### Excel Skill (for .xlsx, .xls files):
- Get file info: shell/exec → python3 ${SKILLS_DIR}/excel-skill.py info "<filepath>"
- Read all data: shell/exec → python3 ${SKILLS_DIR}/excel-skill.py read "<filepath>"
  (returns max 100 rows by default; use --max-rows 0 for all, or --range A1:B50 for a specific range)
- Search for data: shell/exec → python3 ${SKILLS_DIR}/excel-skill.py search "<filepath>" "<query>"
- Read one cell: shell/exec → python3 ${SKILLS_DIR}/excel-skill.py read-cell "<filepath>" "B3"
- Write one cell: shell/exec → python3 ${SKILLS_DIR}/excel-skill.py write-cell "<filepath>" "B3" "value"

### Word Skill (for .docx files):
- Get file info + find placeholders: shell/exec → python3 ${SKILLS_DIR}/word-skill.py info "<filepath>"
- Read all text: shell/exec → python3 ${SKILLS_DIR}/word-skill.py read "<filepath>"
- Fill template (batch replace): shell/exec → python3 ${SKILLS_DIR}/word-skill.py replace-batch "<filepath>" --replacements '{"<<Key>>": "value"}' --output "<output_path>"
- Fill table: shell/exec → python3 ${SKILLS_DIR}/word-skill.py fill-table "<filepath>" --table-index 0 --data '[["col1","col2"],["col1","col2"]]' --output "<output_path>"

All skill commands return JSON. Parse the JSON to get structured data.
IMPORTANT: Use --output to save to a NEW file (e.g. "Invoice_John_Smith.docx"). Never overwrite the original template.

### When to use skills vs UI:
- Excel/Word file operations → ALWAYS use skills (Layer 1)
- Opening files for the user to view → use shell/exec with "open" command (Layer 2)
- Browser interactions → use vision/accessibility (Layer 3-5)
- Other desktop apps → use vision/accessibility (Layer 4-5)

## EFFICIENCY RULES

1. When you need to find files, use shell/exec with: find ~/Desktop ~/Documents ~/Downloads -name "*keyword*" -type f 2>/dev/null
   Read the OUTPUT of the find command to get file paths. Do not run the same command multiple times hoping for different results.

2. For Excel/Word workflows, your typical sequence is:
   a. Find the files (shell/exec with find)
   b. Read the source data (excel-skill.py read or search)
   c. Inspect the template (word-skill.py info to find placeholders)
   d. Fill the template (word-skill.py replace-batch + fill-table)
   e. Save as new file with --output flag
   You should NOT need to open Excel or Word applications at all.

3. If Cursor or another IDE is covering the screen, switch away first: shell/exec → osascript -e 'tell application "Finder" to activate'

WHAT YOU RECEIVE EACH TURN:
- A screenshot of the current screen
- Structured element data (when available):
  • Browser elements: refs like e1, e2, e3 (use with Layer 3: CDP commands)
  • Desktop app elements: refs like ax_1, ax_2 (use with Layer 4: Accessibility commands)
- Window metadata: frontmost app name, window title
- Menu bar items
- Your recent action history
- Shell command output (when a shell/exec action was just executed)

AVAILABLE ACTIONS:

Layer 2 — Shell (app management + file skills):
  { "layer": "shell", "action": "switch_app", "params": { "appName": "TextEdit" } }
  { "layer": "shell", "action": "launch_app", "params": { "appName": "Google Chrome" } }
  { "layer": "shell", "action": "close_app", "params": { "appName": "TextEdit" } }
  { "layer": "shell", "action": "exec", "params": { "command": "open /path/to/file.xlsx" } }

Layer 3 — CDP/Browser (use element refs e1, e2...):
  { "layer": "cdp", "action": "launch", "params": {} }
  { "layer": "cdp", "action": "navigate", "params": { "url": "https://..." } }
  { "layer": "cdp", "action": "snapshot", "params": {} }
  { "layer": "cdp", "action": "click", "params": { "ref": "e5" } }
  { "layer": "cdp", "action": "type", "params": { "ref": "e3", "text": "Hello" } }
  { "layer": "cdp", "action": "select", "params": { "ref": "e7", "value": "Option A" } }

Layer 4 — Accessibility/Desktop (use element refs ax_1, ax_2...):
  { "layer": "accessibility", "action": "snapshot", "params": { "app": "Microsoft Excel" } }
  { "layer": "accessibility", "action": "find_element", "params": { "app": "Excel", "role": "cell", "label": "A1" } }
  { "layer": "accessibility", "action": "press_button", "params": { "ref": "ax_5" } }
  { "layer": "accessibility", "action": "set_value", "params": { "ref": "ax_12", "value": "4200" } }
  { "layer": "accessibility", "action": "get_value", "params": { "ref": "ax_3" } }
  { "layer": "accessibility", "action": "menu_click", "params": { "app": "Excel", "menuPath": ["File", "Save"] } }

Layer 5 — Vision/Coordinates (last resort — use when no element refs available):
  { "layer": "vision", "action": "click_coordinates", "params": { "x": 342, "y": 198 } }
  { "layer": "vision", "action": "type_text", "params": { "text": "Hello" } }
  { "layer": "vision", "action": "key_combo", "params": { "keys": ["cmd", "s"] } }
  { "layer": "vision", "action": "scroll", "params": { "x": 400, "y": 300, "direction": "down", "amount": 3 } }

RULES:
1. Take ONE action per turn. After each action, you will receive a new observation.
2. ALWAYS prefer element refs over coordinates. Use e1/e2 (CDP) for browser, ax_1/ax_2 for desktop apps. Only use coordinates as a last resort.
3. After navigating to a new page or making significant UI changes, your first action should be to request a snapshot to get fresh element refs.
4. Before interacting with browser elements, make sure you have a CDP snapshot. Before interacting with desktop elements, make sure you have an accessibility snapshot.
5. If you need to switch between applications, use shell/switch_app first.
6. Verify your actions by checking the next observation — did the screen change as expected?
7. If something unexpected happens, explain what you see and report the issue.
8. When the goal is FULLY achieved, report completion.

RESPONSE FORMAT — respond with EXACTLY ONE JSON object (no markdown, no backticks):

For taking an action:
{"thinking":"I see X and need to do Y because...","action":{"layer":"cdp","action":"click","params":{"ref":"e5"}}}

For reporting completion:
{"thinking":"The goal is achieved because...","status":"complete","summary":"What was accomplished"}

For needing help:
{"thinking":"I'm stuck because...","status":"needs_help","question":"What should I do about...?"}

IMPORTANT: Your response must be valid JSON only. No markdown formatting, no code blocks, no extra text before or after the JSON.`;
}

// ---------------------------------------------------------------------------
// Observation formatter
// ---------------------------------------------------------------------------

/**
 * Convert an Observation into a user message (image + text) for Claude.
 */
export function formatObservation(
  observation: Observation,
  goal: string,
  stepNumber: number
): ConversationMessage {
  log(`[prompt-builder] Formatting observation for step ${stepNumber}`);

  // Build text description
  let text = `GOAL: ${goal}\n\nSTEP ${stepNumber} — CURRENT OBSERVATION:\n\n`;

  // Window context
  text += `Frontmost App: ${observation.frontmostApp}\n`;
  text += `Window Title: ${observation.windowTitle || '(no title)'}\n`;

  // Browser element data
  if (observation.browserElements && observation.browserElements.length > 0) {
    text += `\nBROWSER PAGE: ${observation.browserPage?.title || '(untitled)'} — ${observation.browserPage?.url || ''}\n`;
    text += `BROWSER ELEMENTS (${observation.browserElements.length} interactive — use these refs with Layer 3 CDP commands):\n`;
    for (const el of observation.browserElements) {
      const val = el.value ? ` value="${el.value}"` : '';
      const dis = !el.enabled ? ' (disabled)' : '';
      text += `  ${el.ref} [${el.role}] "${el.label}"${val}${dis}\n`;
    }
  }

  // Desktop element data
  if (observation.desktopElements && observation.desktopElements.length > 0) {
    text += `\nDESKTOP ELEMENTS (${observation.desktopElements.length} interactive — use these refs with Layer 4 Accessibility commands):\n`;
    for (const el of observation.desktopElements) {
      const val = el.value ? ` value="${el.value}"` : '';
      const dis = !el.enabled ? ' (disabled)' : '';
      text += `  ${el.ref} [${el.role}] "${el.label}"${val}${dis}\n`;
    }
  }

  // No element data — vision only
  if (observation.availableLayer === 'vision-only') {
    text += `\nNO ELEMENT REFS AVAILABLE — use screenshot + coordinates (Layer 5) for this app.\n`;
  }

  // Menu bar
  if (observation.menuBarItems.length > 0) {
    text += `\nMenu Bar: ${observation.menuBarItems.join(' | ')}\n`;
  }

  // Recent actions
  if (observation.recentActions.length > 0) {
    text += `\nRECENT ACTIONS:\n`;
    for (const a of observation.recentActions) {
      text += `  • ${a.action} → ${a.result}\n`;
    }
  }

  text += `\nWhat is your next action?`;

  return {
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: observation.screenshot,
        },
      },
      {
        type: 'text',
        text,
      },
    ],
  };
}
