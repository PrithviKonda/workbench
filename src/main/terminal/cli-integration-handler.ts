/**
 * Claude Integration Handler
 * Manages Claude-specific operations including profile switching, rate limiting, and OAuth token detection
 */

import * as os from 'os';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { IPC_CHANNELS } from '../../shared/constants';
import { getClaudeProfileManager, initializeClaudeProfileManager } from '../claude-profile-manager';
import { getFullCredentialsFromKeychain, clearKeychainCache, updateProfileSubscriptionMetadata } from '../claude-profile/credential-utils';
import { getEmailFromConfigDir } from '../claude-profile/profile-utils';
import { findStandaloneLimitReset } from '../claude-profile/rate-limit-manager';
import { SELF_IMPROVE_NUDGE_ONE_LINE } from '../self-improve/nudge';
import * as OutputParser from './output-parser';
import * as SessionHandler from './session-handler';
import * as PtyManager from './pty-manager';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { debugLog, debugError } from '../../shared/utils/debug-logger';
import {
  escapeShellArg,
  escapeForWindowsDoubleQuote,
  escapePowerShellArg,
  buildCdCommand
} from '../../shared/utils/shell-escape';
import { getClaudeCliInvocation, getClaudeCliInvocationAsync } from '../cli-utils';
import { isWindows } from '../platform';
import { expandClaudeHome, isClaudeHomeInWsl } from '../platform/claude-home';
import { getWslInfo, isWslRuntime, toHostPath, toRuntimePath } from '../platform/shell-runtime';
import { wrapLineForFish } from './wsl-terminal';
import { readSettingsFileAsync } from '../settings-utils';
import type { SupportedCLI } from '../../shared/types/settings';
import type {
  ShellKind,
  TerminalProcess,
  WindowGetter,
  RateLimitEvent,
  OAuthTokenEvent
} from './types';
import { getClaudeGlobalConfigPath, isDefaultClaudeConfigDir } from '../claude-profile/config-dir-paths';
import { lastAgentSession, readAgentSessions, recordAgentSessionAsync } from '../agent-session-store';
import { findSessionTranscript, latestTranscript } from '../claude-code/session-spending';
import { claudeConfigDirs } from '../claude-profile/profile-config-dirs';
import { appLog } from '../app-logger';
import { claudeThemeFlag } from '../claude-cli-theme';
import { pickEngine } from '../claude-code/env';
import { getBestCodexAccount, defaultCodexHome, isCodexAccountId } from '../claude-profile/codex-accounts';
import { getToolInfoAsync } from '../cli-tool-manager';

/**
 * The `codex` command an agent window types when Codex is the engine: the account's CODEX_HOME
 * (set the shell's way), YOLO mode as Codex's bypass flag, and `codex resume <id>` for a task's
 * Codex session (`'last'`: the directory's latest one, for a restored window)
 */
async function buildCodexWindowCommand(
  terminal: TerminalProcess,
  profileId: string | undefined,
  dangerouslySkipPermissions: boolean | undefined,
  resumeSessionId: string | undefined
): Promise<string> {
  const info = isWslWindow(terminal) ? null : await getToolInfoAsync('codex', { refreshIfMissing: true });
  const kind = shellKindOf(terminal);
  const exe = info?.path ? escapeShellCommand(info.path, kind) : 'codex';
  const quote = (value: string) => (kind === 'powershell' ? escapePowerShellArg(value) : kind === 'cmd' ? `"${escapeForWindowsDoubleQuote(value)}"` : escapeShellArg(value));
  const args = [
    ...(resumeSessionId === 'last' ? ['resume', '--last'] : resumeSessionId ? ['resume', resumeSessionId] : []),
    ...(dangerouslySkipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
    // Projects written for Claude Code keep their instructions in CLAUDE.md
    '-c', quote('project_doc_fallback_filenames=["CLAUDE.md"]'),
  ].join(' ');
  const home = isWslWindow(terminal) ? undefined : getBestCodexAccount({ pinnedId: isCodexAccountId(profileId) ? profileId : undefined })?.configDir;
  if (!home || home === defaultCodexHome()) return `${exe} ${args}`;
  if (kind === 'powershell') return `$env:CODEX_HOME=${quote(home)}; ${exe} ${args}`;
  if (kind === 'cmd') return `set "CODEX_HOME=${home}" && ${exe} ${args}`;
  return `env CODEX_HOME=${quote(home)} ${exe} ${args}`;
}

// ============================================================================
// CLI DISPATCH UTILITIES
// ============================================================================

/**
 * Returns the shell command string for a non-Claude CLI tool.
 *
 * @param cli - The CLI identifier (from SupportedCLI, excluding 'claude-code')
 * @param customPath - Optional absolute path for 'custom' CLI
 * @returns The command string to write to the PTY
 */
function getCLICommand(cli: SupportedCLI, customPath?: string): string {
  if (cli === 'custom' && customPath) return customPath;
  const commands: Record<string, string> = {
    'gemini': 'gemini',
    'opencode': 'opencode',
    'kilocode': 'kilocode',
    'codex': 'codex',
  };
  return commands[cli] ?? cli;
}

// ============================================================================
// AUTH TERMINAL ID PATTERN CONSTANTS
// ============================================================================

/**
 * Regular expression pattern for matching auth terminal IDs.
 * Auth terminals follow the format: claude-login-{profileId}-{timestamp}
 *
 * Profile IDs are generated by generateProfileId() in profile-utils.ts:
 * - 'default' for the default profile
 * - Sanitized profile names: name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
 *   Examples: "Work" -> "work", "My Profile" -> "my-profile"
 *
 * The pattern matches:
 * - 'claude-login-' prefix
 * - Profile ID: lowercase letters, numbers, and hyphens (non-greedy to stop at timestamp)
 * - '-' separator before timestamp
 * - Timestamp: 13+ digit Unix timestamp
 *
 * @see claude-code-handlers.ts where the ID format is generated
 * @see profile-utils.ts generateProfileId() for profile ID format
 */
const AUTH_TERMINAL_ID_PATTERN = /^claude-login-([a-z0-9-]+)-(\d{13,})$/;

/**
 * Extract profile ID from an auth terminal ID.
 *
 * @param terminalId - Terminal ID to parse (e.g., 'claude-login-work-1737298800000')
 * @returns The profile ID (e.g., 'work', 'my-profile', 'default'), or null if not an auth terminal
 *
 * @example
 * extractProfileIdFromAuthTerminalId('claude-login-default-1737298800000') // 'default'
 * extractProfileIdFromAuthTerminalId('claude-login-work-1737298800000') // 'work'
 * extractProfileIdFromAuthTerminalId('claude-login-my-profile-1737298800000') // 'my-profile'
 * extractProfileIdFromAuthTerminalId('regular-terminal-1') // null
 */
function extractProfileIdFromAuthTerminalId(terminalId: string): string | null {
  const match = terminalId.match(AUTH_TERMINAL_ID_PATTERN);
  return match ? match[1] : null;
}

/**
 * Mask email address for logging to prevent PII exposure.
 *
 * @param email - Email address to mask
 * @returns Masked email (e.g., 'user@example.com' -> 'u***@e***.com')
 *
 * @example
 * maskEmail('john.doe@example.com') // 'j***@e***.com'
 * maskEmail('a@b.co') // 'a***@b***.co'
 * maskEmail('') // ''
 */
function maskEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string') {
    return '';
  }

  const atIndex = email.indexOf('@');
  if (atIndex === -1) {
    // Not a valid email format, mask most of it
    return email.charAt(0) + '***';
  }

  const localPart = email.substring(0, atIndex);
  const domainPart = email.substring(atIndex + 1);

  // Mask local part (keep first char)
  const maskedLocal = localPart.charAt(0) + '***';

  // Mask domain part (keep first char and TLD)
  const domainDotIndex = domainPart.indexOf('.');
  if (domainDotIndex === -1) {
    // No TLD, just mask after first char
    const maskedDomain = domainPart.charAt(0) + '***';
    return `${maskedLocal}@${maskedDomain}`;
  }

  const domainName = domainPart.substring(0, domainDotIndex);
  const tld = domainPart.substring(domainDotIndex); // includes the dot
  const maskedDomain = domainName.charAt(0) + '***' + tld;

  return `${maskedLocal}@${maskedDomain}`;
}

function normalizePathForBash(envPath: string): string {
  return isWindows() ? envPath.replace(/;/g, ':') : envPath;
}

/**
 * The shell agent windows start on this platform: PowerShell on Windows, POSIX elsewhere and in
 * the WSL runtime
 */
function platformShellKind(): ShellKind {
  return isWindows() && !isWslRuntime() ? 'powershell' : 'posix';
}

/**
 * The syntax a window's shell takes: the kind recorded when its shell started, else the
 * platform's default agent window shell
 */
function shellKindOf(terminal: Pick<TerminalProcess, 'shellKind'>): ShellKind {
  return terminal.shellKind ?? platformShellKind();
}

/**
 * Determine whether a command already resolves via an absolute executable path.
 *
 * When true, we should avoid prefixing PATH=... into the typed shell command because:
 * 1) PATH is not needed to locate the executable
 * 2) very long PATH prefixes create huge echoed command lines that can stress terminal rendering
 */
function isAbsoluteExecutableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return path.isAbsolute(trimmed);
}

/**
 * Generate temp file content for OAuth token based on the shell
 *
 * For cmd.exe, creates a .bat file with set command using double-quote syntax; for PowerShell,
 * a plain file holding just the token, which the typed command reads with Get-Content (running a
 * .ps1 would depend on the machine's execution policy, which blocks scripts by default on Windows
 * PowerShell 5.1); for POSIX shells, a shell script with export.
 *
 * @param token - OAuth token value
 * @param shellKind - The window's shell kind
 * @returns Content string for the temp file
 */
function generateTokenTempFileContent(token: string, shellKind: ShellKind): string {
  if (shellKind === 'powershell') {
    return token.replace(/[\r\n]/g, '');
  }
  if (shellKind === 'cmd') {
    // Windows: Use double-quote syntax for set command to handle special characters
    // Format: set "VARNAME=value" - quotes allow spaces and special chars in value
    // For values inside double quotes, use escapeForWindowsDoubleQuote() because
    // caret is literal inside double quotes in cmd.exe (only " needs escaping).
    const escapedToken = escapeForWindowsDoubleQuote(token);
    return `@echo off\r\nset "CLAUDE_CODE_OAUTH_TOKEN=${escapedToken}"\r\n`;
  }
  // Unix/macOS: Use export with single-quoted value
  return `export CLAUDE_CODE_OAUTH_TOKEN=${escapeShellArg(token)}\n`;
}

