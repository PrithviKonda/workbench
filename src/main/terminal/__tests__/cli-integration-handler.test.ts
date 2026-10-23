import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';
import { buildCdCommand, escapeShellArg } from '../../../shared/utils/shell-escape';

// Mock the platform module (main/platform/index.ts)
vi.mock('../../claude-code/env', () => ({ pickEngine: vi.fn(async () => 'claude') }));
vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => false),
  isUnix: vi.fn(() => false),
  getCurrentOS: vi.fn(() => 'linux'),
}));

import { isWindows } from '../../platform';

/** Escape special regex characters in a string for safe use in RegExp constructor */
const escapeForRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mockGetClaudeCliInvocation = vi.fn();
const mockGetClaudeCliInvocationAsync = vi.fn();
const mockGetClaudeProfileManager = vi.fn();
const mockInitializeClaudeProfileManager = vi.fn();
const mockPersistSession = vi.fn();

const createMockDisposable = (): pty.IDisposable => ({ dispose: vi.fn() });

const createMockPty = (): pty.IPty => ({
  pid: 123,
  cols: 80,
  rows: 24,
  process: 'bash',
  handleFlowControl: false,
  onData: vi.fn(() => createMockDisposable()),
  onExit: vi.fn(() => createMockDisposable()),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
});

const createMockTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: createMockPty(),
  outputBuffer: '',
  isCLIMode: false,
  claudeProfileId: undefined,
  title: 'Terminal 1',  // Use default terminal name pattern to match production behavior
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  ...overrides,
});

vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocation: mockGetClaudeCliInvocation,
  getClaudeCliInvocationAsync: mockGetClaudeCliInvocationAsync,
}));

vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: mockGetClaudeProfileManager,
  initializeClaudeProfileManager: mockInitializeClaudeProfileManager,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    promises: {
      writeFile: vi.fn(),
    },
  };
});

vi.mock('../session-handler', () => ({
  persistSession: mockPersistSession,
  persistSessionAsync: mockPersistSession,
}));

// Mock the store of the sessions agent windows start, so tests write nothing to disk
const mockRecordAgentSession = vi.fn();
const mockLastAgentSession: ReturnType<typeof vi.fn> = vi.fn(async () => undefined);
const mockReadAgentSessions: ReturnType<typeof vi.fn> = vi.fn(async () => []);
vi.mock('../../agent-session-store', () => ({
  recordAgentSessionAsync: mockRecordAgentSession,
  lastAgentSession: mockLastAgentSession,
  readAgentSessions: mockReadAgentSessions,
}));

// Mock the transcript lookups a restored window uses: its own session, and the directory's latest
const mockFindSessionTranscript: ReturnType<typeof vi.fn> = vi.fn(async () => null);
const mockLatestTranscript: ReturnType<typeof vi.fn> = vi.fn(async () => null);
vi.mock('../../claude-code/session-spending', () => ({
  findSessionTranscript: mockFindSessionTranscript,
  latestTranscript: mockLatestTranscript,
}));
vi.mock('../../claude-profile/profile-config-dirs', () => ({
  claudeConfigDirs: () => ['/home/user/.claude'],
}));

// Mock PtyManager.writeToPty - the implementation now uses this instead of terminal.pty.write
const mockWriteToPty = vi.fn();
vi.mock('../pty-manager', () => ({
  writeToPty: mockWriteToPty,
}));

// Mock settings-utils so invokeCLIAsync defaults to claude-code in tests
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
  readSettingsFile: vi.fn(() => undefined),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    tmpdir: vi.fn(() => '/tmp'),
  };
});

/**
 * Helper to set the current platform for testing
 */
function mockPlatform(platform: 'win32' | 'darwin' | 'linux') {
  const mockIsWindows = vi.mocked(isWindows);
  mockIsWindows.mockReturnValue(platform === 'win32');
}

/** PowerShell single-quoted literal, as the code under test writes it */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The shell agent windows run on each platform: PowerShell on Windows, POSIX elsewhere */
function platformShellKind(platform: 'win32' | 'darwin' | 'linux'): 'powershell' | 'posix' {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Helper to get platform-specific expectations for PATH prefix
 */
function getPathPrefixExpectation(
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): string {
  // Absolute executable commands no longer need PATH prefix injection.
  if (path.isAbsolute(command)) {
    return '';
  }

  if (platform === 'win32') {
    // PowerShell: $env:PATH = 'value';
    return `$env:PATH = ${psQuote(pathValue)}; `;
  }
  // Unix/macOS: PATH='value' '
  return `PATH='${pathValue}' `;
}

function expectPathPrefix(
  written: string,
  platform: 'win32' | 'darwin' | 'linux',
  pathValue: string,
  command: string
): void {
  const expectedPrefix = getPathPrefixExpectation(platform, pathValue, command);
  if (expectedPrefix) {
    expect(written).toContain(expectedPrefix);
  } else {
    expect(written).not.toContain('PATH=');
    expect(written).not.toContain('$env:PATH');
  }
}

/**
 * Helper to get platform-specific expectations for command quoting
 */
function getQuotedCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    // PowerShell: the call operator on a single-quoted path
    return `& ${psQuote(command)}`;
  }
  // Unix/macOS: use escapeShellArg which properly handles embedded single quotes
  return escapeShellArg(command);
}

