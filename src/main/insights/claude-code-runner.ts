/**
 * Insights via Claude Code
 * ========================
 *
 * Every Insights turn runs through the locally installed Claude Code CLI in headless mode
 * (`claude -p --output-format stream-json --include-partial-messages`), so text streams
 * into the chat as it is written.
 *
 * The CLI can't change the project's files: only Read/Glob/Grep (plus Bash limited to graphify's
 * read-only searches when the project's memory graph is on) are available, and the only MCP
 * server is Workbench's task tools (`task-tools-server.ts`), so Claude can manage the
 * project's tasks. Anything else is denied without prompting (`--permission-mode dontAsk`) and
 * no session is persisted. Credentials come from the best available Claude profile or the active API profile
 * (`resolveClaudeEnv`).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { routeFor } from '../claude-code/routing';
import { readSettingsFileAsync } from '../settings-utils';
import { resolveClaudeEnv } from '../claude-code/env';
import { startClaudeProcess } from '../claude-code/process';
import type { ClaudeStreamMessage, ClaudeUserContentBlock } from '../claude-code/stream-types';
import { getToolInfoAsync } from '../cli-tool-manager';
import { getPathDelimiter } from '../platform';
import { getShellRuntimeStatus, getWslInfo, toRuntimePath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { appLog } from '../app-logger';
import { INSIGHTS_ERROR_CODES, formatInsightsError } from '../../shared/constants/insights';
import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES } from '../../shared/types/claude-code';
import type { ClaudeEffort, ClaudeModelAlias } from '../../shared/types/claude-code';
import type { AppSettings, ImageAttachment } from '../../shared/types';
import type { GraphifyAgentContext } from '../graphify';
import { TASK_TOOLS_SERVER_NAME, toBridgeServer, type TaskToolsMcpServer, type TaskToolsStdioServer } from './task-tools-mcp';
// The bridge's source, bundled as text and written next to the turn's other temp files
import TASK_TOOLS_BRIDGE_SOURCE from './task-tools-bridge.cjs?raw';
import { buildMessageContent } from './message-content';
import {
  buildConversationPrompt,
  buildSystemPrompt,
  extractTaskSuggestion,
  extractToolInput,
  type InsightsMessage,
  type TaskSuggestion,
} from './prompts';

// =============================================================================
// Types
// =============================================================================

/** Configuration for one Insights turn */
export interface InsightsRunConfig {
  projectDir: string;
  /** User message to process */
  message: string;
  /** Previous conversation history */
  history?: InsightsMessage[];
  /** Model (Claude alias or full model ID, defaults to 'sonnet') */
  model?: string;
  /** Thinking level / effort (defaults to 'medium') */
  thinkingLevel?: string;
  abortSignal?: AbortSignal;
  /** Files attached to the current message (images, PDFs, text/code files) */
  attachments?: ImageAttachment[];
  /** The project's memory graph, when its "Use Graphify" setting is on */
  graphify?: GraphifyAgentContext;
  /** The project's Claude account (Settings > Project); unset = the account in use */
  profileId?: string;
  /** MCP server entry of the turn's task tools session */
  taskTools?: TaskToolsMcpServer;
}

/** Info about a tool call made during the turn */
interface ToolCallInfo {
  name: string;
  input: string;
}

/** Result of an Insights turn */
export interface InsightsResult {
  text: string;
  taskSuggestion: TaskSuggestion | null;
  toolCalls: ToolCallInfo[];
}

/** Events emitted while a turn streams */
export type InsightsStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; input: string }
  | { type: 'tool-end'; name: string }
  | { type: 'error'; error: string };

export type InsightsStreamCallback = (event: InsightsStreamEvent) => void;

/** Error raised when the model finishes without producing any answer text */
const EMPTY_RESPONSE_ERROR = 'The model returned an empty response';

/** Tools the Insights agent may use (read-only codebase exploration) */
export const INSIGHTS_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * Bash commands allowed for searching the project's memory graph (graphify's read-only
 * searches); every other Bash command is denied
 */
export const INSIGHTS_GRAPHIFY_COMMANDS = [
  'Bash(graphify query:*)',
  'Bash(graphify explain:*)',
  'Bash(graphify path:*)',
  'Bash(graphify affected:*)',
  'Bash(graphify god-nodes:*)',
] as const;

// =============================================================================
// Arguments
// =============================================================================