/**
 * Get the file extension for temp files based on the shell
 *
 * @returns File extension including the dot ('.bat' for cmd.exe, '' for PowerShell and POSIX shells)
 */
function getTempFileExtension(shellKind: ShellKind): string {
  return shellKind === 'cmd' ? '.bat' : '';
}

/**
 * Build PATH environment variable prefix for Claude CLI invocation.
 *
 * For cmd.exe, `set "PATH=..." && `; for PowerShell, `$env:PATH = '...'; ` (both keep the
 * semicolon separators). For POSIX shells, uses colon separators and bash escaping.
 *
 * @param pathEnv - PATH environment variable value
 * @param shellKind - The window's shell kind
 * @returns Empty string if no PATH, otherwise the shell's PATH prefix
 */
function buildPathPrefix(pathEnv: string, shellKind: ShellKind): string {
  if (!pathEnv) {
    return '';
  }

  if (shellKind === 'powershell') {
    return `$env:PATH = ${escapePowerShellArg(pathEnv)}; `;
  }

  if (shellKind === 'cmd') {
    // Windows: Use semicolon-separated PATH with double-quote escaping
    // Format: set "PATH=value" where value uses semicolons
    // For values inside double quotes, use escapeForWindowsDoubleQuote() because
    // caret is literal inside double quotes in cmd.exe (only " needs escaping).
    const escapedPath = escapeForWindowsDoubleQuote(pathEnv);
    return `set "PATH=${escapedPath}" && `;
  }

  // Unix/macOS: Use colon-separated PATH with bash escaping
  // Format: PATH='value' where value uses colons
  const normalizedPath = normalizePathForBash(pathEnv);
  return `PATH=${escapeShellArg(normalizedPath)} `;
}

/**
 * Escape a command for safe use in shell commands.
 *
 * For cmd.exe, wraps in double quotes. Since the value is inside
 * double quotes, we use escapeForWindowsDoubleQuote() (only escapes embedded
 * double quotes as ""). Caret escaping is NOT used inside double quotes.
 * For PowerShell, a single-quoted string after the call operator (`& 'C:\path\claude.cmd'`):
 * a quoted string alone would only be echoed back, not run.
 * For POSIX shells, wraps in single quotes for bash.
 *
 * @param cmd - The command to escape
 * @param shellKind - The window's shell kind
 * @returns The escaped command safe for use in shell commands
 */
function escapeShellCommand(cmd: string, shellKind: ShellKind): string {
  if (shellKind === 'powershell') {
    return `& ${escapePowerShellArg(cmd)}`;
  }
  if (shellKind === 'cmd') {
    // Windows: Wrap in double quotes and escape only embedded double quotes
    // Inside double quotes, caret is literal, so use escapeForWindowsDoubleQuote()
    const escapedCmd = escapeForWindowsDoubleQuote(cmd);
    return `"${escapedCmd}"`;
  }
  // Unix/macOS: Wrap in single quotes for bash
  return escapeShellArg(cmd);
}

/**
 * Whether a window runs inside WSL: the app runs its tools there (shell-runtime.ts) and the
 * window's shell is the distribution's (POSIX syntax)
 */
function isWslWindow(terminal: Pick<TerminalProcess, 'shellKind'>): boolean {
  return isWindows() && isWslRuntime() && shellKindOf(terminal) === 'posix';
}

/** A host path as the window's shell sees it: the Linux path in a WSL window, unchanged otherwise */
function windowPath(terminal: Pick<TerminalProcess, 'shellKind'>, hostPath: string): string;
function windowPath(terminal: Pick<TerminalProcess, 'shellKind'>, hostPath: string | undefined): string | undefined;
function windowPath(terminal: Pick<TerminalProcess, 'shellKind'>, hostPath: string | undefined): string | undefined {
  return hostPath && isWslWindow(terminal) ? toRuntimePath(hostPath) : hostPath;
}

/** A Claude config dir as the window's shell sees it (`~` resolved against Claude Code's home in WSL) */
function windowConfigDir(terminal: Pick<TerminalProcess, 'shellKind'>, configDir: string): string {
  return isWslWindow(terminal) ? toRuntimePath(expandClaudeHome(configDir)) : configDir;
}

/** Variable that makes Claude Code bill an API key instead of the window's sign-in */
const WSL_UNSET_API_KEY = 'env -u ANTHROPIC_API_KEY ';

/**
 * The `claude` command and the PATH prefix typed into a window.
 *
 * In a WSL window: the distribution's own claude (cli-tool-manager answers with its Linux path in
 * the WSL runtime), no PATH prefix (the app's PATH is Windows'; the login shell has its own), and
 * `env -u ANTHROPIC_API_KEY` first. Agent windows run on the account's sign-in: natively the key
 * is removed from the window's environment, while in WSL the user's rc files can export one.
 */
function windowClaudeCommand(
  terminal: Pick<TerminalProcess, 'shellKind'>,
  claudeCmd: string,
  claudeEnv: Record<string, string>
): { escapedClaudeCmd: string; pathPrefix: string } {
  const shellKind = shellKindOf(terminal);
  const escapedClaudeCmd = escapeShellCommand(claudeCmd, shellKind);
  if (isWslWindow(terminal)) {
    return { escapedClaudeCmd: `${WSL_UNSET_API_KEY}${escapedClaudeCmd}`, pathPrefix: '' };
  }
  const pathPrefix = isAbsoluteExecutableCommand(claudeCmd) ? '' : buildPathPrefix(claudeEnv.PATH || '', shellKind);
  return { escapedClaudeCmd, pathPrefix };
}

/**
 * Where the temp token file goes. In a WSL window it is written into the Linux home through its
 * UNC path: files the app writes there get mode 644 under the home's own permissions (750 on
 * Ubuntu), while a file in the Windows temp dir shows up as 777 under /mnt/c for every Linux user,
 * and chmod can't change that on a Windows drive. The typed command removes it before Claude
 * starts, as natively. Natively, the OS temp dir.
 */
function tokenTempDir(terminal: Pick<TerminalProcess, 'shellKind'>): string {
  const info = isWslWindow(terminal) ? getWslInfo() : null;
  return info?.home ? toHostPath(info.home) : os.tmpdir();
}

/**
 * Escape text for the inside of a POSIX double-quoted string (`bash -c "..."`): the outer shell
 * expands `$`, backticks and `\` there even inside the single quotes the inner command uses, so
 * e.g. the self-improve text's `type: feedback` would run as a command substitution.
 */
function escapeForPosixDoubleQuote(text: string): string {
  return text.replace(/[\\$`"]/g, (char) => `\\${char}`);
}

/**
 * Flag for YOLO mode (skip all permission prompts)
 * Extracted as constant to ensure consistency across invokeClaude and invokeCLIAsync
 */
const YOLO_MODE_FLAG = ' --dangerously-skip-permissions';

/**
 * Printed by the shell right after a CLI the app launched in a window exits: an OSC sequence that
 * xterm ignores. TerminalManager closes the window when it sees it (unless the app itself is
 * restarting the CLI, e.g. for an account switch). The typed command shows it as the literal text
 * "\\033...", so only the real output matches.
 */
export const CLI_EXIT_MARKER = '\x1b]777;workbench-cli-exit\x07';

/**
 * Whether this output finishes a CLI exit marker that should close the window. The marker can be
 * split across output chunks; an exit the app caused itself (cliRestarting) is consumed instead.
 */
export function shouldCloseOnCliExit(
  terminal: Pick<TerminalProcess, 'cliRestarting' | 'cliExitTail'>,
  data: string
): boolean {
  const text = (terminal.cliExitTail ?? '') + data;
  if (!text.includes(CLI_EXIT_MARKER)) {
    terminal.cliExitTail = text.slice(-(CLI_EXIT_MARKER.length - 1));
    return false;
  }
  terminal.cliExitTail = '';
  if (terminal.cliRestarting) {
    terminal.cliRestarting = false;
    return false;
  }
  return true;
}

/**
 * What the shell runs after the CLI to print CLI_EXIT_MARKER, chained with ';' so it runs whatever
 * the CLI's exit code. POSIX shells (bash, zsh, fish) use printf; PowerShell (7 and 5.1) writes
 * the escape characters it builds with [char], so the typed line itself never holds them. cmd.exe
 * cannot print it, so a cmd.exe window stays open when the CLI exits. A failed
 * `Set-Location -ErrorAction Stop` earlier in a PowerShell line ends the line before the marker,
 * which leaves the window open with the error on screen.
 */
function cliExitMarkerSuffix(shellKind: ShellKind): string {
  switch (shellKind) {
    case 'posix':
      return `; printf '\\033]777;workbench-cli-exit\\007'`;
    case 'powershell':
      return `; [Console]::Write("$([char]27)]777;workbench-cli-exit$([char]7)")`;
    default:
      return '';
  }
}

/**
 * The line typed into the window's shell to launch a CLI: the command, then printing
 * CLI_EXIT_MARKER once the CLI exits (see cliExitMarkerSuffix). A WSL window whose login shell is
 * fish runs the whole POSIX line through `bash -c` (see wsl-terminal.ts).
 */
export function buildCliLine(terminal: Pick<TerminalProcess, 'shellKind' | 'wrapInBash'>, command: string): string {
  const line = `${command.endsWith('\r') ? command.slice(0, -1) : command}${cliExitMarkerSuffix(shellKindOf(terminal))}`;
  return `${terminal.wrapInBash && shellKindOf(terminal) === 'posix' ? wrapLineForFish(line) : line}\r`;
}

/** Type a CLI launch command into the window's shell (see buildCliLine) */
function writeCliCommand(terminal: TerminalProcess, command: string): void {
  PtyManager.writeToPty(terminal, buildCliLine(terminal, command));
}

/**
 * Claude Code flag that tells it where the project's memory graph is, when the terminal's project
 * has one: Graphify's /graphify skill looks for graphify-out in the working directory, while the
 * graph lives in .workbench/knowledge (the terminal's GRAPHIFY_OUT points there). Left out when the
 * path has characters that would need escaping inside the shell command.
 */
function graphifyHintFlag(terminal: Pick<TerminalProcess, 'graphifyOut' | 'shellKind'>): string {
  // In a WSL window, the path inside WSL
  const out = windowPath(terminal, terminal.graphifyOut);
  const shellKind = shellKindOf(terminal);
  const posix = shellKind === 'posix';
  if (!out || /["'$`%!]/.test(out) || (posix && out.includes('\\'))) return '';
  const graph = posix ? path.posix.join(out, 'graph.json') : path.join(out, 'graph.json');
  const text =
    `The Graphify knowledge graph of this project is in ${out} (GRAPHIFY_OUT points there), not in graphify-out ` +
    `under the working directory. For /graphify questions about the code, run graphify query, explain, path or ` +
    `affected with --graph ${graph}, and do not rebuild the graph.`;
  return ` --append-system-prompt ${quoteFlagText(text, shellKind)}`;
}

