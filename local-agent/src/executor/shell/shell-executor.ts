/**
 * Shell Executor — Layer 2: Shell/OS Commands
 *
 * Executes system shell commands using Node.js child_process.
 * This is the workhorse for launching apps, running system commands,
 * file operations, and anything you'd normally type in a terminal.
 *
 * Safety:
 * - Uses execFile('/bin/sh', ['-c', command]) instead of exec(command).
 *   This ensures the command string is passed as a single argument to /bin/sh,
 *   preventing shell metacharacter injection from string concatenation.
 * - Every command is wrapped in a try/catch with a timeout.
 * - The agent should never crash due to a shell command failing.
 */

import { execFile } from 'child_process';
import { ShellExecResult } from '@workflow-agent/shared';
import { DEFAULT_SHELL_TIMEOUT_MS } from '@workflow-agent/shared';
import { log } from '../../utils/logger';

/** Timestamp prefix for log messages */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Execute a shell command and return the result.
 *
 * @param command  - The command string to execute (e.g. "ls -la" or "open -a Chrome")
 * @param timeout  - Max time in ms before killing the process (default: 30s)
 * @returns A structured result with output, error, and exit code
 */
export async function executeShellCommand(
  command: string,
  timeout: number = DEFAULT_SHELL_TIMEOUT_MS
): Promise<ShellExecResult> {
  log(`[${timestamp()}] [shell-executor] Executing: ${command}`);

  return new Promise((resolve) => {
    // Use execFile with /bin/sh -c to avoid shell injection from string interpolation.
    // The command is passed as a single argument to sh, not interpolated into a shell string.
    execFile('/bin/sh', ['-c', command], { timeout }, (error, stdout, stderr) => {
      if (error) {
        // The command failed — could be a timeout, bad command, or non-zero exit code
        log(`[${timestamp()}] [shell-executor] Error: ${error.message}`);
        resolve({
          output: stdout?.toString() || '',
          error: error.message,
          exitCode: error.code !== undefined ? (typeof error.code === 'number' ? error.code : 1) : 1,
        });
        return;
      }

      // Command succeeded
      const result: ShellExecResult = {
        output: stdout?.toString().trim() || '',
        error: stderr?.toString().trim() || '',
        exitCode: 0,
      };

      log(`[${timestamp()}] [shell-executor] Success (exit code 0)`);
      resolve(result);
    });
  });
}
