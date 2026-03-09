/**
 * Skill Generator — Autonomously create new skills for unknown apps.
 *
 * Uses a SEPARATE Claude conversation (not the agent loop) to generate
 * TypeScript skill code, then compiles, tests, and registers it.
 *
 * Flow:
 *   1. Build generation prompt (with template + discovery results)
 *   2. Call Claude to generate code
 *   3. Save to src/skills/generated/<app>-skill.ts
 *   4. Compile with tsc
 *   5. Test with a safe read-only command
 *   6. On success → register in registry.json
 *   7. On failure → send error back to Claude, iterate (max 5 attempts)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { initLLMClient, sendMessageWithMeta } from '../agent/llm-client';
import type { ConversationMessage } from '../agent/llm-client';
import type { DiscoveryResult } from './discovery';
import { registerSkill, SKILLS_DIR, SKILLS_DIST_DIR } from './registry';
import type { SkillEntry, SkillCommand } from './registry';
import { saveDiscovery } from './registry';
import { uploadSkillToShared } from './skill-sharing';
import {
  buildGenerationSystemPrompt,
  buildGenerationUserPrompt,
  buildFixPrompt,
} from './generation-prompt';
import { log, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerationResult {
  success: boolean;
  skillFile?: string;
  registryEntry?: SkillEntry;
  error?: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const GENERATION_MAX_TOKENS = 8192;
const GENERATED_SOURCE_DIR = path.join(SKILLS_DIR, 'generated');
const GENERATED_DIST_DIR = path.join(SKILLS_DIST_DIR, 'generated');
const TEMPLATE_PATH = path.join(SKILLS_DIR, 'outlook-skill.ts');
const COMPILE_TIMEOUT = 30_000;
const TEST_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command and return stdout/stderr/errorMessage separately. */
function runCmd(
  cmd: string,
  args: string[],
  timeout: number = COMPILE_TIMEOUT
): Promise<{ stdout: string; stderr: string; exitCode: number; errorMessage: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout?.trim() || '',
        stderr: stderr?.trim() || '',
        exitCode: err ? 1 : 0,
        errorMessage: err ? err.message : '',
      });
    });
  });
}

/** Ensure generated source/dist directories and tsconfig exist. */
function ensureGeneratedDirs(): void {
  fs.mkdirSync(GENERATED_SOURCE_DIR, { recursive: true });
  fs.mkdirSync(GENERATED_DIST_DIR, { recursive: true });

  const tsconfigPath = path.join(GENERATED_SOURCE_DIR, 'tsconfig.generated.json');
  if (!fs.existsSync(tsconfigPath)) {
    const relativeOutDir = path.relative(GENERATED_SOURCE_DIR, GENERATED_DIST_DIR);
    const config = {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        lib: ['ES2020'],
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false,
        noImplicitAny: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        outDir: relativeOutDir,
        rootDir: '.',
        moduleResolution: 'node',
        types: ['node'],
      },
      include: ['*.ts'],
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
}

/** Derive a filename slug from an app name. */
function toSlug(appName: string): string {
  return appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Strip markdown code fences if the LLM wrapped its output. */
function stripCodeFences(code: string): string {
  let cleaned = code.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:typescript|ts|javascript|js)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
  }
  return cleaned;
}

/**
 * Try to extract command names from the generated code.
 * Looks for case statements in the main switch block.
 */