/**
 * Quote the text of a flag for the window's shell: single quotes for POSIX shells and PowerShell
 * (where nothing inside expands), double quotes for cmd.exe. The texts passed here hold no
 * characters those quotes would need to escape.
 */
function quoteFlagText(text: string, shellKind: ShellKind): string {
  if (shellKind === 'powershell') return escapePowerShellArg(text);
  return shellKind === 'posix' ? `'${text}'` : `"${text}"`;
}

/**
 * Claude Code flag telling an agent window's session to save what it learns about the project, when
 * the project's self-improve switch is on. The project's own `.claude/MEMORY.md` carries the same
 * text for sessions started outside the app; this covers the window Workbench launches.
 */
function selfImproveFlag(terminal: Pick<TerminalProcess, 'selfImprove' | 'shellKind'>): string {
  if (!terminal.selfImprove) return '';
  return ` --append-system-prompt ${quoteFlagText(SELF_IMPROVE_NUDGE_ONE_LINE, shellKindOf(terminal))}`;
}

/**
 * Options for launching Claude Code on a specific session (an agent window resuming a task)
 */
export interface InvokeCLIOptions {
  /** Resume this Claude Code session (`claude --resume <id>`) instead of starting a new one */
  resumeSessionId?: string;
  /**
   * Claude config dir that holds the session transcript. When set, Claude Code runs with this
   * CLAUDE_CONFIG_DIR even if the terminal (or its active profile) uses another one.
   */
  configDir?: string;
  /** The CLI to run ("New agent" menu); absent: a Codex profile or the Settings > Agents engine decides */
  engine?: 'claude' | 'codex';
}

/** Session ids are UUIDs; anything else is refused so it never reaches the shell unescaped */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Whether a Claude Code session id is safe to pass on the command line */
export function isValidClaudeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Flags that resume a Claude Code session (` --resume <id>`).
 * Throws for ids that are not plain session ids.
 */
export function buildResumeSessionFlag(sessionId: string): string {
  if (!isValidClaudeSessionId(sessionId)) {
    throw new Error(`Invalid Claude Code session id: ${sessionId}`);
  }
  return ` --resume ${sessionId}`;
}

/**
 * Flags that start a new session under an id Workbench picked (` --session-id <uuid>`), so what
 * the window spends can be read back from that session's transcript. Throws for ids that are not
 * plain session ids.
 */
export function buildNewSessionFlag(sessionId: string): string {
  if (!isValidClaudeSessionId(sessionId)) {
    throw new Error(`Invalid Claude Code session id: ${sessionId}`);
  }
  return ` --session-id ${sessionId}`;
}

/**
 * Keep the session an agent window is starting, so Settings > Accounts > Metrics can read what the
 * window spent from Claude Code's transcript: a window runs Claude Code itself, so its cost
 * reaches no task's run file. Windows without a project have nowhere to keep it.
 */
function trackAgentWindowSession(
  terminal: Pick<TerminalProcess, 'id' | 'projectPath' | 'cwd'>,
  sessionId: string,
  configDir: string | undefined,
  cwd: string | undefined
): void {
  if (!terminal.projectPath) return;
  recordAgentSessionAsync(terminal.projectPath, {
    sessionId,
    configDir: resolveSessionConfigDir(configDir),
    // Claude Code names the transcript's folder after the directory it runs in
    cwd: cwd || terminal.cwd,
    terminalId: terminal.id,
    startedAt: new Date().toISOString(),
  });
}

/**
 * How a restored window picks Claude Code up again, and what that costs the project.
 *
 * Its own last session comes first, by id, so a window always continues its own conversation
 * rather than whatever session in the directory was written to last. When it has none - the window
 * was there before Workbench recorded sessions, or its session's transcript is gone - it picks up
 * the session `claude --continue` would have picked, the directory's newest, and records it as the
 * window's own. From then on that conversation's spending reaches Metrics, including what it had
 * already spent on earlier days.
 */
async function resumeOwnSessionFlag(
  terminal: Pick<TerminalProcess, 'id' | 'projectPath' | 'cwd'>
): Promise<string> {
  if (!terminal.projectPath) return ' --continue';
  try {
    const own = await lastAgentSession(terminal.projectPath, terminal.id);
    if (own) {
      // Claude Code names the transcript's folder after the directory as it sees it (in WSL, the
      // Linux path; the translation leaves a path that is already one unchanged)
      const transcript = await findSessionTranscript(
        own.sessionId,
        claudeConfigDirs([own.configDir]),
        own.cwd ? toRuntimePath(own.cwd) : own.cwd
      );
      if (transcript) return buildResumeSessionFlag(own.sessionId);
    }

    // The window has no session of its own: adopt the one it would have continued anyway,
    // leaving the conversations the project's other windows are in to those windows
    const taken = new Set(
      (await readAgentSessions(terminal.projectPath))
        .filter((session) => session.terminalId && session.terminalId !== terminal.id)
        .map((session) => session.sessionId)
    );
    const cwd = terminal.projectPath || terminal.cwd;
    const latest = await latestTranscript(claudeConfigDirs([own?.configDir]), toRuntimePath(cwd), taken);
    if (!latest || !isValidClaudeSessionId(latest.sessionId)) return ' --continue';
    trackAgentWindowSession(terminal, latest.sessionId, latest.configDir, cwd);
    return buildResumeSessionFlag(latest.sessionId);
  } catch (error) {
    appLog.warn('[ClaudeIntegration] Could not look up the window\'s own session:', error);
    return ' --continue';
  }
}

/**
 * Extra flags for an agent window's `claude` command: the session it resumes or the id its new
 * session gets, YOLO mode, the Graphify hint and the theme matching the app's
 */
function buildClaudeExtraFlags(
  terminal: Pick<TerminalProcess, 'graphifyOut' | 'selfImprove' | 'shellKind'>,
  dangerouslySkipPermissions: boolean | undefined,
  resumeSessionId?: string,
  newSessionId?: string
): string | undefined {
  const flags =
    `${resumeSessionId ? buildResumeSessionFlag(resumeSessionId) : ''}` +
    `${!resumeSessionId && newSessionId ? buildNewSessionFlag(newSessionId) : ''}` +
    `${dangerouslySkipPermissions ? YOLO_MODE_FLAG : ''}${graphifyHintFlag(terminal)}` +
    `${selfImproveFlag(terminal)}${claudeThemeFlag(shellKindOf(terminal))}`;
  return flags || undefined;
}

/**
 * The CLAUDE_CONFIG_DIR to force for a resumed session, or undefined to keep the terminal's
 * environment. `~` is expanded; the default ~/.claude needs no override (Claude Code uses it
 * when CLAUDE_CONFIG_DIR is unset, and setting it would move its .claude.json).
 */
export function resolveSessionConfigDir(configDir: string | undefined): string | undefined {
  if (!configDir) return undefined;
  // `~` is Claude Code's home: the Linux home (as a UNC path) when the app runs its tools in WSL
  const expanded = expandClaudeHome(configDir);
  if (isDefaultClaudeConfigDir(expanded)) return undefined;
  return (isClaudeHomeInWsl() ? path.win32 : path).resolve(expanded);
}

// ============================================================================
// SHARED HELPERS - Used by both sync and async invokeClaude
// ============================================================================

/**
 * Configuration for building Claude shell commands using discriminated union.
 * This provides type safety by ensuring the correct options are provided for each method.
 *
 * Note: Paths are NOT escaped - buildClaudeShellCommand handles platform-specific escaping.
 */
type ClaudeCommandConfig =
  | { method: 'default' }
  | { method: 'temp-file'; tempFile: string }
  | { method: 'config-dir'; configDir: string };

/**
 * Build the shell command for invoking Claude CLI.
 *
 * Generates the appropriate command string based on the invocation method:
 * - 'default': Simple command execution
 * - 'temp-file': Sources OAuth token from temp file, then removes it
 * - 'config-dir': Sets CLAUDE_CONFIG_DIR for custom profile location
 *
 * All non-default methods include history-safe prefixes (HISTFILE=, HISTCONTROL=)
 * to prevent sensitive data from appearing in shell history (Unix/macOS only).
 *
 * For cmd.exe, the temp file method uses a batch file approach with inline environment setup.
 *
 * For PowerShell (7 and Windows PowerShell 5.1, which has no '&&'), statements are chained with
 * ';': `Clear-Host`, `$env:NAME = '...'` for the variables, the token read from its plain temp
 * file with Get-Content and the file removed before Claude starts. Commands whose failure must stop
 * the line (changing directory, reading the token) use -ErrorAction Stop, which ends the whole
 * typed line the way '&&' would. Variables set this way stay in the window's shell, as cmd.exe's
 * `set` does.
 *
 * @param cwdCommand - Command to change directory (empty string if no change needed)
 * @param pathPrefix - PATH prefix for Claude CLI (empty string if not needed)
 * @param escapedClaudeCmd - Shell-escaped Claude CLI command
 * @param config - Configuration object with method and required options (discriminated union)
 * @param extraFlags - Optional extra flags to append to the command (e.g., '--dangerously-skip-permissions')
 * @param shellKind - The window's shell kind (the platform's default agent window shell when not given)
 * @returns Complete shell command string ready for terminal.pty.write()
 *
 * @example
 * // Default method (Unix/macOS)
 * buildClaudeShellCommand('cd /path && ', 'PATH=/bin ', 'claude', { method: 'default' });
 * // Returns: 'cd /path && PATH=/bin claude\r'
 *
 * // Temp file method (Unix/macOS)
 * buildClaudeShellCommand('', '', 'claude', { method: 'temp-file', tempFile: '/tmp/token' });
 * // Returns: 'clear && HISTFILE= HISTCONTROL=ignorespace bash -c "source /tmp/token && rm -f /tmp/token && exec claude"\r'
 *
 * // Temp file method (cmd.exe)
 * buildClaudeShellCommand('', '', '"claude.cmd"', { method: 'temp-file', tempFile: 'C:\\Users\\...\\token.bat' }, undefined, 'cmd');
 * // Returns: 'cls && call "C:\\Users\\...\\token.bat" && del "C:\\Users\\...\\token.bat" && "claude.cmd"\r'
 *
 * // Config dir method (PowerShell)
 * buildClaudeShellCommand('', '', "& 'claude'", { method: 'config-dir', configDir: 'C:\\cfg' }, undefined, 'powershell');
 * // Returns: "Clear-Host; $env:CLAUDE_CONFIG_DIR = 'C:\\cfg'; & 'claude'\r"
 */
