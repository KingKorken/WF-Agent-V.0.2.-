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
  /** Window index (0-based) within the application */
  windowIndex: number;
  /** Flat index in window.entireContents() — used by actions */
  flatIndex: number;
}

// ---------------------------------------------------------------------------
// Layer 5 — Vision-Based (Hybrid — Last Resort)
// ---------------------------------------------------------------------------

/** All vision layer actions */
export type VisionAction =
  | 'screenshot'
  | 'collect_context'
  | 'click_coordinates'
  | 'double_click'
  | 'right_click'
  | 'type_text'
  | 'key_combo'
  | 'drag'
  | 'scroll'
  | 'capture_region';

/** Screenshot result returned by capture functions */
export interface ScreenshotResult {
  base64: string;
  width: number;
  height: number;
  imagePath?: string;
  captureType: 'fullscreen' | 'window' | 'region';
  timestamp: string;
}

/** Partial accessibility element (best-effort data from Layer 4) */
export interface PartialAXElement {
  role: string;
  label: string;
  value?: string;
  position?: [number, number];  // [x, y] if available
  size?: [number, number];      // [width, height] if available
}

/** Full hybrid vision context — the signature data structure of Layer 5 */
export interface VisionContext {
  screenshot: {
    base64: string;
    width: number;
    height: number;
    captureType: 'fullscreen' | 'window' | 'region';
  };
  windowInfo: {
    frontmostApp: string;
    windowTitle: string;
    windowBounds: { x: number; y: number; width: number; height: number };
    screenSize: { width: number; height: number };
  };
  partialAccessibility: {
    available: boolean;
    menuBarItems: string[];
    visibleLabels: string[];
    focusedElement: { role: string; label: string; value: string } | null;
    elementCount: number;
    rawElements: PartialAXElement[];
  };
  recentActions: Array<{
    action: string;
    result: string;
    timestamp: string;
  }>;
  taskContext: {
    currentStep: string;
    expectedOutcome: string;
    workflowName: string;
  } | null;
}

/** Vision action result */
export interface VisionActionResult {
  success: boolean;
  action: string;
  timestamp: string;
  error?: string;
  verificationScreenshot?: {
    base64: string;
    width: number;
    height: number;
  };
}

/** Params for vision screenshot */
export interface VisionScreenshotParams {
  app?: string;
}

/** Params for collect_context */
export interface VisionCollectContextParams {
  app?: string;
  taskContext?: {
    currentStep: string;
    expectedOutcome: string;
    workflowName: string;
  };
  /** Skip screenshot and AX scan — return only window metadata, menu bar, recent actions.
   *  Used by the observer to avoid redundant work (it takes its own screenshot + AX snapshot). */
  metadataOnly?: boolean;
}

/** Params for click/double_click/right_click */
export interface VisionClickParams {
  x: number;
  y: number;
  verify?: boolean;
}

/** Params for type_text */
export interface VisionTypeParams {
  text: string;
}

/** Params for key_combo */
export interface VisionKeyComboParams {
  keys: string[];
}

/** Params for drag */
export interface VisionDragParams {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/** Params for scroll */
export interface VisionScrollParams {
  x: number;
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
  amount: number;
}

/** Params for capture_region */
export interface VisionCaptureRegionParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Union of all vision params */
export type VisionParams =
  | VisionScreenshotParams
  | VisionCollectContextParams
  | VisionClickParams
  | VisionTypeParams
  | VisionKeyComboParams
  | VisionDragParams
  | VisionScrollParams
  | VisionCaptureRegionParams;

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
  /** Room token for multi-tenancy. Optional in local dev, required when deployed. */
  roomId?: string;
}

// ---------------------------------------------------------------------------
// Dashboard ↔ Server protocol
// ---------------------------------------------------------------------------

/** Sent by the dashboard when it connects to the bridge server */
export interface DashboardHello {
  type: 'dashboard_hello';
  /** Unique identifier for this dashboard session */
  dashboardId: string;
  /** Dashboard version */
  version: string;
  /** Room token for multi-tenancy. Optional in local dev, required when deployed. */
  roomId?: string;
}

