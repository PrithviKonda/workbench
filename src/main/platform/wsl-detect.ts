/**
 * WSL detection (Windows): whether WSL has a usable Linux distribution, and one probe of that
 * distribution for what Workbench needs to run tools in it (user, home, login PATH, mount root,
 * networking mode, tool paths and versions).
 *
 * Everything is async (wsl.exe through promisified execFile with timeouts); nothing here blocks
 * the main process. Not re-exported from platform/index.ts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fsPromises } from 'fs';
import type { WslAvailability, WslUnavailableReason } from '../../shared/types/settings';
import { isWindows } from './index';
import { getWindowsShellPaths } from './paths';
import { normalizeMountRoot } from './wsl-paths';

const execFileAsync = promisify(execFile);

/** `wsl.exe -l` answers quickly, but may have to start the WSL service first */
const LIST_TIMEOUT_MS = 15_000;
/** The probe starts the distribution; the first VM boot can take around 30 seconds */
const PROBE_TIMEOUT_MS = 60_000;

/** Tools looked up inside the distribution */
export const WSL_PROBE_TOOLS = ['claude', 'codex', 'git', 'gh', 'glab', 'python3', 'node', 'npx', 'graphify'] as const;
export type WslProbeTool = (typeof WSL_PROBE_TOOLS)[number];

export interface WslToolProbe {
  /** Absolute path inside the distribution, null when not found (or only a Windows shim was) */
  path: string | null;
  /** Version number from `--version` (e.g. "2.43.0"), null when unknown */
  version: string | null;
}

export interface WslProbeResult {
  distro: string;
  user: string;
  home: string;
  /** Login shell from the passwd entry */
  loginShell: string;
  /** The login shell's PATH, without the Windows directories WSL appends (under the mount root) */
  loginPath: string;
  /** Where Windows drives are mounted, with a trailing slash ("/mnt/") */
  mountRoot: string;
  /** `wslinfo --networking-mode` ("nat", "mirrored"...), null when unknown */
  networkingMode: string | null;
  /** False when the distribution can't run Windows programs (WSL interop is off) */
  interop?: boolean;
  tools: Record<WslProbeTool, WslToolProbe>;
}

/** Each line of the probe's output starts with this marker, so rc-file noise is ignored */
const MARKER = '\x1e';
const FALLBACK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Path of wsl.exe (System32) */
export function getWslExePath(): string {
  return getWindowsShellPaths().wsl?.[0] ?? 'wsl.exe';
}

/**
 * wsl.exe writes UTF-16LE unless WSL_UTF8=1 is honored (older WSL ignores it), so decode as
 * UTF-16LE when the output has NUL bytes; drop a byte order mark either way.
 */
export function decodeWslOutput(output: Buffer | string | null | undefined): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output.replace(/^\uFEFF/, '').replace(/\0/g, '');
  const text = output.includes(0) ? output.toString('utf16le') : output.toString('utf8');
  return text.replace(/^\uFEFF/, '').replace(/\0/g, '');
}

/** Docker Desktop and Rancher Desktop add distributions of their own that can't run tools */
function isUsableDistro(name: string): boolean {
  return !/^(docker-desktop|rancher-desktop)/i.test(name);
}

/** Distribution names from `wsl.exe -l -q` */
export function parseDistroList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/\s/.test(line));
}

export interface WslVerboseEntry {
  name: string;
  isDefault: boolean;
  state: string;
  version: number;
}

/** Rows of `wsl.exe -l -v` ("* Ubuntu  Running  2"); the header and other lines are skipped */
export function parseVerboseList(text: string): WslVerboseEntry[] {
  const entries: WslVerboseEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const isDefault = line.startsWith('*');
    if (isDefault) line = line.slice(1).trim();
    const tokens = line.split(/\s+/);
    if (tokens.length < 3 || !/^\d+$/.test(tokens[tokens.length - 1])) continue;
    entries.push({
      name: tokens.slice(0, -2).join(' '),
      isDefault,
      state: tokens[tokens.length - 2],
      version: Number(tokens[tokens.length - 1])
    });
  }
  return entries;
}

interface ExecFailure {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  message?: string;
}

