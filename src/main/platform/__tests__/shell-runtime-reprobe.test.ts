/**
 * Looking up the tools in WSL again (tools installed after startup), and the line-ending
 * difference shown in the runtime status
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WslProbeResult } from '../wsl-detect';

vi.mock('../index', () => ({ isWindows: () => true }));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const detect = vi.hoisted(() => ({ checkWslAvailable: vi.fn(), probeWsl: vi.fn() }));
vi.mock('../wsl-detect', () => detect);

import {
  getShellRuntimeStatus,
  getWslInfo,
  initShellRuntime,
  reprobeWslTools,
  resetShellRuntimeForTests,
  setAutocrlfMismatch,
} from '../shell-runtime';

const tool = (path: string | null, version: string | null = null) => ({ path, version });
const probe = (graphify: string | null): WslProbeResult => ({
  distro: 'Ubuntu',
  user: 'me',
  home: '/home/me',
  loginShell: '/bin/bash',
  loginPath: '/usr/bin:/bin',
  mountRoot: '/mnt/',
  networkingMode: 'nat',
  tools: {
    claude: tool(null), git: tool('/usr/bin/git', '2.43.0'), gh: tool(null), glab: tool(null),
    codex: { path: null, version: null },
    python3: tool(null), node: tool(null), npx: tool(null), graphify: tool(graphify),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetShellRuntimeForTests();
  detect.checkWslAvailable.mockResolvedValue({ available: true, distros: ['Ubuntu'], defaultDistro: 'Ubuntu', version: 2, checkedAt: 1 });
});

describe('reprobeWslTools', () => {
  it('replaces the probe in WSL', async () => {
    detect.probeWsl.mockResolvedValueOnce(probe(null)).mockResolvedValueOnce(probe('/home/me/.local/bin/graphify'));
    await initShellRuntime('wsl');
    expect(getWslInfo()?.tools.graphify.path).toBeNull();

    await reprobeWslTools();
    expect(detect.probeWsl).toHaveBeenLastCalledWith('Ubuntu');
    expect(getWslInfo()?.tools.graphify.path).toBe('/home/me/.local/bin/graphify');
    expect(getShellRuntimeStatus().active).toBe('wsl');
  });

  it('keeps the earlier probe when the new one fails', async () => {
    detect.probeWsl.mockResolvedValueOnce(probe('/usr/bin/graphify')).mockRejectedValueOnce(new Error('timed out'));
    await initShellRuntime('wsl');
    await reprobeWslTools();
    expect(getWslInfo()?.tools.graphify.path).toBe('/usr/bin/graphify');
  });

  it('does nothing natively', async () => {
    await initShellRuntime('pwsh');
    await reprobeWslTools();
    expect(detect.probeWsl).not.toHaveBeenCalled();
  });
});

describe('core.autocrlf difference in the status', () => {
  it('is shown while running in WSL', async () => {
    detect.probeWsl.mockResolvedValue(probe(null));
    await initShellRuntime('wsl');
    setAutocrlfMismatch({ windows: 'true', wsl: 'input' });
    expect(getShellRuntimeStatus().autocrlfMismatch).toEqual({ windows: 'true', wsl: 'input' });
    setAutocrlfMismatch(null);
    expect(getShellRuntimeStatus().autocrlfMismatch).toBeUndefined();
  });
});
