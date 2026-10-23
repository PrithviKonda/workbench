/**
 * cli-tool-manager while the app runs its tools in WSL: the tools come from the startup probe
 * (source 'wsl'), the user's WSL paths (`wslToolPaths`) are checked inside WSL, Windows detection
 * doesn't run, and native mode keeps using the native paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WslProbeResult } from '../platform/wsl-detect';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn() } }));

const childProcess = vi.hoisted(() => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      setImmediate(() => (callback as (e: Error | null, out: string, err: string) => void)(null, 'git version 2.40.0\n', ''));
    }
    return {};
  }),
  execFileSync: vi.fn(() => 'git version 2.40.0\n')
}));
vi.mock('child_process', () => childProcess);

const envUtils = vi.hoisted(() => ({
  findExecutable: vi.fn(() => null),
  findExecutableAsync: vi.fn(() => Promise.resolve('/native/git')),
  getAugmentedEnv: vi.fn(() => ({ PATH: '' })),
  getAugmentedEnvAsync: vi.fn(() => Promise.resolve({ PATH: '' })),
  shouldUseShell: vi.fn(() => false),
  existsAsync: vi.fn(() => Promise.resolve(false))
}));
vi.mock('../env-utils', () => envUtils);

const windowsPaths = vi.hoisted(() => ({
  getWindowsExecutablePaths: vi.fn(() => []),
  getWindowsExecutablePathsAsync: vi.fn(() => Promise.resolve([])),
  WINDOWS_GIT_PATHS: {},
  WINDOWS_GLAB_PATHS: {},
  findWindowsExecutableViaWhere: vi.fn(() => null),
  findWindowsExecutableViaWhereAsync: vi.fn(() => Promise.resolve(null)),
  isSecurePath: vi.fn(() => true)
}));
vi.mock('../utils/windows-paths', () => windowsPaths);
vi.mock('../utils/homebrew-python', () => ({ findHomebrewPython: vi.fn(() => null) }));

const probe: WslProbeResult = {
  distro: 'Ubuntu',
  user: 'me',
  home: '/home/me',
  loginShell: '/bin/bash',
  loginPath: '/usr/local/bin:/usr/bin:/bin',
  mountRoot: '/mnt/',
  networkingMode: 'nat',
  tools: {
    claude: { path: '/home/me/.local/bin/claude', version: '2.1.0' },
    codex: { path: null, version: null },
    git: { path: '/usr/bin/git', version: '2.43.0' },
    gh: { path: null, version: null },
    glab: { path: null, version: null },
    python3: { path: '/usr/bin/python3', version: '3.12.3' },
    node: { path: null, version: null },
    npx: { path: null, version: null },
    graphify: { path: null, version: null }
  }
};

const runtime = vi.hoisted(() => ({
  wsl: false,
  ready: true,
  configured: 'pwsh' as 'pwsh' | 'wsl'
}));
vi.mock('../platform/shell-runtime', () => ({
  isWslRuntime: () => runtime.wsl,
  getWslInfo: () => (runtime.wsl ? probe : null),
  whenShellRuntimeReady: () => Promise.resolve(),
  getShellRuntimeStatus: () => ({
    supported: true,
    ready: runtime.ready,
    configured: runtime.configured,
    active: runtime.wsl ? 'wsl' : 'pwsh',
    wsl: null
  })
}));

const wslExec = vi.hoisted(() => ({ execInWsl: vi.fn() }));
vi.mock('../platform/wsl-exec-basic', () => wslExec);

import {
  configureTools,
  getToolInfo,
  getToolInfoAsync,
  getToolPath,
  getToolPathAsync,
  isWslToolPath
} from '../cli-tool-manager';

function useWsl(): void {
  runtime.wsl = true;
  runtime.ready = true;
  runtime.configured = 'wsl';
}

function useNative(): void {
  runtime.wsl = false;
  runtime.ready = true;
  runtime.configured = 'pwsh';
}

describe('cli-tool-manager in WSL mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWsl();
    configureTools({});
  });

  it('reports the tools the probe found inside WSL with source wsl', async () => {
    const git = await getToolInfoAsync('git');
    expect(git).toMatchObject({ found: true, path: '/usr/bin/git', version: '2.43.0', source: 'wsl' });
    expect(git.message).toContain('WSL (Ubuntu)');

    const python = await getToolInfoAsync('python');
    expect(python).toMatchObject({ found: true, path: '/usr/bin/python3', version: '3.12.3', source: 'wsl' });

    expect(await getToolPathAsync('claude')).toBe('/home/me/.local/bin/claude');
  });

  it('says a missing tool is not installed in WSL', async () => {
    const gh = await getToolInfoAsync('gh');
    expect(gh).toMatchObject({ found: false, source: 'wsl' });
    expect(gh.message).toBe('GitHub CLI not installed in WSL (Ubuntu)');
    expect(await getToolPathAsync('glab')).toBe('glab');
  });

  it('does not run Windows detection', async () => {
    await getToolInfoAsync('git');
    await getToolPathAsync('gh');
    getToolPath('glab');
    getToolInfo('python');

    expect(envUtils.findExecutableAsync).not.toHaveBeenCalled();
    expect(envUtils.findExecutable).not.toHaveBeenCalled();
    expect(windowsPaths.findWindowsExecutableViaWhereAsync).not.toHaveBeenCalled();
    expect(windowsPaths.findWindowsExecutableViaWhere).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  it('sync callers get what the probe found (python as python3 when missing)', () => {
    expect(getToolPath('git')).toBe('/usr/bin/git');
    expect(getToolPath('gh')).toBe('gh');
    expect(getToolInfo('claude')).toMatchObject({ found: true, source: 'wsl', path: '/home/me/.local/bin/claude' });
  });

  it('uses the WSL set of the configuration, checked with --version inside WSL', async () => {
    wslExec.execInWsl.mockResolvedValue({ stdout: 'git version 2.45.1\n', stderr: '' });
    configureTools({ gitPath: 'C:\\Git\\cmd\\git.exe', wslToolPaths: { git: '/opt/git/bin/git' } });

    const git = await getToolInfoAsync('git');

    expect(wslExec.execInWsl).toHaveBeenCalledWith('/opt/git/bin/git', ['--version']);
    expect(git).toMatchObject({ found: true, path: '/opt/git/bin/git', version: '2.45.1', source: 'user-config' });
    expect(git.message).toContain('in WSL (Ubuntu)');
  });

  it('falls back to the probe when the WSL path fails its check', async () => {
    wslExec.execInWsl.mockRejectedValue(new Error('No such file or directory'));
    configureTools({ wslToolPaths: { git: '/nope/git' } });

    expect(await getToolInfoAsync('git')).toMatchObject({ found: true, path: '/usr/bin/git', source: 'wsl' });
  });

  it('ignores a Windows path in the WSL set', async () => {
    configureTools({ wslToolPaths: { git: 'C:\\Git\\cmd\\git.exe' } });

    expect(await getToolInfoAsync('git')).toMatchObject({ path: '/usr/bin/git', source: 'wsl' });
    expect(wslExec.execInWsl).not.toHaveBeenCalled();
  });

  it('looks a missing tool up again inside WSL on refresh', async () => {
    wslExec.execInWsl.mockImplementation(async (file: string) =>
      file === '/bin/sh'
        ? { stdout: '/usr/bin/gh\n', stderr: '' }
        : { stdout: 'gh version 2.60.0 (2024-10-01)\n', stderr: '' }
    );

    const gh = await getToolInfoAsync('gh', { refresh: true });

    expect(gh).toMatchObject({ found: true, path: '/usr/bin/gh', version: '2.60.0', source: 'wsl' });
  });

  it('does not accept a Windows shim found by a refresh', async () => {
    wslExec.execInWsl.mockResolvedValue({ stdout: '/mnt/c/Program Files/GitHub CLI/gh.exe\n', stderr: '' });

    expect(await getToolInfoAsync('gh', { refresh: true })).toMatchObject({ found: false, source: 'wsl' });
  });

  it('waits while WSL is still being checked: sync callers get the plain name, nothing is cached', () => {
    runtime.wsl = false;
    runtime.ready = false;
    runtime.configured = 'wsl';

    expect(getToolPath('git')).toBe('git');
    expect(getToolInfo('git')).toMatchObject({ found: false, source: 'wsl' });
    expect(envUtils.findExecutable).not.toHaveBeenCalled();
  });
});

describe('cli-tool-manager in native mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNative();
    configureTools({});
  });

  it('keeps native detection and ignores the WSL set', async () => {
    configureTools({ wslToolPaths: { git: '/opt/git/bin/git' } });

    const git = await getToolInfoAsync('git');

    expect(git.source).not.toBe('wsl');
    expect(git.path).not.toBe('/opt/git/bin/git');
    expect(envUtils.findExecutableAsync).toHaveBeenCalled();
    expect(wslExec.execInWsl).not.toHaveBeenCalled();
  });
});

describe('isWslToolPath', () => {
  it('accepts absolute Linux paths only', () => {
    expect(isWslToolPath('/usr/bin/git')).toBe(true);
    expect(isWslToolPath('C:\\Git\\git.exe')).toBe(false);
    expect(isWslToolPath('git')).toBe(false);
    expect(isWslToolPath('/usr/bin/git; rm -rf ~')).toBe(false);
    expect(isWslToolPath('//server/share/git')).toBe(false);
    expect(isWslToolPath(undefined)).toBe(false);
  });
});