/** Map a failed `wsl.exe -l` to the reason shown in Settings */
export function classifyWslListFailure(error: unknown): { reason: WslUnavailableReason; detail?: string } {
  const failure = (error ?? {}) as ExecFailure;
  if (failure.code === 'ENOENT') return { reason: 'not-installed' };
  if (failure.killed || failure.code === 'ETIMEDOUT') return { reason: 'timeout' };

  const output = `${decodeWslOutput(failure.stdout)}\n${decodeWslOutput(failure.stderr)}`.trim();
  const detail = output.split(/\r?\n/).find((line) => line.trim())?.trim() || failure.message;
  if (/no installed distributions|WSL_E_DEFAULT_DISTRO_NOT_FOUND/i.test(output)) {
    return { reason: 'no-distro', detail };
  }
  if (/not installed|--install|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|optional component/i.test(output)) {
    return { reason: 'not-installed', detail };
  }
  return { reason: 'error', detail };
}

async function runWsl(args: string[], timeout: number): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const result = await execFileAsync(getWslExePath(), args, {
    encoding: 'buffer',
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, WSL_UTF8: '1' }
  });
  return { stdout: result.stdout as Buffer, stderr: result.stderr as Buffer };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectWslAvailability(): Promise<WslAvailability> {
  const checkedAt = Date.now();
  const unavailable = (reason: WslUnavailableReason, detail?: string): WslAvailability => ({
    available: false,
    reason,
    ...(detail ? { detail } : {}),
    distros: [],
    checkedAt
  });

  if (!isWindows()) return unavailable('not-windows');

  const wslExe = getWslExePath();
  if (wslExe.includes('\\') && !(await fileExists(wslExe))) return unavailable('not-installed');

  // Listing doesn't boot the VM; -v adds the default distribution and its WSL version
  const [quiet, verbose] = await Promise.allSettled([
    runWsl(['-l', '-q'], LIST_TIMEOUT_MS),
    runWsl(['-l', '-v'], LIST_TIMEOUT_MS)
  ]);
  if (quiet.status === 'rejected') {
    const { reason, detail } = classifyWslListFailure(quiet.reason);
    return unavailable(reason, detail);
  }

  const distros = parseDistroList(decodeWslOutput(quiet.value.stdout)).filter(isUsableDistro);
  if (distros.length === 0) return unavailable('no-distro');

  const entries = verbose.status === 'fulfilled' ? parseVerboseList(decodeWslOutput(verbose.value.stdout)) : [];
  const marked = entries.find((entry) => entry.isDefault && isUsableDistro(entry.name));
  const defaultDistro = marked && distros.includes(marked.name) ? marked.name : distros[0];
  const version = entries.find((entry) => entry.name === defaultDistro)?.version;

  return {
    available: true,
    distros,
    defaultDistro,
    ...(version ? { version } : {}),
    checkedAt
  };
}

let availabilityPromise: Promise<WslAvailability> | null = null;

/**
 * Whether WSL has a distribution Workbench can use. The result is kept; `refresh` checks again
 * (after the user installs WSL or a distribution).
 */
export function checkWslAvailable(options: { refresh?: boolean } = {}): Promise<WslAvailability> {
  if (!availabilityPromise || options.refresh) {
    availabilityPromise = detectWslAvailability().catch((error: unknown) => ({
      available: false,
      reason: 'error' as const,
      detail: error instanceof Error ? error.message : String(error),
      distros: [],
      checkedAt: Date.now()
    }));
  }
  return availabilityPromise;
}

/** Forget the kept availability result (tests) */
export function resetWslAvailabilityCache(): void {
  availabilityPromise = null;
}

/**
 * The probe, run by /bin/sh inside the distribution. Every result line is
 * `<\x1e>key=value`; the login shell runs with -lic so its rc files set PATH as in a terminal.
 * Windows directories (under the mount root) are taken off PATH before tools are looked up, so
 * Windows shims don't count as Linux tools.
 */
export const WSL_PROBE_SCRIPT = [
  `R=$(printf '\\036')`,
  `out() { printf '%s%s=%s\\n' "$R" "$1" "$2"; }`,
  `T=; if command -v timeout >/dev/null 2>&1; then T="timeout 15"; fi`,
  `u=$(id -un 2>/dev/null)`,
  `out user "$u"`,
  `out home "$HOME"`,
  `s=$(getent passwd "$u" 2>/dev/null | cut -d: -f7)`,
  `[ -n "$s" ] || s=/bin/sh`,
  `out shell "$s"`,
  `m=$(wslpath -u 'C:\\' 2>/dev/null)`,
  `out mount "$m"`,
  `[ -n "$m" ] || m=/mnt/c/`,
  `m=\${m%/}; m=\${m%/*}/`,
  `case "$s" in *fish) c='printf "\\x1eP%s\\n" (string join : $PATH)';; *) c='printf "\\036P%s\\n" "$PATH"';; esac`,
  `lp=$($T "$s" -lic "$c" </dev/null 2>/dev/null | tr -d '\\r' | grep "\${R}P" | tail -n 1 | sed "s/^.*\${R}P//")`,
  `out path "$lp"`,
  `set -f; p=; o=$IFS; IFS=:`,
  `for d in $lp; do case "$d" in "$m"?|"$m"?/*|"") ;; *) p="\${p:+$p:}$d";; esac; done`,
  `IFS=$o; set +f`,
  `[ -n "$p" ] || p=${FALLBACK_PATH}`,
  `PATH=$p; export PATH`,
  `for t in ${WSL_PROBE_TOOLS.join(' ')}; do`,
  `  w=$(command -v "$t" 2>/dev/null)`,
  `  out "tool.$t" "$w"`,
  `  case "$w" in /*) out "ver.$t" "$($T "$w" --version </dev/null 2>/dev/null | head -n 1)";; esac`,
  `done`,
  `out net "$(wslinfo --networking-mode 2>/dev/null)"`,
  `if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then out interop 1; else out interop 0; fi`,
  `out done 1`
].join('\n');