/** Chat message from dashboard to server */
export interface DashboardChatMessage {
  type: 'dashboard_chat';
  /** Unique message ID */
  id: string;
  /** Conversation this message belongs to */
  conversationId: string;
  /** User's message content */
  content: string;
  /** True if this is a direct command (e.g. /shell, /browser, /ax, /vision) */
  isDirect?: boolean;
}

/** Request to run a workflow */
export interface DashboardWorkflowRun {
  type: 'dashboard_workflow_run';
  workflowId: string;
  workflowName: string;
}

/** Request to cancel a running workflow */
export interface DashboardWorkflowCancel {
  type: 'dashboard_workflow_cancel';
  workflowId: string;
}

/** Chat response from server to dashboard */
export interface ServerChatResponse {
  type: 'server_chat_response';
  conversationId: string;
  message: {
    id: string;
    role: 'agent' | 'system';
    type: 'text' | 'progress-card' | 'error';
    content: string;
  };
}

/** Phase of the agent loop — what stage the agent is currently in */
export type AgentPhase =
  | 'step'           // New step starting
  | 'observing'      // Capturing screen, elements, etc.
  | 'thinking'       // Sending to Claude API
  | 'parsed'         // Claude returned a response
  | 'executing'      // About to execute an action
  | 'action_result'  // Action completed (success or failure)
  | 'complete'       // Goal achieved
  | 'needs_help'     // Agent has a question
  | 'error';         // Something went wrong

/** Agent thinking/action progress from server to dashboard */
export interface ServerAgentProgress {
  type: 'server_agent_progress';
  conversationId: string;
  phase: AgentPhase;
  step: number;
  maxSteps: number;
  /** Human-readable description of what's happening */
  message: string;
  /** Additional detail (action name, error context, etc.) */
  detail?: string;
  /** Which layer is involved */
  layer?: CommandLayer;
  /** Timestamp of this event */
  timestamp: string;
}

/** Agent connection status from server to dashboard */
export interface ServerAgentStatus {
  type: 'server_agent_status';
  agentConnected: boolean;
  agentName?: string;
  supportedLayers?: CommandLayer[];
}

/** Workflow execution progress from server to dashboard */
export interface ServerWorkflowProgress {
  type: 'server_workflow_progress';
  workflowId: string;
  step: number;
  totalSteps: number;
  currentStepName: string;
  status: 'running' | 'complete' | 'error';
  summary?: string;
}

// ---------------------------------------------------------------------------
// Dashboard → Server → Local Agent: Recording & Workflow CRUD
// ---------------------------------------------------------------------------

/** Start a recording session on the local agent */
export interface DashboardStartRecording {
  type: 'dashboard_start_recording';
  description: string;
}

/** Stop the current recording session on the local agent */
export interface DashboardStopRecording {
  type: 'dashboard_stop_recording';
}

/** Request list of all workflows from the local agent */
export interface DashboardListWorkflows {
  type: 'dashboard_list_workflows';
}

/** Request full details for a specific workflow */
export interface DashboardGetWorkflow {
  type: 'dashboard_get_workflow';
  workflowId: string;
}

/** Delete a workflow from the local agent */
export interface DashboardDeleteWorkflow {
  type: 'dashboard_delete_workflow';
  workflowId: string;
}

// ---------------------------------------------------------------------------
// Local Agent → Server → Dashboard: Recording & Workflow responses
// ---------------------------------------------------------------------------

/** Recording session started successfully */
export interface AgentRecordingStarted {
  type: 'agent_recording_started';
  sessionId: string;
}

/** Recording session stopped */
export interface AgentRecordingStopped {
  type: 'agent_recording_stopped';
  sessionId: string;
}

/** Recording is being parsed into a workflow (show spinner) */
export interface AgentRecordingParsing {
  type: 'agent_recording_parsing';
}

