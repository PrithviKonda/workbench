/**
 * Claude Code CLI process
 * =======================
 *
 * Spawns `claude -p` (headless mode), feeds the prompt on stdin and reads the newline-delimited
 * JSON stream (`--output-format stream-json`) or the single JSON result (`--output-format json`).
 * Never blocks the main process: everything is async child-process I/O.
 */

import type { ChildProcess } from 'child_process';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import type { ClaudeResultMessage, ClaudeStreamMessage, ClaudeUserContentBlock } from './stream-types';
import { createCodexTranslator, toCodexInvocation, type CodexTranslator } from './codex';
import { readCodexRateLimits, readCodexThreadUsage, defaultCodexHome } from '../claude-profile/codex-accounts';
import type { EngineKind } from './env';

export interface ClaudeProcessOptions {
  command: string;
  /** Claude Code arguments (translated to `codex exec` when `engine` is codex) */
  args: string[];
  /** CLI that `command` runs (from resolveClaudeEnv; default claude) */
  engine?: EngineKind;
  cwd: string;
  env: Record<string, string>;
  /**
   * Prompt to send. A string is passed as plain text on stdin; content blocks (text + images)
   * are sent as one stream-json user message, which requires `--input-format stream-json`.
   */
  input: string | ClaudeUserContentBlock[];
  /** Called for every parsed stream-json line */
  onMessage?: (message: ClaudeStreamMessage) => void;
  /** Called with stderr chunks (CLI warnings, errors before the run starts) */
  onStderr?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  /** Kill the process after this many milliseconds */
  timeoutMs?: number;
}

interface ClaudeProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The final `result` message, when the CLI produced one */
  result?: ClaudeResultMessage;
  /** Last ~8KB of stderr */
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

/** Handle on a running Claude Code process */
export interface ClaudeProcessHandle {
  child: ChildProcess;
  done: Promise<ClaudeProcessResult>;
  /** Stop the run (SIGINT first so Claude Code ends the turn, then force) */
  stop: () => void;
}

/** Spawn the Claude Code CLI and collect its output */
export function startClaudeProcess(options: ClaudeProcessOptions): ClaudeProcessHandle {
  // Codex: same arguments and messages for the callers, translated both ways (codex.ts)
  let codex: { translator: CodexTranslator; cleanup: () => void; stdin: string } | null = null;
  let args = options.args;
  let env = options.env;
  if (options.engine === 'codex') {
    const codexHome = options.env.CODEX_HOME || defaultCodexHome();
    const invocation = toCodexInvocation(options.args, options.input, codexHome);
    const resumeIndex = options.args.indexOf('--resume');
    const resumeId = resumeIndex === -1 ? undefined : options.args[resumeIndex + 1];
    args = invocation.args;
    env = { ...options.env, ...invocation.env };
    codex = {
      stdin: invocation.stdin,
      cleanup: invocation.cleanup,
      translator: createCodexTranslator({
        model: invocation.model,
        partial: invocation.partial,
        structured: invocation.structured,
        cwd: options.cwd,
        baselineUsage: resumeId ? readCodexThreadUsage(codexHome, resumeId) : null,
        resetAt: () => {
          const limits = readCodexRateLimits(codexHome);
          return limits?.sessionPercent !== undefined && limits.sessionPercent >= 100 ? limits.sessionResetAt : limits?.weeklyResetAt ?? limits?.sessionResetAt;
        },
      }),
    };
  }
  const child = spawnTool(options.engine ?? 'claude', args, {
    command: options.command,
    cwd: options.cwd,
    env,
    windowsHide: true,
    stdio: 'pipe',
  });

  let aborted = false;
  let timedOut = false;
  const stop = () => {
    if (child.exitCode !== null || child.killed) return;
    killRuntimeProcess(child, { debugPrefix: '[ClaudeCode]' });
  };

  const done = new Promise<ClaudeProcessResult>((resolve) => {
    let stdoutBuffer = '';
    let stderr = '';
    let result: ClaudeResultMessage | undefined;
    let timer: NodeJS.Timeout | undefined;

    const deliver = (message: ClaudeStreamMessage) => {
      if (message.type === 'result') result = message as ClaudeResultMessage;
      try {
        options.onMessage?.(message);
      } catch (error) {
        console.error('[ClaudeCode] onMessage handler failed:', error);
      }
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return;
      let message: ClaudeStreamMessage;
      try {
        message = JSON.parse(trimmed) as ClaudeStreamMessage;
      } catch {
        return; // Not JSON (CLI warning)
      }
      if (codex) {
        for (const translated of codex.translator.translate(message as Parameters<CodexTranslator['translate']>[0])) deliver(translated);
      } else {
        deliver(message);
      }
    };

    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        handleLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
      options.onStderr?.(chunk);
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onAbort);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      stdoutBuffer = '';
      if (codex) {
        for (const translated of codex.translator.finish(stderr)) deliver(translated);
        codex.cleanup();
      }
      resolve({ exitCode, signal, result, stderr, aborted, timedOut });
    };
    child.on('error', (error) => {
      stderr = (stderr + `\n${error.message}`).slice(-8000);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    // Send the prompt and close stdin so the run starts
    const input = codex
      ? codex.stdin
      : typeof options.input === 'string'
      ? options.input
      : `${JSON.stringify({ type: 'user', message: { role: 'user', content: options.input } })}\n`;
    child.stdin?.on('error', () => { /* process exited before reading stdin */ });
    child.stdin?.end(input);
  });

  if (options.abortSignal?.aborted) {
    aborted = true;
    stop();
  }

  return { child, done, stop };
}