/** Whether a path is on a Windows drive (`<mount root><letter>` or below it) */
export function isUnderMountRoot(p: string, mountRoot: string): boolean {
  return p.startsWith(mountRoot) && /^[a-z](?:\/|$)/i.test(p.slice(mountRoot.length));
}

/** First version number in a `--version` line ("git version 2.43.0" -> "2.43.0") */
function extractVersion(line: string | undefined): string | null {
  return line?.match(/\d+(?:\.\d+)+/)?.[0] ?? null;
}

/** Turn the probe's marked output into a result; throws when the probe didn't finish */
export function parseProbeOutput(output: string, distro: string): WslProbeResult {
  const values = new Map<string, string>();
  for (const chunk of output.replace(/\0/g, '').split(MARKER).slice(1)) {
    const line = chunk.split(/\r?\n/)[0];
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  if (!values.has('done') || !values.get('home')) {
    throw new Error('The WSL probe returned no result');
  }

  // "/mnt/c/" -> "/mnt/" ("/c/" -> "/" when drives are mounted at the root)
  const drive = /^(\/(?:.*\/)?)[a-z]$/i.exec((values.get('mount') ?? '').replace(/\/+$/, ''));
  const mountRoot = normalizeMountRoot(drive?.[1]);
  const isWindowsDir = (p: string) => isUnderMountRoot(p, mountRoot);

  const loginPath = (values.get('path') ?? '')
    .split(':')
    .filter((entry) => entry.startsWith('/') && !isWindowsDir(entry))
    .join(':');

  const tools = {} as Record<WslProbeTool, WslToolProbe>;
  for (const tool of WSL_PROBE_TOOLS) {
    const found = values.get(`tool.${tool}`) ?? '';
    const isLinuxTool = found.startsWith('/') && !isWindowsDir(found);
    tools[tool] = {
      path: isLinuxTool ? found : null,
      version: isLinuxTool ? extractVersion(values.get(`ver.${tool}`)) : null
    };
  }

  return {
    distro,
    user: values.get('user') ?? '',
    home: values.get('home') ?? '',
    loginShell: values.get('shell') || '/bin/sh',
    loginPath: loginPath || FALLBACK_PATH,
    mountRoot,
    networkingMode: values.get('net') || null,
    // Older probes (and WSL without binfmt_misc) give no answer: assume interop works, as by default
    interop: values.get('interop') !== '0',
    tools
  };
}

/**
 * Probe a distribution in one wsl.exe call (starts it when it isn't running). Throws when wsl.exe
 * fails, times out or the probe doesn't finish.
 */
export async function probeWsl(distro: string, options: { timeout?: number } = {}): Promise<WslProbeResult> {
  if (!isWindows()) throw new Error('WSL is only available on Windows');
  let stdout: Buffer;
  try {
    ({ stdout } = await runWsl(
      ['-d', distro, '--exec', '/bin/sh', '-c', WSL_PROBE_SCRIPT],
      options.timeout ?? PROBE_TIMEOUT_MS
    ));
  } catch (error) {
    const failure = (error ?? {}) as ExecFailure;
    if (failure.killed) throw new Error(`The WSL probe of ${distro} timed out`);
    // The probe may still have finished (a non-zero exit from the last command)
    const partial = decodeWslOutput(failure.stdout);
    if (partial.includes(`${MARKER}done=`)) return parseProbeOutput(partial, distro);
    throw error instanceof Error ? error : new Error(String(error));
  }
  // The Linux side writes UTF-8; wsl.exe's own messages may be UTF-16, which stripping NULs handles
  return parseProbeOutput(stdout.toString('utf8'), distro);
}
