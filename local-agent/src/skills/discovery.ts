/**
 * Skill Discovery — Probe an application's automation capabilities.
 *
 * Runs three checks: AppleScript support, CLI availability, known API lookup.
 * Discovery only — reports findings, does not generate code.
 */

import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
  app: string;
  appleScript: { supported: boolean; error?: string };
  cli: { found: boolean; path?: string; helpText?: string };
  knownApi: { hasApi: boolean; docsUrl?: string };
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Known API directory
// ---------------------------------------------------------------------------

const KNOWN_APIS: Record<string, string> = {
  'Slack': 'https://api.slack.com/methods',
  'Notion': 'https://developers.notion.com/reference',
  'GitHub': 'https://docs.github.com/en/rest',
  'GitHub Desktop': 'https://docs.github.com/en/rest',
  'Jira': 'https://developer.atlassian.com/cloud/jira/platform/rest/v3',
  'Google Sheets': 'https://developers.google.com/sheets/api/reference/rest',
  'Google Chrome': 'https://developer.chrome.com/docs/extensions/reference',
  'Microsoft Teams': 'https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview',
  'Microsoft Outlook': 'https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview',
  'Zoom': 'https://developers.zoom.us/docs/api/',
  'Figma': 'https://www.figma.com/developers/api',
  'Linear': 'https://linear.app/docs/graphql/working-with-the-graphql-api',
  'Asana': 'https://developers.asana.com/reference/rest-api-reference',
  'Trello': 'https://developer.atlassian.com/cloud/trello/rest/',
  'Discord': 'https://discord.com/developers/docs/reference',
  'Salesforce': 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
  'Spotify': 'https://developer.spotify.com/documentation/web-api',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISCOVERY_TIMEOUT = 5000;

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: DISCOVERY_TIMEOUT }, (err, stdout, stderr) => {
      if (err) {
        resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || err.message });
      } else {
        resolve({ stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
      }
    });
  });
}

/** Derive plausible CLI names from an app name. */
function deriveCLINames(appName: string): string[] {
  const names: string[] = [];
  // Lowercase the full name with hyphens
  const lower = appName.toLowerCase().replace(/\s+/g, '-');
  names.push(lower);
  // Just the last word (e.g. "Microsoft Outlook" → "outlook")
  const parts = appName.split(/\s+/);
  if (parts.length > 1) {
    names.push(parts[parts.length - 1].toLowerCase());
  }
  // Prefix variations for Microsoft apps
  if (appName.startsWith('Microsoft ')) {
    const short = parts[parts.length - 1].toLowerCase();
    names.push(`ms-${short}`);
  }
  // Remove duplicates
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

export async function discoverAppCapabilities(appName: string): Promise<DiscoveryResult> {
  // --- Check 1: AppleScript support ---
  let appleScript: DiscoveryResult['appleScript'];
  try {
    const { stderr: err1 } = await runCommand('/usr/bin/osascript', [
      '-e', `tell application "${appName}" to count windows`,
    ]);
    if (err1 && (err1.includes('error') || err1.includes('not scriptable'))) {
      appleScript = { supported: false, error: err1 };
    } else {
      // Deeper check — try getting window names
      const { stderr: err2 } = await runCommand('/usr/bin/osascript', [
        '-e', `tell application "${appName}" to get name of every window`,
      ]);
      if (err2 && err2.includes('error')) {
        appleScript = { supported: true, error: `Basic support only: ${err2}` };
      } else {
        appleScript = { supported: true };
      }
    }
  } catch {
    appleScript = { supported: false, error: 'Check timed out' };
  }

  // --- Check 2: CLI availability ---
  let cli: DiscoveryResult['cli'] = { found: false };
  const cliCandidates = deriveCLINames(appName);
  for (const name of cliCandidates) {
    const { stdout: whichOut } = await runCommand('/usr/bin/which', [name]);
    if (whichOut) {
      const { stdout: helpOut } = await runCommand(whichOut, ['--help']);
      cli = {
        found: true,
        path: whichOut,
        helpText: helpOut.substring(0, 500) || '(no help output)',
      };
      break;
    }
  }

  // --- Check 3: Known API lookup ---
  let knownApi: DiscoveryResult['knownApi'] = { hasApi: false };
  const lowerApp = appName.toLowerCase();
  for (const [key, url] of Object.entries(KNOWN_APIS)) {
    if (key.toLowerCase() === lowerApp || lowerApp.includes(key.toLowerCase()) || key.toLowerCase().includes(lowerApp)) {
      knownApi = { hasApi: true, docsUrl: url };
      break;
    }
  }

  // --- Build recommendation ---
  const recs: string[] = [];
  if (appleScript.supported) {
    recs.push('AppleScript wrapper skill');
  }
  if (cli.found) {
    recs.push(`CLI tool (${cli.path})`);
  }
  if (knownApi.hasApi) {
    recs.push(`REST API (${knownApi.docsUrl})`);
  }

  let recommendation: string;
  if (recs.length === 0) {
    recommendation = `${appName} has no discovered automation interfaces. UI automation (accessibility/vision) is the only option.`;
  } else {
    recommendation = `${appName} supports: ${recs.join(', ')}. Recommended approach: ${recs[0]}.`;
  }

  return { app: appName, appleScript, cli, knownApi, recommendation };
}