/**
 * Helper to get platform-specific clear command, with the separator that follows it
 */
function getClearPrefix(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? 'Clear-Host; ' : 'clear && ';
}

/**
 * Helper to get platform-specific history prefix
 */
function getHistoryPrefix(platform: 'win32' | 'darwin' | 'linux'): string {
  return platform === 'win32' ? '' : 'HISTFILE= HISTCONTROL=ignorespace ';
}

/**
 * Helper to get platform-specific temp file extension (PowerShell reads a plain token file)
 */
function getTempFileExtension(_platform: 'win32' | 'darwin' | 'linux'): string {
  return '';
}

/**
 * Helper to get platform-specific token file content
 */
function getTokenFileContent(platform: 'win32' | 'darwin' | 'linux', token: string): string {
  if (platform === 'win32') {
    return token;
  }
  return `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`;
}

/**
 * Helper to get platform-specific temp file invocation
 */
function getTempFileInvocation(platform: 'win32' | 'darwin' | 'linux', tokenPath: string): string {
  if (platform === 'win32') {
    return `$env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content -LiteralPath ${psQuote(tokenPath)} -Raw -ErrorAction Stop).Trim(); `;
  }
  return `source '${tokenPath}'`;
}

/**
 * Helper to get platform-specific temp file cleanup
 *
 * Note: Windows deletes BEFORE the command runs, for security - environment
 * variables persist in memory after deletion.
 */
function getTempFileCleanup(platform: 'win32' | 'darwin' | 'linux', tokenPath: string): string {
  if (platform === 'win32') {
    return `Remove-Item -LiteralPath ${psQuote(tokenPath)} -Force -ErrorAction SilentlyContinue; `;
  }
  return `&& rm -f '${tokenPath}' &&`;
}

/**
 * Helper to get platform-specific exec command
 */
function getExecCommand(platform: 'win32' | 'darwin' | 'linux', command: string): string {
  if (platform === 'win32') {
    return command; // Windows doesn't use exec
  }
  return `exec ${command}`;
}

/**
 * Helper to get platform-specific config dir command
 */
function getConfigDirCommand(platform: 'win32' | 'darwin' | 'linux', configDir: string): string {
  if (platform === 'win32') {
    return `$env:CLAUDE_CONFIG_DIR = ${psQuote(configDir)}; `;
  }
  return `CLAUDE_CONFIG_DIR='${configDir}'`;
}

