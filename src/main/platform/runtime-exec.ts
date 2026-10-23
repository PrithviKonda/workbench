/**
 * Running Workbench's command-line tools (git, gh, claude, python, glab)
 * =====================================================================
 *
 * Every launch of a tool goes through here, so the place a tool runs is decided in one spot.
 *
 * Native (macOS, Linux, Windows with the pwsh shell): the tool's detected path (cli-tool-manager),
 * Windows `.cmd`/`.bat` shims through a shell with their arguments quoted, everything else
 * straight through execFile/spawn.
 *
 * WSL (Windows with the wsl shell, see shell-runtime.ts): the tool runs inside the WSL
 * distribution through
 *
 *   wsl.exe -d <distro> --cd <cwd inside WSL> --exec /bin/sh -c '<WBPID marker>; export PATH="$WB_PATH"; exec "$@"' sh <tool> <args...>
 *
 * - the tool is the distribution's own (startup probe) or an absolute Linux path the caller gave
 * - arguments that are whole Windows paths (`C:\...`, `\\wsl.localhost\<distro>\...`) are translated
 * - the environment reaches Linux through WSLENV: only variables the caller added or changed
 *   (never PATH or Windows-only ones), path values translated; PATH is the distribution's login
 *   PATH (WB_PATH). Secrets therefore travel in the environment, never in the arguments
 * - the wrapper's first stderr line is the Linux pid (`\x1eWBPID <pid>`), removed before callers
 *   see stderr and used to stop the Linux process (killing only wsl.exe can leave it running)
 *
 * Arguments reach Linux byte for byte through wsl.exe (multiline text, quotes, `$`, backticks,
 * `%VAR%`, unicode, JSON), so nothing needs a temp file on the way.
 *
 * Not re-exported from platform/index.ts, so tests that mock '../platform' wholesale keep working.
 * No sync variants: nothing reachable from the UI may block the main process.
 */

import { execFile, spawn, type ChildProcess, type StdioOptions } from 'child_process';
import { Transform, type Readable, type TransformCallback } from 'stream';
import { promisify } from 'util';
import { getToolPathAsync, type CLITool } from '../cli-tool-manager';
import { getSpawnCommand, shouldUseShell } from '../env-utils';
import { GRACEFUL_KILL_TIMEOUT_MS, killProcessGracefully, type KillProcessOptions } from './index';
import { getWslInfo, isWslRuntime, toRuntimePath, whenShellRuntimeReady } from './shell-runtime';
import { getWslExePath, type WslProbeResult, type WslProbeTool } from './wsl-detect';
import { isWslUncPath } from './wsl-paths';

const execFileAsync = promisify(execFile);

/** A tool Workbench runs (the names cli-tool-manager detects) */
export type RuntimeTool = CLITool;

export interface RunToolOptions {
  cwd?: string;
  /** Full environment for the process (defaults to the app's own) */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
  /**
   * Executable to run instead of the detected one (a path the caller already resolved). In WSL
   * only an absolute Linux path (or a `\\wsl.localhost\...` path) is used; a Windows executable
   * is replaced by the distribution's own tool.
   */
  command?: string;
}

/** Same contract as promisified execFile: errors carry code, stdout and stderr */
export interface RunToolResult {
  stdout: string;
  stderr: string;
}

export interface SpawnToolOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  windowsHide?: boolean;
  /** Executable to run (a path the caller resolved); defaults to the tool's name on PATH. See RunToolOptions.command */
  command?: string;
}