/** Claude Code model alias for a stored Insights model (legacy full IDs map to their family) */
export function toClaudeModel(model: string | undefined): string {
  if (!model) return 'sonnet';
  if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(model)) return model as ClaudeModelAlias;
  if (model.startsWith('claude-')) return model;
  for (const alias of CLAUDE_MODEL_ALIASES) {
    if (model.toLowerCase().includes(alias)) return alias;
  }
  return 'sonnet';
}

/** Claude Code effort for a stored thinking level */
function toClaudeEffort(level: string | undefined): ClaudeEffort {
  return level && (CLAUDE_EFFORTS as readonly string[]).includes(level) ? (level as ClaudeEffort) : 'medium';
}

/** MCP tools rule for Workbench's task tools (every tool of the server) */
export const INSIGHTS_TASK_TOOLS_RULE = `mcp__${TASK_TOOLS_SERVER_NAME}`;

/** How long a task tool may run (merging a PR with conflicts takes a while) */
const TASK_TOOL_TIMEOUT_MS = 45 * 60 * 1000;

/** CLI arguments for a non-persistent headless turn that can't change files */
export function buildInsightsArgs(
  model: string,
  effort: ClaudeEffort,
  systemPromptFile: string,
  withGraphify = false,
  mcpConfigFile?: string,
): string[] {
  const tools = withGraphify ? [...INSIGHTS_READ_ONLY_TOOLS, 'Bash'] : [...INSIGHTS_READ_ONLY_TOOLS];
  const allowed = [
    ...(withGraphify ? INSIGHTS_GRAPHIFY_COMMANDS : []),
    ...(mcpConfigFile ? [INSIGHTS_TASK_TOOLS_RULE] : []),
  ];
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--effort', effort,
    '--tools', tools.join(','),
    ...(allowed.length ? ['--allowedTools', ...allowed] : []),
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    ...(mcpConfigFile ? ['--mcp-config', mcpConfigFile] : []),
    '--no-session-persistence',
    '--append-system-prompt-file', systemPromptFile,
  ];
}

// =============================================================================
// Stream handling
// =============================================================================

interface StreamState {
  text: string;
  toolCalls: ToolCallInfo[];
  /** tool_use id → tool name, for matching tool results */
  toolNames: Map<string, string>;
  /** Content block index → in-progress tool call */
  pendingTools: Map<number, { id: string; name: string; json: string }>;
  result?: { isError: boolean; subtype?: string; text?: string };
}

function createStreamState(): StreamState {
  return { text: '', toolCalls: [], toolNames: new Map(), pendingTools: new Map() };
}

/** Apply one stream-json message from the CLI to the turn state, emitting UI events */
function handleInsightsEvent(
  event: ClaudeStreamMessage | Record<string, unknown>,
  state: StreamState,
  onStream?: InsightsStreamCallback,
): void {
  const raw = event as Record<string, unknown>;
  switch (raw.type) {
    case 'stream_event': {
      const inner = raw.event as Record<string, unknown> | undefined;
      const index = inner?.index as number | undefined;
      if (inner?.type === 'content_block_start') {
        const block = inner.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === 'tool_use' && index !== undefined) {
          state.pendingTools.set(index, { id: block.id ?? '', name: block.name ?? 'tool', json: '' });
        } else if (block?.type === 'text' && state.text) {
          // Separate text written before and after tool use
          state.text += '\n\n';
          onStream?.({ type: 'text-delta', text: '\n\n' });
        }
      } else if (inner?.type === 'content_block_delta') {
        const delta = inner.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === 'text_delta' && delta.text) {
          state.text += delta.text;
          onStream?.({ type: 'text-delta', text: delta.text });
        } else if (delta?.type === 'input_json_delta' && index !== undefined) {
          const pending = state.pendingTools.get(index);
          if (pending) pending.json += delta.partial_json ?? '';
        }
      } else if (inner?.type === 'content_block_stop' && index !== undefined) {
        const pending = state.pendingTools.get(index);
        if (pending) {
          state.pendingTools.delete(index);
          let args: Record<string, unknown> = {};
          try {
            args = pending.json ? (JSON.parse(pending.json) as Record<string, unknown>) : {};
          } catch {
            // Keep empty args if the CLI sent malformed partial JSON
          }
          const input = extractToolInput(args);
          state.toolNames.set(pending.id, pending.name);
          state.toolCalls.push({ name: pending.name, input });
          onStream?.({ type: 'tool-start', name: pending.name, input });
        }
      }
      break;
    }
    case 'user': {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
          if (block.type === 'tool_result') {
            onStream?.({ type: 'tool-end', name: state.toolNames.get(block.tool_use_id ?? '') ?? 'tool' });
          }
        }
      }
      break;
    }
    case 'result': {
      const errors = Array.isArray(raw.errors) ? (raw.errors as string[]).join('; ') : '';
      state.result = {
        isError: raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype !== 'success'),
        subtype: raw.subtype as string | undefined,
        text: typeof raw.result === 'string' && raw.result ? raw.result : errors || undefined,
      };
      break;
    }
  }
}