describe('cli-integration-handler', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocation.mockClear();
    mockGetClaudeProfileManager.mockClear();
    mockPersistSession.mockClear();
    mockWriteToPty.mockClear();
    vi.mocked(writeFileSync).mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('uses the resolved CLI path and PATH prefix when invoking Claude', async () => {
      mockGetClaudeCliInvocation.mockReturnValue({
        command: "/opt/claude bin/claude's",
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', undefined, () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project', platformShellKind(platform)));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', "/opt/claude bin/claude's");
      expect(written).toContain(getQuotedCommand(platform, "/opt/claude bin/claude's"));
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.getActiveProfile).toHaveBeenCalled();
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('default');
    });

    it('uses the temp token flow when the active profile has an oauth token', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-1',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234);

      const terminal = createMockTerminal({ id: 'term-3' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-1', () => null);

      const tokenPath = vi.mocked(writeFileSync).mock.calls[0]?.[0] as string;
      const tokenContents = vi.mocked(writeFileSync).mock.calls[0]?.[1] as string;
      const tokenPrefix = path.join(tmpdir(), '.claude-token-1234-');
      const tokenExt = getTempFileExtension(platform);
      expect(tokenPath).toMatch(new RegExp(`^${escapeForRegex(tokenPrefix)}[0-9a-f]{16}${escapeForRegex(tokenExt)}$`));
      expect(tokenContents).toBe(getTokenFileContent(platform, 'token-value'));

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);

      expect(written).toContain(histPrefix);
      expect(written).toContain(clearCmd);
      // Inside bash -c "..." a backslash (a Windows host's temp path) is escaped
      const shownPath = platform === 'win32' ? tokenPath : tokenPath.replace(/\\/g, '\\\\');
      expect(written).toContain(getTempFileInvocation(platform, shownPath));
      expect(written).toContain(getTempFileCleanup(platform, shownPath));
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-1');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);

      nowSpy.mockRestore();
    });

    it('prefers the config dir flow when profile has both oauth token and config dir', async () => {
      // The configDir method is preferred over temp-file because CLAUDE_CONFIG_DIR lets
      // Claude Code read full Keychain credentials including subscriptionType ("max") and
      // rateLimitTier. Using CLAUDE_CODE_OAUTH_TOKEN alone lacks tier info.
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-both',
          name: 'Work',
          isDefault: false,
          oauthToken: 'token-value',
          configDir: '/tmp/claude-config',
        })),
        getProfileToken: vi.fn(() => 'token-value'),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-both' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-both', () => null);

      // Should NOT write a temp file - configDir is used instead
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, '/tmp/claude-config');

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expect(written).toContain(clearCmd);
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-both');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-both');
    });

    it('handles missing profiles by falling back to the default command', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => undefined),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-6' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'missing', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(profileManager.getProfile).toHaveBeenCalledWith('missing');
      expect(profileManager.markProfileUsed).not.toHaveBeenCalled();
    });

    it('uses the config dir flow when the active profile has a config dir', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-2',
          name: 'Work',
          isDefault: false,
          configDir: '/tmp/claude-config',
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-4' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-2', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, '/tmp/claude-config');

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', command);
      expect(written).toContain(getQuotedCommand(platform, command));
      expect(written).toContain(clearCmd);
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-2');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-2');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('uses profile switching when a non-default profile is requested', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-3',
          name: 'Team',
          isDefault: false,
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocation.mockReturnValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockGetClaudeProfileManager.mockReturnValue(profileManager);

      const terminal = createMockTerminal({ id: 'term-5' });

      const { invokeClaude } = await import('../cli-integration-handler');
      invokeClaude(terminal, '/tmp/project', 'prof-3', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getQuotedCommand(platform, command));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', command);
      expect(profileManager.getProfile).toHaveBeenCalledWith('prof-3');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-3');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('changes to the project directory and continues its latest session', async () => {
      mockGetClaudeCliInvocation.mockReturnValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });

      const terminal = createMockTerminal({
        id: 'term-2',
        cwd: undefined,
        projectPath: '/tmp/project',
      });

      const { resumeClaude } = await import('../cli-integration-handler');

      resumeClaude(terminal, () => null);

      const resumeCall = mockWriteToPty.mock.calls[0][1] as string;
      expectPathPrefix(resumeCall, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(resumeCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(resumeCall).not.toContain('--resume');
      expect(resumeCall).toContain('/tmp/project');
      expect(resumeCall.indexOf('/tmp/project')).toBeLessThan(resumeCall.indexOf(' --continue'));
      expect(terminal.isCLIMode).toBe(true);
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);

      mockWriteToPty.mockClear();
      mockPersistSession.mockClear();
      terminal.projectPath = undefined;
      terminal.isCLIMode = false;
      resumeClaude(terminal, () => null);
      const continueCall = mockWriteToPty.mock.calls[0][1] as string;
      expect(continueCall).toContain(getQuotedCommand(platform, '/opt/claude/bin/claude') + ' --continue');
      expect(terminal.isCLIMode).toBe(true);
      expect(mockPersistSession).not.toHaveBeenCalled();
    });
  });

  it('throws when invokeClaude cannot resolve the CLI invocation', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('boom');
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal({ id: 'term-err' });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', undefined, () => null)).toThrow('boom');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('throws when resumeClaude cannot resolve the CLI invocation', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('boom');
    });

    const terminal = createMockTerminal({
      id: 'term-err-2',
      cwd: undefined,
      projectPath: '/tmp/project',
    });

    const { resumeClaude } = await import('../cli-integration-handler');
    expect(() => resumeClaude(terminal, () => null)).toThrow('boom');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('throws when writing the OAuth token temp file fails', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });
    const profileManager = {
      getActiveProfile: vi.fn(),
      getProfile: vi.fn(() => ({
        id: 'prof-err',
        name: 'Work',
        isDefault: false,
        oauthToken: 'token-value',
      })),
      getProfileToken: vi.fn(() => 'token-value'),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const terminal = createMockTerminal({ id: 'term-err-3' });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', 'prof-err', () => null)).toThrow('disk full');
    expect(mockWriteToPty).not.toHaveBeenCalled();
  });

  it('includes YOLO mode flag when dangerouslySkipPermissions is true', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal();

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', undefined, () => null, true);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).toContain('--dangerously-skip-permissions');
    expect(terminal.dangerouslySkipPermissions).toBe(true);
  });

  it('does not include YOLO mode flag when dangerouslySkipPermissions is false', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({
      command: '/opt/claude/bin/claude',
      env: { PATH: '/opt/claude/bin:/usr/bin' },
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal();

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', undefined, () => null, false);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).not.toContain('--dangerously-skip-permissions');
    expect(terminal.dangerouslySkipPermissions).toBe(false);
  });

  it('resets terminal state on error', async () => {
    mockGetClaudeCliInvocation.mockImplementation(() => {
      throw new Error('CLI error');
    });
    const profileManager = {
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    };
    mockGetClaudeProfileManager.mockReturnValue(profileManager);

    const terminal = createMockTerminal({
      isCLIMode: false,
      claudeProfileId: 'old-profile',
    });

    const { invokeClaude } = await import('../cli-integration-handler');
    expect(() => invokeClaude(terminal, '/tmp/project', 'new-profile', () => null)).toThrow('CLI error');

    // Terminal state should be rolled back
    expect(terminal.isCLIMode).toBe(false);
    expect(terminal.claudeProfileId).toBe('old-profile');
  });
});

