/**
 * Platform Permission Checks — Reusable macOS permission verification.
 *
 * Used by both the setup window (first-launch) and the command handler
 * (pre-flight check before every command execution).
 *
 * On non-macOS platforms, all permissions are assumed granted.
 */

export interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
}

/**
 * Check Accessibility and Screen Recording permissions on macOS.
 * Returns all-granted on non-macOS platforms.
 */
export function checkRequiredPermissions(): PermissionStatus {
  if (process.platform !== 'darwin') {
    return { accessibility: true, screenRecording: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { systemPreferences } = require('electron');
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
  };
}

/**
 * Return an array of missing permission names (e.g. ['Accessibility', 'Screen Recording']).
 * Empty array means all required permissions are granted.
 */
export function getMissingPermissions(): string[] {
  const status = checkRequiredPermissions();
  const missing: string[] = [];
  if (!status.accessibility) missing.push('Accessibility');
  if (!status.screenRecording) missing.push('Screen Recording');
  return missing;
}
