/**
 * AppPaths — Centralized path resolution for dev and packaged Electron app.
 *
 * In dev:       paths resolve relative to the local-agent/ root (via app.getAppPath())
 * In packaged:  binaries are in Contents/Resources/bin/ (extraResources)
 *               user data is in ~/Library/Application Support/WFA Agent/
 *
 * Design decisions:
 *   - app.isPackaged is read lazily (not at module load time) to avoid timing issues
 *   - getUserDataPath is a pure function (no side effects — no directory creation)
 *   - ensureDir creates directories explicitly where needed
 *   - Uses app.getAppPath() as anchor instead of __dirname (bundler-safe)
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Whether the app is running as a packaged build (not dev).
 * Called as a function to avoid module-level timing issues with app.isPackaged.
 */
function isPackaged(): boolean {
  return app.isPackaged;
}

/**
 * Get the path to a native binary (event-monitor-darwin, audio-recorder-darwin).
 * In dev: local-agent/bin/<name>
 * Packaged: Contents/Resources/bin/<name>
 */
export function getBinPath(binaryName: string): string {
  return isPackaged()
    ? path.join(process.resourcesPath, 'bin', binaryName)
    : path.join(app.getAppPath(), 'bin', binaryName);
}

/**
 * Get the path to a user data subdirectory (workflows, recordings, config).
 * Pure function — does NOT create the directory. Use ensureDir() to create.
 *
 * In dev: local-agent/<subdir>
 * Packaged: ~/Library/Application Support/WFA Agent/<subdir>
 */
export function getUserDataPath(subdir: string): string {
  return isPackaged()
    ? path.join(app.getPath('userData'), subdir)
    : path.join(app.getAppPath(), subdir);
}

/**
 * Get the path to an app resource file.
 * In dev: local-agent/<relativePath>
 * Packaged: Contents/Resources/<relativePath>
 */
export function getResourcePath(relativePath: string): string {
  return isPackaged()
    ? path.join(process.resourcesPath, relativePath)
    : path.join(app.getAppPath(), relativePath);
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * Returns the directory path for convenient chaining.
 */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
