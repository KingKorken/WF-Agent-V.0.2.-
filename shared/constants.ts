/**
 * Shared constants for the Workflow Automation Agent.
 *
 * These values are used by both the Local Agent and the cloud server
 * to ensure consistency (ports, timeouts, app metadata, etc.).
 */

/** Application metadata */
export const APP_NAME = 'Workflow Agent';
export const APP_VERSION = '0.1.0';
export const AGENT_NAME = 'workflow-agent-local';

/** WebSocket configuration */
export const DEFAULT_WS_PORT = 8765;
export const DEFAULT_WS_URL = `ws://localhost:${DEFAULT_WS_PORT}`;

/** Shell executor defaults */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000; // 30 seconds

/** Reconnect configuration (exponential backoff) */
export const RECONNECT_INITIAL_DELAY_MS = 1_000;   // 1 second
export const RECONNECT_MAX_DELAY_MS = 30_000;       // 30 seconds
export const RECONNECT_BACKOFF_MULTIPLIER = 2;

/** Supported command layers in the current build */
export const SUPPORTED_LAYERS = ['shell', 'cdp', 'accessibility'] as const;