/**
 * Tests for invokeCLIAsync() - async version with timeout protection
 */
describe('invokeCLIAsync', () => {
  beforeEach(() => {
    mockGetClaudeCliInvocationAsync.mockClear();
    mockInitializeClaudeProfileManager.mockClear();
    mockPersistSession.mockClear();
    mockWriteToPty.mockClear();
    vi.mocked(writeFileSync).mockClear();
  });

  describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
    beforeEach(() => {
      mockPlatform(platform);
    });

    it('should invoke Claude asynchronously with default profile', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project', platformShellKind(platform)));
      expectPathPrefix(written, platform, '/opt/claude/bin:/usr/bin', '/opt/claude/bin/claude');
      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('default');
    });

    it('should handle profile with configDir', async () => {
      const command = '/opt/claude/bin/claude';
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({
          id: 'prof-config',
          name: 'Work',
          isDefault: false,
          configDir: '/tmp/claude-config',
        })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };

      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command,
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', 'prof-config', () => null);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      const clearCmd = getClearPrefix(platform);
      const histPrefix = getHistoryPrefix(platform);
      const configDir = getConfigDirCommand(platform, '/tmp/claude-config');

      expect(written).toContain(histPrefix);
      expect(written).toContain(configDir);
      expect(written).toContain(clearCmd);
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('prof-config');
    });

    it('should timeout after 10 seconds if CLI invocation hangs', async () => {
      mockGetClaudeCliInvocationAsync.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({
          command: '/opt/claude/bin/claude',
          env: { PATH: '/opt/claude/bin:/usr/bin' },
        }), 15000))
      );
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');

      await expect(invokeCLIAsync(terminal, '/tmp/project', undefined, () => null))
        .rejects.toThrow('CLI invocation timeout after 10s');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
    }, 12000); // Allow 12 seconds for test (10s timeout + 2s buffer)

    it('should reset terminal state on async error', async () => {
      mockGetClaudeCliInvocationAsync.mockRejectedValue(new Error('Async CLI error'));
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal({
        isCLIMode: false,
        claudeProfileId: 'old-profile',
      });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(invokeCLIAsync(terminal, '/tmp/project', 'new-profile', () => null))
        .rejects.toThrow('Async CLI error');

      // Terminal state should be rolled back
      expect(terminal.isCLIMode).toBe(false);
      expect(terminal.claudeProfileId).toBe('old-profile');
    });

    it('should include YOLO mode flag when dangerouslySkipPermissions is true', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, true);

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain('--dangerously-skip-permissions');
      expect(terminal.dangerouslySkipPermissions).toBe(true);
    });

    it('resumes a task session in its worktree on the config dir that holds the transcript', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({ id: 'work', name: 'Work', isDefault: true, configDir: '/tmp/work-config' })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      // The terminal already runs on that profile: the config dir is still set explicitly
      const terminal = createMockTerminal({ claudeProfileId: 'work' });

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/project/.workbench/worktrees/tasks/001-x', 'work', () => null, true, {
        resumeSessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
        configDir: '/tmp/task-config',
      });

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(buildCdCommand('/tmp/project/.workbench/worktrees/tasks/001-x', platformShellKind(platform)));
      // The config dir is resolved on the host (a drive letter on Windows)
      expect(written).toContain(getConfigDirCommand(platform, path.resolve('/tmp/task-config')));
      expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455 --dangerously-skip-permissions');
      expect(profileManager.markProfileUsed).toHaveBeenCalledWith('work');
      expect(terminal.isCLIMode).toBe(true);
    });

    it('falls back to the profile config dir when the run has none', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      const profileManager = {
        getActiveProfile: vi.fn(),
        getProfile: vi.fn(() => ({ id: 'work', name: 'Work', isDefault: false, configDir: '/tmp/work-config' })),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      };
      mockInitializeClaudeProfileManager.mockResolvedValue(profileManager);

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await invokeCLIAsync(terminal, '/tmp/wt', 'work', () => null, false, { resumeSessionId: 'sess-1' });

      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written).toContain(getConfigDirCommand(platform, path.resolve('/tmp/work-config')));
      expect(written).toContain('--resume sess-1');
      expect(written).not.toContain('--dangerously-skip-permissions');
    });

    it('refuses a session id that is not a plain id', async () => {
      mockGetClaudeCliInvocationAsync.mockResolvedValue({
        command: '/opt/claude/bin/claude',
        env: { PATH: '/opt/claude/bin:/usr/bin' },
      });
      mockInitializeClaudeProfileManager.mockResolvedValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });

      const terminal = createMockTerminal();

      const { invokeCLIAsync } = await import('../cli-integration-handler');
      await expect(
        invokeCLIAsync(terminal, '/tmp/wt', undefined, () => null, false, { resumeSessionId: 'x; rm -rf ~' })
      ).rejects.toThrow('Invalid Claude Code session id');
      expect(mockWriteToPty).not.toHaveBeenCalled();
      expect(terminal.isCLIMode).toBe(false);
    });

  });
});

