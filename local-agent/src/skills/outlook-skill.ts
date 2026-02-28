#!/usr/bin/env node
/**
 * Outlook Skill — Layer 1 CLI for Microsoft Outlook on macOS.
 *
 * Uses AppleScript (NOT JXA) via osascript to interact with Outlook.
 * JXA crashes when spawned from Electron; AppleScript works because it
 * uses Automation permissions, not Accessibility permissions.
 *
 * Commands:
 *   send-email   --to <addr> --subject <subj> --body <body> [--cc <addr>] [--bcc <addr>]
 *   read-inbox   [--count N] [--unread-only]
 *   search-emails --query <q> [--folder <name>] [--count N]
 *   list-folders
 *
 * All commands return JSON to stdout.
 */

import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// AppleScript helpers
// ---------------------------------------------------------------------------

/** Escape a string for embedding inside AppleScript double-quoted strings. */
function escapeAS(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

/** Convert newlines to Outlook's expected \r for rich-text bodies. */
function bodyToAS(s: string): string {
  return escapeAS(s).replace(/\n/g, '\\r');
}

/** Run an AppleScript string via osascript and return stdout. */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        // Surface AppleScript errors clearly
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Output JSON result to stdout. */
function ok(data: unknown): void {
  console.log(JSON.stringify({ success: true, data }));
}

/** Output JSON error to stdout (not stderr — agent parses stdout). */
function fail(message: string): void {
  console.log(JSON.stringify({ success: false, error: message }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function sendEmail(args: Record<string, string>): Promise<void> {
  const to = args['--to'];
  const subject = args['--subject'];
  const body = args['--body'];
  const cc = args['--cc'] || '';
  const bcc = args['--bcc'] || '';

  if (!to || !subject || !body) {
    fail('send-email requires --to, --subject, and --body');
    return;
  }

  // Build recipient lines
  const toAddrs = to.split(',').map(a => a.trim()).filter(Boolean);
  const ccAddrs = cc ? cc.split(',').map(a => a.trim()).filter(Boolean) : [];
  const bccAddrs = bcc ? bcc.split(',').map(a => a.trim()).filter(Boolean) : [];

  let recipientLines = '';
  for (const addr of toAddrs) {
    recipientLines += `\n        make new to recipient at newMsg with properties {email address:{address:"${escapeAS(addr)}"}}`;
  }
  for (const addr of ccAddrs) {
    recipientLines += `\n        make new cc recipient at newMsg with properties {email address:{address:"${escapeAS(addr)}"}}`;
  }
  for (const addr of bccAddrs) {
    recipientLines += `\n        make new bcc recipient at newMsg with properties {email address:{address:"${escapeAS(addr)}"}}`;
  }

  const script = `
tell application "Microsoft Outlook"
    set newMsg to make new outgoing message with properties {subject:"${escapeAS(subject)}", content:"${bodyToAS(body)}"}${recipientLines}
    send newMsg
end tell
return "sent"`;

  try {
    await runAppleScript(script);
    ok({ message: `Email sent to ${toAddrs.join(', ')}`, subject });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not running') || msg.includes('-600')) {
      fail('Microsoft Outlook is not running. Please open Outlook first.');
    } else {
      fail(`Failed to send email: ${msg}`);
    }
  }
}

async function readInbox(args: Record<string, string>): Promise<void> {
  const count = parseInt(args['--count'] || '10', 10);
  const unreadOnly = args['--unread-only'] === 'true';

  const filterClause = unreadOnly ? ' whose is read is false' : '';

  // AppleScript to read messages and return tab/newline delimited data.
  // We use a delimiter approach because AppleScript list-to-string is fragile.
  const script = `
tell application "Microsoft Outlook"
    set msgs to messages of inbox${filterClause}
    set maxCount to ${count}
    if (count of msgs) < maxCount then set maxCount to (count of msgs)
    set output to ""
    repeat with i from 1 to maxCount
        set m to item i of msgs
        set subj to subject of m
        set sndr to address of sender of m
        set d to time received of m
        set rd to is read of m
        set bd to content of m
        if (length of bd) > 200 then set bd to (text 1 thru 200 of bd)
        set output to output & subj & "\\t" & sndr & "\\t" & (d as string) & "\\t" & rd & "\\t" & bd & "\\n"
    end repeat
    return output
end tell`;

  try {
    const raw = await runAppleScript(script);
    const emails = raw
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [subject, sender, date, read, body_preview] = line.split('\t');
        return {
          subject: subject || '',
          sender: sender || '',
          date: date || '',
          read: read === 'true',
          body_preview: (body_preview || '').replace(/\r/g, '\n'),
        };
      });
    ok(emails);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('not running') || msg.includes('-600')) {
      fail('Microsoft Outlook is not running. Please open Outlook first.');
    } else {
      fail(`Failed to read inbox: ${msg}`);
    }
  }
}