/** One invocation's outcome in a runToolScript batch */
export interface ToolScriptResult {
  /** Exit code (0 on success; 1 when the process failed without one) */
  code: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// Native launches
// =============================================================================

/** How a native executable is launched: through a shell for Windows `.cmd`/`.bat` shims */
interface NativeLaunch {
  file: string;
  args: string[];
  shell: boolean;
}

/** Quote arguments containing spaces when the command runs through a shell (Windows .cmd shims) */
function quoteForShell(args: string[], useShell: boolean): string[] {
  return useShell ? args.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
}

function nativeLaunch(command: string, args: string[]): NativeLaunch {
  const shell = shouldUseShell(command);
  return { file: getSpawnCommand(command), args: quoteForShell(args, shell), shell };
}

// =============================================================================
// WSL launches
// =============================================================================

/** Probe name of each tool inside the distribution */
const WSL_TOOL_NAMES: Record<RuntimeTool, WslProbeTool> = {
  claude: 'claude',
  git: 'git',
  gh: 'gh',
  glab: 'glab',
  python: 'python3',
  codex: 'codex',
};

/**
 * Runs inside WSL as `/bin/sh -c WSL_WRAPPER sh <tool> <args...>`: reports its pid on stderr,
 * switches to the distribution's login PATH and becomes the tool (same pid)
 */
export const WSL_WRAPPER = `printf '\\036WBPID %s\\n' "$$" >&2; export PATH="\${WB_PATH:-$PATH}"; exec "$@"`;

/** The wrapper's pid line (with the line break) */
const PID_LINE = /\x1eWBPID (\d+)\r?\n?/;

/** A whole argument that is a Windows path: `C:\...`, `C:/...`, `\\wsl$\...`, `\\wsl.localhost\...` */
const WINDOWS_PATH_ARG = /^(?:[A-Za-z]:[\\/]|\\\\wsl(?:\$|\.localhost)\\)/i;

/** A value that is one absolute Windows path (not a list) */
const SINGLE_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\wsl(?:\$|\.localhost)\\)[^;\r\n]*$/i;

/** Variables never sent to Linux: Windows-only, or replaced inside WSL */
const NEVER_FORWARD = new Set([
  'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC',
  'PSMODULEPATH', 'PATHEXT', 'WINDIR', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'WSLENV', 'WB_PATH',
  'WSL_UTF8', 'CLAUDE_CODE_GIT_BASH_PATH',
]);

/** Variables holding a path: always sent when set, translated to the WSL path */
const PATH_VARIABLES = new Set(['CLAUDE_CONFIG_DIR', 'GRAPHIFY_OUT']);

/** Variables dropped from the environment in WSL (Windows-only settings of Claude Code) */
const DROPPED_VARIABLES = new Set(['CLAUDE_CODE_GIT_BASH_PATH']);

export interface WslLaunch {
  /** wsl.exe */
  file: string;
  args: string[];
  /** Environment for wsl.exe: the caller's, with translated values, WB_PATH and WSLENV */
  env: NodeJS.ProcessEnv;
  distro: string;
  /** The program run inside WSL */
  tool: string;
}

/** A whole-argument Windows path translated to its WSL path; every other argument unchanged */
export function toRuntimeArg(arg: string): string {
  return WINDOWS_PATH_ARG.test(arg) ? toRuntimePath(arg) : arg;
}

/** The program to run inside WSL for a tool */
function resolveWslTool(tool: RuntimeTool, command: string | undefined, info: WslProbeResult): string {
  if (command?.startsWith('/')) return command;
  if (command && isWslUncPath(command)) {
    const runtimePath = toRuntimePath(command);
    if (runtimePath.startsWith('/')) return runtimePath;
  }
  const name = WSL_TOOL_NAMES[tool];
  return info.tools[name]?.path ?? name;
}

function findKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(env).find((key) => key.toUpperCase() === name);
}

/**
 * The environment wsl.exe runs with: the caller's environment (or the app's), where every
 * variable the caller added or changed is listed in WSLENV so it reaches Linux, path values
 * translated. PATH and Windows-only variables stay on the Windows side; WB_PATH carries the
 * distribution's login PATH for the wrapper.
 */
