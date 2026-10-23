/**
 * Ask the other engine
 * ====================
 *
 * One MCP tool a task phase gets (served by openToolsSession): `ask_codex` on Claude Code runs,
 * `ask_claude` on Codex runs. The other engine answers in a one-shot, read-only run in the same
 * worktree, so it can look at the code but not change it.
 */

import { READ_ONLY_TOOLS, runClaudeText } from './run-text';
import type { EngineKind } from './env';
import type { ServedTool } from '../insights/task-tools-server';

/** Server name of the second-opinion tool in a task run's MCP config */
export const SECOND_OPINION_SERVER = 'workbench_ask';
export const MAX_SECOND_OPINIONS = 3;
export const SECOND_OPINION_TIMEOUT_MS = 5 * 60 * 1000;

const ENGINE_NAMES: Record<EngineKind, string> = { claude: 'Claude', codex: 'ChatGPT (Codex)' };

/** Prompt line telling a run it can consult the other engine */
export function secondOpinionPromptLine(otherEngine: EngineKind): string {
  return `For a hard call (a tricky design choice, a bug you can't pin down), you can ask ${ENGINE_NAMES[otherEngine]} for a second opinion with the ask_${otherEngine} tool (up to ${MAX_SECOND_OPINIONS} times per phase).`;
}

/** The tool for one phase; `onCost` gets each answer's cost, `abortSignal` stops a running answer with the task */
export function secondOpinionTools(
  otherEngine: EngineKind,
  cwd: string,
  onCost: (costUsd: number) => void,
  abortSignal?: AbortSignal,
): { tools: ServedTool[]; call: (name: string, args: Record<string, unknown>) => Promise<string> } {
  const name = `ask_${otherEngine}`;
  const other = ENGINE_NAMES[otherEngine];
  let calls = 0;
  const tools: ServedTool[] = [
    {
      name,
      description: `Ask ${other} for a second opinion on a hard question. It can read the project (read-only) but not change it. At most ${MAX_SECOND_OPINIONS} questions per phase.`,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, self-contained' },
          context: { type: 'string', description: 'What you know so far: relevant files, findings, options you weigh' },
        },
        required: ['question'],
      },
    },
  ];
  const call = async (toolName: string, args: Record<string, unknown>) => {
    if (toolName !== name) throw new Error(`Unknown tool: ${toolName}`);
    const question = String(args.question ?? '').trim();
    if (!question) throw new Error('question is required');
    if (calls >= MAX_SECOND_OPINIONS) {
      return `You already asked ${other} ${MAX_SECOND_OPINIONS} times in this phase, the limit. Decide on your own.`;
    }
    calls++;
    const context = typeof args.context === 'string' && args.context.trim() ? `\n\nContext:\n${args.context.trim()}` : '';
    try {
      const answer = await runClaudeText({
        engine: otherEngine,
        cwd,
        tools: READ_ONLY_TOOLS,
        allowedTools: READ_ONLY_TOOLS,
        step: 'helpers',
        appendSystemPrompt: 'Another coding agent working in this project asks you for a second opinion. You can read the code but not change it. Answer concisely and concretely.',
        prompt: `${question}${context}`,
        timeoutMs: SECOND_OPINION_TIMEOUT_MS,
        abortSignal,
      });
      if (answer.costUsd) onCost(answer.costUsd);
      return answer.text.trim() || `${other} gave no answer.`;
    } catch (error) {
      // The run is killed at the timeout (startClaudeProcess)
      if (error instanceof Error && /timed out/.test(error.message)) {
        return `${other} didn't answer within ${SECOND_OPINION_TIMEOUT_MS / 60000} minutes. Go on without it.`;
      }
      throw error;
    }
  };
  return { tools, call };
}