/** Workflow summary — subset of WorkflowDefinition for list views */
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  applicationCount: number;
  stepCount: number;
}

/** Workflow parsed successfully from a recording */
export interface AgentWorkflowParsed {
  type: 'agent_workflow_parsed';
  workflow: WorkflowSummary;
}

/** List of all workflows on the local agent */
export interface AgentWorkflowList {
  type: 'agent_workflow_list';
  workflows: WorkflowSummary[];
}

/** Full workflow definition (response to get_workflow) */
export interface AgentWorkflowDetail {
  type: 'agent_workflow_detail';
  workflow: WorkflowDefinition;
}

/** Workflow deleted from local agent */
export interface AgentWorkflowDeleted {
  type: 'agent_workflow_deleted';
  workflowId: string;
}

/** Recording or workflow operation error */
export interface AgentRecordingError {
  type: 'agent_recording_error';
  error: string;
}

// ---------------------------------------------------------------------------
// Server ↔ Agent: Workflow fetch protocol (structured workflow execution)
// ---------------------------------------------------------------------------

/** Server requests a workflow definition from the agent */
export interface ServerRequestWorkflow {
  type: 'server_request_workflow';
  /** Correlation ID — agent echoes this back in the response */
  requestId: string;
  /** Which workflow to fetch */
  workflowId: string;
}

/** Agent responds with workflow data (discriminated union for found/not-found) */
export type AgentWorkflowData =
  | {
      type: 'agent_workflow_data';
      requestId: string;
      workflowId: string;
      found: true;
      workflow: WorkflowDefinition;
    }
  | {
      type: 'agent_workflow_data';
      requestId: string;
      workflowId: string;
      found: false;
      error?: string;
    };

// ---------------------------------------------------------------------------
// Skill types (used by local registry and shared skill base)
// ---------------------------------------------------------------------------

