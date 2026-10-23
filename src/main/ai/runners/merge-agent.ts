/**
 * Merge Agent
 * ===========
 *
 * A Claude Code run, in a task's worktree, that finishes a merge of the PR's target branch into
 * the task branch: it resolves the conflicted files so the task's changes and every change
 * already merged into the target (other tasks that ran in parallel) survive, checks the result
 * and commits the merge. The caller verifies the result (see `pr-merger.ts`).
 */

import { runClaudeText } from '../../claude-code/run-text';
import type { ClaudeEffort } from '../../../shared/types/claude-code';

/** Lines of the target branch missing from a file after a first resolution */
export interface MissingTargetLines {
  file: string;
  lines: string[];
}

export interface MergeAgentInput {
  worktreePath: string;
  /** Task branch (checked out in the worktree) */
  branch: string;
  /** Target branch being merged in, as a ref (e.g. `origin/main`) */
  targetRef: string;
  conflictedFiles: string[];
  taskTitle?: string;
  taskDescription?: string;
  /** Second pass: target lines the first resolution dropped */
  missingLines?: MissingTargetLines[];
  model?: string;
  effort?: ClaudeEffort;
  profileId?: string;
  /** The task's spec dir (model routing by task size) */
  specDir?: string;
  abortSignal?: AbortSignal;
}

export interface MergeAgentResult {
  status: 'resolved' | 'failed';
  summary: string;
  /** Target lines the agent left out on purpose (both sides changed them), with the reason */
  intentionallyDropped: Array<{ file: string; line: string; reason: string }>;
}

export type MergeAgentFn = (input: MergeAgentInput) => Promise<MergeAgentResult>;

const MERGE_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

const MERGE_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['resolved', 'failed'] },
    summary: { type: 'string', description: 'How each conflict was resolved and how the result was checked' },
    intentionallyDropped: {
      type: 'array',
      description: 'Lines added on the target branch that the resolution leaves out on purpose',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'line', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['status', 'summary', 'intentionallyDropped'],
  additionalProperties: false,
} as const;

function systemPrompt(input: MergeAgentInput): string {
  return `You are the merge agent of Workbench, a desktop app that runs coding tasks in parallel, each in its own git worktree. Nobody watches this session and nobody can answer questions.

Your working directory is the worktree of a task on branch \`${input.branch}\`. Its pull request is about to be merged into \`${input.targetRef}\`, so \`${input.targetRef}\` was merged into \`${input.branch}\` first, and that merge stopped with conflicts. Other tasks that ran in parallel have already merged their changes into \`${input.targetRef}\`: none of those changes may be lost, and none of this task's changes either.

How to resolve:
- For each conflicted file, understand both sides before editing: \`git diff\`, \`git log -p --merge -- <file>\`, and the three versions \`git show :1:<file>\` (common ancestor), \`:2:<file>\` (this task) and \`:3:<file>\` (${input.targetRef}).
- Keep both sides' changes. When both sides changed the same lines, combine their intent so the code does what both changes meant; never drop one side just to end the conflict.
- Change nothing beyond what the merge needs. Make sure no conflict markers remain.
- Check the result with the project's own checks that apply to the files involved (type checker, tests, build) when they can run here, and fix breakage the merge caused.
- Then stage the files and conclude the merge with \`git commit --no-edit\`.
- Never push, abort the merge, reset, rebase, stash, or touch other branches.

Report status "failed" if you could not resolve every conflict safely. List in intentionallyDropped every line added on ${input.targetRef} that the resolution leaves out on purpose, with the reason.`;
}

function userPrompt(input: MergeAgentInput): string {
  const task = input.taskTitle
    ? `<task title="${input.taskTitle.replace(/"/g, "'")}">\n${input.taskDescription ?? ''}\n</task>\n\n`
    : '';
  if (input.missingLines?.length) {
    const missing = input.missingLines
      .map(({ file, lines }) => `${file}:\n${lines.map((line) => `  ${line}`).join('\n')}`)
      .join('\n\n');
    return `${task}The merge of \`${input.targetRef}\` into \`${input.branch}\` was committed, but these lines added on \`${input.targetRef}\` are no longer in the files:

${missing}

Compare each file with \`git show ${input.targetRef}:<file>\` and the merge's first parent. Restore every line that was lost, combined with this task's changes; check the result and commit the fix (\`git commit\`, don't amend). Only leave a line out when this task's change replaces it on purpose, and list it in intentionallyDropped with the reason.`;
  }
  return `${task}Resolve the merge conflicts in:
${input.conflictedFiles.map((file) => `- ${file}`).join('\n')}`;
}

/** Run the merge agent */
export const runMergeAgent: MergeAgentFn = async (input) => {
  const result = await runClaudeText({
    prompt: userPrompt(input),
    appendSystemPrompt: systemPrompt(input),
    model: input.model ?? 'opus',
    effort: input.effort ?? 'medium',
    step: 'merge',
    specDir: input.specDir,
    cwd: input.worktreePath,
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    allowedTools: ['Edit', 'Write', 'Bash'],
    jsonSchema: MERGE_AGENT_SCHEMA,
    maxTurns: 150,
    timeoutMs: MERGE_AGENT_TIMEOUT_MS,
    abortSignal: input.abortSignal,
    profileId: input.profileId,
  });
  const structured = result.structured as Partial<MergeAgentResult> | undefined;
  return {
    status: structured?.status === 'resolved' ? 'resolved' : 'failed',
    summary: typeof structured?.summary === 'string' ? structured.summary : result.text,
    intentionallyDropped: Array.isArray(structured?.intentionallyDropped) ? structured.intentionallyDropped : [],
  };
};
