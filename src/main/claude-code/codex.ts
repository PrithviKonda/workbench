/**
 * Codex engine
 * ============
 *
 * Runs OpenAI's Codex CLI (`codex exec --json`, signed in with ChatGPT or an OpenAI API key) in
 * place of `claude -p`, behind the same seam: `startClaudeProcess` hands the Claude Code arguments
 * the callers built to `toCodexInvocation`, and every Codex JSONL event goes through
 * `createCodexTranslator`, which emits the Claude Code stream-json messages the callers already
 * read (init, assistant text and tool use, tool results, rate limits, the final result). So
 * tasks, triage, Insights and the one-shot utilities run on Codex without knowing it.
 *
 * Mapping, Claude Code -> Codex:
 * - model aliases (haiku/sonnet/opus/fable) -> Codex models by tier, from `models_cache.json`
 * - `--effort` -> `model_reasoning_effort` (clamped to what the model supports)
 * - `--json-schema` -> `--output-schema` (made strict, which OpenAI requires)
 * - permission modes -> `sandbox_mode` / `--dangerously-bypass-approvals-and-sandbox`
 * - system prompts -> prepended to the prompt; CLAUDE.md -> read as project instructions
 * - `--mcp-config` -> `mcp_servers.*` overrides (secrets go through the environment)
 * - `--resume <id>` -> `exec resume <id>`; image blocks -> `-i <file>`
 * - Claude Code's task list -> Workbench's own TaskCreate/TaskUpdate MCP tools (see codexTaskListTools)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { requestCostUsd } from './session-pricing';
import type { ClaudeResultMessage, ClaudeStreamMessage, ClaudeUserContentBlock } from './stream-types';
import type { ServedTool } from '../insights/task-tools-server';

// =============================================================================
// Models
// =============================================================================

interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
  efforts: string[];
}

/** Codex's listed models, best first (`$CODEX_HOME/models_cache.json`, which Codex keeps fresh) */
export function readCodexModels(codexHome: string): CodexModel[] {
  try {
    const cache = JSON.parse(readFileSync(path.join(codexHome, 'models_cache.json'), 'utf-8')) as {
      models?: Array<{
        slug: string;
        display_name?: string;
        description?: string;
        visibility?: string;
        priority?: number;
        supported_reasoning_levels?: Array<{ effort: string }>;
      }>;
    };
    return (cache.models ?? [])
      .filter((m) => m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => ({
        slug: m.slug,
        displayName: m.display_name ?? m.slug,
        description: m.description ?? '',
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      }));
  } catch {
    return [];
  }
}

const CLAUDE_TIERS = new Set(['haiku', 'sonnet', 'opus', 'fable']);

/**
 * Codex model for a Claude model alias (triage and Settings speak in Claude's tiers): opus/fable
 * get the flagship, sonnet the next model, haiku the newest fast/affordable one. Anything else is
 * taken as a Codex model name. Undefined leaves the choice to Codex's own config.
 */
export function codexModelFor(model: string | undefined, models: CodexModel[]): string | undefined {
  if (!model) return undefined;
  const alias = model.toLowerCase().replace(/\[.*\]$/, '');
  if (!CLAUDE_TIERS.has(alias)) return model.startsWith('claude-') ? models[0]?.slug : model;
  if (models.length === 0) return undefined;
  if (alias === 'opus' || alias === 'fable') return models[0].slug;
  if (alias === 'sonnet') return (models[1] ?? models[0]).slug;
  return (models.find((m) => /fast|affordable|efficient|mini/i.test(m.description)) ?? models[models.length - 1]).slug;
}

/** Claude's effort, clamped to the levels the Codex model supports */
export function codexEffortFor(effort: string | undefined, model: string | undefined, models: CodexModel[]): string | undefined {
  if (!effort) return undefined;
  const supported = models.find((m) => m.slug === model)?.efforts;
  if (!supported?.length || supported.includes(effort)) return effort;
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const wanted = order.indexOf(effort);
  // The highest supported level that isn't above the one asked for (or the lowest one)
  const below = supported.filter((e) => order.indexOf(e) !== -1 && order.indexOf(e) <= wanted);
  return below.sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? supported[0];
}