describe('task session resume helpers', () => {
  it('builds the resume flag only for plain session ids', async () => {
    const { buildResumeSessionFlag, isValidClaudeSessionId } = await import('../cli-integration-handler');
    expect(buildResumeSessionFlag('0b7c6c1e-1234-4abc-9def-001122334455')).toBe(
      ' --resume 0b7c6c1e-1234-4abc-9def-001122334455'
    );
    expect(isValidClaudeSessionId('abc_123')).toBe(true);
    expect(isValidClaudeSessionId('-abc')).toBe(false);
    expect(isValidClaudeSessionId('a b')).toBe(false);
    expect(isValidClaudeSessionId('$(id)')).toBe(false);
    expect(() => buildResumeSessionFlag("a'b")).toThrow();
  });

  it('only forces a config dir other than the default ~/.claude', async () => {
    const os = await import('os');
    const path = await import('path');
    const { resolveSessionConfigDir } = await import('../cli-integration-handler');
    expect(resolveSessionConfigDir(undefined)).toBeUndefined();
    expect(resolveSessionConfigDir(path.join(os.homedir(), '.claude'))).toBeUndefined();
    expect(resolveSessionConfigDir('~/.claude')).toBeUndefined();
    expect(resolveSessionConfigDir('~/.claude-profiles/work')).toBe(path.join(os.homedir(), '.claude-profiles', 'work'));
  });
});

/**
 * Unit tests for helper functions
 */
