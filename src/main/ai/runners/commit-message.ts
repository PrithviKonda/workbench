/**
 * Commit Message Runner
 * =====================
 *
 * Generates a conventional-commit message for a task's staged changes through a
 * one-shot Claude Code run (no tools). The model picks the commit type from the diff.
 */

import { loadClaudeRunInfo } from '../../claude-code/task-runner';
import { runClaudeText } from '../../claude-code/run-text';
import type { ClaudeEffort } from '../../../shared/types/claude-code';

// =============================================================================
// Constants
// =============================================================================

const SYSTEM_PROMPT = `You are a Git expert who writes clear, concise commit messages following conventional commits format.

Rules:
1. First line: type(scope): description (max 72 chars total)
2. Leave blank line after first line
3. Body: 1-3 sentences explaining WHAT changed and WHY
4. If GitHub issue number provided, end with "Fixes #N" on its own line
5. Be specific about the changes, not generic
6. Use imperative mood ("Add feature" not "Added feature")
7. Choose the type that best fits the changes

Types: feat, fix, refactor, docs, test, perf, chore, style, ci, build

Example output:
feat(auth): add OAuth2 login flow

Implement OAuth2 authentication with Google and GitHub providers.
Add token refresh logic and secure storage.

Fixes #42

Output ONLY the commit message, nothing else.`;

const COMMIT_MESSAGE_TIMEOUT_MS = 2 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

/** Configuration for commit message generation */
export interface CommitMessageConfig {
  /** Spec identifier (e.g., "001-add-feature"), used for the fallback message */
  specName: string;
  /** Task spec directory (holds claude_run.json with the run summary) */
  specDir?: string;
  /** Task title and description */
  taskTitle?: string;
  taskDescription?: string;
  /** Git diff stat or summary */
  diffSummary?: string;
  /** List of changed file paths */
  filesChanged?: string[];
  /** GitHub issue number if linked */
  githubIssue?: number;
  /** Claude model alias (defaults to 'haiku') */
  model?: string;
  /** Reasoning effort (defaults to 'low') */
  effort?: ClaudeEffort;
}

// =============================================================================
// Prompt
// =============================================================================

function buildPrompt(config: CommitMessageConfig): string {
  const filesChanged = config.filesChanged ?? [];
  const filesDisplay = filesChanged.length > 20
    ? `${filesChanged.slice(0, 20).join('\n')}\n... and ${filesChanged.length - 20} more files`
    : filesChanged.length > 0 ? filesChanged.join('\n') : '(no files listed)';

  const summary = config.specDir ? loadClaudeRunInfo(config.specDir)?.summary : undefined;
  const githubRef = config.githubIssue
    ? `\nGitHub Issue: #${config.githubIssue} (include 'Fixes #${config.githubIssue}' at the end)`
    : '';

  return `Generate a commit message for this change.

Task: ${config.taskTitle || config.specName}
Files changed: ${filesChanged.length}${githubRef}

Description: ${config.taskDescription ? config.taskDescription.slice(0, 1000) : 'No description available'}
${summary ? `\nSummary of the work:\n${summary.slice(0, 2000)}\n` : ''}
Changed files:
${filesDisplay}

Diff summary:
${config.diffSummary ? config.diffSummary.slice(0, 2000) : '(no diff available)'}

Follow the format exactly:
type(scope): short description

Body explaining changes.

Fixes #N (if applicable)`;
}

// =============================================================================
// Commit Message Generator
// =============================================================================

/**
 * Generate a commit message with Claude Code.
 * Returns a simple fallback message when the run fails.
 */
export async function generateCommitMessage(config: CommitMessageConfig): Promise<string> {
  try {
    const result = await runClaudeText({
      prompt: buildPrompt(config),
      systemPrompt: SYSTEM_PROMPT,
      model: config.model ?? 'haiku',
      effort: config.effort ?? 'low',
      step: 'git',
      specDir: config.specDir,
      timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
    });
    const text = result.text.trim();
    if (text) return text;
  } catch {
    // Fall through to fallback
  }

  let fallback = `chore: ${config.taskTitle || config.specName}`;
  if (config.githubIssue) fallback += `\n\nFixes #${config.githubIssue}`;
  return fallback;
}