// =============================================================================
// Arguments
// =============================================================================

/** Claude Code flags that take no value */
const BOOLEAN_FLAGS = new Set([
  '-p', '--print', '--verbose', '--include-partial-messages', '--no-session-persistence', '--strict-mcp-config',
  '--dangerously-skip-permissions', '--disable-slash-commands',
]);

/** Parse Claude Code arguments into flag -> values (variadic flags such as --allowedTools keep every value) */
function parseClaudeArgs(args: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('-')) continue;
    const values: string[] = [];
    if (!BOOLEAN_FLAGS.has(flag)) {
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) values.push(args[++i]);
    }
    flags.set(flag, values);
  }
  return flags;
}

/** A TOML value for `-c key=value` (TOML basic strings take JSON string escapes) */
function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  }
  return '""';
}

/**
 * OpenAI structured outputs need strict schemas: every object closed and every property required
 * (optional ones become nullable), without size keywords
 */
export function toStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (['maxItems', 'minItems', 'maxLength', 'minLength', 'pattern', 'format', 'default'].includes(key)) continue;
    out[key] = key === 'properties' || key === 'items' || key === 'anyOf' ? toStrictSchema(value) : value;
  }
  if (out.properties && typeof out.properties === 'object') {
    const properties = out.properties as Record<string, Record<string, unknown>>;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const [name, prop] of Object.entries(properties)) {
      properties[name] = toStrictSchema(prop) as Record<string, unknown>;
      if (!required.has(name) && typeof prop.type === 'string') {
        const nullable: Record<string, unknown> = { ...properties[name], type: [prop.type, 'null'] };
        if (Array.isArray(nullable.enum)) nullable.enum = [...nullable.enum, null];
        properties[name] = nullable;
      }
    }
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

type McpEntry = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };

/** `--mcp-config` servers as Codex `mcp_servers.*` overrides; header values travel in `env` */
function mcpOverrides(json: string, env: Record<string, string>): string[] {
  let servers: Record<string, McpEntry>;
  try {
    servers = (JSON.parse(json) as { mcpServers?: Record<string, McpEntry> }).mcpServers ?? {};
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [rawName, server] of Object.entries(servers)) {
    const name = rawName.replace(/[^A-Za-z0-9_-]/g, '_');
    const key = `mcp_servers.${name}`;
    // Long-running task tools (start a task, wait for a merge) like MCP_TOOL_TIMEOUT for Claude Code;
    // the servers Workbench passes are approved like Claude Code's --mcp-config ones (a headless run
    // can't answer an approval prompt)
    out.push('-c', `${key}.tool_timeout_sec=2700`, '-c', `${key}.default_tools_approval_mode="approve"`);
    if (server.url) {
      out.push('-c', `${key}.url=${toml(server.url)}`);
      const envHeaders: Record<string, string> = {};
      for (const [header, value] of Object.entries(server.headers ?? {})) {
        const variable = `WORKBENCH_MCP_${name.toUpperCase().replace(/-/g, '_')}_${header.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        const bearer = header.toLowerCase() === 'authorization' ? /^Bearer (.+)$/.exec(value)?.[1] : undefined;
        if (bearer) {
          env[variable] = bearer;
          out.push('-c', `${key}.bearer_token_env_var=${toml(variable)}`);
        } else {
          env[variable] = value;
          envHeaders[header] = variable;
        }
      }
      if (Object.keys(envHeaders).length) out.push('-c', `${key}.env_http_headers=${toml(envHeaders)}`);
    } else if (server.command) {
      out.push('-c', `${key}.command=${toml(server.command)}`);
      if (server.args?.length) out.push('-c', `${key}.args=${toml(server.args)}`);
      if (server.env && Object.keys(server.env).length) out.push('-c', `${key}.env=${toml(server.env)}`);
    }
  }
  return out;
}

/** What Claude Code's `/init` does, for Codex (which has no slash commands in `exec`) */
const INIT_PROMPT = `Analyze this codebase and create a CLAUDE.md file in the repository root (or improve the existing one) for future AI coding agents working here. Include: the commands to build, lint and test (including how to run a single test), and the high-level architecture and structure that takes reading several files to understand. Don't list every file, don't repeat obvious practices, and don't invent sections that aren't backed by the code. Look at README.md, existing agent instruction files (AGENTS.md, .cursor/rules, .github/copilot-instructions.md) and the git history for conventions. Start the file with:

# CLAUDE.md

This file provides guidance to AI coding agents when working with code in this repository.`;

export interface CodexInvocation {
  args: string[];
  /** Prompt text for stdin */
  stdin: string;
  /** Variables the run needs on top of the caller's environment (MCP secrets) */
  env: Record<string, string>;
  /** Codex model the run uses (undefined: Codex's configured default) */
  model?: string;
  /** Claude Code asked for partial messages (Insights renders from them) */
  partial: boolean;
  /** A JSON schema was asked for: the final message is the structured output */
  structured: boolean;
  /** Remove the run's temp files */
  cleanup: () => void;
}

/** Translate one Claude Code invocation (arguments + prompt) to `codex exec` */
export function toCodexInvocation(claudeArgs: string[], input: string | ClaudeUserContentBlock[], codexHome: string): CodexInvocation {
  const flags = parseClaudeArgs(claudeArgs);
  const value = (flag: string) => flags.get(flag)?.[0];
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'workbench-codex-'));
  const env: Record<string, string> = {};
  const models = readCodexModels(codexHome);

  const resumeId = value('--resume');
  const args = resumeId ? ['exec', 'resume', resumeId] : ['exec'];
  args.push('--json', '--skip-git-repo-check');
  // Nobody can answer an approval prompt in a headless run
  args.push('-c', 'approval_policy="never"');
  // Projects written for Claude Code keep their instructions in CLAUDE.md
  args.push('-c', 'project_doc_fallback_filenames=["CLAUDE.md"]');
  if (flags.has('--no-session-persistence')) args.push('--ephemeral');

  const model = codexModelFor(value('--model'), models);
  if (model) args.push('-m', model);
  const effort = codexEffortFor(value('--effort'), model, models);
  if (effort) args.push('-c', `model_reasoning_effort=${toml(effort)}`);

  // Permissions: worktree runs skip checks like Claude Code's --dangerously-skip-permissions;
  // read-only uses (plan mode, triage, Insights, naming) can't write
  const tools = (value('--tools') ?? '').split(',').filter(Boolean);
  const writes = tools.some((t) => t === 'Edit' || t === 'Write' || t === 'MultiEdit');
  if (flags.has('--dangerously-skip-permissions')) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    const mode = value('--permission-mode');
    const sandbox = mode === 'plan' ? 'read-only' : mode === 'auto' || writes ? 'workspace-write' : 'read-only';
    args.push('-c', `sandbox_mode=${toml(sandbox)}`);
  }

  const schema = value('--json-schema');
  if (schema) {
    const file = path.join(tmp, 'schema.json');
    writeFileSync(file, JSON.stringify(toStrictSchema(JSON.parse(schema))));
    args.push('--output-schema', file);
  }

  const mcp = value('--mcp-config');
  if (mcp) {
    // Insights writes the config to a file so its token stays out of the process list
    const json = mcp.trim().startsWith('{') ? mcp : readFileSync(mcp, 'utf-8');
    args.push(...mcpOverrides(json, env));
  }

  // Prompt: system prompts first, then the user's text; images go as files
  const parts: string[] = [];
  const systemPrompt = value('--system-prompt');
  const appended = [value('--append-system-prompt'), flags.has('--append-system-prompt-file') ? readFileSync(value('--append-system-prompt-file')!, 'utf-8') : undefined]
    .filter((s): s is string => !!s?.trim());
  if (systemPrompt || appended.length) parts.push(`<instructions>\n${[systemPrompt, ...appended].filter(Boolean).join('\n\n')}\n</instructions>`);

  const blocks: ClaudeUserContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
  let fileIndex = 0;
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text.trim() === '/init' && !flags.has('--disable-slash-commands') ? INIT_PROMPT : block.text);
    } else if (block.type === 'image' || block.type === 'document') {
      const ext = block.type === 'document' ? 'pdf' : block.source.media_type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const file = path.join(tmp, `attachment-${++fileIndex}.${ext}`);
      writeFileSync(file, Buffer.from(block.source.data, 'base64'));
      if (block.type === 'image') {
        args.push('-i', file);
      } else {
        parts.push(`Attached document: ${file}`);
      }
    }
  }
  args.push('-');

  return {
    args,
    stdin: parts.join('\n\n'),
    env,
    model,
    partial: flags.has('--include-partial-messages'),
    structured: !!schema,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// =============================================================================
// Events
// =============================================================================

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: Array<{ type: string; text?: string }>; structured_content?: unknown } | null;
  error?: { message?: string } | null;
  query?: string;
  items?: Array<{ text: string; completed: boolean }>;
  message?: string;
}

/** Token totals Codex reports */
export interface CodexUsage { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
}

/** Server name of the task-list tools a Codex task run gets (see codexTaskListTools) */
export const CODEX_TASK_LIST_SERVER = 'workbench_tasks';

/** Codex's usage-limit and sign-in errors */
const LIMIT_ERROR = /usage limit|rate limit|too many requests|\b429\b|quota|limit reached/i;
const AUTH_ERROR = /\b401\b|\b403\b|unauthori[sz]ed|not logged in|log ?in again|sign ?in again|refresh token|token (?:is )?(?:expired|invalid)/i;

export interface CodexTranslator {
  /** Claude Code messages for one Codex event */
  translate: (event: CodexEvent) => ClaudeStreamMessage[];
  /** A result for a run that ended without one (crash, killed, error before the turn) */
  finish: (stderr: string) => ClaudeStreamMessage[];
}

/**
 * Turns Codex events into Claude Code stream messages. `resetAt` reads when the account's limit
 * resets (from its session files), for usage-limit errors.
 */
export function createCodexTranslator(options: {
  model?: string;
  partial: boolean;
  structured: boolean;
  cwd: string;
  resetAt?: () => Date | undefined;
  /** A resumed thread's token totals before this run (its usage is the thread's running total) */
  baselineUsage?: CodexUsage | null;
}): CodexTranslator {
  const startedAt = Date.now();
  let sessionId = '';
  let lastText = '';
  let lastError = '';
  let turns = 0;
  let blockIndex = 0;
  let done = false;
  const started = new Set<string>();
  /** todo_list item index -> task id handed out */
  const todoIds = new Map<number, string>();
  const todoDone = new Set<number>();
  let todoInProgress = -1;

  const assistant = (content: unknown[]): ClaudeStreamMessage => ({
    type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { content, model: options.model },
  } as ClaudeStreamMessage);
  const toolResult = (id: string, text: string, isError = false): ClaudeStreamMessage => ({
    type: 'user', session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
  } as ClaudeStreamMessage);
  const streamEvent = (event: Record<string, unknown>): ClaudeStreamMessage => ({ type: 'stream_event', session_id: sessionId, event });

  /** Tool call as Claude Code shows it (plus Insights' partial events) */
  const toolUse = (id: string, name: string, input: Record<string, unknown>): ClaudeStreamMessage[] => {
    const out: ClaudeStreamMessage[] = [];
    if (options.partial) {
      const index = blockIndex++;
      out.push(
        streamEvent({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } }),
        streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
        streamEvent({ type: 'content_block_stop', index }),
      );
    }
    out.push(assistant([{ type: 'tool_use', id, name, input }]));
    return out;
  };

  const text = (value: string): ClaudeStreamMessage[] => {
    const out: ClaudeStreamMessage[] = [];
    if (options.partial) {
      const index = blockIndex++;
      out.push(
        streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
        streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }),
        streamEvent({ type: 'content_block_stop', index }),
      );
    }
    out.push(assistant([{ type: 'text', text: value }]));
    return out;
  };

  const errorResult = (message: string): ClaudeStreamMessage[] => {
    done = true;
    const out: ClaudeStreamMessage[] = [];
    const limited = LIMIT_ERROR.test(message);
    if (limited) {
      const reset = options.resetAt?.();
      out.push({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset ? Math.floor(reset.getTime() / 1000) : undefined } });
    }
    const result: ClaudeResultMessage = {
      type: 'result',
      subtype: 'error_during_execution',
      session_id: sessionId,
      is_error: true,
      result: message,
      errors: [message],
      duration_ms: Date.now() - startedAt,
      num_turns: turns,
      api_error_status: limited ? 429 : AUTH_ERROR.test(message) ? 401 : null,
    };
    out.push(result);
    return out;
  };

  /** Codex's own plan list (when its plan tool is on) mirrored as TaskCreate/TaskUpdate */
  const todoList = (item: CodexItem): ClaudeStreamMessage[] => {
    const out: ClaudeStreamMessage[] = [];
    (item.items ?? []).forEach((entry, index) => {
      if (!todoIds.has(index)) {
        const id = String(todoIds.size + 1);
        todoIds.set(index, id);
        const useId = `codex-todo-${item.id}-${index}`;
        out.push(...toolUse(useId, 'TaskCreate', { subject: entry.text, description: '' }), toolResult(useId, `Task #${id} created`));
      }
      if (entry.completed && !todoDone.has(index)) {
        todoDone.add(index);
        out.push(...toolUse(`codex-todo-done-${item.id}-${index}`, 'TaskUpdate', { taskId: todoIds.get(index), status: 'completed' }));
      }
    });
    const open = (item.items ?? []).findIndex((entry) => !entry.completed);
    if (open !== -1 && open !== todoInProgress) {
      todoInProgress = open;
      out.push(...toolUse(`codex-todo-active-${item.id}-${open}`, 'TaskUpdate', { taskId: todoIds.get(open), status: 'in_progress' }));
    }
    return out;
  };

  const itemStarted = (item: CodexItem): ClaudeStreamMessage[] => {
    if (item.type === 'command_execution') {
      started.add(item.id);
      return toolUse(item.id, 'Bash', { command: item.command ?? '' });
    }
    if (item.type === 'mcp_tool_call') {
      started.add(item.id);
      return toolUse(item.id, mcpToolName(item), (item.arguments ?? {}) as Record<string, unknown>);
    }
    if (item.type === 'todo_list') return todoList(item);
    return [];
  };

  const itemCompleted = (item: CodexItem): ClaudeStreamMessage[] => {
    switch (item.type) {
      case 'agent_message':
        if (!item.text) return [];
        lastText = item.text;
        // The structured answer is the result, not a log line
        return options.structured && item.text.trim().startsWith('{') ? [] : text(item.text);
      case 'reasoning':
        return item.text ? [assistant([{ type: 'thinking', thinking: item.text }])] : [];
      case 'command_execution': {
        const out = started.has(item.id) ? [] : toolUse(item.id, 'Bash', { command: item.command ?? '' });
        out.push(toolResult(item.id, item.aggregated_output ?? '', typeof item.exit_code === 'number' && item.exit_code !== 0));
        return out;
      }
      case 'mcp_tool_call': {
        const out = started.has(item.id) ? [] : toolUse(item.id, mcpToolName(item), (item.arguments ?? {}) as Record<string, unknown>);
        const resultText = item.error?.message ?? (item.result?.content ?? []).map((c) => c.text ?? '').join('\n');
        out.push(toolResult(item.id, resultText, !!item.error || item.status === 'failed'));
        return out;
      }
      case 'file_change': {
        // As Write/Edit with file_path, so the task hooks and the parallel-task changelog see the files
        const out: ClaudeStreamMessage[] = [];
        (item.changes ?? []).forEach((change, index) => {
          const id = `${item.id}-${index}`;
          const filePath = path.isAbsolute(change.path) ? change.path : path.join(options.cwd, change.path);
          out.push(...toolUse(id, change.kind === 'add' ? 'Write' : 'Edit', { file_path: filePath }), toolResult(id, `${change.kind} ${change.path}`, item.status === 'failed'));
        });
        return out;
      }
      case 'web_search': {
        const out = toolUse(item.id, 'WebSearch', { query: item.query ?? '' });
        out.push(toolResult(item.id, ''));
        return out;
      }
      case 'todo_list':
        return todoList(item);
      case 'error':
        return item.message ? text(`Codex: ${item.message}`) : [];
      default:
        return [];
    }
  };

  const translate = (event: CodexEvent): ClaudeStreamMessage[] => {
    switch (event.type) {
      case 'thread.started':
        sessionId = event.thread_id ?? sessionId;
        return [{
          type: 'system', subtype: 'init', session_id: sessionId, model: options.model, cwd: options.cwd,
          claude_code_version: 'codex', tools: [], agents: [], skills: [], slash_commands: [], mcp_servers: [], plugins: [],
        } as ClaudeStreamMessage];
      case 'turn.started':
        turns++;
        return [];
      case 'item.started':
        return event.item ? itemStarted(event.item) : [];
      case 'item.updated':
        return event.item?.type === 'todo_list' ? todoList(event.item) : [];
      case 'item.completed':
        return event.item ? itemCompleted(event.item) : [];
      case 'turn.completed': {
        done = true;
        let structured: unknown;
        if (options.structured) {
          try {
            structured = JSON.parse(lastText);
          } catch {
            structured = undefined;
          }
        }
        // The usage is the thread's running total: this run's share is what it added since the
        // baseline, priced at this run's model (a resumed thread may change models between phases)
        const usage = event.usage ?? {};
        const base = options.baselineUsage ?? {};
        const input = Math.max((usage.input_tokens ?? 0) - (base.input_tokens ?? 0), 0);
        const cached = Math.min(Math.max((usage.cached_input_tokens ?? 0) - (base.cached_input_tokens ?? 0), 0), input);
        const cost = requestCostUsd(options.model, {
          input_tokens: input - cached,
          cache_read_input_tokens: cached,
          output_tokens: Math.max((usage.output_tokens ?? 0) - (base.output_tokens ?? 0), 0),
        });
        const result: ClaudeResultMessage = {
          type: 'result',
          subtype: 'success',
          session_id: sessionId,
          is_error: false,
          result: lastText,
          structured_output: structured,
          total_cost_usd: cost,
          cost_scope: 'run',
          duration_ms: Date.now() - startedAt,
          num_turns: turns,
        };
        return [result];
      }
      case 'turn.failed':
        return errorResult(event.error?.message || lastError || 'Codex stopped with an error');
      case 'error':
        // Transient errors (reconnecting) arrive here too; the turn's own outcome decides
        lastError = event.message ?? lastError;
        return [{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 0, error: lastError } as ClaudeStreamMessage];
      default:
        return [];
    }
  };

  const finish = (stderr: string): ClaudeStreamMessage[] => {
    if (done) return [];
    const message = lastError || stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ');
    return message ? errorResult(message) : [];
  };

  return { translate, finish };
}