describe('cli-integration-handler - Helper Functions', () => {
  describe('buildClaudeShellCommand', () => {
    describe.each(['win32', 'darwin', 'linux'] as const)('on %s', (platform) => {
      beforeEach(() => {
        mockPlatform(platform);
      });

      it('should build default command without cwd or PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', '', "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("'/opt/bin/claude'\r");
      });

      it('should build command with cwd', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand("cd '/tmp/project' && ", '', "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("cd '/tmp/project' && '/opt/bin/claude'\r");
      });

      it('should build command with PATH prefix', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand('', "PATH='/custom/path' ", "'/opt/bin/claude'", { method: 'default' });

        expect(result).toBe("PATH='/custom/path' '/opt/bin/claude'\r");
      });

      it('should build temp-file method command with history-safe prefixes', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          "cd '/tmp/project' && ",
          "PATH='/opt/bin' ",
          "'/opt/bin/claude'",
          { method: 'temp-file', tempFile: '/tmp/.token-123' }
        );

        const clearCmd = getClearPrefix(platform);
        const histPrefix = getHistoryPrefix(platform);
        const tempCmd = getTempFileInvocation(platform, '/tmp/.token-123');
        const cleanupCmd = getTempFileCleanup(platform, '/tmp/.token-123');
        const execCmd = getExecCommand(platform, "'/opt/bin/claude'");

        expect(result).toContain(clearCmd);
        expect(result).toContain("cd '/tmp/project' && ");
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).toContain("PATH='/opt/bin' ");
        expect(result).toContain(tempCmd);
        expect(result.endsWith('\r')).toBe(true);
        expect(result).toContain(cleanupCmd);
        expect(result).toContain(execCmd);
      });

      it('should build config-dir method command with CLAUDE_CONFIG_DIR', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          "cd '/tmp/project' && ",
          "PATH='/opt/bin' ",
          "'/opt/bin/claude'",
          { method: 'config-dir', configDir: '/home/user/.claude-work' }
        );

        const clearCmd = getClearPrefix(platform);
        const histPrefix = getHistoryPrefix(platform);
        const configDirVar = getConfigDirCommand(platform, '/home/user/.claude-work');
        const execCmd = getExecCommand(platform, "'/opt/bin/claude'");

        expect(result).toContain(clearCmd);
        expect(result).toContain("cd '/tmp/project' && ");
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).toContain(configDirVar);
        expect(result).toContain("PATH='/opt/bin' ");
        expect(result).toContain(execCmd);
      });

      it('should handle empty cwdCommand for temp-file method', async () => {
        const { buildClaudeShellCommand } = await import('../cli-integration-handler');
        const result = buildClaudeShellCommand(
          '',
          '',
          "'/opt/bin/claude'",
          { method: 'temp-file', tempFile: '/tmp/.token' }
        );

        const clearCmd = getClearPrefix(platform);
        const histPrefix = getHistoryPrefix(platform);
        const tempCmd = getTempFileInvocation(platform, '/tmp/.token');

        expect(result).toContain(clearCmd);
        if (platform !== 'win32') {
          expect(result).toContain(histPrefix);
        }
        expect(result).not.toContain('cd ');
        expect(result).toContain(tempCmd);
      });
    });

    it("takes the shell kind's syntax over the platform's", async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      const config = { method: 'config-dir', configDir: '/home/user/.claude-work' } as const;

      mockPlatform('win32');
      expect(buildClaudeShellCommand('', '', "'/opt/bin/claude'", config, undefined, 'posix')).toContain(
        "clear && HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR='/home/user/.claude-work'"
      );
      mockPlatform('linux');
      expect(buildClaudeShellCommand('', '', '"claude"', config, undefined, 'cmd')).toBe(
        'cls && set "CLAUDE_CONFIG_DIR=/home/user/.claude-work" && "claude"\r'
      );
      expect(buildClaudeShellCommand('', '', "& 'claude'", config, undefined, 'powershell')).toBe(
        "Clear-Host; $env:CLAUDE_CONFIG_DIR = '/home/user/.claude-work'; & 'claude'\r"
      );
    });

    it('builds PowerShell commands that Windows PowerShell 5.1 can run (no && anywhere)', async () => {
      const { buildClaudeShellCommand } = await import('../cli-integration-handler');
      const cd = buildCdCommand("C:\\Users\\O'Brien\\my repo", 'powershell');
      const pathPrefix = "$env:PATH = 'C:\\tools;C:\\Program Files\\nodejs'; ";
      const claude = "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd'";

      expect(buildClaudeShellCommand(cd, pathPrefix, claude, { method: 'default' }, ' --continue', 'powershell')).toBe(
        "Set-Location -LiteralPath 'C:\\Users\\O''Brien\\my repo' -ErrorAction Stop; " +
          "$env:PATH = 'C:\\tools;C:\\Program Files\\nodejs'; " +
          "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd' --continue\r"
      );

      const configDir = buildClaudeShellCommand(cd, pathPrefix, claude, { method: 'config-dir', configDir: "C:\\cfg\\it's" }, undefined, 'powershell');
      expect(configDir).toBe(
        "Clear-Host; Set-Location -LiteralPath 'C:\\Users\\O''Brien\\my repo' -ErrorAction Stop; " +
          "$env:CLAUDE_CONFIG_DIR = 'C:\\cfg\\it''s'; " +
          "$env:PATH = 'C:\\tools;C:\\Program Files\\nodejs'; " +
          "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd'\r"
      );

      const tempFile = buildClaudeShellCommand('', '', claude, { method: 'temp-file', tempFile: 'C:\\Temp\\.claude-token-1' }, undefined, 'powershell');
      expect(tempFile).toBe(
        'Clear-Host; ' +
          "$env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content -LiteralPath 'C:\\Temp\\.claude-token-1' -Raw -ErrorAction Stop).Trim(); " +
          "Remove-Item -LiteralPath 'C:\\Temp\\.claude-token-1' -Force -ErrorAction SilentlyContinue; " +
          "& 'C:\\Users\\O''Brien\\AppData\\Roaming\\npm\\claude.cmd'\r"
      );
      for (const command of [configDir, tempFile]) {
        expect(command).not.toContain('&&');
      }
    });
  });

  describe("a terminal's shell kind", () => {
    beforeEach(() => {
      mockWriteToPty.mockClear();
      mockGetClaudeCliInvocation.mockReturnValue({ command: '/opt/bin/claude', env: { PATH: '/usr/bin' } });
      mockGetClaudeProfileManager.mockReturnValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });
    });

    it('decides the quoting and the exit marker, whatever the platform', async () => {
      const { invokeClaude } = await import('../cli-integration-handler');

      mockPlatform('win32');
      invokeClaude(createMockTerminal({ shellKind: 'posix' }), undefined, undefined, () => null);
      const posix = mockWriteToPty.mock.calls[0][1] as string;
      expect(posix).toContain("'/opt/bin/claude'");
      expect(posix).toContain("printf '\\033]777;workbench-cli-exit\\007'");

      mockPlatform('linux');
      invokeClaude(createMockTerminal({ shellKind: 'cmd' }), undefined, undefined, () => null);
      const cmd = mockWriteToPty.mock.calls[1][1] as string;
      expect(cmd).toContain('"/opt/bin/claude"');
      expect(cmd).not.toContain('workbench-cli-exit');

      invokeClaude(createMockTerminal({ shellKind: 'powershell' }), 'C:\\repo', undefined, () => null);
      const powershell = mockWriteToPty.mock.calls[2][1] as string;
      expect(powershell.startsWith("Set-Location -LiteralPath 'C:\\repo' -ErrorAction Stop; & '/opt/bin/claude' --session-id ")).toBe(true);
      expect(powershell.endsWith('; [Console]::Write("$([char]27)]777;workbench-cli-exit$([char]7)")\r')).toBe(true);
      // The typed line never holds the marker's escape characters, only the CLI's output can
      expect(powershell).not.toContain('\x1b');
    });

    it('quotes the Graphify hint and the self-improve text for PowerShell', async () => {
      const { invokeCLIAsync } = await import('../cli-integration-handler');
      mockPlatform('win32');
      mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: 'C:\\npm' } });
      mockInitializeClaudeProfileManager.mockResolvedValue({
        getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
        getProfile: vi.fn(),
        getProfileToken: vi.fn(() => null),
        markProfileUsed: vi.fn(),
      });

      await invokeCLIAsync(
        createMockTerminal({
          shellKind: 'powershell',
          graphifyOut: 'C:\\My Repo\\.workbench\\knowledge',
          selfImprove: true,
        }),
        undefined,
        undefined,
        () => null
      );
      const written = mockWriteToPty.mock.calls[0][1] as string;
      expect(written.startsWith("$env:PATH = 'C:\\npm'; & 'claude' --session-id ")).toBe(true);
      expect(written).toMatch(/ --append-system-prompt 'The Graphify knowledge graph of this project is in C:\\My Repo\\\.workbench\\knowledge [^']*'/);
      expect(written).toMatch(/ --append-system-prompt '## Project memory [^']*'/);
    });
  });

  describe('finalizeClaudeInvoke', () => {
    it('should set terminal title to "Claude" for default profile when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 1' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Default', isDefault: true },
        () => mockWindow as any
      );

      expect(terminal.title).toBe('Claude');
    });

    it('should set terminal title to "Claude (ProfileName)" for non-default profile', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 2' });
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn(), isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Work Profile', isDefault: false },
        () => mockWindow as any
      );

      expect(terminal.title).toBe('Claude (Work Profile)');
    });

    it('should send IPC message to renderer when terminal has default name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Use a default terminal name pattern so renaming logic kicks in
      const terminal = createMockTerminal({ title: 'Terminal 3' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        undefined,
        () => mockWindow as any
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.stringContaining('title'),
        terminal.id,
        'Claude'
      );
    });

    it('should NOT rename terminal when already named Claude', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // Terminal already has Claude title - should NOT be renamed
      const terminal = createMockTerminal({ title: 'Claude' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        { name: 'Work Profile', isDefault: false },
        () => mockWindow as any
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('Claude');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should NOT rename terminal with user-customized name', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      // User has customized the terminal name - should NOT be renamed
      const terminal = createMockTerminal({ title: 'My Custom Terminal' });
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend, isDestroyed: () => false }
      };

      finalizeClaudeInvoke(
        terminal,
        undefined,
        () => mockWindow as any
      );

      // Title should remain unchanged
      expect(terminal.title).toBe('My Custom Terminal');
      // No IPC message should be sent for title change
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should persist session when terminal has projectPath', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal({ projectPath: '/tmp/project' });

      finalizeClaudeInvoke(
        terminal,
        undefined,
        () => null
      );

      expect(mockPersistSession).toHaveBeenCalledWith(terminal);
    });

    it('should not crash when getWindow returns null', async () => {
      const { finalizeClaudeInvoke } = await import('../cli-integration-handler');
      const terminal = createMockTerminal();

      expect(() => {
        finalizeClaudeInvoke(
          terminal,
          undefined,
          () => null
        );
      }).not.toThrow();
    });
  });

  describe('shouldAutoRenameTerminal', () => {
    it('should return true for default terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Terminal 1')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 2')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 99')).toBe(true);
      expect(shouldAutoRenameTerminal('Terminal 123')).toBe(true);
    });

    it('should return false for terminals already named Claude', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('Claude')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Work)')).toBe(false);
      expect(shouldAutoRenameTerminal('Claude (Profile Name)')).toBe(false);
    });

    it('should return false for user-customized terminal names', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      expect(shouldAutoRenameTerminal('My Custom Terminal')).toBe(false);
      expect(shouldAutoRenameTerminal('Dev Server')).toBe(false);
      expect(shouldAutoRenameTerminal('Backend')).toBe(false);
    });

    it('should return false for edge cases that do not match the pattern', async () => {
      const { shouldAutoRenameTerminal } = await import('../cli-integration-handler');

      // Terminal 0 is not a valid default (terminals start at 1)
      expect(shouldAutoRenameTerminal('Terminal 0')).toBe(true);  // Pattern matches \d+, so this is valid

      // Lowercase doesn't match
      expect(shouldAutoRenameTerminal('terminal 1')).toBe(false);

      // Extra whitespace doesn't match
      expect(shouldAutoRenameTerminal('Terminal  1')).toBe(false);
      expect(shouldAutoRenameTerminal(' Terminal 1')).toBe(false);
      expect(shouldAutoRenameTerminal('Terminal 1 ')).toBe(false);

      // Tab instead of space doesn't match
      expect(shouldAutoRenameTerminal('Terminal\t1')).toBe(false);
    });
  });
});