// =============================================================================
// Runner
// =============================================================================

/**
 * How Claude Code reaches the turn's task tools, served over HTTP on the host's 127.0.0.1:
 * - 'direct': natively, and inside WSL1 or WSL2 with mirrored networking (they share the
 *   host's localhost)
 * - 'bridge': inside WSL2 with NAT networking, which gives the distribution its own localhost:
 *   through the stdio bridge (task-tools-bridge.cjs) that Claude Code starts as a Windows
 *   process through WSL interop
 * - 'off': the distribution has WSL interop off (the probe says so), or the bridge failed to
 *   start before; tasks are suggested instead
 */
export type TaskToolsRoute = 'direct' | 'bridge' | 'off';

/** Set once the bridge failed to start, so later turns don't offer tools Claude can't reach */
let taskToolsBridgeFailed = false;

export function getTaskToolsRoute(): TaskToolsRoute {
  const wsl = getWslInfo();
  if (!wsl) return 'direct';
  if (wsl.networkingMode === 'mirrored' || getShellRuntimeStatus().wsl?.version === 1) return 'direct';
  // The bridge is a Windows program, which the distribution can only run with interop on
  return taskToolsBridgeFailed || wsl.interop === false ? 'off' : 'bridge';
}

/** Claude Code's init message lists the bridge as failed: task tools are off from the next turn */
function noteBridgeFailure(event: ClaudeStreamMessage | Record<string, unknown>): void {
  const raw = event as { type?: unknown; subtype?: unknown; mcp_servers?: unknown };
  if (raw.type !== 'system' || raw.subtype !== 'init' || !Array.isArray(raw.mcp_servers)) return;
  const server = (raw.mcp_servers as Array<{ name?: string; status?: string }>).find((entry) => entry.name === TASK_TOOLS_SERVER_NAME);
  if (server?.status !== 'failed' || taskToolsBridgeFailed) return;
  taskToolsBridgeFailed = true;
  appLog.warn(`[Insights] The task tools bridge did not start in WSL (${getWslInfo()?.distro ?? 'unknown'}), is WSL interop off? Task tools are off for this session; tasks are suggested instead`);
}

/**
 * Forget a bridge failure (tests)
 * @internal
 */
export function resetTaskToolsBridgeForTests(): void {
  taskToolsBridgeFailed = false;
}

/** The task tools entry of the turn's MCP config (the bridge script is written to `tempDir`) */
async function taskToolsEntry(
  taskTools: TaskToolsMcpServer,
  route: Exclude<TaskToolsRoute, 'off'>,
  tempDir: string,
): Promise<TaskToolsMcpServer | TaskToolsStdioServer> {
  if (route === 'direct') return taskTools;
  const bridgeScript = join(tempDir, 'task-tools-bridge.cjs');
  await writeFile(bridgeScript, TASK_TOOLS_BRIDGE_SOURCE, 'utf-8');
  // Claude Code starts the executable by its Linux path; the Windows process reads the script by its Windows path
  return toBridgeServer(taskTools, toRuntimePath(process.execPath), bridgeScript);
}

/**
 * Run an Insights turn through the Claude Code CLI.
 * Rejects with a readable message when the CLI fails, or an AbortError when cancelled.
 */
