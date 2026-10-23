/**
 * Agent windows in the WSL runtime (Windows host, the window's shell inside WSL, shellKind 'posix'):
 * - bash syntax with Linux paths: cd, CLAUDE_CONFIG_DIR, the token file, Graphify and theme paths
 * - the distribution's claude without the Windows PATH prefix, started with `env -u ANTHROPIC_API_KEY`
 * - the CLI exit marker after the command, so the window closes when claude exits
 * - a fish login shell gets the whole line through `bash -c`
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as pty from '@lydell/node-pty';
import type { TerminalProcess } from '../types';

const INFO = {
  distro: 'Ubuntu',
  user: 'me',
  home: '/home/me',
  loginShell: '/bin/bash',
  loginPath: '/home/me/.local/bin:/usr/bin:/bin',
  mountRoot: '/mnt/',
  networkingMode: 'nat',
  tools: {},
};

vi.mock('../../claude-code/env', () => ({ pickEngine: vi.fn(async () => 'claude') }));
vi.mock('../../platform', () => ({
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  isUnix: () => false,
  getCurrentOS: () => 'win32',
}));
vi.mock('../../platform/shell-runtime', async () => {
  const { windowsToWsl, wslToWindows } = await vi.importActual<typeof import('../../platform/wsl-paths')>(
    '../../platform/wsl-paths'
  );
  return {
    whenShellRuntimeReady: async () => ({}),
    isWslRuntime: () => true,
    getWslInfo: () => INFO,
    toRuntimePath: (p: string) => windowsToWsl(p, INFO) ?? p,
    toHostPath: (p: string) => wslToWindows(p, INFO),
  };
});

const CLAUDE = '/home/me/.local/bin/claude';
const mockInvocation = vi.fn(async () => ({ command: CLAUDE, env: { PATH: 'C:\\Windows\\System32' } }));
vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocation: vi.fn(),
  getClaudeCliInvocationAsync: () => mockInvocation(),
}));

const profileManager = {
  getActiveProfile: vi.fn(),
  getProfile: vi.fn(),
  getProfileToken: vi.fn(),
  markProfileUsed: vi.fn(),
};
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => profileManager,
  initializeClaudeProfileManager: async () => profileManager,
}));

const { mockWriteFile } = vi.hoisted(() => ({ mockWriteFile: vi.fn(async () => undefined) }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeFileSync: vi.fn(), promises: { ...actual.promises, writeFile: mockWriteFile } };
});

vi.mock('../session-handler', () => ({ persistSession: vi.fn(), persistSessionAsync: vi.fn() }));
vi.mock('../../agent-session-store', () => ({
  recordAgentSessionAsync: vi.fn(),
  lastAgentSession: vi.fn(async () => undefined),
  readAgentSessions: vi.fn(async () => []),
}));
vi.mock('../../claude-code/session-spending', () => ({
  findSessionTranscript: vi.fn(async () => null),
  latestTranscript: vi.fn(async () => null),
}));
vi.mock('../../claude-profile/profile-config-dirs', () => ({ claudeConfigDirs: () => [] }));
const mockWriteToPty = vi.fn();
vi.mock('../pty-manager', () => ({ writeToPty: (...args: unknown[]) => mockWriteToPty(...args) }));
const mockSettings = vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined);
vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: () => mockSettings(),
  readSettingsFile: vi.fn(() => undefined),
}));
// The theme file's path inside WSL (claude-cli-theme.test covers the translation)
vi.mock('../../claude-cli-theme', () => ({
  claudeThemeFlag: (kind: string) =>
    kind === 'posix' ? " --settings '/mnt/c/Users/me/AppData/Roaming/Workbench/claude-theme-dark.json'" : '',
}));

import {
  buildCliLine,
  invokeCLIAsync,
  resolveSessionConfigDir,
  resumeClaudeAsync,
} from '../cli-integration-handler';
import { quoteForFish } from '../wsl-terminal';

const MARKER = "; printf '\\033]777;workbench-cli-exit\\007'";
const PROJECT = 'C:\\Users\\me\\my repo';
const LINUX_PROJECT = '/mnt/c/Users/me/my repo';

const createTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: { write: vi.fn() } as unknown as pty.IPty,
  outputBuffer: '',
  isCLIMode: false,
  title: 'Terminal 1',
  cwd: PROJECT,
  projectPath: PROJECT,
  shellKind: 'posix',
  ...overrides,
});

function written(): string {
  expect(mockWriteToPty).toHaveBeenCalledTimes(1);
  return mockWriteToPty.mock.calls[0][1] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.mockImplementation(async () => undefined);
  profileManager.getActiveProfile.mockReturnValue({ id: 'default', name: 'Default', isDefault: true });
  profileManager.getProfile.mockReturnValue(undefined);
  profileManager.getProfileToken.mockReturnValue(null);
});

describe('agent windows in WSL', () => {
  it("starts the distribution's claude in the Linux path of the project, without the Windows PATH", async () => {
    const terminal = createTerminal({ graphifyOut: `${PROJECT}\\.workbench\\knowledge` });
    await invokeCLIAsync(terminal, PROJECT, undefined, () => null);

    const line = written();
    expect(line.startsWith(`cd '${LINUX_PROJECT}' && env -u ANTHROPIC_API_KEY '${CLAUDE}' --session-id `)).toBe(true);
    expect(line).not.toContain('PATH=');
    expect(line).not.toContain('C:\\');
    expect(line).toContain(`The Graphify knowledge graph of this project is in ${LINUX_PROJECT}/.workbench/knowledge`);
    expect(line).toContain(`--graph ${LINUX_PROJECT}/.workbench/knowledge/graph.json`);
    expect(line).toContain(" --settings '/mnt/c/Users/me/AppData/Roaming/Workbench/claude-theme-dark.json'");
    expect(line.endsWith(`${MARKER}\r`)).toBe(true);
  });

  it("runs a profile's config dir as its Linux path, in bash syntax", async () => {
    profileManager.getProfile.mockReturnValue({
      id: 'work',
      name: 'Work',
      isDefault: false,
      configDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-work',
    });
    const terminal = createTerminal({ selfImprove: true });
    await invokeCLIAsync(terminal, PROJECT, 'work', () => null);

    const line = written();
    expect(line).toContain(
      `clear && cd '${LINUX_PROJECT}' && HISTFILE= HISTCONTROL=ignorespace CLAUDE_CONFIG_DIR='/home/me/.claude-work' bash -c "exec env -u ANTHROPIC_API_KEY '${CLAUDE}' --session-id `
    );
    // Backticks of the self-improve text are escaped inside bash -c "..." (no command substitution)
    expect(line).toContain('\\`type: feedback\\`');
    expect(line.endsWith(`"${MARKER}\r`)).toBe(true);
  });

  it('writes the token file into the Linux home and sources its Linux path', async () => {
    profileManager.getProfile.mockReturnValue({ id: 'legacy', name: 'Legacy', isDefault: false });
    profileManager.getProfileToken.mockReturnValue('tok-123');
    await invokeCLIAsync(createTerminal(), PROJECT, 'legacy', () => null);

    const [file, contents] = mockWriteFile.mock.calls[0] as unknown as [string, string];
    expect(file.replace(/\//g, '\\')).toMatch(/^\\\\wsl\.localhost\\Ubuntu\\home\\me\\\.claude-token-\d+-[0-9a-f]{16}$/);
    expect(contents).toBe("export CLAUDE_CODE_OAUTH_TOKEN='tok-123'\n");
    const linuxFile = `/home/me/${file.replace(/\\/g, '/').split('/').pop()}`;
    expect(written()).toContain(`source '${linuxFile}' && rm -f '${linuxFile}' && exec env -u ANTHROPIC_API_KEY '${CLAUDE}'`);
  });

  it("resumes a session on its config dir's Linux path", async () => {
    await invokeCLIAsync(createTerminal(), PROJECT, undefined, () => null, false, {
      resumeSessionId: 'abc-123',
      configDir: '~/.claude-work',
    });
    const line = written();
    expect(line).toContain("CLAUDE_CONFIG_DIR='/home/me/.claude-work'");
    expect(line).toContain(`env -u ANTHROPIC_API_KEY '${CLAUDE}' --resume abc-123`);
  });

  it("treats the Linux home's ~/.claude as the default config dir", () => {
    expect(resolveSessionConfigDir('~/.claude')).toBeUndefined();
    expect(resolveSessionConfigDir('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude')).toBeUndefined();
    expect(resolveSessionConfigDir('~/.claude-work')?.replace(/\//g, '\\')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-work'
    );
  });

  it('continues the latest session from the Linux path of the project', async () => {
    await resumeClaudeAsync(createTerminal({ projectPath: undefined }), () => null);
    expect(written()).toMatch(
      new RegExp(`^cd '${LINUX_PROJECT}' && env -u ANTHROPIC_API_KEY '${CLAUDE}' --continue .*${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r$`)
    );
  });

  it("runs a custom CLI's Windows path through its /mnt path", async () => {
    mockSettings.mockImplementation(async () => ({ preferredCLI: 'custom', customCLIPath: 'C:\\Tools\\my cli.exe' }));
    await invokeCLIAsync(createTerminal(), PROJECT, undefined, () => null);
    expect(written()).toBe(`cd '${LINUX_PROJECT}' && '/mnt/c/Tools/my cli.exe'${MARKER}\r`);
  });

  it('runs the whole line through bash -c in a fish window', async () => {
    await invokeCLIAsync(createTerminal({ wrapInBash: true }), PROJECT, undefined, () => null);
    const line = written();
    expect(line.startsWith(" bash -c 'cd \\'/mnt/c/Users/me/my repo\\' && env -u ANTHROPIC_API_KEY \\'")).toBe(true);
    expect(line.endsWith(`\\'\\\\033]777;workbench-cli-exit\\\\007\\''\r`)).toBe(true);
  });
});

describe('buildCliLine', () => {
  it('adds the exit marker, and quotes the line for fish when the window runs fish', () => {
    const command = "cd '/mnt/c/it'\\''s' && claude --append-system-prompt 'a `b` $c'";
    expect(buildCliLine({ shellKind: 'posix' }, command)).toBe(`${command}${MARKER}\r`);
    expect(buildCliLine({ shellKind: 'posix', wrapInBash: true }, `${command}\r`)).toBe(
      ` bash -c ${quoteForFish(`${command}${MARKER}`)}\r`
    );
  });
});