export function buildClaudeShellCommand(
  cwdCommand: string,
  pathPrefix: string,
  escapedClaudeCmd: string,
  config: ClaudeCommandConfig,
  extraFlags?: string,
  shellKind: ShellKind = platformShellKind()
): string {
  const fullCmd = extraFlags ? `${escapedClaudeCmd}${extraFlags}` : escapedClaudeCmd;
  const isWin = shellKind === 'cmd';

  if (shellKind === 'powershell') {
    switch (config.method) {
      case 'temp-file': {
        // The token is read into the window's environment and the file removed before Claude
        // starts, like the cmd.exe flow's call + del. A token file that can't be read ends the
        // line; one that can't be removed doesn't keep Claude from starting.
        const tempFile = escapePowerShellArg(config.tempFile);
        return (
          `Clear-Host; ${cwdCommand}${pathPrefix}` +
          `$env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content -LiteralPath ${tempFile} -Raw -ErrorAction Stop).Trim(); ` +
          `Remove-Item -LiteralPath ${tempFile} -Force -ErrorAction SilentlyContinue; ${fullCmd}\r`
        );
      }
      case 'config-dir':
        return `Clear-Host; ${cwdCommand}$env:CLAUDE_CONFIG_DIR = ${escapePowerShellArg(config.configDir)}; ${pathPrefix}${fullCmd}\r`;
      default:
        return `${cwdCommand}${pathPrefix}${fullCmd}\r`;
    }
  }

  switch (config.method) {
    case 'temp-file':
      if (isWin) {
        // Windows: Use batch file approach with 'call' command
        // The temp file on Windows is a .bat file that sets CLAUDE_CODE_OAUTH_TOKEN
        // We use 'cls' instead of 'clear', and 'call' to execute the batch file
        //
        // SECURITY: Environment variables set via 'call' persist in memory
        // after the batch file is deleted, so we can safely delete the file
        // immediately after sourcing it (before running Claude).
        //
        // For paths inside double quotes (call "..." and del "..."), use
        // escapeForWindowsDoubleQuote() instead of escapeShellArgWindows()
        // because caret is literal inside double quotes in cmd.exe.
        const escapedTempFile = escapeForWindowsDoubleQuote(config.tempFile);
        return `cls && ${cwdCommand}${pathPrefix}call "${escapedTempFile}" && del "${escapedTempFile}" && ${fullCmd}\r`;
      } else {
        // Unix/macOS: Use bash with source command and history-safe prefixes
        const escapedTempFile = escapeShellArg(config.tempFile);
        return `clear && ${cwdCommand}HISTFILE= HISTCONTROL=ignorespace ${pathPrefix}bash -c "${escapeForPosixDoubleQuote(`source ${escapedTempFile} && rm -f ${escapedTempFile} && exec ${fullCmd}`)}"\r`;
      }

    case 'config-dir':
      if (isWin) {
        // Windows: Set environment variable using double-quote syntax
        // For values inside double quotes (set "VAR=value"), use
        // escapeForWindowsDoubleQuote() because caret is literal inside
        // double quotes in cmd.exe (only double quotes need escaping).
        const escapedConfigDir = escapeForWindowsDoubleQuote(config.configDir);
        return `cls && ${cwdCommand}set "CLAUDE_CONFIG_DIR=${escapedConfigDir}" && ${pathPrefix}${fullCmd}\r`;
      } else {
        // Unix/macOS: Use bash with config dir and history-safe prefixes
        const escapedConfigDir = escapeShellArg(config.configDir);
        return `clear && ${cwdCommand}HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR=${escapedConfigDir} ${pathPrefix}bash -c "${escapeForPosixDoubleQuote(`exec ${fullCmd}`)}"\r`;
      }

    default:
      return `${cwdCommand}${pathPrefix}${fullCmd}\r`;
  }
}

/**
 * Profile information for terminal title generation
 */
interface ProfileInfo {
  /** Profile name for display */
  name?: string;
  /** Whether this is the default profile */
  isDefault?: boolean;
}

/**
 * Check if a terminal should be auto-renamed when Claude is invoked.
 * Returns false if:
 * - Terminal already has a Claude-related title (already renamed)
 * - Terminal has a user-customized name (not "Terminal X" pattern)
 *
 * This prevents aggressive renaming on every Claude invocation and
 * preserves user-customized terminal names.
 */
export function shouldAutoRenameTerminal(currentTitle: string): boolean {
  // Already has Claude title - don't rename again
  if (currentTitle === 'Claude' || currentTitle.startsWith('Claude (')) {
    return false;
  }

  // Check if it's a default terminal name (Terminal 1, Terminal 2, etc.)
  // Only these can be auto-renamed on first Claude invocation
  const defaultNamePattern = /^Terminal \d+$/;
  return defaultNamePattern.test(currentTitle);
}

/**
 * Callback type for session capture
 */

/**
 * Finalize terminal state after invoking Claude.
 *
 * Updates terminal title, sends IPC notification to renderer and persists the session.
 * This consolidates the post-invocation logic used by both sync and async invoke methods.
 *
 * @param terminal - The terminal process to update
 * @param activeProfile - The profile being used (or undefined for default)
 * @param getWindow - Function to get the BrowserWindow
 *
 * @example
 * finalizeClaudeInvoke(
 *   terminal,
 *   { name: 'Work', isDefault: false },
 *   () => mainWindow
 * );
 */
export function finalizeClaudeInvoke(
  terminal: TerminalProcess,
  activeProfile: ProfileInfo | undefined,
  getWindow: WindowGetter
): void {
  // Only auto-rename if terminal has default name (first Claude invocation)
  // This preserves user-customized names and prevents renaming on every invocation
  if (shouldAutoRenameTerminal(terminal.title)) {
    const title = activeProfile && !activeProfile.isDefault
      ? `Claude (${activeProfile.name})`
      : 'Claude';
    terminal.title = title;

    // Notify renderer of title change (use safeSendToRenderer to prevent SIGABRT on disposed frame)
    safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, title);
  }

  // Persist session if project path is available
  if (terminal.projectPath) {
    SessionHandler.persistSession(terminal);
  }
}

/**
 * Handle rate limit detection and profile switching
 */
export function handleRateLimit(
  terminal: TerminalProcess,
  data: string,
  lastNotifiedRateLimitReset: Map<string, string>,
  getWindow: WindowGetter,
  switchProfileCallback: (terminalId: string, profileId: string) => Promise<void>
): void {
  if (!OutputParser.extractRateLimitReset(data)) {
    return;
  }
  // Only a limit message on its own line counts. Terminals also show source code, diffs and
  // chats that quote one (e.g. `"Limit reached · resets Dec 17 at 6am (Europe/Oslo)"`), which
  // used to flag a working account as rate limited for months.
  const resetTime = findStandaloneLimitReset(data);
  if (!resetTime) {
    return;
  }

  const lastNotifiedReset = lastNotifiedRateLimitReset.get(terminal.id);
  if (resetTime === lastNotifiedReset) {
    return;
  }

  lastNotifiedRateLimitReset.set(terminal.id, resetTime);
  console.warn('[ClaudeIntegration] Rate limit detected, reset:', resetTime);

  const profileManager = getClaudeProfileManager();
  const currentProfileId = terminal.claudeProfileId || 'default';

  try {
    const rateLimitEvent = profileManager.recordRateLimitEvent(currentProfileId, resetTime);
    if (!rateLimitEvent) {
      // Not a real Claude reset time (see recordRateLimitEvent)
      return;
    }
    console.warn('[ClaudeIntegration] Recorded rate limit event:', rateLimitEvent.type);
  } catch (err) {
    console.error('[ClaudeIntegration] Failed to record rate limit event:', err);
  }

  const autoSwitchSettings = profileManager.getAutoSwitchSettings();
  const bestProfile = profileManager.getBestAvailableProfile(currentProfileId);

  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_RATE_LIMIT, {
    terminalId: terminal.id,
    resetTime,
    detectedAt: new Date().toISOString(),
    profileId: currentProfileId,
    suggestedProfileId: bestProfile?.id,
    suggestedProfileName: bestProfile?.name,
    autoSwitchEnabled: autoSwitchSettings.autoSwitchOnRateLimit
  } as RateLimitEvent);

  if (autoSwitchSettings.enabled && autoSwitchSettings.autoSwitchOnRateLimit && bestProfile) {
    console.warn('[ClaudeIntegration] Auto-switching to profile:', bestProfile.name);
    switchProfileCallback(terminal.id, bestProfile.id).then(_result => {
      console.warn('[ClaudeIntegration] Auto-switch completed');
    }).catch(err => {
      console.error('[ClaudeIntegration] Auto-switch failed:', err);
    });
  }
}

/**
 * Handle OAuth token detection and auto-save
 * Also handles "Login successful" detection for claude /login flow
 */