export function buildWslEnv(env: NodeJS.ProcessEnv | undefined, loginPath: string): NodeJS.ProcessEnv {
  const source = env ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  const forwarded: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (DROPPED_VARIABLES.has(upper)) continue;
    result[key] = value;
    if (NEVER_FORWARD.has(upper) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const isPathVariable = PATH_VARIABLES.has(upper);
    // The app's own environment stays on Windows; only what the caller set goes to Linux
    if (!isPathVariable && process.env[key] === value) continue;
    result[key] = isPathVariable || SINGLE_WINDOWS_PATH.test(value) ? toRuntimePath(value) : value;
    forwarded.push(key);
  }

  result.WB_PATH = loginPath;
  forwarded.push('WB_PATH');
  // wsl.exe's own messages in UTF-8 rather than UTF-16
  result.WSL_UTF8 = '1';

  const existingKey = findKey(source, 'WSLENV');
  const existing = (existingKey ? source[existingKey] : process.env.WSLENV) ?? '';
  if (existingKey) delete result[existingKey];
  const entries = existing.split(':').filter(Boolean);
  const listed = new Set(entries.map((entry) => entry.split('/')[0].toUpperCase()));
  for (const key of forwarded) {
    if (!listed.has(key.toUpperCase())) entries.push(key);
  }
  result.WSLENV = entries.join(':');
  return result;
}

function wslArgs(distro: string, cwd: string | undefined, argv: string[]): string[] {
  return [
    '-d', distro,
    ...(cwd ? ['--cd', toRuntimePath(cwd)] : []),
    '--exec', '/bin/sh', '-c', WSL_WRAPPER, 'sh',
    ...argv,
  ];
}

/** The wsl.exe launch of a tool (WSL mode only) */
export function buildWslLaunch(
  tool: RuntimeTool,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; command?: string },
  info: WslProbeResult
): WslLaunch {
  const runtimeTool = resolveWslTool(tool, options.command, info);
  return {
    file: getWslExePath(),
    args: wslArgs(info.distro, options.cwd, [runtimeTool, ...args.map(toRuntimeArg)]),
    env: buildWslEnv(options.env, info.loginPath),
    distro: info.distro,
    tool: runtimeTool,
  };
}

/** Remove the wrapper's pid line from stderr */
export function stripPidLine(stderr: string): string {
  return stderr.replace(PID_LINE, '');
}

/** An execFile failure with the pid line removed and the message naming the tool instead of wsl.exe */
function cleanWslError(error: unknown, runtimeTool: string, args: string[]): unknown {
  if (!error || typeof error !== 'object') return error;
  const failure = error as Error & { stderr?: unknown; code?: unknown };
  if (typeof failure.stderr === 'string') failure.stderr = stripPidLine(failure.stderr);
  if (typeof failure.message === 'string' && failure.message.startsWith('Command failed:')) {
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    failure.message = `Command failed: ${[runtimeTool, ...args].join(' ')}\n${stderr}`;
  }
  return error;
}

/** Spawned WSL processes: distribution and Linux pid (once the wrapper reported it) */
interface WslProcess {
  distro: string;
  pid: number | null;
}

const wslProcesses = new WeakMap<ChildProcess, WslProcess>();

/** Passes stderr through, minus the wrapper's pid line (reported to `onPid`) */
class PidLineFilter extends Transform {
  private pending: Buffer | null = Buffer.alloc(0);

  constructor(private readonly onPid: (pid: number) => void) {
    super();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.pending === null) {
      callback(null, data);
      return;
    }
    let buffer = Buffer.concat([this.pending, data]);
    // Lines before the pid line (wsl.exe's own warnings) pass through as they complete
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline + 1);
      buffer = buffer.subarray(newline + 1);
      const match = PID_LINE.exec(line.toString('latin1'));
      if (match) {
        this.onPid(Number(match[1]));
        this.pending = null;
        if (buffer.length) this.push(buffer);
        callback();
        return;
      }
      this.push(line);
      newline = buffer.indexOf(0x0a);
    }
    // Give up looking after a lot of output without the line
    if (buffer.length > 64 * 1024) {
      this.pending = null;
      callback(null, buffer);
      return;
    }
    this.pending = buffer;
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.pending;
    this.pending = null;
    callback(null, rest && rest.length ? rest : undefined);
  }
}

/** Track the Linux pid of a spawned WSL process; callers read stderr without the pid line */
function trackWslProcess(child: ChildProcess, distro: string): void {
  const entry: WslProcess = { distro, pid: null };
  wslProcesses.set(child, entry);
  const original = child.stderr;
  if (!original) return;
  const filter = new PidLineFilter((pid) => { entry.pid = pid; });
  original.pipe(filter);
  const writable = child as unknown as { stderr: Readable | null; stdio: Array<unknown> };
  writable.stderr = filter;
  if (Array.isArray(writable.stdio)) writable.stdio[2] = filter;
}

