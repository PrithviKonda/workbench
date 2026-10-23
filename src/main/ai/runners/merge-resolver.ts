/**
 * Merge Resolver Runner
 * =====================
 *
 * AI-powered merge conflict resolution through a one-shot Claude Code run.
 * Takes a system prompt describing the merge context and a user prompt with
 * the conflict, and returns the resolved content. No tools are enabled.
 */

import { runClaudeText } from '../../claude-code/run-text';
import type { ClaudeEffort } from '../../../shared/types/claude-code';

// =============================================================================
// Types
// =============================================================================

/** Configuration for merge conflict resolution */
export interface MergeResolverConfig {
  /** System prompt describing the merge resolution context */
  systemPrompt: string;
  /** User prompt with the conflict to resolve */
  userPrompt: string;
  /** Claude model alias (defaults to 'sonnet') */
  model?: string;
  /** Reasoning effort (defaults to 'low') */
  effort?: ClaudeEffort;
  /** The task's spec dir (model routing by task size) */
  specDir?: string;
  abortSignal?: AbortSignal;
}

/** Result of a merge resolution */
export interface MergeResolverResult {
  /** Whether the resolution succeeded */
  success: boolean;
  /** Resolved text (empty string if failed) */
  text: string;
  /** Error message if failed */
  error?: string;
}

/** Function used by the merge orchestrator to resolve one conflict */
export type MergeResolverCallFn = (system: string, user: string) => Promise<string>;

/** How long a single conflict resolution may run */
const RESOLVE_TIMEOUT_MS = 5 * 60 * 1000;

// =============================================================================
// Merge Resolver
// =============================================================================

/** Remove one Markdown code fence wrapping the whole answer */
function stripCodeFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  return match ? match[1] : text;
}

/** Resolve a merge conflict with Claude Code */
export async function resolveMergeConflict(
  config: MergeResolverConfig,
): Promise<MergeResolverResult> {
  const { systemPrompt, userPrompt, model = 'sonnet', effort = 'low', specDir, abortSignal } = config;

  try {
    const result = await runClaudeText({
      prompt: userPrompt,
      systemPrompt,
      model,
      effort,
      step: 'merge',
      specDir,
      timeoutMs: RESOLVE_TIMEOUT_MS,
      abortSignal,
    });
    const text = stripCodeFence(result.text.trim());
    if (text) return { success: true, text };
    return { success: false, text: '', error: 'Empty response from Claude Code' };
  } catch (error) {
    return {
      success: false,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create the `(system, user) => resolved text` function the merge orchestrator calls.
 * Returns an empty string when resolution fails (the orchestrator treats that as unresolved).
 */
export function createMergeResolverFn(
  model = 'sonnet',
  effort: ClaudeEffort = 'low',
  specDir?: string,
): MergeResolverCallFn {
  return async (system: string, user: string): Promise<string> => {
    const result = await resolveMergeConflict({ systemPrompt: system, userPrompt: user, model, effort, specDir });
    return result.text;
  };
}