export function handleOAuthToken(
  terminal: TerminalProcess,
  data: string,
  getWindow: WindowGetter
): void {
  // Extract profile ID from auth terminal ID pattern (if this is an auth terminal)
  const profileId = extractProfileIdFromAuthTerminalId(terminal.id);

  // First check for "Login successful" message (claude /login flow)
  // This is the primary detection method since tokens aren't displayed in output
  if (OutputParser.hasLoginSuccess(data) && profileId) {
    console.warn('[ClaudeIntegration] Login success detected for profile:', profileId);

    const emailFromOutput = OutputParser.extractEmail(terminal.outputBuffer);
    const profileManager = getClaudeProfileManager();
    const profile = profileManager.getProfile(profileId);

    if (!profile) {
      console.error('[ClaudeIntegration] Profile not found for login success:', profileId);
      return;
    }

    // Clear Keychain cache to get fresh credentials
    clearKeychainCache(profile.configDir);

    // Extract full credentials from Keychain including subscriptionType and rateLimitTier
    const keychainCreds = getFullCredentialsFromKeychain(profile.configDir);

    // Check if there was a keychain access error (not just "not found")
    if (keychainCreds.error) {
      console.error('[ClaudeIntegration] Keychain access error:', keychainCreds.error);
      // Don't retry on keychain failures - they won't resolve with retries
      return;
    }

    if (keychainCreds.token) {
      // NOTE: We intentionally do NOT store the OAuth token in the profile.
      // Storing causes Workbench to use a stale cached token instead of letting
      // Claude CLI read fresh tokens from Keychain (which auto-refreshes).
      // See: docs/LONG_LIVED_AUTH_PLAN.md for full context.

      // Get email from multiple sources, preferring config file as the authoritative source
      // Terminal output parsing can be corrupted by ANSI escape codes
      let email = emailFromOutput || keychainCreds.email;

      // Fallback/validation: Read from Claude's config file (authoritative source)
      const configEmail = getEmailFromConfigDir(profile.configDir);
      if (configEmail) {
        if (!email) {
          console.warn('[ClaudeIntegration] Email not found in output/keychain, using config file:', maskEmail(configEmail));
          email = configEmail;
        } else if (configEmail !== email) {
          // Config file email is different (terminal extraction might be corrupt)
          console.warn('[ClaudeIntegration] Email from output differs from config file, using config file:', {
            outputEmail: maskEmail(email),
            configEmail: maskEmail(configEmail)
          });
          email = configEmail;
        }
      }

      if (email) {
        profile.email = email;
      }
      // Update subscription metadata from Keychain credentials
      updateProfileSubscriptionMetadata(profile, keychainCreds);
      profile.isAuthenticated = true;
      profileManager.saveProfile(profile);

      console.warn('[ClaudeIntegration] Profile credentials verified via Keychain (not caching token):', profileId);

      // Mark onboarding complete so future `claude` invocations skip the wizard.
      // `claude auth login` creates .claude.json but doesn't set this flag.
      if (profile.configDir) {
        ensureOnboardingComplete(profile.configDir);
      }

      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, {
        terminalId: terminal.id,
        profileId,
        email: emailFromOutput || keychainCreds.email || profile?.email,
        success: true,
        detectedAt: new Date().toISOString()
      } as OAuthTokenEvent);
    } else {
      // Token not in Keychain yet, but profile may still be authenticated via configDir
      // Check if profile has valid auth (credentials exist in configDir)
      const hasCredentials = profileManager.hasValidAuth(profileId);

      if (hasCredentials) {
        console.warn('[ClaudeIntegration] Profile credentials verified (no Keychain token):', profileId);

        // Mark onboarding complete so future `claude` invocations skip the wizard
        if (profile.configDir) {
          ensureOnboardingComplete(profile.configDir);
        }

        safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, {
          terminalId: terminal.id,
          profileId,
          email: emailFromOutput || profile?.email,
          success: true,
          detectedAt: new Date().toISOString()
        } as OAuthTokenEvent);
      } else {
        console.warn('[ClaudeIntegration] Login successful but Keychain token not found and no credentials in configDir - user may need to complete authentication manually');
      }
    }
    return;
  }

  // Fallback: Check for raw OAuth token in output (legacy method)
  const token = OutputParser.extractOAuthToken(data);
  if (!token) {
    return;
  }

  console.warn('[ClaudeIntegration] OAuth token detected in output');

  let email = OutputParser.extractEmail(terminal.outputBuffer);

  if (profileId) {
    // Update profile metadata (but NOT the token - see docs/LONG_LIVED_AUTH_PLAN.md)
    const profileManager = getClaudeProfileManager();
    const profile = profileManager.getProfile(profileId);

    if (profile) {
      // Fallback/validation: Read email from Claude's config file (authoritative source)
      const configEmail = getEmailFromConfigDir(profile.configDir);
      if (configEmail) {
        if (!email) {
          console.warn('[ClaudeIntegration] Email not found in output, using config file:', maskEmail(configEmail));
          email = configEmail;
        } else if (configEmail !== email) {
          console.warn('[ClaudeIntegration] Email from output differs from config file, using config file:', {
            outputEmail: maskEmail(email),
            configEmail: maskEmail(configEmail)
          });
          email = configEmail;
        }
      }

      if (email) {
        profile.email = email;
      }
      // Update subscription metadata from Keychain credentials
      updateProfileSubscriptionMetadata(profile, profile.configDir);
      profile.isAuthenticated = true;
      profileManager.saveProfile(profile);

      // Clear keychain cache so next getCredentialsFromKeychain() fetches fresh token
      clearKeychainCache(profile.configDir);
      console.warn('[ClaudeIntegration] Profile credentials verified (not caching token):', profileId);

      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, {
        terminalId: terminal.id,
        profileId,
        email,
        success: true,
        detectedAt: new Date().toISOString()
      } as OAuthTokenEvent);
    } else {
      console.error('[ClaudeIntegration] Profile not found for OAuth token:', profileId);
    }
  } else {
    // No profile-specific terminal, update active profile metadata (GitHub OAuth flow, etc.)
    // NOTE: We do NOT store the token - see docs/LONG_LIVED_AUTH_PLAN.md
    console.warn('[ClaudeIntegration] OAuth token detected in non-profile terminal, updating active profile metadata');
    const profileManager = getClaudeProfileManager();
    const activeProfile = profileManager.getActiveProfile();

    // Defensive null check for active profile
    if (!activeProfile) {
      console.error('[ClaudeIntegration] Failed to update profile: no active profile found');
      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, {
        terminalId: terminal.id,
        profileId: undefined,
        email,
        success: false,
        message: 'No active profile found',
        detectedAt: new Date().toISOString()
      } as OAuthTokenEvent);
      return;
    }

    // A token-looking string in an ordinary terminal (code, logs, a diff) says nothing about
    // the active account. Only update it when its config dir really has credentials.
    if (!profileManager.hasValidAuth(activeProfile.id)) {
      console.warn('[ClaudeIntegration] Token-like output in a non-profile terminal, but the active profile has no credentials; ignoring');
      return;
    }

    // Fallback/validation: Read email from Claude's config file (authoritative source)
    const configEmail = getEmailFromConfigDir(activeProfile.configDir);
    if (configEmail) {
      if (!email) {
        console.warn('[ClaudeIntegration] Email not found in output, using config file:', maskEmail(configEmail));
        email = configEmail;
      } else if (configEmail !== email) {
        console.warn('[ClaudeIntegration] Email from output differs from config file, using config file:', {
          outputEmail: maskEmail(email),
          configEmail: maskEmail(configEmail)
        });
        email = configEmail;
      }
    }

    if (email) {
      activeProfile.email = email;
    }
    // Update subscription metadata from Keychain credentials
    updateProfileSubscriptionMetadata(activeProfile, activeProfile.configDir);
    activeProfile.isAuthenticated = true;
    profileManager.saveProfile(activeProfile);

    // Clear keychain cache so next getCredentialsFromKeychain() fetches fresh token
    clearKeychainCache(activeProfile.configDir);
    console.warn('[ClaudeIntegration] Active profile credentials verified (not caching token):', activeProfile.name);

    safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OAUTH_TOKEN, {
      terminalId: terminal.id,
      profileId: activeProfile.id,
      email,
      success: true,
      detectedAt: new Date().toISOString()
    } as OAuthTokenEvent);
  }
}

/**
 * Handle onboarding complete detection
 * Called when terminal output indicates Claude Code is ready after login/onboarding.
 *
 * Note: This is now a no-op. The onboarding flag is set proactively via
 * ensureOnboardingComplete() in handleOAuthToken() and executeProfileCommand(),
 * so awaitingOnboardingComplete is never set and this path is never reached.
 * Kept as a stub to satisfy the terminal-event-handler callback interface.
 */
export function handleOnboardingComplete(
  _terminal: TerminalProcess,
  _data: string,
  _getWindow: WindowGetter
): void {
  // No-op — onboarding is handled proactively in handleOAuthToken()
}

/**
 * Handle Claude exit detection (user closed Claude, returned to shell)
 *
 * This is called when we detect that Claude has exited and the terminal
 * has returned to a shell prompt. This resets the Claude mode state
 * and notifies the renderer to update the UI.
 */
export function handleClaudeExit(
  terminal: TerminalProcess,
  getWindow: WindowGetter
): void {
  // Only handle if we're actually in Claude mode
  if (!terminal.isCLIMode) {
    return;
  }

  console.warn('[ClaudeIntegration] Claude exit detected, resetting mode for terminal:', terminal.id);

  // Reset Claude mode state
  terminal.isCLIMode = false;

  // Persist the session state change
  if (terminal.projectPath) {
    SessionHandler.persistSession(terminal);
  }

  // Notify renderer to update UI
  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_CLAUDE_EXIT, terminal.id);
}

/**
 * Ensure hasCompletedOnboarding is set in profile's .claude.json.
 * When CLAUDE_CONFIG_DIR is set, Claude Code reads .claude.json from that directory.
 * Without this flag, it triggers the onboarding wizard even for authenticated profiles.
 */