/** Send a signal to a Linux process, its process group and its children */
function signalWslProcess(distro: string, pid: number, signal: 'TERM' | 'KILL'): Promise<unknown> {
  const script = `pkill -${signal} -P ${pid} 2>/dev/null; kill -${signal} -${pid} 2>/dev/null; kill -${signal} ${pid} 2>/dev/null; exit 0`;
  return execFileAsync(getWslExePath(), ['-d', distro, '--exec', '/bin/sh', '-c', script], {
    windowsHide: true,
    timeout: 15_000,
  });
}

/** After KILL, how long to wait before stopping wsl.exe itself */
const WSL_FINAL_GRACE_MS = 2000;

function stopWslProcess(child: ChildProcess, tracked: WslProcess, options: KillProcessOptions): void {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return;
  const fallback = () => {
    if (!exited()) killProcessGracefully(child, options);
  };
  const pid = tracked.pid;
  if (pid === null) {
    // The wrapper hasn't reported its pid: stopping wsl.exe also ends the Linux process
    fallback();
    return;
  }
  signalWslProcess(tracked.distro, pid, 'TERM').catch(fallback);
  const timer = setTimeout(() => {
    if (exited()) return;
    signalWslProcess(tracked.distro, pid, 'KILL')
      .then(() => setTimeout(fallback, WSL_FINAL_GRACE_MS).unref())
      .catch(fallback);
  }, options.timeoutMs ?? GRACEFUL_KILL_TIMEOUT_MS);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run a tool to completion and collect its output.
 * Rejects like execFile does (non-zero exit, timeout, missing executable), with code/stdout/stderr.
 */
export async function runTool(tool: RuntimeTool, args: string[], options: RunToolOptions = {}): Promise<RunToolResult> {
  await whenShellRuntimeReady();
  const info = getWslInfo();
  if (info) {
    const { cwd, env, command, encoding = 'utf8', windowsHide: _windowsHide, ...execOptions } = options;
    const launch = buildWslLaunch(tool, args, { cwd, env, command }, info);
    try {
      const { stdout, stderr } = await execFileAsync(launch.file, launch.args, {
        ...execOptions,
        env: launch.env,
        encoding,
        windowsHide: true,
      });
      return { stdout, stderr: stripPidLine(stderr) };
    } catch (error) {
      throw cleanWslError(error, launch.tool, args);
    }
  }

  const { command, encoding = 'utf8', ...execOptions } = options;
  const launch = nativeLaunch(command ?? await getToolPathAsync(tool), args);
  const { stdout, stderr } = await execFileAsync(launch.file, launch.args, { ...execOptions, encoding, shell: launch.shell });
  return { stdout, stderr };
}

/**
 * Start a tool as a long-running process (streams stay with the caller). Decides native vs WSL
 * from the runtime as it is now, so callers that may run early at startup await
 * whenShellRuntimeReady() first (resolveClaudeEnv does for Claude Code runs).
 */
export function spawnTool(tool: RuntimeTool, args: string[], options: SpawnToolOptions = {}): ChildProcess {
  const info = isWslRuntime() ? getWslInfo() : null;
  if (info) {
    const launch = buildWslLaunch(tool, args, options, info);
    const child = spawn(launch.file, launch.args, {
      env: launch.env,
      ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
      windowsHide: true,
    });
    trackWslProcess(child, launch.distro);
    return child;
  }

  const { command, ...spawnOptions } = options;
  const launch = nativeLaunch(command ?? tool, args);
  return spawn(launch.file, launch.args, { ...spawnOptions, shell: launch.shell });
}

/**
 * Stop a process started with spawnTool: graceful first, forced after a grace period.
 * In WSL the Linux process (and its process group and children) gets TERM, then KILL after the
 * grace period; wsl.exe itself is stopped when that doesn't end it.
 */
export function killRuntimeProcess(child: ChildProcess, options: KillProcessOptions = {}): void {
  const tracked = wslProcesses.get(child);
  if (tracked) {
    stopWslProcess(child, tracked, options);
    return;
  }
  killProcessGracefully(child, options);
}

/** POSIX shell quoting (single quotes) */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Marker before each invocation's output in a WSL batch: `\x1eWBRES <code> <stdout bytes> <stderr bytes>` */
const RESULT_HEADER = /\x1eWBRES (\d+) (\d+) (\d+)\n/g;

/** Script running each invocation and printing its exit code and output sizes, then its output */
function buildBatchScript(runtimeTool: string, invocations: string[][]): string {
  return [
    `d=$(mktemp -d) || exit 1`,
    `r() { "$@" >"$d/o" 2>"$d/e" </dev/null; c=$?; printf '\\036WBRES %s %s %s\\n' "$c" $(wc -c <"$d/o") $(wc -c <"$d/e"); cat "$d/o" "$d/e"; }`,
    ...invocations.map((args) => `r ${[runtimeTool, ...args.map(toRuntimeArg)].map(shellQuote).join(' ')}`),
    `rm -rf "$d"`,
  ].join('\n');
}

/** Results of a WSL batch from its output; invocations without output count as failed */
export function parseBatchOutput(
  output: Buffer,
  count: number,
  encoding: BufferEncoding,
  failure: string
): ToolScriptResult[] {
  const results: ToolScriptResult[] = [];
  const text = output.toString('latin1');
  let offset = 0;
  while (results.length < count) {
    RESULT_HEADER.lastIndex = offset;
    const header = RESULT_HEADER.exec(text);
    if (!header) break;
    const start = header.index + header[0].length;
    const outBytes = Number(header[2]);
    const errBytes = Number(header[3]);
    results.push({
      code: Number(header[1]),
      stdout: output.subarray(start, start + outBytes).toString(encoding),
      stderr: output.subarray(start + outBytes, start + outBytes + errBytes).toString(encoding),
    });
    offset = start + outBytes + errBytes;
  }
  while (results.length < count) results.push({ code: 1, stdout: '', stderr: failure });
  return results;
}

/**
 * Run several invocations of one tool and collect each one's outcome (failures included, in
 * order). Natively they run one after the other; in WSL they share one launch.
 */
export async function runToolScript(
  tool: RuntimeTool,
  invocations: string[][],
  options: RunToolOptions = {}
): Promise<ToolScriptResult[]> {
  await whenShellRuntimeReady();
  const info = getWslInfo();
  if (info) {
    if (invocations.length === 0) return [];
    const { cwd, env, command, encoding = 'utf8', windowsHide: _windowsHide, ...execOptions } = options;
    const runtimeTool = resolveWslTool(tool, command, info);
    const args = wslArgs(info.distro, cwd, ['/bin/sh', '-c', buildBatchScript(runtimeTool, invocations)]);
    let stdout: Buffer;
    let failure = '';
    try {
      ({ stdout } = await execFileAsync(getWslExePath(), args, {
        maxBuffer: 64 * 1024 * 1024,
        ...execOptions,
        env: buildWslEnv(env, info.loginPath),
        encoding: 'buffer',
        windowsHide: true,
      }));
    } catch (error) {
      const partial = (error as { stdout?: unknown; stderr?: unknown }).stdout;
      const stderr = (error as { stderr?: unknown }).stderr;
      stdout = Buffer.isBuffer(partial) ? partial : Buffer.alloc(0);
      failure = (Buffer.isBuffer(stderr) ? stripPidLine(stderr.toString('utf8')) : '').trim()
        || (error instanceof Error ? error.message : String(error));
    }
    return parseBatchOutput(stdout, invocations.length, encoding, failure || 'The command did not run');
  }

  const command = options.command ?? await getToolPathAsync(tool);
  const results: ToolScriptResult[] = [];
  for (const args of invocations) {
    try {
      const { stdout, stderr } = await runTool(tool, args, { ...options, command });
      results.push({ code: 0, stdout, stderr });
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      results.push({
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
        stderr: typeof failure.stderr === 'string' ? failure.stderr : String(error),
      });
    }
  }
  return results;
}
