/**
 * One-shot Claude Code calls
 * ==========================
 *
 * Small headless runs for app utilities (task triage, titles, terminal names, PR descriptions,
 * merge conflict resolution). Each call is a single `claude -p --output-format json` run that
 * is not saved as a session. Tools are off unless the caller asks for read-only exploration.
 */

import { resolveClaudeEnv, type EngineKind } from './env';
import { startClaudeProcess } from './process';
import { isClaudeModel, type ClaudeEffort, type ClaudeModelAlias, type RouteStep } from '../../shared/types/claude-code';
import { routeFor } from './routing';
import type { ClaudeUserContentBlock } from './stream-types';

/** Built-in tools for read-only exploration of a project */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export interface RunClaudeTextOptions {
  prompt: string | ClaudeUserContentBlock[];
  /** Appended to Claude Code's default system prompt */
  appendSystemPrompt?: string;
  /** Replaces Claude Code's system prompt (for non-coding utilities such as naming) */
  systemPrompt?: string;
  model?: ClaudeModelAlias | string;
  effort?: ClaudeEffort;
  /** JSON Schema: the run returns validated `structured` output */
  jsonSchema?: Record<string, unknown>;
  /** Working directory (defaults to the process cwd) */
  cwd?: string;
  /** Built-in tools to enable; empty (default) disables all tools */
  tools?: readonly string[];
  /** Extra allow rules, e.g. "Bash(git log *)" */
  allowedTools?: readonly string[];
  /** Expand Claude Code's slash commands in the prompt (off by default, so prompts stay literal) */
  slashCommands?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Claude profile to use (defaults to the best available one) */
  profileId?: string;
  /** Kind of work, so Settings > Agents > Model routing can pick the engine, model and effort */
  step?: RouteStep;
  /** Run on this engine; a route for the other engine (or its model) is then ignored */
  engine?: EngineKind;
  /** The task's spec dir, for routes that differ by task size */
  specDir?: string;
}

export interface RunClaudeTextResult {
  text: string;
  structured?: unknown;
  sessionId?: string;
  costUsd?: number;
}

/** Error from a one-shot Claude Code run */
class ClaudeCodeRunError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = 'ClaudeCodeRunError';
  }
}

/** Run Claude Code once and return its answer */
export async function runClaudeText(options: RunClaudeTextOptions): Promise<RunClaudeTextResult> {
  const routed = options.step ? await routeFor(options.step, options.specDir) : {};
  const otherEngine = options.engine && (
    (routed.engine && routed.engine !== options.engine)
    || (routed.model && isClaudeModel(routed.model) !== (options.engine === 'claude'))
  );
  const route = otherEngine ? {} : routed;
  const model = route.model ?? options.model ?? 'haiku';
  const effort = route.effort ?? options.effort;
  const { command, env, engine } = await resolveClaudeEnv({ profileId: options.profileId, engine: options.engine ?? route.engine });
  const tools = options.tools ?? [];
  const usesContentBlocks = typeof options.prompt !== 'string';

  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--model', model,
    '--tools', tools.length > 0 ? tools.join(',') : '',
  ];
  if (!options.slashCommands) args.push('--disable-slash-commands');
  if (usesContentBlocks) args.push('--input-format', 'stream-json', '--verbose');
  if (effort) args.push('--effort', effort);
  if (options.allowedTools?.length) args.push('--allowedTools', ...options.allowedTools);
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  if (options.jsonSchema) args.push('--json-schema', JSON.stringify(options.jsonSchema));
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);

  const handle = startClaudeProcess({
    command,
    engine,
    args,
    cwd: options.cwd ?? process.cwd(),
    env,
    input: options.prompt,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
  });
  const outcome = await handle.done;

  if (outcome.aborted) {
    const error = new ClaudeCodeRunError('Claude Code run was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  if (outcome.timedOut) throw new ClaudeCodeRunError('Claude Code run timed out', outcome.stderr);

  const result = outcome.result;
  if (!result) {
    throw new ClaudeCodeRunError(outcome.stderr.trim() || `Claude Code exited with code ${outcome.exitCode}`, outcome.stderr);
  }
  if (result.is_error || result.subtype !== 'success') {
    const message = result.errors?.join('; ') || result.result || `Claude Code failed (${result.subtype})`;
    throw new ClaudeCodeRunError(message, outcome.stderr);
  }
  return {
    text: result.result ?? '',
    structured: result.structured_output,
    sessionId: result.session_id,
    costUsd: result.total_cost_usd,
  };
}
