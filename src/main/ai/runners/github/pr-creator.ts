/**
 * PR Creator Runner
 * =================
 *
 * Creates GitHub Pull Requests with a title and description written by Claude Code.
 *
 * Steps:
 * 1. Push the worktree branch to origin
 * 2. Gather context: task title/description, the Claude Code run summary, plan and validation
 *    (`claude_run.json`), and the branch's commit log and diff summary
 * 3. Ask Claude Code (read-only tools, cwd = worktree) for a PR title and body
 * 4. Create the PR with `gh pr create`
 *
 * All git/gh calls are async so the main process never blocks.
 */

import { runTool } from '../../../platform/runtime-exec';
import { loadClaudeRunInfo } from '../../../claude-code/task-runner';
import { runClaudeText, READ_ONLY_TOOLS } from '../../../claude-code/run-text';
import type { ClaudeEffort } from '../../../../shared/types/claude-code';

// =============================================================================
// Constants
// =============================================================================

const SYSTEM_PROMPT = `You are a senior software engineer writing a GitHub Pull Request.
Write a clear, professional PR title and description that explains WHAT was changed, WHY it was changed, and HOW to test it.

The title is one line (under 72 characters), imperative mood, no trailing period.

The body is Markdown with these sections:
## Summary
(1-3 bullet points describing the main changes)

## Changes
(Bulleted list of specific changes made)

## Testing
(How to verify the changes work correctly)

Keep the description concise but informative. You may read files in the repository to understand
the changes, but do not modify anything. Do not include any preamble.`;

const PR_TEXT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'PR title, one line' },
    body: { type: 'string', description: 'PR description in Markdown' },
  },
  required: ['title', 'body'],
  additionalProperties: false,
} as const;

/** Upper bound for the PR text generation run */
const PR_TEXT_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_TITLE_LENGTH = 200;

// =============================================================================
// Types
// =============================================================================

/** Configuration for PR creation */
export interface CreatePRConfig {
  /** Project root directory (main git repo) */
  projectDir: string;
  /** Worktree directory (where the branch lives) */
  worktreePath: string;
  /** Spec ID (e.g., "001-add-feature") */
  specId: string;
  /** Task spec directory in the main project (holds claude_run.json) */
  specDir?: string;
  /** Task title and description (context for the PR text) */
  taskTitle?: string;
  taskDescription?: string;
  /** Branch name to push and create PR from */
  branchName: string;
  /** Base branch to merge into (e.g., "main", "develop") */
  baseBranch: string;
  /** PR title chosen by the user; generated when omitted */
  title?: string;
  /** Whether to create as a draft PR */
  draft?: boolean;
  /** Claude model alias (defaults to 'sonnet') */
  model?: string;
  /** Reasoning effort (defaults to 'low') */
  effort?: ClaudeEffort;
}

/** Result of PR creation */
export interface CreatePRResult {
  success: boolean;
  prUrl?: string;
  alreadyExists?: boolean;
  error?: string;
}

interface PRText {
  title: string;
  body: string;
}

// =============================================================================
// Helpers
// =============================================================================

