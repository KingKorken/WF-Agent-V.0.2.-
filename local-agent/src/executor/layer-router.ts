/**
 * Layer Router — Routes incoming commands to the correct executor.
 *
 * The cloud sends commands with a "layer" field that tells us which
 * execution layer should handle it. This router reads that field and
 * dispatches to the right module.
 *
 * Currently implemented:
 *   - Layer 2 (shell): Shell commands, app launching, window management
 *   - Layer 3 (cdp): Browser automation via Chrome DevTools Protocol / Playwright
 *   - Layer 4 (accessibility): Desktop app control via macOS Accessibility APIs / JXA
 *   - Layer 5 (vision): Hybrid screenshot + context automation (last resort)
 *
 * Not yet implemented (returns "not implemented" response):
 *   - System: Keyboard shortcuts, screenshots
 */

import { AgentCommand, AgentResult } from '@workflow-agent/shared';
import { executeShellCommand } from './shell/shell-executor';
import {
  launchApp,
  switchToApp,
  closeApp,
  listRunningApps,
  minimizeWindow,
} from './shell/app-launcher';
import { launchBrowser, closeBrowser } from './cdp/browser-manager';
import { navigateTo, getPageInfo, createNewTab, closeCurrentTab, listTabs, takeScreenshot } from './cdp/cdp-client';
import { getSnapshot } from './cdp/element-snapshot';
import { clickElement, typeInElement, selectOption } from './cdp/browser-actions';
import { getAppTree, getElementSnapshot, findElement } from './accessibility/ax-tree';
import {
  clickElement as axClickElement,
  setElementValue as axSetElementValue,
  getElementValue as axGetElementValue,
  focusElement as axFocusElement,
  pressMenuPath,
  getWindowInfo as axGetWindowInfo,
} from './accessibility/ax-actions';
import { captureFullScreen, captureWindow, captureRegion } from './vision/screenshot';
import { collectVisionContext } from './vision/context-collector';
import {
  clickAt,
  doubleClickAt,
  rightClickAt,
  typeText,
  typeKeyCombo,
  dragFromTo,
  scrollAt,
} from './vision/vision-actions';
import { log, error as logError } from '../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Route a command to the correct layer executor and return the result.
 * This function NEVER throws — it always returns a structured AgentResult.
 *
 * @param command - The parsed command from the cloud
 * @returns The result of executing the command
 */