describe('agent window sessions', () => {
  beforeEach(() => {
    mockWriteToPty.mockClear();
    mockRecordAgentSession.mockClear();
    mockPlatform('linux');
  });

  it('builds the new session flag only for plain session ids', async () => {
    const { buildNewSessionFlag } = await import('../cli-integration-handler');
    expect(buildNewSessionFlag('0b7c6c1e-1234-4abc-9def-001122334455')).toBe(
      ' --session-id 0b7c6c1e-1234-4abc-9def-001122334455'
    );
    expect(() => buildNewSessionFlag('$(id)')).toThrow();
  });

  it('starts a window session under an id of its own and remembers it for the project', async () => {
    mockGetClaudeCliInvocation.mockReturnValue({ command: 'claude', env: { PATH: '/usr/bin' } });
    mockGetClaudeProfileManager.mockReturnValue({
      getActiveProfile: vi.fn(() => ({
        id: 'work',
        name: 'Work',
        isDefault: false,
        configDir: '~/.claude-profiles/work',
      })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    });

    const terminal = createMockTerminal({ projectPath: '/tmp/project' });
    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(terminal, '/tmp/project', undefined, () => null);

    const written = mockWriteToPty.mock.calls[0][1] as string;
    const sessionId = /--session-id ([0-9a-f-]{36})/.exec(written)?.[1];
    expect(sessionId).toBeTruthy();
    expect(mockRecordAgentSession).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ sessionId, terminalId: terminal.id, configDir: expect.stringContaining('.claude-profiles') })
    );
  });

  it('leaves a resumed task session its own id, and does not count it as a window session', async () => {
    mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: '/usr/bin' } });
    mockInitializeClaudeProfileManager.mockResolvedValue({
      getActiveProfile: vi.fn(() => ({ id: 'default', name: 'Default', isDefault: true })),
      getProfile: vi.fn(),
      getProfileToken: vi.fn(() => null),
      markProfileUsed: vi.fn(),
    });

    const terminal = createMockTerminal({ projectPath: '/tmp/project' });
    const { invokeCLIAsync } = await import('../cli-integration-handler');
    await invokeCLIAsync(terminal, '/tmp/project', undefined, () => null, false, {
      resumeSessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: '~/.claude-profiles/work',
    });

    const written = mockWriteToPty.mock.calls[0][1] as string;
    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).not.toContain('--session-id');
    expect(mockRecordAgentSession).not.toHaveBeenCalled();
  });
});

