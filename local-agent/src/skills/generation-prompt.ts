/**
 * Generation Prompt — Specialized prompts for autonomous skill generation.
 *
 * Completely separate from the agent loop's prompt-builder.ts.
 * Used by generator.ts to instruct Claude to write skill code.
 */

import type { DiscoveryResult } from './discovery';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the skill code generator.
 * This tells Claude it's a TypeScript skill generator — NOT the agent loop.
 */
export function buildGenerationSystemPrompt(): string {
  return `You are a TypeScript skill generator. You create standalone CLI scripts that wrap application interfaces (AppleScript, CLI tools, REST APIs) for a workflow automation agent.

RULES:
1. Generate a COMPLETE, RUNNABLE TypeScript file
2. The file must be a CLI script: parse process.argv for command and flags
3. All output must be JSON to stdout: {success: true, data: ...} or {success: false, error: "..."}
4. Handle errors gracefully — never throw unhandled exceptions
5. For AppleScript skills: use child_process.execFile("/usr/bin/osascript", ["-e", script]) — NOT JXA (-l JavaScript)
6. For CLI skills: use child_process.execFile with the CLI binary path
7. For API skills: use Node.js built-in https module (no npm dependencies)
8. Include a help command that lists all available commands
9. Escape all user input properly (AppleScript strings, shell arguments, URL parameters)
10. Use ONLY Node.js built-in modules — no npm dependencies allowed
11. Follow the EXACT patterns from the example skill provided

Return ONLY TypeScript code. No markdown fences. No explanation before or after the code.`;
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for a specific skill generation request.
 *
 * @param appName      - The application to generate a skill for
 * @param discovery    - Discovery results showing available interfaces
 * @param templateCode - Full source of an existing skill (e.g. outlook-skill.ts) as a template
 */
export function buildGenerationUserPrompt(
  appName: string,
  discovery: DiscoveryResult,
  templateCode: string
): string {
  // Determine which interfaces are available
  const interfaces: string[] = [];
  if (discovery.appleScript.supported) {
    interfaces.push('AppleScript');
  }
  if (discovery.cli.found) {
    interfaces.push(`CLI (${discovery.cli.path})`);
  }
  if (discovery.knownApi.hasApi) {
    interfaces.push(`REST API (${discovery.knownApi.docsUrl})`);
  }

  const interfaceList = interfaces.join(', ');

  // Build details about each interface
  let interfaceDetails = '';
  if (discovery.appleScript.supported) {
    interfaceDetails += `\nAppleScript: Supported.`;
    if (discovery.appleScript.error) {
      interfaceDetails += ` Note: ${discovery.appleScript.error}`;
    }
  }
  if (discovery.cli.found) {
    interfaceDetails += `\nCLI: Found at ${discovery.cli.path}`;
    if (discovery.cli.helpText) {
      interfaceDetails += `\nCLI help output:\n${discovery.cli.helpText}`;
    }
  }
  if (discovery.knownApi.hasApi) {
    interfaceDetails += `\nKnown API: ${discovery.knownApi.docsUrl}`;
  }

  return `Generate a complete skill file for "${appName}". It supports: ${interfaceList}.

DISCOVERY DETAILS:
${interfaceDetails}

EXAMPLE SKILL (follow this pattern EXACTLY):
--- BEGIN TEMPLATE ---
${templateCode}
--- END TEMPLATE ---

Follow the exact patterns from the outlook-skill.ts example:
- Same CLI argument parsing structure (parseArgs function)
- Same JSON output pattern (ok/fail helper functions)
- Same error handling approach
- Same main() entry point with switch/case for commands
- For AppleScript: same escapeAS() and runAppleScript() helpers

The skill should have commands that cover the main capabilities of the application.
Return ONLY the TypeScript code, no markdown fences, no explanation.`;
}

// ---------------------------------------------------------------------------
// Fix prompt
// ---------------------------------------------------------------------------

/**
 * Build a follow-up prompt when a generation attempt fails.
 * Sent in the same conversation so Claude has context of its previous code.
 */
export function buildFixPrompt(error: string): string {
  return `The skill failed with this error:
${error}

Fix the code. Return ONLY the corrected TypeScript code, no markdown fences, no explanation.`;
}