/** A single command that a skill exposes */
export interface SkillCommand {
  name: string;
  args: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Shared Skill Base — Network Learning (Phase 1)
// ---------------------------------------------------------------------------

/** A skill stored in the central shared skill base */
export interface SharedSkillEntry {
  /** Unique ID for this shared skill (uuid) */
  id: string;
  /** Application name this skill targets (e.g. "Google Chrome", "Asana") */
  app: string;
  /** Aliases for the application name */
  aliases: string[];
  /** Filename of the skill script */
  file: string;
  /** Runtime used to execute the skill ("node", "python", etc.) */
  runtime: string;
  /** Which skills directory the file lives in */
  skillsDir: 'source' | 'dist';
  /** Available commands exposed by this skill */
  commands: SkillCommand[];
  /** Human-readable notes about the skill */
  notes: string;
  /** The compiled JavaScript source code */
  compiledCode: string;
  /** The TypeScript source code (for debugging/re-generation) */
  sourceCode: string;
  /** ISO timestamp when this skill was uploaded */
  uploadedAt: string;
  /** Agent identifier that uploaded the skill */
  uploadedBy: string;
}

/** Agent uploads a newly generated skill to the shared skill base */
export interface AgentSkillUpload {
  type: 'agent_skill_upload';
  skill: SharedSkillEntry;
}

/** Agent requests the full list of shared skills (sent on startup) */
export interface AgentSkillListRequest {
  type: 'agent_skill_list_request';
}

/** Server responds with all shared skills */
export interface ServerSkillListResult {
  type: 'server_skill_list_result';
  skills: SharedSkillEntry[];
}

/** Server broadcasts a newly uploaded skill to all connected agents */
export interface ServerSkillBroadcast {
  type: 'server_skill_broadcast';
  skill: SharedSkillEntry;
}

// ---------------------------------------------------------------------------
// Smart Chat Routing — Action preview & confirmation protocol
// ---------------------------------------------------------------------------

/** Action preview sent from bridge to dashboard for user confirmation */
export interface ServerActionPreview {
  type: 'server_action_preview';
  /** Unique ID for this preview — echoed back in confirm/cancel */
  previewId: string;
  /** The conversation this preview belongs to */
  conversationId: string;
  /** Human-readable plan shown to the user */
  plan: string;
  /** The original user message that triggered this preview */
  originalMessage: string;
}

/** User confirms the previewed action */
export interface DashboardActionConfirm {
  type: 'dashboard_action_confirm';
  /** Echoes the previewId from ServerActionPreview */
  previewId: string;
  /** The conversation this belongs to */
  conversationId: string;
}

/** User cancels the previewed action */
export interface DashboardActionCancel {
  type: 'dashboard_action_cancel';
  /** Echoes the previewId from ServerActionPreview */
  previewId: string;
  /** The conversation this belongs to */
  conversationId: string;
}

// ---------------------------------------------------------------------------
// Task cancellation — stop a running agent task
// ---------------------------------------------------------------------------

/** Request to cancel a running task (from dashboard) */
export interface DashboardCancelTask {
  type: 'dashboard_cancel_task';
  conversationId: string;
}

/** Acknowledgement that the task was cancelled (from server) */
export interface ServerCancelAck {
  type: 'server_cancel_ack';
  conversationId: string;
  completedSubGoals: string[];
}

// ---------------------------------------------------------------------------
// Debug logging — pipeline visibility for dashboard + fly logs
// ---------------------------------------------------------------------------

/** Sub-goal progress from server to dashboard */
export interface ServerSubGoalProgress {
  type: 'server_subgoal_progress';
  conversationId: string;
  subGoal: { id: string; label: string };
  index: number;
  total: number;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
}

/** Debug log entry pushed from bridge server to dashboard */
export interface ServerDebugLog {
  type: 'server_debug_log';
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  detail?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Conversation Persistence Protocol
// ---------------------------------------------------------------------------

/** Dashboard requests a new conversation */
export interface DashboardNewConversation {
  type: 'dashboard_new_conversation';
  tempId: string;
}

/** Server confirms conversation creation */
export interface ServerConversationCreated {
  type: 'server_conversation_created';
  tempId: string;
  id: string;
  title: string;
  createdAt: string;
}

/** Server sends conversation list on dashboard connect */
export interface ServerConversationList {
  type: 'server_conversation_list';
  conversations: Array<{
    id: string;
    title: string;
    status: 'active' | 'complete' | 'interrupted';
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessagePreview: string;
  }>;
}

/** Dashboard requests full messages for a conversation */
export interface DashboardLoadConversation {
  type: 'dashboard_load_conversation';
  conversationId: string;
}

/** Server responds with full message history */
export interface ServerConversationMessages {
  type: 'server_conversation_messages';
  conversationId: string;
  messages: Array<{
    id: string;
    role: 'user' | 'agent' | 'system';
    type: string;
    content: string;
    metadata?: string;
    timestamp: string;
  }>;
}

/** Dashboard requests conversation deletion */
export interface DashboardDeleteConversation {
  type: 'dashboard_delete_conversation';
  conversationId: string;
}

/** Server confirms deletion */
export interface ServerConversationDeleted {
  type: 'server_conversation_deleted';
  conversationId: string;
}

/** Dashboard sends search query */
export interface DashboardSearchConversations {
  type: 'dashboard_search_conversations';
  query: string;
}

/** Server responds with search results */
export interface ServerSearchResults {
  type: 'server_search_results';
  query: string;
  results: Array<{
    conversationId: string;
    conversationTitle: string;
    messageId: string;
    snippet: string;
    timestamp: string;
  }>;
}

/** Any message that can be sent over the WebSocket */
export type WebSocketMessage =
  | AgentCommand | AgentResult | AgentHello
  | DashboardHello | DashboardChatMessage
  | DashboardWorkflowRun | DashboardWorkflowCancel
  | DashboardStartRecording | DashboardStopRecording
  | DashboardListWorkflows | DashboardGetWorkflow | DashboardDeleteWorkflow
  | ServerChatResponse | ServerAgentProgress
  | ServerAgentStatus | ServerWorkflowProgress
  | AgentRecordingStarted | AgentRecordingStopped
  | AgentRecordingParsing | AgentWorkflowParsed
  | AgentWorkflowList | AgentWorkflowDetail
  | AgentWorkflowDeleted | AgentRecordingError
  | ServerRequestWorkflow | AgentWorkflowData
  | AgentSkillUpload | AgentSkillListRequest
  | ServerSkillListResult | ServerSkillBroadcast
  | ServerActionPreview | DashboardActionConfirm | DashboardActionCancel
  | DashboardCancelTask | ServerCancelAck
  | ServerSubGoalProgress | ServerDebugLog
  | DashboardNewConversation | ServerConversationCreated
  | ServerConversationList | DashboardLoadConversation | ServerConversationMessages
  | DashboardDeleteConversation | ServerConversationDeleted
  | DashboardSearchConversations | ServerSearchResults
  | ServerAuditEntry | ServerAuditSessionStart | ServerAuditSessionEnd;

// ---------------------------------------------------------------------------
// Workflow Definition — structured, reusable workflows (moved from local-agent)
// ---------------------------------------------------------------------------

/** A structured workflow generated from a recording */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  createdFrom: string;
  createdAt: string;
  applications: ApplicationMapping[];
  variables: WorkflowVariable[];
  steps: WorkflowStep[];
  loops?: LoopDefinition;
  rules?: BusinessRule[];
}

export interface ApplicationMapping {
  name: string;
  type: 'desktop' | 'browser' | 'system';
  preferredLayer: 'skill' | 'shell' | 'cdp' | 'accessibility' | 'vision';
  url?: string;
}

export interface WorkflowVariable {
  name: string;
  description: string;
  source: string;
  type: 'string' | 'number' | 'date' | 'boolean';
}

export interface WorkflowStep {
  id: number;
  description: string;
  application: string;
  layer: 'skill' | 'shell' | 'cdp' | 'accessibility' | 'vision';
  action: string;
  params: Record<string, unknown>;
  output?: string;
  verification?: string;
  fallbackLayer?: string;
}

export interface LoopDefinition {
  over: string;
  source: string;
  variable: string;
  stepsInLoop: number[];
}

export interface BusinessRule {
  condition: string;
  action: string;
  source: string;
}

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

// ---------------------------------------------------------------------------
// Audit Logging — Compliance-grade audit trail (EU AI Act, GDPR, BDSG §76)
// ---------------------------------------------------------------------------

/** Branded type for SHA-256 hashes — prevents accidentally passing a UUID where a hash is expected */
export type SHA256Hash = string & { readonly __brand: 'SHA256Hash' };

/** Audit event type — what kind of action was performed (ISO/IEC 24970) */
export type AuditEventType = 'llm_call' | 'tool_invocation' | 'decision' | 'human_review' | 'error' | 'cancellation';

/** BDSG §76 action type — how personal data was processed */
export type AuditActionType = 'collect' | 'read' | 'modify' | 'delete' | 'transmit' | 'combine';

/** Terminal state of an audit session (EU AI Act Art. 12 — period of each use) */
export type AuditTerminalState = 'success' | 'failure' | 'cancelled' | 'timeout' | 'in_progress';

/** How the session was triggered (ISO 27001) */
export type AuditTriggerType = 'manual' | 'scheduled' | 'event';

/** Accessor role for audit log access (BDSG §76) */
export type AuditAccessorRole = 'dpo' | 'regulator' | 'data_subject' | 'system';

/** Access type for audit log meta-logging (GDPR Art. 5(2)) */
export type AuditAccessType = 'query' | 'export' | 'verify' | 'erasure';

/** Control layer identifier for audit (product-specific) */
export type AuditControlLayer = 'skill' | 'shell' | 'cdp' | 'accessibility' | 'vision';

// --- Session types ---

/** Audit session — one complete workflow execution (Tier 1 in the three-tier hierarchy) */
export interface AuditSession {
  readonly id: string;
  readonly roomId: string;
  readonly userId: string | null;
  readonly userPseudonymId: string;
  readonly agentId: string | null;
  readonly workflowId: string | null;
  readonly workflowName: string;
  readonly department: string;
  readonly triggerType: AuditTriggerType;
  readonly terminalState: AuditTerminalState;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly timezone: string;
  readonly modelVersions: string | null;
  readonly stepCount: number;
  readonly humanOversightEvents: string | null;
  readonly riskFlags: string | null;
  readonly recordingIndicatorVisible: boolean;
  readonly noEmployeeComparison: boolean;
  readonly purposeLimitationScope: string;
  readonly createdAt: string;
}

// --- Event types (two-layer architecture) ---

/** Shared base for both L1 and L2 audit events */
export interface AuditEventBase {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

/** Layer 1 — Operational audit event (erasable for GDPR Art. 17) */
export interface AuditEventOperational extends AuditEventBase {
  readonly userId: string | null;
  readonly humanVerifierId: string | null;
  readonly recipientId: string | null;
  readonly originalValue: string | null;
  readonly newValue: string | null;
  readonly sourceIp: string | null;
  readonly sourceDevice: string | null;
  readonly sourceSessionId: string | null;
}

/** Layer 2 — Compliance audit event (immutable, pseudonymized, hash-chained) */
export interface AuditEventCompliance extends AuditEventBase {
  readonly userPseudonymId: string;
  readonly timestamp: string;
  readonly timezone: string;
  readonly eventType: AuditEventType;
  readonly actionType: AuditActionType;
  readonly action: string;
  readonly entityId: string | null;
  readonly entityType: string | null;
  readonly purpose: string;
  readonly legalBasis: string;
  readonly result: 'success' | 'failure';
  readonly inputHash: string | null;
  readonly outputSummary: string | null;
  readonly reasoningContext: string | null;
  readonly controlLayer: AuditControlLayer | null;
  readonly authorizationScope: string | null;
  readonly durationMs: number | null;
  readonly llmDataTransferDestination: string | null;
  readonly llmModelProvider: string | null;
  readonly llmModelVersion: string | null;
  readonly recordingIndicatorVisible: boolean;
  readonly noEmployeeComparison: boolean;
  readonly purposeLimitationScope: string;
  readonly previousHash: SHA256Hash;
  readonly entryHash: SHA256Hash;
}

// --- Filter types (endpoint-specific) ---

/** Filters for querying audit sessions */
export interface AuditSessionFilters {
  /** Room ID — required for tenant isolation */
  roomId: string;
  dateFrom?: string;
  dateTo?: string;
  department?: string;
  terminalState?: AuditTerminalState;
  workflowId?: string;
  cursor?: string;
  limit?: number;
}

/** Filters for querying audit events within a session */
export interface AuditEventFilters {
  /** Session ID — required */
  sessionId: string;
  eventType?: AuditEventType;
  cursor?: string;
  limit?: number;
}

/** Filters for audit data export */
export interface AuditExportFilters {
  /** Room ID — required for tenant isolation */
  roomId: string;
  dateFrom?: string;
  dateTo?: string;
  sessionIds?: string[];
  format: 'json' | 'csv';
}

// --- WebSocket message types (server → dashboard) ---

/** Real-time audit event pushed to dashboard (EU AI Act Art. 12 — tamper-resistant logging) */
export interface ServerAuditEntry {
  type: 'server_audit_entry';
  entry: AuditEventCompliance;
  sessionInfo: { workflowName: string; stepCount: number };
}

/** Audit session started — new workflow execution began */
export interface ServerAuditSessionStart {
  type: 'server_audit_session_start';
  session: AuditSession;
}

/** Audit session ended — workflow execution reached terminal state */
export interface ServerAuditSessionEnd {
  type: 'server_audit_session_end';
  sessionId: string;
  terminalState: AuditTerminalState;
  endTime: string;
  stepCount: number;
}
