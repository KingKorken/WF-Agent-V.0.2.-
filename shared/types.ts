/**
 * Shared type definitions for the Workflow Automation Agent.
 *
 * Defines the WebSocket command/response protocol used between the
 * cloud server and the Local Agent. Commands are organized by the
 * five execution layers described in the architecture:
 *
 *   Layer 1: Skill/API (cloud-side only, not sent over WebSocket)
 *   Layer 2: Shell/OS Commands
 *   Layer 3: CDP/Playwright (browser)
 *   Layer 4: Accessibility APIs (desktop apps)
 *   Layer 5: Vision-based (last resort)
 *   System:  General commands (keyboard, screenshot)
 */

// ---------------------------------------------------------------------------
// Layer identifiers
// ---------------------------------------------------------------------------

/** The five execution layers plus system commands */
export type CommandLayer = 'shell' | 'cdp' | 'accessibility' | 'vision' | 'system';

// ---------------------------------------------------------------------------
// Layer 2 — Shell / OS Commands
// ---------------------------------------------------------------------------

export interface ShellExecParams {
  /** The shell command to execute (e.g. "open -a 'Google Chrome'") */
  command: string;
  /** Optional timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/** Shell layer only supports "exec" for now */
export type ShellAction = 'exec';

// ---------------------------------------------------------------------------
// Layer 3 — CDP / Playwright (Browser)
// ---------------------------------------------------------------------------

export interface CdpNavigateParams {
  url: string;
}

export interface CdpSnapshotParams {
  /** Whether to include only interactive elements */
  interactive?: boolean;
}

export interface CdpClickParams {
  /** Element reference ID (e.g. "e12") */
  ref: string;
}

export interface CdpTypeParams {
  /** Element reference ID */
  ref: string;
  /** Text to type into the element */
  text: string;
}

export interface CdpSelectParams {
  /** Element reference ID */
  ref: string;
  /** Value to select */
  value: string;
}

export interface CdpNewTabParams {
  /** Optional URL to navigate the new tab to */
  url?: string;
}

export type CdpAction =
  | 'launch' | 'close'
  | 'navigate' | 'snapshot' | 'click' | 'type' | 'select'
  | 'screenshot' | 'page_info' | 'new_tab' | 'close_tab' | 'list_tabs';

export type CdpParams =
  | CdpNavigateParams | CdpSnapshotParams | CdpClickParams
  | CdpTypeParams | CdpSelectParams | CdpNewTabParams;

// ---------------------------------------------------------------------------
// Layer 3 — CDP Snapshot element (returned in snapshot results)
// ---------------------------------------------------------------------------

export interface CdpSnapshotElement {
  /** Reference ID (e.g. "e1", "e2") — used to target this element in actions */
  ref: string;
  /** Element type: "button", "input[text]", "link", "select", etc. */
  role: string;
  /** Human-readable label */
  label: string;
  /** Current value (for inputs/selects) */
  value: string;
  /** HTML tag name */
  tagName: string;
  /** Whether the element is enabled */
  enabled: boolean;
  /** Whether the element is visible on screen */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Layer 4 — Accessibility APIs (Desktop Apps)
// ---------------------------------------------------------------------------

export interface AccessibilityGetTreeParams {
  /** The application name (e.g. "TextEdit", "Microsoft Excel") */
  app: string;
  /** Maximum tree depth (default 3) */
  depth?: number;
}

export interface AccessibilitySnapshotParams {
  /** The application name */
  app: string;
}

export interface AccessibilityFindElementParams {
  /** The application name */
  app: string;
  /** Accessibility role to match (e.g. "button", "cell", "textField") */
  role?: string;
  /** Label/title to match (partial, case-insensitive) */
  label?: string;
  /** Value to match (partial, case-insensitive) */
  value?: string;
}

export interface AccessibilityRefParams {
  /** Element reference ID from a previous snapshot (e.g. "ax_5") */
  ref: string;
}

export interface AccessibilitySetValueParams {
  /** Element reference ID */
  ref: string;
  /** The value to set */
  value: string;
}

export interface AccessibilityMenuClickParams {
  /** The application name */
  app: string;
  /** Menu path (e.g. ["File", "Save As..."]) */
  menuPath: string[];
}

export interface AccessibilityWindowInfoParams {
  /** The application name */
  app: string;
}

export type AccessibilityAction =
  | 'get_tree' | 'snapshot' | 'find_element'
  | 'press_button' | 'set_value' | 'get_value'
  | 'focus' | 'menu_click' | 'window_info';

export type AccessibilityParams =
  | AccessibilityGetTreeParams
  | AccessibilitySnapshotParams
  | AccessibilityFindElementParams
  | AccessibilityRefParams
  | AccessibilitySetValueParams
  | AccessibilityMenuClickParams
  | AccessibilityWindowInfoParams;

// ---------------------------------------------------------------------------
// Layer 4 — Accessibility Snapshot types (returned in snapshot/tree results)
// ---------------------------------------------------------------------------

/** A node in the accessibility tree (returned by get_tree) */
export interface AXTreeNode {
  /** Reference ID (e.g. "ax_1") */
  id: string;
  /** Accessibility role (e.g. "AXButton", "AXWindow") */
  role: string;
  /** Human-readable label/title */
  label: string;
  /** Current value */
  value?: string;
  /** Child nodes */
  children: AXTreeNode[];
}

/** An interactive element in the accessibility snapshot (returned by snapshot/find) */
export interface AXSnapshotElement {
  /** Reference ID (e.g. "ax_1", "ax_2") — used to target this element in actions */
  ref: string;
  /** Accessibility role (e.g. "AXButton", "AXTextField") */
  role: string;
  /** Human-readable label/title */
  label: string;
  /** Current value (for text fields, checkboxes, etc.) */
  value?: string;
  /** Whether the element is enabled */
  enabled: boolean;
  /** Path to the element in the accessibility tree */
  elementPath: string[];
}

// ---------------------------------------------------------------------------
// Layer 5 — Vision-Based (Last Resort)
// ---------------------------------------------------------------------------

export interface VisionScreenshotParams {
  /** No params needed — captures the full screen */
}

export interface VisionClickCoordinatesParams {
  x: number;
  y: number;
}

export type VisionAction = 'screenshot' | 'click_coordinates';
export type VisionParams = VisionScreenshotParams | VisionClickCoordinatesParams;

// ---------------------------------------------------------------------------
// System Commands (cross-layer utilities)
// ---------------------------------------------------------------------------

export interface SystemKeyboardParams {
  /** Array of keys to press (e.g. ["cmd", "s"]) */
  keys: string[];
}

export interface SystemScreenshotParams {
  /** No params needed */
}

export type SystemAction = 'keyboard' | 'screenshot';
export type SystemParams = SystemKeyboardParams | SystemScreenshotParams;

// ---------------------------------------------------------------------------
// Unified Command & Response types
// ---------------------------------------------------------------------------

/** A command sent from the cloud to the Local Agent */
export interface AgentCommand {
  type: 'command';
  /** Unique command ID (e.g. "cmd_101") */
  id: string;
  /** Which execution layer should handle this command */
  layer: CommandLayer;
  /** The action to perform within the layer */
  action: string;
  /** Action-specific parameters */
  params: Record<string, unknown>;
}

/** Result sent from the Local Agent back to the cloud */
export interface AgentResult {
  type: 'result';
  /** Matches the command ID this is responding to */
  id: string;
  /** Whether the command succeeded or failed */
  status: 'success' | 'error';
  /** Result data — contents vary by command */
  data: Record<string, unknown>;
}

/** Registration message sent by the Local Agent when it first connects */
export interface AgentHello {
  type: 'hello';
  /** Name of the agent (e.g. "workflow-agent-local") */
  agentName: string;
  /** Agent version */
  version: string;
  /** Operating system (e.g. "darwin", "win32", "linux") */
  platform: string;
  /** Which layers are currently supported */
  supportedLayers: CommandLayer[];
}

/** Any message that can be sent over the WebSocket */
export type WebSocketMessage = AgentCommand | AgentResult | AgentHello;

// ---------------------------------------------------------------------------
// Shell executor result (used internally by the Local Agent)
// ---------------------------------------------------------------------------

export interface ShellExecResult {
  /** Standard output from the command */
  output: string;
  /** Standard error output (empty string if none) */
  error: string;
  /** Process exit code (0 = success) */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// App launcher result (used internally by the Local Agent)
// ---------------------------------------------------------------------------

export interface AppLauncherResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Human-readable message describing what happened */
  message: string;
  /** Error message if the operation failed */
  error?: string;
}