function extractCommands(code: string): SkillCommand[] {
  const commands: SkillCommand[] = [];
  const caseRegex = /case\s+['"]([a-z][\w-]*)['"]:/g;
  let match: RegExpExecArray | null;
  while ((match = caseRegex.exec(code)) !== null) {
    const name = match[1];
    // Skip 'default' and internal names
    if (name === 'default') continue;
    commands.push({
      name,
      args: '',
      description: name.replace(/-/g, ' '),
    });
  }
  return commands;
}

/**
 * Pick a safe read-only test command from the generated commands.
 * Prefers: help, list, info, status, read, get — in that order.
 */
function pickTestCommand(commands: SkillCommand[]): string {
  const preferred = ['help', 'list', 'info', 'status', 'read', 'get', 'list-folders', 'read-inbox'];
  for (const pref of preferred) {
    if (commands.some(c => c.name === pref)) return pref;
  }
  // Fall back to first command that looks read-only
  const safe = commands.find(c =>
    !c.name.includes('send') &&
    !c.name.includes('write') &&
    !c.name.includes('delete') &&
    !c.name.includes('create') &&
    !c.name.includes('update') &&
    !c.name.includes('set')
  );
  return safe ? safe.name : 'help';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a skill for an application.
 *
 * Uses a fresh Claude conversation to write code, then compiles and tests it.
 * Iterates up to MAX_ATTEMPTS times on failure.
 */
export async function generateSkill(
  appName: string,
  discovery: DiscoveryResult
): Promise<GenerationResult> {
  log(`[generator] Starting skill generation for "${appName}"`);

  // Ensure the LLM client is initialized
  try {
    initLLMClient();
  } catch {
    // Already initialized — fine
  }

  // Check that at least one viable interface was found
  if (!discovery.appleScript.supported && !discovery.cli.found && !discovery.knownApi.hasApi) {
    saveDiscovery(discovery);
    return {
      success: false,
      error: `No viable automation interface found for "${appName}". Discovery saved.`,
      attempts: 0,
    };
  }

  // Read the template skill
  let templateCode: string;
  try {
    templateCode = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  } catch {
    return {
      success: false,
      error: `Cannot read template skill at ${TEMPLATE_PATH}`,
      attempts: 0,
    };
  }

  // Ensure generated directories and tsconfig exist
  ensureGeneratedDirs();

  const slug = toSlug(appName);
  const sourceFile = path.join(GENERATED_SOURCE_DIR, `${slug}-skill.ts`);
  const distFile = path.join(GENERATED_DIST_DIR, `${slug}-skill.js`);

  // Build prompts
  const systemPrompt = buildGenerationSystemPrompt();
  const userPrompt = buildGenerationUserPrompt(appName, discovery, templateCode);

  // Fresh conversation for generation (completely separate from agent loop)
  const conversation: ConversationMessage[] = [
    { role: 'user', content: userPrompt },
  ];

  let lastError = '';
  let useJavaScript = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`[generator] Attempt ${attempt}/${MAX_ATTEMPTS} for "${appName}"${useJavaScript ? ' (JavaScript mode)' : ''}`);

    // --- Switch to JavaScript on attempt 4 ---
    if (attempt === 4 && !useJavaScript) {
      useJavaScript = true;
      conversation.push({
        role: 'user',
        content: `TypeScript compilation has failed ${attempt - 1} times. Generate the skill as PLAIN JAVASCRIPT instead. Same structure, same ok()/fail() pattern, same CLI parsing — but as a .js file that can run directly with node. Return ONLY JavaScript code.`,
      });
    }

    // --- Step 2: Call Claude ---
    let code: string;
    try {
      const response = await sendMessageWithMeta(systemPrompt, conversation, GENERATION_MAX_TOKENS);
      code = response.text;

      if (response.truncated) {
        log(`[generator] Response truncated at ${response.outputTokens} tokens — requesting continuation`);
        conversation.push({ role: 'assistant', content: code });
        conversation.push({
          role: 'user',
          content: 'Your code was truncated mid-line. Continue EXACTLY from where you stopped. Output ONLY the remaining code starting from the exact cut-off point. Do not repeat any code that was already generated.',
        });
        const cont = await sendMessageWithMeta(systemPrompt, conversation, GENERATION_MAX_TOKENS);
        code = code + cont.text;
        // Remove the continuation messages from conversation (keep it clean for fix prompts)
        conversation.pop();
        conversation.pop();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[generator] LLM call failed: ${msg}`);
      lastError = `LLM call failed: ${msg}`;
      continue;
    }

    code = stripCodeFences(code);
    conversation.push({ role: 'assistant', content: code });

    if (useJavaScript) {
      // --- JavaScript path: skip compilation, write .js directly ---
      fs.writeFileSync(distFile, code, 'utf8');
      log(`[generator] Saved JavaScript directly to ${distFile}`);
    } else {
      // --- TypeScript path: save source then compile ---
      fs.writeFileSync(sourceFile, code, 'utf8');
      log(`[generator] Saved source to ${sourceFile}`);

      const tsconfigPath = path.join(GENERATED_SOURCE_DIR, 'tsconfig.generated.json');
      const compileResult = await runCmd('npx', [
        'tsc',
        '--project', tsconfigPath,
      ], COMPILE_TIMEOUT);

      if (compileResult.exitCode !== 0) {
        const errorParts = [compileResult.stdout, compileResult.stderr]
          .filter(Boolean)
          .join('\n');
        lastError = `Compilation failed:\n${errorParts || compileResult.errorMessage || 'Unknown error'}`;
        log(`[generator] Compile failed (attempt ${attempt}): ${lastError.substring(0, 1000)}`);

        // Send fix prompt with full error output
        conversation.push({ role: 'user', content: buildFixPrompt(lastError, attempt) });
        continue;
      }

      log(`[generator] Compiled successfully`);
    }

    // --- Test with a safe command ---
    const commands = extractCommands(code);
    const testCmd = pickTestCommand(commands);
    log(`[generator] Testing with command: ${testCmd}`);

    const testResult = await runCmd('node', [distFile, testCmd], TEST_TIMEOUT);

    // Validate output is JSON with a "success" field
    let testPassed = false;
    let testOutput = testResult.stdout || testResult.stderr;
    try {
      const parsed = JSON.parse(testResult.stdout);
      if ('success' in parsed) {
        testPassed = true;
        log(`[generator] Test passed: success=${parsed.success}`);
      } else {
        lastError = `Test output is JSON but missing "success" field: ${testResult.stdout.substring(0, 200)}`;
      }
    } catch {
      lastError = `Test output is not valid JSON.\nstdout: ${testResult.stdout.substring(0, 300)}\nstderr: ${testResult.stderr.substring(0, 300)}`;
      testOutput = lastError;
    }

    if (!testPassed) {
      log(`[generator] Test failed (attempt ${attempt}): ${lastError.substring(0, 1000)}`);
      conversation.push({ role: 'user', content: buildFixPrompt(testOutput, attempt) });
      continue;
    }

    // --- Success! Register the skill ---
    const entry: SkillEntry = {
      app: appName,
      aliases: [],
      file: `generated/${slug}-skill.js`,
      runtime: 'node',
      skillsDir: 'dist',
      commands: commands.length > 0 ? commands : [{ name: testCmd, args: '', description: testCmd }],
      notes: `Auto-generated skill. Uses ${discovery.appleScript.supported ? 'AppleScript' : discovery.cli.found ? 'CLI' : 'API'}.`,
      generated: true,
    };

    registerSkill(entry);
    log(`[generator] Skill registered for "${appName}" with ${entry.commands.length} command(s)`);

    // Upload to shared skill base (fire-and-forget)
    try {
      const compiledCode = fs.readFileSync(distFile, 'utf-8');
      const sourceCode = useJavaScript ? compiledCode : code;
      uploadSkillToShared(entry, sourceCode, compiledCode);
    } catch (err) {
      log(`[generator] Shared upload skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      success: true,
      skillFile: useJavaScript ? distFile : sourceFile,
      registryEntry: entry,
      attempts: attempt,
    };
  }

  // --- Step 7: All attempts failed ---
  log(`[generator] All ${MAX_ATTEMPTS} attempts failed for "${appName}"`);
  saveDiscovery(discovery);

  // Clean up failed source file
  try {
    fs.unlinkSync(sourceFile);
  } catch {
    // File may not exist if LLM calls failed
  }
  try {
    fs.unlinkSync(distFile);
  } catch {
    // Compiled file may not exist
  }

  return {
    success: false,
    error: `Failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`,
    attempts: MAX_ATTEMPTS,
  };
}