async function searchEmails(args: Record<string, string>): Promise<void> {
  const query = args['--query'];
  const folder = args['--folder'] || 'inbox';
  const count = parseInt(args['--count'] || '10', 10);

  if (!query) {
    fail('search-emails requires --query');
    return;
  }

  const escapedQuery = escapeAS(query).toLowerCase();

  // Search by subject or sender containing the query string.
  // Outlook AppleScript 'whose' filtering is limited, so we fetch and filter.
  const folderRef = folder.toLowerCase() === 'inbox'
    ? 'inbox'
    : `mail folder "${escapeAS(folder)}"`;

  const script = `
tell application "Microsoft Outlook"
    set allMsgs to messages of ${folderRef}
    set maxScan to 200
    if (count of allMsgs) < maxScan then set maxScan to (count of allMsgs)
    set matchCount to 0
    set output to ""
    repeat with i from 1 to maxScan
        if matchCount >= ${count} then exit repeat
        set m to item i of allMsgs
        set subj to subject of m
        set sndr to address of sender of m
        set lowerSubj to do shell script "echo " & quoted form of subj & " | tr '[:upper:]' '[:lower:]'"
        set lowerSndr to do shell script "echo " & quoted form of sndr & " | tr '[:upper:]' '[:lower:]'"
        if lowerSubj contains "${escapedQuery}" or lowerSndr contains "${escapedQuery}" then
            set d to time received of m
            set rd to is read of m
            set bd to content of m
            if (length of bd) > 200 then set bd to (text 1 thru 200 of bd)
            set output to output & subj & "\\t" & sndr & "\\t" & (d as string) & "\\t" & rd & "\\t" & bd & "\\n"
            set matchCount to matchCount + 1
        end if
    end repeat
    return output
end tell`;

  try {
    const raw = await runAppleScript(script);
    const emails = raw
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [subject, sender, date, read, body_preview] = line.split('\t');
        return {
          subject: subject || '',
          sender: sender || '',
          date: date || '',
          read: read === 'true',
          body_preview: (body_preview || '').replace(/\r/g, '\n'),
        };
      });
    ok(emails);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`Failed to search emails: ${msg}`);
  }
}

async function listFolders(_args: Record<string, string>): Promise<void> {
  const script = `
tell application "Microsoft Outlook"
    set accts to exchange accounts & pop accounts & imap accounts
    set output to ""
    repeat with acct in accts
        set fldrs to mail folders of acct
        repeat with f in fldrs
            set output to output & (name of f) & "\\n"
        end repeat
    end repeat
    return output
end tell`;

  try {
    const raw = await runAppleScript(script);
    const folders = raw.split('\n').filter(Boolean);
    ok(folders);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`Failed to list folders: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { command: string; args: Record<string, string> } {
  const command = argv[2] || '';
  const args: Record<string, string> = {};

  let i = 3;
  while (i < argv.length) {
    const key = argv[i];
    if (key.startsWith('--')) {
      // Flag with no value (boolean)
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        args[key] = 'true';
      } else {
        args[key] = argv[i + 1];
        i++;
      }
    }
    i++;
  }

  return { command, args };
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv);

  switch (command) {
    case 'send-email':
      await sendEmail(args);
      break;
    case 'read-inbox':
      await readInbox(args);
      break;
    case 'search-emails':
      await searchEmails(args);
      break;
    case 'list-folders':
      await listFolders(args);
      break;
    default:
      fail(`Unknown command: "${command}". Available: send-email, read-inbox, search-emails, list-folders`);
      break;
  }
}

main().catch(e => {
  fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