async function run(tool: 'git' | 'gh', args: string[], cwd: string): Promise<string> {
  const { stdout } = await runTool(tool, args, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** First git command that succeeds, or an empty string */
async function firstOutput(cwd: string, attempts: string[][], limit: number): Promise<string> {
  for (const args of attempts) {
    try {
      return (await run('git', args, cwd)).slice(0, limit);
    } catch {
      // Try the next form
    }
  }
  return '';
}

/** Gather diff and commit log context for the PR */
async function gatherPRContext(
  worktreePath: string,
  baseBranch: string,
): Promise<{ diffSummary: string; commitLog: string }> {
  const base = baseBranch.startsWith('origin/') ? baseBranch.slice('origin/'.length) : baseBranch;
  const [diffSummary, commitLog] = await Promise.all([
    firstOutput(worktreePath, [
      ['diff', '--stat', `origin/${base}...HEAD`],
      ['diff', '--stat', `${base}...HEAD`],
    ], 4000),
    firstOutput(worktreePath, [
      ['log', '--oneline', `origin/${base}..HEAD`],
      ['log', '--oneline', `${base}..HEAD`],
    ], 3000),
  ]);
  return { diffSummary, commitLog };
}

/** Task context from the task itself and its Claude Code run */
function describeTask(config: CreatePRConfig): string {
  const parts: string[] = [];
  if (config.taskTitle) parts.push(`Task title: ${config.taskTitle}`);
  if (config.taskDescription) parts.push(`Task description:\n${config.taskDescription.slice(0, 4000)}`);

  const info = config.specDir ? loadClaudeRunInfo(config.specDir) : null;
  if (info?.summary) parts.push(`Summary written after implementation:\n${info.summary.slice(0, 4000)}`);
  if (info?.plan) parts.push(`Implementation plan:\n${info.plan.slice(0, 4000)}`);
  if (info?.validation) {
    const v = info.validation;
    const checks = v.checks.map((c) => `- ${c.name}`).join('\n');
    parts.push(`Validation (${v.status}): ${v.summary}${checks ? `\nChecks:\n${checks}` : ''}`);
  }
  return parts.join('\n\n');
}

/** Fallback PR text when Claude Code is unavailable */
function fallbackPRText(config: CreatePRConfig, commitLog: string): PRText {
  const info = config.specDir ? loadClaudeRunInfo(config.specDir) : null;
  const summary = info?.summary || config.taskDescription || `Implements ${config.specId}`;
  const body = commitLog.trim()
    ? `## Summary\n\n${summary.slice(0, 2000)}\n\n## Commits\n\n${commitLog.trim()}`
    : `## Summary\n\n${summary.slice(0, 2000)}`;
  return { title: config.taskTitle || `workbench: ${config.specId}`, body };
}

/** Ask Claude Code for the PR title and body */
async function generatePRText(
  config: CreatePRConfig,
  diffSummary: string,
  commitLog: string,
): Promise<PRText | null> {
  const prompt = `Write the title and description for a GitHub Pull Request.

${describeTask(config)}

Branch: ${config.branchName}
Base branch: ${config.baseBranch}

Commit log:
${commitLog || '(no commits listed)'}

Diff summary:
${diffSummary || '(no diff available)'}

You can inspect the changes with \`git diff ${config.baseBranch}...HEAD\` or by reading files.`;

  try {
    const result = await runClaudeText({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      model: config.model ?? 'sonnet',
      effort: config.effort ?? 'low',
      step: 'git',
      specDir: config.specDir,
      cwd: config.worktreePath,
      tools: [...READ_ONLY_TOOLS, 'Bash'],
      allowedTools: ['Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)'],
      jsonSchema: PR_TEXT_SCHEMA,
      maxTurns: 15,
      timeoutMs: PR_TEXT_TIMEOUT_MS,
    });
    const structured = result.structured as Partial<PRText> | undefined;
    const title = typeof structured?.title === 'string' ? structured.title.split('\n')[0].trim() : '';
    const body = typeof structured?.body === 'string' ? structured.body.trim() : result.text.trim();
    if (!body) return null;
    return { title: title.slice(0, MAX_TITLE_LENGTH), body };
  } catch {
    return null;
  }
}

/** Push the worktree branch to origin; returns an error string on failure */
async function pushBranch(worktreePath: string, branchName: string): Promise<string | undefined> {
  try {
    await run('git', ['push', '--set-upstream', 'origin', branchName], worktreePath);
    return undefined;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr;
    return stderr ? String(stderr) : err instanceof Error ? err.message : String(err);
  }
}

/** URL of an existing PR for the branch */
async function getExistingPRUrl(
  projectDir: string,
  branchName: string,
  baseBranch: string,
): Promise<string | undefined> {
  try {
    const output = (await run('gh', ['pr', 'view', branchName, '--json', 'url', '--jq', '.url'], projectDir)).trim();
    if (output.startsWith('http')) return output;
  } catch {
    // Fall through to listing
  }
  try {
    const listOutput = (await run(
      'gh',
      ['pr', 'list', '--head', branchName, '--base', baseBranch, '--json', 'url', '--jq', '.[0].url'],
      projectDir,
    )).trim();
    return listOutput.startsWith('http') ? listOutput : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Main PR Creator
// =============================================================================

/** Push a worktree branch and create a GitHub PR with a Claude-written title and description */
export async function createPR(config: CreatePRConfig): Promise<CreatePRResult> {
  const { projectDir, worktreePath, branchName, baseBranch, draft = false } = config;

  // Step 1: Push the branch to origin
  const pushError = await pushBranch(worktreePath, branchName);
  if (pushError) {
    const isUpToDate = pushError.includes('Everything up-to-date') || pushError.includes('up to date');
    if (!isUpToDate) {
      return { success: false, error: `Failed to push branch: ${pushError}` };
    }
  }

  // Step 2-3: Gather context and generate the PR text
  const { diffSummary, commitLog } = await gatherPRContext(worktreePath, baseBranch);
  const generated = await generatePRText(config, diffSummary, commitLog);
  const fallback = fallbackPRText(config, commitLog);
  const title = config.title?.trim() || generated?.title || fallback.title;
  const body = generated?.body || fallback.body;

  // Step 4: Create the PR
  const effectiveBase = baseBranch.startsWith('origin/') ? baseBranch.slice('origin/'.length) : baseBranch;
  const ghArgs = ['pr', 'create', '--base', effectiveBase, '--head', branchName, '--title', title, '--body', body];
  if (draft) ghArgs.push('--draft');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = (await run('gh', ghArgs, projectDir)).trim();
      let prUrl: string | undefined;
      if (output.startsWith('http')) {
        prUrl = output;
      } else {
        const match = output.match(/https:\/\/[^\s]+\/pull\/\d+/);
        prUrl = match ? match[0] : undefined;
      }
      return { success: true, prUrl, alreadyExists: false };
    } catch (err: unknown) {
      const spawnErr = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      const stderr = String(spawnErr.stderr ?? '');
      const stdout = String(spawnErr.stdout ?? '');

      if (stderr.toLowerCase().includes('already exists') || stdout.toLowerCase().includes('already exists')) {
        const existingUrl = await getExistingPRUrl(projectDir, branchName, effectiveBase);
        return { success: true, prUrl: existingUrl, alreadyExists: true };
      }

      const isNetworkError = /timeout|connection|network|ECONNRESET|ECONNREFUSED/i.test(stderr);
      const isServerError = /5\d\d|server error|internal error/i.test(stderr);
      if ((isNetworkError || isServerError) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
        continue;
      }

      return { success: false, error: stderr || stdout || String(spawnErr.message) || 'Failed to create PR' };
    }
  }

  return { success: false, error: 'PR creation failed after 3 attempts' };
}