export function ensureOnboardingComplete(configDir: string): void {
  try {
    const expandedDir = path.resolve(
      expandClaudeHome(configDir)
    );
    const claudeJsonPath = getClaudeGlobalConfigPath(expandedDir);

    // Read directly instead of existsSync + readFileSync to avoid TOCTOU race (CodeQL js/file-system-race)
    let content: string;
    try {
      content = fs.readFileSync(claudeJsonPath, 'utf-8');
    } catch (readErr) {
      if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // No .claude.json yet — Claude Code will create it during auth
      }
      throw readErr;
    }

    const config = JSON.parse(content);

    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      return; // Not a valid config object
    }

    if (config.hasCompletedOnboarding === true) {
      return; // Already set
    }

    config.hasCompletedOnboarding = true;
    const updatedContent = JSON.stringify(config, null, 2);

    // Write atomically via temp file + rename to avoid partial writes and satisfy CodeQL js/insecure-temporary-file.
    // crypto.randomUUID() ensures no collisions; mode 0o600 restricts to owner-only.
    const tmpPath = `${claudeJsonPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, updatedContent, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, claudeJsonPath);
    debugLog(`[ClaudeIntegration] Set hasCompletedOnboarding in ${claudeJsonPath}`);
  } catch (error) {
    // Non-fatal — worst case the user sees onboarding once
    debugError('[ClaudeIntegration] Failed to set hasCompletedOnboarding:', error);
  }
}

/**
 * Shared command execution logic for profile-based invocation
 * Returns true if command was executed via configDir or temp-file method
 */
interface ExecuteProfileCommandOptions {
  needsEnvOverride: boolean;
  activeProfile: any;
  cwdCommand: string;
  pathPrefix: string;
  escapedClaudeCmd: string;
  extraFlags: string | undefined;
  terminal: TerminalProcess;
  profileManager: any;
  projectPath: string | undefined;
  startTime: number;
  getWindow: WindowGetter;
  logPrefix: string;
}

function executeProfileCommand(options: ExecuteProfileCommandOptions): boolean {
  const {
    needsEnvOverride,
    activeProfile,
    cwdCommand,
    pathPrefix,
    escapedClaudeCmd,
    extraFlags,
    terminal,
    profileManager,
    getWindow,
    logPrefix,
  } = options;

  if (!needsEnvOverride || !activeProfile || activeProfile.isDefault) {
    return false; // Use default method
  }

  // Prefer configDir over token because CLAUDE_CONFIG_DIR lets Claude Code
  // read full Keychain credentials including subscriptionType ("max") and rateLimitTier.
  // Using CLAUDE_CODE_OAUTH_TOKEN alone lacks tier info, causing "Claude API" display.
  if (activeProfile.configDir) {
    // Ensure Claude Code skips onboarding for authenticated profiles
    ensureOnboardingComplete(activeProfile.configDir);

    const command = buildClaudeShellCommand(
      cwdCommand,
      pathPrefix,
      escapedClaudeCmd,
      { method: 'config-dir', configDir: windowConfigDir(terminal, activeProfile.configDir) },
      extraFlags,
      shellKindOf(terminal)
    );
    debugLog(`${logPrefix} Executing command (configDir method, history-safe)`);
    writeCliCommand(terminal, command);
    profileManager.markProfileUsed(activeProfile.id);
    finalizeClaudeInvoke(terminal, activeProfile, getWindow);
    debugLog(`${logPrefix} ========== INVOKE CLAUDE COMPLETE (configDir) ==========`);
    return true;
  }

  // Legacy fallback: use temp-file method if only token is available
  const token = profileManager.getProfileToken(activeProfile.id);
  debugLog(`${logPrefix} Token retrieval:`, {
    hasToken: !!token
  });

  if (token) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const tempFile = path.join(
      tokenTempDir(terminal),
      `.claude-token-${Date.now()}-${nonce}${getTempFileExtension(shellKindOf(terminal))}`
    );
    debugLog(`${logPrefix} Writing token to temp file:`, tempFile);
    fs.writeFileSync(tempFile, generateTokenTempFileContent(token, shellKindOf(terminal)), { mode: 0o600 });

    const command = buildClaudeShellCommand(
      cwdCommand,
      pathPrefix,
      escapedClaudeCmd,
      { method: 'temp-file', tempFile: windowPath(terminal, tempFile) },
      extraFlags,
      shellKindOf(terminal)
    );
    debugLog(`${logPrefix} Executing command (temp file method, history-safe)`);
    writeCliCommand(terminal, command);
    profileManager.markProfileUsed(activeProfile.id);
    finalizeClaudeInvoke(terminal, activeProfile, getWindow);
    debugLog(`${logPrefix} ========== INVOKE CLAUDE COMPLETE (temp file) ==========`);
    return true;
  }

  debugLog(`${logPrefix} WARNING: No token or configDir available for non-default profile`);
  return false;
}

/**
 * Async version of executeProfileCommand for non-blocking file operations
 * Returns true if command was executed via configDir or temp-file method
 */
async function executeProfileCommandAsync(options: ExecuteProfileCommandOptions): Promise<boolean> {
  const {
    needsEnvOverride,
    activeProfile,
    cwdCommand,
    pathPrefix,
    escapedClaudeCmd,
    extraFlags,
    terminal,
    profileManager,
    getWindow,
    logPrefix,
  } = options;

  if (!needsEnvOverride || !activeProfile || activeProfile.isDefault) {
    return false; // Use default method
  }

  // Prefer configDir over token because CLAUDE_CONFIG_DIR lets Claude Code
  // read full Keychain credentials including subscriptionType ("max") and rateLimitTier.
  // Using CLAUDE_CODE_OAUTH_TOKEN alone lacks tier info, causing "Claude API" display.
  if (activeProfile.configDir) {
    // Ensure Claude Code skips onboarding for authenticated profiles
    ensureOnboardingComplete(activeProfile.configDir);

    const command = buildClaudeShellCommand(
      cwdCommand,
      pathPrefix,
      escapedClaudeCmd,
      { method: 'config-dir', configDir: windowConfigDir(terminal, activeProfile.configDir) },
      extraFlags,
      shellKindOf(terminal)
    );
    debugLog(`${logPrefix} Executing command (configDir method, history-safe)`);
    writeCliCommand(terminal, command);
    profileManager.markProfileUsed(activeProfile.id);
    finalizeClaudeInvoke(terminal, activeProfile, getWindow);
    debugLog(`${logPrefix} ========== INVOKE CLAUDE COMPLETE (configDir) ==========`);
    return true;
  }

  // Legacy fallback: use temp-file method if only token is available
  const token = profileManager.getProfileToken(activeProfile.id);
  debugLog(`${logPrefix} Token retrieval:`, {
    hasToken: !!token
  });

  if (token) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const tempFile = path.join(
      tokenTempDir(terminal),
      `.claude-token-${Date.now()}-${nonce}${getTempFileExtension(shellKindOf(terminal))}`
    );
    debugLog(`${logPrefix} Writing token to temp file:`, tempFile);
    await fsPromises.writeFile(tempFile, generateTokenTempFileContent(token, shellKindOf(terminal)), { mode: 0o600 });

    const command = buildClaudeShellCommand(
      cwdCommand,
      pathPrefix,
      escapedClaudeCmd,
      { method: 'temp-file', tempFile: windowPath(terminal, tempFile) },
      extraFlags,
      shellKindOf(terminal)
    );
    debugLog(`${logPrefix} Executing command (temp file method, history-safe)`);
    writeCliCommand(terminal, command);
    profileManager.markProfileUsed(activeProfile.id);
    finalizeClaudeInvoke(terminal, activeProfile, getWindow);
    debugLog(`${logPrefix} ========== INVOKE CLAUDE COMPLETE (temp file) ==========`);
    return true;
  }

  debugLog(`${logPrefix} WARNING: No token or configDir available for non-default profile`);
  return false;
}

/**
 * Invoke Claude with optional profile override
 */
export function invokeClaude(
  terminal: TerminalProcess,
  cwd: string | undefined,
  profileId: string | undefined,
  getWindow: WindowGetter,
  dangerouslySkipPermissions?: boolean
): void {
  debugLog('[ClaudeIntegration:invokeClaude] ========== INVOKE CLAUDE START ==========');
  debugLog('[ClaudeIntegration:invokeClaude] Terminal ID:', terminal.id);
  debugLog('[ClaudeIntegration:invokeClaude] Requested profile ID:', profileId);
  debugLog('[ClaudeIntegration:invokeClaude] CWD:', cwd);
  debugLog('[ClaudeIntegration:invokeClaude] Dangerously skip permissions:', dangerouslySkipPermissions);

  // A new session gets an id of Workbench's own, so its spending can be read back later
  const newSessionId = crypto.randomUUID();

  // Compute extra flags for the new session and YOLO mode
  const extraFlags =
    `${buildNewSessionFlag(newSessionId)}${dangerouslySkipPermissions ? YOLO_MODE_FLAG : ''}` +
    `${graphifyHintFlag(terminal)}${claudeThemeFlag(shellKindOf(terminal))}`;

  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;
  const previousProfileId = terminal.claudeProfileId;

  try {
    terminal.isCLIMode = true;
    // Store YOLO mode setting so it persists across profile switches
    terminal.dangerouslySkipPermissions = dangerouslySkipPermissions;

    const startTime = Date.now();
    const projectPath = cwd || terminal.projectPath || terminal.cwd;

    const profileManager = getClaudeProfileManager();
    const activeProfile = profileId
      ? profileManager.getProfile(profileId)
      : profileManager.getActiveProfile();

    terminal.claudeProfileId = activeProfile?.id;
    trackAgentWindowSession(terminal, newSessionId, activeProfile?.configDir, cwd);

    debugLog('[ClaudeIntegration:invokeClaude] Profile resolution:', {
      previousProfileId,
      newProfileId: activeProfile?.id,
      profileName: activeProfile?.name,
      hasOAuthToken: !!activeProfile?.oauthToken,
      isDefault: activeProfile?.isDefault
    });

    const cwdCommand = buildCdCommand(windowPath(terminal, cwd), shellKindOf(terminal));
    const { command: claudeCmd, env: claudeEnv } = getClaudeCliInvocation();
    const { escapedClaudeCmd, pathPrefix } = windowClaudeCommand(terminal, claudeCmd, claudeEnv);
    const needsEnvOverride: boolean = !!(profileId && profileId !== previousProfileId);

    debugLog('[ClaudeIntegration:invokeClaude] Environment override check:', {
      profileIdProvided: !!profileId,
      previousProfileId,
      needsEnvOverride
    });

    // Try to execute using profile-specific method (configDir or temp-file)
    const executed = executeProfileCommand({
      needsEnvOverride,
      activeProfile,
      cwdCommand,
      pathPrefix,
      escapedClaudeCmd,
      extraFlags,
      terminal,
      profileManager,
      projectPath,
      startTime,
      getWindow,
        logPrefix: '[ClaudeIntegration:invokeClaude]',
    });

    if (executed) {
      return; // Command already executed via configDir or temp-file method
    }

    // Fall back to default method
    if (activeProfile && !activeProfile.isDefault) {
      debugLog('[ClaudeIntegration:invokeClaude] Using terminal environment for non-default profile:', activeProfile.name);
    }

    const command = buildClaudeShellCommand(cwdCommand, pathPrefix, escapedClaudeCmd, { method: 'default' }, extraFlags, shellKindOf(terminal));
    debugLog('[ClaudeIntegration:invokeClaude] Executing command (default method):', command);
    writeCliCommand(terminal, command);

    if (activeProfile) {
      profileManager.markProfileUsed(activeProfile.id);
    }

    finalizeClaudeInvoke(terminal, activeProfile, getWindow);
    debugLog('[ClaudeIntegration:invokeClaude] ========== INVOKE CLAUDE COMPLETE (default) ==========');
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    terminal.claudeProfileId = previousProfileId;
    debugError('[ClaudeIntegration:invokeClaude] Invocation failed:', error);
    debugError('[ClaudeIntegration:invokeClaude] Error details:', {
      terminalId: terminal.id,
      profileId,
      cwd,
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Resume Claude in the terminal's project
 *
 * Changes to the project directory and runs `claude --continue`, which picks up the latest
 * Claude session there.
 */
export function resumeClaude(
  terminal: TerminalProcess,
  getWindow: WindowGetter
): void {
  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;

  try {
    terminal.isCLIMode = true;

    const { command: claudeCmd, env: claudeEnv } = getClaudeCliInvocation();
    const { escapedClaudeCmd, pathPrefix } = windowClaudeCommand(terminal, claudeCmd, claudeEnv);

    // Preserve YOLO mode flag from terminal's stored state
    const extraFlags = `${terminal.dangerouslySkipPermissions ? YOLO_MODE_FLAG : ''}${graphifyHintFlag(terminal)}${claudeThemeFlag(shellKindOf(terminal))}`;

    // Go to the project directory, then pick up its latest Claude session
    const cdCommand = buildCdCommand(windowPath(terminal, terminal.projectPath || terminal.cwd), shellKindOf(terminal));
    const command = `${cdCommand}${pathPrefix}${escapedClaudeCmd} --continue${extraFlags}`;

    // Use PtyManager.writeToPty for safer write with error handling
    writeCliCommand(terminal, command);

    // Only auto-rename if terminal has default name
    // This preserves user-customized names and prevents renaming on every resume
    if (shouldAutoRenameTerminal(terminal.title)) {
      terminal.title = 'Claude';
      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'Claude');
    }

    // Persist session
    if (terminal.projectPath) {
      SessionHandler.persistSession(terminal);
    }
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    debugError('[ClaudeIntegration:resumeClaude] Resume failed:', error);
    throw error; // Re-throw to allow caller to handle
  }
}

// ============================================================================
// ASYNC VERSIONS - Non-blocking alternatives for Electron main process
// ============================================================================

/**
 * Invoke Claude asynchronously (non-blocking)
 *
 * Safe to call from Electron main process without blocking the event loop.
 * Uses async CLI detection which doesn't block on subprocess calls.
 * Includes error handling and timeout protection to prevent hangs.
 */
export async function invokeCLIAsync(
  terminal: TerminalProcess,
  cwd: string | undefined,
  profileId: string | undefined,
  getWindow: WindowGetter,
  dangerouslySkipPermissions?: boolean,
  options: InvokeCLIOptions = {}
): Promise<void> {
  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;
  const previousProfileId = terminal.claudeProfileId;
  const { resumeSessionId, engine } = options;

  const startTime = Date.now();

  try {
    debugLog('[ClaudeIntegration:invokeCLIAsync] ========== INVOKE CLAUDE START (async) ==========');
    debugLog('[ClaudeIntegration:invokeCLIAsync] Terminal ID:', terminal.id);
    debugLog('[ClaudeIntegration:invokeCLIAsync] Requested profile ID:', profileId);
    debugLog('[ClaudeIntegration:invokeCLIAsync] CWD:', cwd);
    debugLog('[ClaudeIntegration:invokeCLIAsync] Dangerously skip permissions:', dangerouslySkipPermissions);

    debugLog('[ClaudeIntegration:invokeCLIAsync] Resume session:', resumeSessionId);

    // A new session gets an id of Workbench's own, so its spending can be read back later
    const newSessionId = resumeSessionId ? undefined : crypto.randomUUID();

    // Extra flags: the session, YOLO mode, the Graphify hint and the matching theme
    const extraFlags = buildClaudeExtraFlags(terminal, dangerouslySkipPermissions, resumeSessionId, newSessionId);

    terminal.isCLIMode = true;
    // Store YOLO mode setting so it persists across profile switches
    terminal.dangerouslySkipPermissions = dangerouslySkipPermissions;

    const projectPath = cwd || terminal.projectPath || terminal.cwd;

    // Codex engine (the "New agent" menu, Settings > Agents, or a task's Codex session to resume):
    // the window runs codex
    const codexWindow = engine === 'codex' || (engine !== 'claude' &&
      (isCodexAccountId(profileId) || (!resumeSessionId && (await pickEngine()) === 'codex')));
    terminal.engine = codexWindow ? 'codex' : 'claude';
    if (codexWindow) {
      const cwdCommand = buildCdCommand(windowPath(terminal, cwd), shellKindOf(terminal));
      writeCliCommand(terminal, `${cwdCommand}${await buildCodexWindowCommand(terminal, profileId, dangerouslySkipPermissions, resumeSessionId)}`);
      if (shouldAutoRenameTerminal(terminal.title)) {
        terminal.title = 'Codex';
        safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'Codex');
      }
      if (terminal.projectPath) SessionHandler.persistSessionAsync(terminal);
      return;
    }

    // Dispatch to the appropriate CLI based on preferredCLI setting
    const settings = await readSettingsFileAsync();
    const preferredCLI = (settings?.preferredCLI as SupportedCLI | undefined) || 'claude-code';

    // A resumed task session is always a Claude Code session, whatever the preferred CLI
    if (preferredCLI !== 'claude-code' && !resumeSessionId) {
      // Non-Claude CLI: change directory if needed, then run the CLI command directly
      // The cd command ends in its own separator
      const cwdCommand = buildCdCommand(windowPath(terminal, cwd), shellKindOf(terminal));
      const command = getCLICommand(preferredCLI, settings?.customCLIPath as string | undefined);
      debugLog('[ClaudeIntegration:invokeCLIAsync] Non-Claude CLI dispatch:', { preferredCLI, command });
      // PowerShell runs a (possibly quoted) path only through the call operator; a WSL window runs
      // a custom CLI's Windows path through its /mnt path
      const wslPath = isWslWindow(terminal) && /^[A-Za-z]:[\\/]|^\\\\/.test(command) ? toRuntimePath(command) : undefined;
      const shellCommand = shellKindOf(terminal) === 'powershell'
        ? escapeShellCommand(command, 'powershell')
        : wslPath ? escapeShellArg(wslPath) : command;
      writeCliCommand(terminal, `${cwdCommand}${shellCommand}`);
      return;
    }

    // Ensure profile manager is initialized (async, yields to event loop)
    const profileManager = await initializeClaudeProfileManager();
    const activeProfile = profileId
      ? profileManager.getProfile(profileId)
      : profileManager.getActiveProfile();

    terminal.claudeProfileId = activeProfile?.id;
    if (newSessionId) trackAgentWindowSession(terminal, newSessionId, activeProfile?.configDir, cwd);

    debugLog('[ClaudeIntegration:invokeCLIAsync] Profile resolution:', {
      previousProfileId,
      newProfileId: activeProfile?.id,
      profileName: activeProfile?.name,
      hasOAuthToken: !!activeProfile?.oauthToken,
      isDefault: activeProfile?.isDefault
    });

    // Async CLI invocation - non-blocking
    const cwdCommand = buildCdCommand(windowPath(terminal, cwd), shellKindOf(terminal));

    // Add timeout protection for CLI detection (10s timeout)
    const cliInvocationPromise = getClaudeCliInvocationAsync();
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('CLI invocation timeout after 10s')), 10000);
    });
    const { command: claudeCmd, env: claudeEnv } = await Promise.race([cliInvocationPromise, timeoutPromise])
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

    const { escapedClaudeCmd, pathPrefix } = windowClaudeCommand(terminal, claudeCmd, claudeEnv);
    const needsEnvOverride: boolean = !!(profileId && profileId !== previousProfileId);

    debugLog('[ClaudeIntegration:invokeCLIAsync] Environment override check:', {
      profileIdProvided: !!profileId,
      previousProfileId,
      needsEnvOverride
    });

    // A resumed session must run on the config dir that holds its transcript, even when the
    // terminal already uses that profile or the profile is the default one
    const sessionConfigDir = resumeSessionId
      ? resolveSessionConfigDir(options.configDir ?? activeProfile?.configDir)
      : undefined;
    if (sessionConfigDir) {
      ensureOnboardingComplete(sessionConfigDir);
      const command = buildClaudeShellCommand(
        cwdCommand,
        pathPrefix,
        escapedClaudeCmd,
        { method: 'config-dir', configDir: windowConfigDir(terminal, sessionConfigDir) },
        extraFlags,
        shellKindOf(terminal)
      );
      debugLog('[ClaudeIntegration:invokeCLIAsync] Resuming session (configDir method, history-safe)');
      writeCliCommand(terminal, command);
      if (activeProfile) {
        profileManager.markProfileUsed(activeProfile.id);
      }
      finalizeClaudeInvoke(terminal, activeProfile, getWindow);
      return;
    }

    // Try to execute using profile-specific method (configDir or temp-file) with async file operations
    const executed = await executeProfileCommandAsync({
      needsEnvOverride,
      activeProfile,
      cwdCommand,
      pathPrefix,
      escapedClaudeCmd,
      extraFlags,
      terminal,
      profileManager,
      projectPath,
      startTime,
      getWindow,
        logPrefix: '[ClaudeIntegration:invokeCLIAsync]',
    });

    if (executed) {
      return; // Command already executed via configDir or temp-file method
    }

    // Fall back to default method
    if (activeProfile && !activeProfile.isDefault) {
      debugLog('[ClaudeIntegration:invokeCLIAsync] Using terminal environment for non-default profile:', activeProfile.name);
    }

    const command = buildClaudeShellCommand(cwdCommand, pathPrefix, escapedClaudeCmd, { method: 'default' }, extraFlags, shellKindOf(terminal));
    debugLog('[ClaudeIntegration:invokeCLIAsync] Executing command (default method):', command);
    writeCliCommand(terminal, command);

    if (activeProfile) {
      profileManager.markProfileUsed(activeProfile.id);
    }

    finalizeClaudeInvoke(terminal, activeProfile, getWindow);
    debugLog('[ClaudeIntegration:invokeCLIAsync] ========== INVOKE CLAUDE COMPLETE (default) ==========');
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    terminal.claudeProfileId = previousProfileId;
    const elapsed = Date.now() - startTime;
    debugError('[ClaudeIntegration:invokeCLIAsync] Invocation failed:', error);
    debugError('[ClaudeIntegration:invokeCLIAsync] Error details:', {
      terminalId: terminal.id,
      profileId,
      cwd,
      elapsedMs: elapsed,
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Resume Claude asynchronously (non-blocking)
 *
 * Safe to call from Electron main process without blocking the event loop.
 * Uses async CLI detection which doesn't block on subprocess calls.
 * Changes to the project directory and picks the window's own Claude Code session up again,
 * falling back to `claude --continue` (the directory's latest session) when it has none.
 */
export async function resumeClaudeAsync(
  terminal: TerminalProcess,
  getWindow: WindowGetter
): Promise<void> {
  // Track terminal state for cleanup on error
  const wasClaudeMode = terminal.isCLIMode;

  try {
    terminal.isCLIMode = true;

    // A Codex window picks up the directory's latest Codex session
    if (terminal.engine === 'codex') {
      const cdCommand = buildCdCommand(windowPath(terminal, terminal.projectPath || terminal.cwd), shellKindOf(terminal));
      writeCliCommand(terminal, `${cdCommand}${await buildCodexWindowCommand(terminal, undefined, terminal.dangerouslySkipPermissions, 'last')}`);
      if (terminal.projectPath) SessionHandler.persistSessionAsync(terminal);
      return;
    }

    // Async CLI invocation - non-blocking
    // Add timeout protection for CLI detection (10s timeout)
    const cliInvocationPromise = getClaudeCliInvocationAsync();
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('CLI invocation timeout after 10s')), 10000);
    });

    const { command: claudeCmd, env: claudeEnv } = await Promise.race([cliInvocationPromise, timeoutPromise])
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

    const { escapedClaudeCmd, pathPrefix } = windowClaudeCommand(terminal, claudeCmd, claudeEnv);

    // Preserve YOLO mode flag from terminal's stored state
    const extraFlags = `${terminal.dangerouslySkipPermissions ? YOLO_MODE_FLAG : ''}${graphifyHintFlag(terminal)}${claudeThemeFlag(shellKindOf(terminal))}`;

    // Go to the project directory, then pick the window's own session up again
    const cdCommand = buildCdCommand(windowPath(terminal, terminal.projectPath || terminal.cwd), shellKindOf(terminal));
    const sessionFlag = await resumeOwnSessionFlag(terminal);
    const command = `${cdCommand}${pathPrefix}${escapedClaudeCmd}${sessionFlag}${extraFlags}`;

    // Use PtyManager.writeToPty for safer write with error handling
    writeCliCommand(terminal, command);

    // Only auto-rename if terminal has default name
    // This preserves user-customized names and prevents renaming on every resume
    if (shouldAutoRenameTerminal(terminal.title)) {
      terminal.title = 'Claude';
      safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'Claude');
    }

    // Persist session (async, fire-and-forget to prevent main process blocking)
    if (terminal.projectPath) {
      SessionHandler.persistSessionAsync(terminal);
    }
  } catch (error) {
    // Reset terminal state on error to prevent inconsistent state
    terminal.isCLIMode = wasClaudeMode;
    debugError('[ClaudeIntegration:resumeClaudeAsync] Resume failed:', error);
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Configuration for waiting for Claude to exit
 */
interface WaitForExitConfig {
  /** Maximum time to wait for Claude to exit (ms) */
  timeout?: number;
  /** Interval between checks (ms) */
  pollInterval?: number;
}

/**
 * Result of waiting for Claude to exit
 */
interface WaitForExitResult {
  /** Whether Claude exited successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the operation timed out */
  timedOut?: boolean;
}

/**
 * Shell prompt patterns that indicate Claude has exited and shell is ready
 * These patterns match common shell prompts across bash, zsh, fish, etc.
 */
const SHELL_PROMPT_PATTERNS = [
  /[$%#>❯]\s*$/m,                    // Common prompt endings: $, %, #, >, ❯
  /\w+@[\w.-]+[:\s]/,                // user@hostname: format
  /^\s*\S+\s*[$%#>❯]\s*$/m,          // hostname/path followed by prompt char
  /\(.*\)\s*[$%#>❯]\s*$/m,           // (venv) or (branch) followed by prompt
];

/**
 * Wait for Claude to exit by monitoring terminal output for shell prompt
 *
 * Instead of using fixed delays, this monitors the terminal's outputBuffer
 * for patterns indicating that Claude has exited and the shell prompt is visible.
 */
async function waitForClaudeExit(
  terminal: TerminalProcess,
  config: WaitForExitConfig = {}
): Promise<WaitForExitResult> {
  const { timeout = 5000, pollInterval = 100 } = config;

  debugLog('[ClaudeIntegration:waitForClaudeExit] Waiting for Claude to exit...');
  debugLog('[ClaudeIntegration:waitForClaudeExit] Config:', { timeout, pollInterval });

  // Capture current buffer length to detect new output
  const initialBufferLength = terminal.outputBuffer.length;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const checkForPrompt = () => {
      const elapsed = Date.now() - startTime;

      // Check for timeout
      if (elapsed >= timeout) {
        console.warn('[ClaudeIntegration:waitForClaudeExit] Timeout waiting for Claude to exit after', timeout, 'ms');
        debugLog('[ClaudeIntegration:waitForClaudeExit] Timeout reached, Claude may not have exited cleanly');
        resolve({
          success: false,
          error: `Timeout waiting for Claude to exit after ${timeout}ms`,
          timedOut: true
        });
        return;
      }

      // Get new output since we started waiting
      const newOutput = terminal.outputBuffer.slice(initialBufferLength);

      // Check if we can see a shell prompt in the new output
      for (const pattern of SHELL_PROMPT_PATTERNS) {
        if (pattern.test(newOutput)) {
          debugLog('[ClaudeIntegration:waitForClaudeExit] Shell prompt detected after', elapsed, 'ms');
          debugLog('[ClaudeIntegration:waitForClaudeExit] Matched pattern:', pattern.toString());
          resolve({ success: true });
          return;
        }
      }

      // Also check if isCLIMode was cleared (set by other handlers)
      if (!terminal.isCLIMode) {
        debugLog('[ClaudeIntegration:waitForClaudeExit] isCLIMode flag cleared after', elapsed, 'ms');
        resolve({ success: true });
        return;
      }

      // Continue polling
      setTimeout(checkForPrompt, pollInterval);
    };

    // Start checking
    checkForPrompt();
  });
}

/**
 * Switch terminal to a different Claude profile
 */
export async function switchClaudeProfile(
  terminal: TerminalProcess,
  profileId: string,
  _getWindow: WindowGetter,
  invokeClaudeCallback: (terminalId: string, cwd: string | undefined, profileId: string, dangerouslySkipPermissions?: boolean) => Promise<void>,
  clearRateLimitCallback: (terminalId: string) => void
): Promise<{ success: boolean; error?: string }> {
  // Always-on tracing
  console.warn('[ClaudeIntegration:switchClaudeProfile] Called for terminal:', terminal.id, '| profileId:', profileId);
  console.warn('[ClaudeIntegration:switchClaudeProfile] Terminal state: isCLIMode=', terminal.isCLIMode);

  debugLog('[ClaudeIntegration:switchClaudeProfile] ========== SWITCH PROFILE START ==========');
  debugLog('[ClaudeIntegration:switchClaudeProfile] Terminal ID:', terminal.id);
  debugLog('[ClaudeIntegration:switchClaudeProfile] Target profile ID:', profileId);
  debugLog('[ClaudeIntegration:switchClaudeProfile] Terminal state:', {
    isCLIMode: terminal.isCLIMode,
    currentProfileId: terminal.claudeProfileId,
    projectPath: terminal.projectPath,
    cwd: terminal.cwd
  });

  // Ensure profile manager is initialized (async, yields to event loop)
  const profileManager = await initializeClaudeProfileManager();
  const profile = profileManager.getProfile(profileId);

  console.warn('[ClaudeIntegration:switchClaudeProfile] Profile found:', profile?.name || 'NOT FOUND');
  debugLog('[ClaudeIntegration:switchClaudeProfile] Target profile:', profile ? {
    id: profile.id,
    name: profile.name,
    hasOAuthToken: !!profile.oauthToken,
    isDefault: profile.isDefault
  } : 'NOT FOUND');

  if (!profile) {
    console.error('[ClaudeIntegration:switchClaudeProfile] Profile not found, aborting');
    debugError('[ClaudeIntegration:switchClaudeProfile] Profile not found, aborting');
    return { success: false, error: 'Profile not found' };
  }

  console.warn('[ClaudeIntegration:switchClaudeProfile] Switching to profile:', profile.name);
  debugLog('[ClaudeIntegration:switchClaudeProfile] Switching to Claude profile:', profile.name);

  if (terminal.isCLIMode) {
    console.warn('[ClaudeIntegration:switchClaudeProfile] Sending exit commands (Ctrl+C, /exit)');
    debugLog('[ClaudeIntegration:switchClaudeProfile] Terminal is in Claude mode, sending exit commands');

    // The CLI's exit marker that follows is the app's own restart: keep the window open
    terminal.cliRestarting = true;

    // Send Ctrl+C to interrupt any ongoing operation
    debugLog('[ClaudeIntegration:switchClaudeProfile] Sending Ctrl+C (\\x03)');
    // Use PtyManager.writeToPty for safer write with error handling
    PtyManager.writeToPty(terminal, '\x03');

    // Wait briefly for Ctrl+C to take effect before sending /exit
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send /exit command
    debugLog('[ClaudeIntegration:switchClaudeProfile] Sending /exit command');
    // Use PtyManager.writeToPty for safer write with error handling
    PtyManager.writeToPty(terminal, '/exit\r');

    // Wait for Claude to actually exit by monitoring for shell prompt
    const exitResult = await waitForClaudeExit(terminal, { timeout: 5000, pollInterval: 100 });

    if (exitResult.timedOut) {
      console.warn('[ClaudeIntegration:switchClaudeProfile] Timed out waiting for Claude to exit, proceeding with caution');
      debugLog('[ClaudeIntegration:switchClaudeProfile] Exit timeout - terminal may be in inconsistent state');

      // Even on timeout, we'll try to proceed but log the warning
      // The alternative would be to abort, but that could leave users stuck
      // If this becomes a problem, we could add retry logic or abort option
    } else if (!exitResult.success) {
      console.error('[ClaudeIntegration:switchClaudeProfile] Failed to exit Claude:', exitResult.error);
      debugError('[ClaudeIntegration:switchClaudeProfile] Exit failed:', exitResult.error);
      // Continue anyway - the /exit command was sent
    } else {
      console.warn('[ClaudeIntegration:switchClaudeProfile] Claude exited successfully');
      debugLog('[ClaudeIntegration:switchClaudeProfile] Claude exited, ready to switch profile');
    }
  } else {
    console.warn('[ClaudeIntegration:switchClaudeProfile] NOT in Claude mode, skipping exit commands');
    debugLog('[ClaudeIntegration:switchClaudeProfile] Terminal NOT in Claude mode, skipping exit commands');
  }

  debugLog('[ClaudeIntegration:switchClaudeProfile] Clearing rate limit state for terminal');
  clearRateLimitCallback(terminal.id);

  const projectPath = terminal.projectPath || terminal.cwd;
  console.warn('[ClaudeIntegration:switchClaudeProfile] Invoking Claude with profile:', profileId, '| cwd:', projectPath, '| YOLO:', terminal.dangerouslySkipPermissions);
  debugLog('[ClaudeIntegration:switchClaudeProfile] Invoking Claude with new profile:', {
    terminalId: terminal.id,
    projectPath,
    profileId,
    dangerouslySkipPermissions: terminal.dangerouslySkipPermissions
  });
  // Pass the stored dangerouslySkipPermissions value to preserve YOLO mode across profile switches
  await invokeClaudeCallback(terminal.id, projectPath, profileId, terminal.dangerouslySkipPermissions);

  debugLog('[ClaudeIntegration:switchClaudeProfile] Setting active profile in profile manager');
  profileManager.setActiveProfile(profileId);

  console.warn('[ClaudeIntegration:switchClaudeProfile] COMPLETE');
  debugLog('[ClaudeIntegration:switchClaudeProfile] ========== SWITCH PROFILE COMPLETE ==========');
  return { success: true };
}