export async function routeCommand(command: AgentCommand): Promise<AgentResult> {
  log(`[${timestamp()}] [layer-router] Routing command ${command.id} → layer: ${command.layer}, action: ${command.action}`);

  try {
    switch (command.layer) {
      case 'shell':
        return await handleShellCommand(command);

      case 'cdp':
        return await handleCdpCommand(command);

      case 'accessibility':
        return await handleAccessibilityCommand(command);

      case 'vision':
        return await handleVisionCommand(command);

      case 'system':
        return notImplemented(command, 'System commands');

      default:
        return {
          type: 'result',
          id: command.id,
          status: 'error',
          data: { error: `Unknown layer: ${command.layer}` },
        };
    }
  } catch (err) {
    // Safety net — if anything unexpected happens, we return an error
    // instead of crashing the agent
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${timestamp()}] [layer-router] Unexpected error: ${message}`);
    return {
      type: 'result',
      id: command.id,
      status: 'error',
      data: { error: `Unexpected error in layer-router: ${message}` },
    };
  }
}

/**
 * Handle Layer 2 (shell) commands.
 * Supports raw shell execution and app management actions.
 */
async function handleShellCommand(command: AgentCommand): Promise<AgentResult> {
  const params = command.params;

  switch (command.action) {
    case 'exec': {
      // Raw shell command execution
      const cmd = params.command as string;
      if (!cmd) {
        return {
          type: 'result',
          id: command.id,
          status: 'error',
          data: { error: 'Missing "command" parameter for shell exec' },
        };
      }

      const timeout = (params.timeout as number) || undefined;
      const result = await executeShellCommand(cmd, timeout);

      return {
        type: 'result',
        id: command.id,
        status: result.exitCode === 0 ? 'success' : 'error',
        data: {
          output: result.output,
          error: result.error,
          exitCode: result.exitCode,
        },
      };
    }

    case 'launch_app': {
      const appName = params.appName as string;
      if (!appName) {
        return {
          type: 'result',
          id: command.id,
          status: 'error',
          data: { error: 'Missing "appName" parameter' },
        };
      }
      const result = await launchApp(appName);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { message: result.message, error: result.error },
      };
    }

    case 'switch_app': {
      const appName = params.appName as string;
      if (!appName) {
        return {
          type: 'result',
          id: command.id,
          status: 'error',
          data: { error: 'Missing "appName" parameter' },
        };
      }
      const result = await switchToApp(appName);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { message: result.message, error: result.error },
      };
    }

    case 'close_app': {
      const appName = params.appName as string;
      if (!appName) {
        return {
          type: 'result',
          id: command.id,
          status: 'error',
          data: { error: 'Missing "appName" parameter' },
        };
      }
      const result = await closeApp(appName);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { message: result.message, error: result.error },
      };
    }

    case 'list_apps': {
      const result = await listRunningApps();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { apps: result.message, error: result.error },
      };
    }

    case 'minimize_window': {
      const appName = params.appName as string | undefined;
      const result = await minimizeWindow(appName);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { message: result.message, error: result.error },
      };
    }

    default:
      return {
        type: 'result',
        id: command.id,
        status: 'error',
        data: { error: `Unknown shell action: ${command.action}` },
      };
  }
}

/**
 * Handle Layer 3 (cdp) commands.
 * Supports browser launch/close, navigation, element snapshots, and element actions.
 */
async function handleCdpCommand(command: AgentCommand): Promise<AgentResult> {
  const params = command.params;

  switch (command.action) {
    case 'launch': {
      const result = await launchBrowser();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { message: result.success ? 'Browser launched' : 'Failed to launch browser', error: result.error },
      };
    }

    case 'close': {
      const result = await closeBrowser();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { message: result.success ? 'Browser closed' : 'Failed to close browser', error: result.error },
      };
    }

    case 'navigate': {
      const url = params.url as string;
      if (!url) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "url" parameter' } };
      }
      const result = await navigateTo(url);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'snapshot': {
      const interactive = params.interactive !== false; // default true
      const result = await getSnapshot(interactive);
      if (!result.success) {
        return { type: 'result', id: command.id, status: 'error', data: { error: result.error } };
      }
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: {
          pageUrl: result.pageUrl,
          pageTitle: result.pageTitle,
          elements: result.elements,
          count: result.elements?.length ?? 0,
        },
      };
    }

    case 'click': {
      const ref = params.ref as string;
      if (!ref) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" parameter' } };
      }
      const result = await clickElement(ref);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'type': {
      const ref = params.ref as string;
      const text = params.text as string;
      if (!ref || text === undefined) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" or "text" parameter' } };
      }
      const result = await typeInElement(ref, text);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'select': {
      const ref = params.ref as string;
      const value = params.value as string;
      if (!ref || !value) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" or "value" parameter' } };
      }
      const result = await selectOption(ref, value);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'screenshot': {
      const result = await takeScreenshot();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'page_info': {
      const result = await getPageInfo();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'new_tab': {
      const url = params.url as string | undefined;
      const result = await createNewTab(url);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'close_tab': {
      const result = await closeCurrentTab();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'list_tabs': {
      const result = await listTabs();
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    default:
      return {
        type: 'result',
        id: command.id,
        status: 'error',
        data: { error: `Unknown cdp action: ${command.action}` },
      };
  }
}

/**
 * Handle Layer 4 (accessibility) commands.
 * Supports reading accessibility trees, element snapshots, find, click, set value, menus.
 */
async function handleAccessibilityCommand(command: AgentCommand): Promise<AgentResult> {
  const params = command.params;

  switch (command.action) {
    case 'get_tree': {
      const app = params.app as string;
      if (!app) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "app" parameter' } };
      }
      const depth = (params.depth as number) || 3;
      const result = await getAppTree(app, depth);
      if (!result.success) {
        return { type: 'result', id: command.id, status: 'error', data: { error: result.error } };
      }
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: {
          app: result.app,
          windows: result.windows,
          elementCount: result.elementCount,
        },
      };
    }

    case 'snapshot': {
      const app = params.app as string;
      if (!app) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "app" parameter' } };
      }
      const result = await getElementSnapshot(app);
      if (!result.success) {
        return { type: 'result', id: command.id, status: 'error', data: { error: result.error } };
      }
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: {
          app: result.app,
          elements: result.elements,
          count: result.count,
        },
      };
    }

    case 'find_element': {
      const app = params.app as string;
      if (!app) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "app" parameter' } };
      }
      const query: { role?: string; label?: string; value?: string } = {};
      if (params.role) query.role = params.role as string;
      if (params.label) query.label = params.label as string;
      if (params.value) query.value = params.value as string;
      const result = await findElement(app, query);
      if (!result.success) {
        return { type: 'result', id: command.id, status: 'error', data: { error: result.error } };
      }
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: {
          elements: result.elements,
          count: result.count,
        },
      };
    }

    case 'press_button': {
      const ref = params.ref as string;
      if (!ref) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" parameter' } };
      }
      const result = await axClickElement(ref);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'set_value': {
      const ref = params.ref as string;
      const value = params.value as string;
      if (!ref || value === undefined) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" or "value" parameter' } };
      }
      const result = await axSetElementValue(ref, value);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'get_value': {
      const ref = params.ref as string;
      if (!ref) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" parameter' } };
      }
      const result = await axGetElementValue(ref);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'menu_click': {
      const app = params.app as string;
      const menuPath = params.menuPath as string[];
      if (!app || !menuPath || !Array.isArray(menuPath) || menuPath.length === 0) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "app" or "menuPath" parameter' } };
      }
      const result = await pressMenuPath(app, menuPath);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'focus': {
      const ref = params.ref as string;
      if (!ref) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "ref" parameter' } };
      }
      const result = await axFocusElement(ref);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    case 'window_info': {
      const app = params.app as string;
      if (!app) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "app" parameter' } };
      }
      const result = await axGetWindowInfo(app);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: result.success ? { ...result.data } : { error: result.error },
      };
    }

    default:
      return {
        type: 'result',
        id: command.id,
        status: 'error',
        data: { error: `Unknown accessibility action: ${command.action}` },
      };
  }
}

/**
 * Handle Layer 5 (vision) commands.
 * Supports screenshot capture, hybrid context collection, and coordinate-based actions.
 */
async function handleVisionCommand(command: AgentCommand): Promise<AgentResult> {
  const params = command.params;

  switch (command.action) {
    case 'screenshot': {
      const app = params.app as string | undefined;
      const result = app ? await captureWindow(app) : await captureFullScreen();
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: { ...result },
      };
    }

    case 'capture_region': {
      const x = params.x as number;
      const y = params.y as number;
      const width = params.width as number;
      const height = params.height as number;
      if (x === undefined || y === undefined || !width || !height) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing x, y, width, or height parameter' } };
      }
      const result = await captureRegion(x, y, width, height);
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: { ...result },
      };
    }

    case 'collect_context': {
      const app = params.app as string | undefined;
      const taskContext = params.taskContext as {
        currentStep: string;
        expectedOutcome: string;
        workflowName: string;
      } | undefined;
      const metadataOnly = params.metadataOnly as boolean | undefined;
      const result = await collectVisionContext(app, taskContext, metadataOnly);
      return {
        type: 'result',
        id: command.id,
        status: 'success',
        data: { ...result },
      };
    }

    case 'click_coordinates': {
      const x = params.x as number;
      const y = params.y as number;
      const verify = params.verify as boolean | undefined;
      if (x === undefined || y === undefined) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing x or y parameter' } };
      }
      const result = await clickAt(x, y, verify);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    case 'double_click': {
      const x = params.x as number;
      const y = params.y as number;
      const verify = params.verify as boolean | undefined;
      if (x === undefined || y === undefined) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing x or y parameter' } };
      }
      const result = await doubleClickAt(x, y, verify);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    case 'right_click': {
      const x = params.x as number;
      const y = params.y as number;
      const verify = params.verify as boolean | undefined;
      if (x === undefined || y === undefined) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing x or y parameter' } };
      }
      const result = await rightClickAt(x, y, verify);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    case 'type_text': {
      const text = params.text as string;
      if (!text) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "text" parameter' } };
      }
      const result = await typeText(text);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    case 'key_combo': {
      const keys = params.keys as string[];
      if (!keys || !Array.isArray(keys) || keys.length === 0) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing "keys" array parameter' } };
      }
      const result = await typeKeyCombo(keys);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    case 'drag': {
      const fromX = params.fromX as number;
      const fromY = params.fromY as number;
      const toX = params.toX as number;
      const toY = params.toY as number;
      if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing fromX, fromY, toX, or toY parameter' } };
      }
      const result = await dragFromTo(fromX, fromY, toX, toY);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    case 'scroll': {
      const x = params.x as number;
      const y = params.y as number;
      const direction = params.direction as 'up' | 'down' | 'left' | 'right';
      const amount = (params.amount as number) || 3;
      if (x === undefined || y === undefined || !direction) {
        return { type: 'result', id: command.id, status: 'error', data: { error: 'Missing x, y, or direction parameter' } };
      }
      const result = await scrollAt(x, y, direction, amount);
      return {
        type: 'result',
        id: command.id,
        status: result.success ? 'success' : 'error',
        data: { ...result },
      };
    }

    default:
      return {
        type: 'result',
        id: command.id,
        status: 'error',
        data: { error: `Unknown vision action: ${command.action}` },
      };
  }
}

/**
 * Return a "not yet implemented" response for layers that aren't built yet.
 */
function notImplemented(command: AgentCommand, layerName: string): AgentResult {
  log(`[${timestamp()}] [layer-router] Layer not implemented: ${layerName}`);
  return {
    type: 'result',
    id: command.id,
    status: 'error',
    data: {
      error: `${layerName} is not yet implemented. Coming in a future update.`,
    },
  };
}