describe('restoring an agent window', () => {
  beforeEach(() => {
    mockWriteToPty.mockClear();
    mockLastAgentSession.mockReset();
    mockFindSessionTranscript.mockReset();
    mockLatestTranscript.mockReset();
    mockRecordAgentSession.mockClear();
    mockReadAgentSessions.mockReset();
    mockReadAgentSessions.mockResolvedValue([]);
    mockPlatform('linux');
    mockGetClaudeCliInvocationAsync.mockResolvedValue({ command: 'claude', env: { PATH: '/usr/bin' } });
  });

  const resume = async (terminal: TerminalProcess) => {
    const { resumeClaudeAsync } = await import('../cli-integration-handler');
    await resumeClaudeAsync(terminal, () => null);
    return mockWriteToPty.mock.calls[0][1] as string;
  };

  it('picks the window\'s own session up again instead of the directory\'s latest', async () => {
    mockLastAgentSession.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    mockFindSessionTranscript.mockResolvedValue({ file: '/t.jsonl', size: 10, modifiedMs: 1 });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).not.toContain('--continue');
  });

  it('adopts the session it would have continued when the window has none of its own', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockLatestTranscript.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: '/home/user/.claude-profiles/work',
      file: '/t.jsonl',
      size: 10,
      modifiedMs: 1,
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
    expect(written).not.toContain('--continue');
    // Recorded for the project, so what the conversation spends from here on reaches Metrics
    expect(mockRecordAgentSession).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
        configDir: path.resolve('/home/user/.claude-profiles/work'),
        cwd: '/tmp/project',
      })
    );
  });

  it('adopts the directory\'s latest session when its own session transcript is gone', async () => {
    mockLastAgentSession.mockResolvedValue({
      sessionId: 'c0ffee00-1234-4abc-9def-001122334455',
      startedAt: '2026-10-21T09:00:00.000Z',
    });
    mockFindSessionTranscript.mockResolvedValue(null);
    mockLatestTranscript.mockResolvedValue({
      sessionId: '0b7c6c1e-1234-4abc-9def-001122334455',
      configDir: '/home/user/.claude',
      file: '/t.jsonl',
      size: 10,
      modifiedMs: 1,
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--resume 0b7c6c1e-1234-4abc-9def-001122334455');
  });

  it('leaves the conversation another window is in to that window', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockReadAgentSessions.mockResolvedValue([
      { sessionId: 'owned-by-another', terminalId: 'other-window', startedAt: '2026-10-21T09:00:00.000Z' },
    ]);
    mockLatestTranscript.mockResolvedValue(null);

    await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(mockLatestTranscript).toHaveBeenCalledWith(expect.anything(), '/tmp/project', new Set(['owned-by-another']));
  });

  it('continues when the directory holds no session at all', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockLatestTranscript.mockResolvedValue(null);

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--continue');
    expect(mockRecordAgentSession).not.toHaveBeenCalled();
  });

  it('continues without adopting a transcript whose name is not a session id', async () => {
    mockLastAgentSession.mockResolvedValue(undefined);
    mockLatestTranscript.mockResolvedValue({
      sessionId: '../../escape',
      configDir: '/home/user/.claude',
      file: '/t.jsonl',
      size: 10,
      modifiedMs: 1,
    });

    const written = await resume(createMockTerminal({ projectPath: '/tmp/project' }));

    expect(written).toContain('--continue');
    expect(mockRecordAgentSession).not.toHaveBeenCalled();
  });
});