function mcpToolName(item: CodexItem): string {
  // Workbench's task-list tools keep Claude Code's names, so the runner mirrors them as subtasks
  if (item.server === CODEX_TASK_LIST_SERVER) return item.tool ?? 'TaskCreate';
  return `mcp__${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`;
}

// =============================================================================
// Task list tools
// =============================================================================

/**
 * Claude Code's TaskCreate/TaskUpdate for a Codex task run, served by Workbench over MCP (Codex's
 * `exec` mode has no plan tool). The answers read like Claude Code's ("Task #3 created"), so the
 * runner's subtask mirror works unchanged.
 */
export function codexTaskListTools(): { tools: ServedTool[]; call: (name: string, args: Record<string, unknown>) => Promise<string> } {
  let created = 0;
  const tools: ServedTool[] = [
    {
      name: 'TaskCreate',
      description: 'Add a step to your task list. Use it for multi-step work so the user can follow progress; skip it for small changes.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Short imperative title of the step' },
          description: { type: 'string', description: 'What the step involves' },
        },
        required: ['subject'],
      },
      mutates: true,
    },
    {
      name: 'TaskUpdate',
      description: 'Update a step of your task list: mark it in_progress when you start it and completed when it is done.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Id from TaskCreate (e.g. "3")' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
          subject: { type: 'string', description: 'New title (optional)' },
        },
        required: ['taskId'],
      },
      mutates: true,
    },
  ];
  const call = async (name: string, args: Record<string, unknown>) => {
    if (name === 'TaskCreate') return `Task #${++created} created successfully: ${String(args.subject ?? '')}`;
    if (name === 'TaskUpdate') return `Updated task #${String(args.taskId ?? '')}`;
    throw new Error(`Unknown tool: ${name}`);
  };
  return { tools, call };
}