export async function runInsights(config: InsightsRunConfig, onStream?: InsightsStreamCallback): Promise<InsightsResult> {
  const { projectDir, message, history = [], abortSignal, attachments, graphify } = config;

  try {
    await whenShellRuntimeReady();
    const wsl = getWslInfo();
    // Settings > Agents > Model routing for the Claude page (unset fields: the page's own choice)
    const route = await routeFor('insights');
    const { command, env, engine } = await resolveClaudeEnv({ profileId: config.profileId, engine: route.engine });
    const cli = engine === 'codex' ? 'codex' : 'claude';
    const cliName = engine === 'codex' ? 'Codex CLI' : 'Claude Code CLI';
    if (wsl) {
      // The CLI runs inside WSL: the distribution's own one (from the startup probe)
      if (!wsl.tools[cli].path) {
        throw new Error(formatInsightsError(INSIGHTS_ERROR_CODES.claudeCodeMissing, `${cliName} not found in WSL (${wsl.distro})`));
      }
    } else {
      const cliInfo = await getToolInfoAsync(cli, { refreshIfMissing: true });
      if (!cliInfo.found) {
        throw new Error(formatInsightsError(INSIGHTS_ERROR_CODES.claudeCodeMissing, cliInfo.message || `${cliName} not found`));
      }
    }
    const taskToolsRoute = getTaskToolsRoute();
    const offeredTaskTools = taskToolsRoute === 'off' ? undefined : config.taskTools;

    if (graphify) {
      // graphify commands find the project's graph (GRAPHIFY_OUT, translated for WSL when the
      // run starts) and run without a full path (natively; in WSL from the login PATH)
      env.GRAPHIFY_OUT = dirname(graphify.graph);
      if (!wsl) env.PATH = [dirname(graphify.cli), env.PATH].filter(Boolean).join(getPathDelimiter());
    }

    // System prompt goes through a file: no argument length or shell quoting limits
    const tempDir = await mkdtemp(join(tmpdir(), 'workbench-insights-'));
    const systemPromptFile = join(tempDir, 'system-prompt.md');
    const basePrompt = buildSystemPrompt(projectDir, { taskTools: !!offeredTaskTools });
    const instructions = (((await readSettingsFileAsync()) ?? {}) as Partial<AppSettings>).claudeCodeTasks?.customInstructions?.trim();
    const systemPrompt = [basePrompt, instructions && `## The user's instructions\n${instructions}`, graphify?.commandPrompt].filter(Boolean).join('\n\n');
    await writeFile(systemPromptFile, systemPrompt, 'utf-8');
    // The task tools' URL and token go through a file too, so they aren't in the process list
    let mcpConfigFile: string | undefined;
    const taskTools = offeredTaskTools && taskToolsRoute !== 'off'
      ? await taskToolsEntry(offeredTaskTools, taskToolsRoute, tempDir)
      : undefined;
    if (taskTools) {
      mcpConfigFile = join(tempDir, 'mcp-config.json');
      await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: { [TASK_TOOLS_SERVER_NAME]: taskTools } }), 'utf-8');
      env.MCP_TOOL_TIMEOUT = String(TASK_TOOL_TIMEOUT_MS);
    }

    const state = createStreamState();
    try {
      const handle = startClaudeProcess({
        command,
        engine,
        args: buildInsightsArgs(route.model ?? toClaudeModel(config.model), route.effort ?? toClaudeEffort(config.thinkingLevel), systemPromptFile, !!graphify, mcpConfigFile),
        cwd: projectDir,
        env,
        // Document blocks (PDFs) are valid Anthropic content even though the shared type omits them
        input: buildMessageContent(buildConversationPrompt(message, history), attachments) as ClaudeUserContentBlock[],
        onMessage: (event) => {
          if (taskTools?.type === 'stdio') noteBridgeFailure(event);
          handleInsightsEvent(event, state, onStream);
        },
        abortSignal,
      });
      const outcome = await handle.done;

      if (outcome.aborted || abortSignal?.aborted) {
        const abortError = new Error('Insights request was cancelled');
        abortError.name = 'AbortError';
        throw abortError;
      }
      if (state.result?.isError) {
        throw new Error(state.result.text?.trim() || `Claude Code failed (${state.result.subtype ?? 'error'})`);
      }
      if (outcome.exitCode !== 0 && !state.result) {
        throw new Error(outcome.stderr.trim() || `Claude Code exited with code ${outcome.exitCode}`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const text = state.text.trim() ? state.text : (state.result?.text ?? '');
    if (!text.trim()) {
      throw new Error(EMPTY_RESPONSE_ERROR);
    }

    return { text, taskSuggestion: extractTaskSuggestion(text), toolCalls: state.toolCalls };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!(error instanceof Error && error.name === 'AbortError')) {
      onStream?.({ type: 'error', error: errorMsg });
    }
    throw error;
  }
}
