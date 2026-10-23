/**
 * PR Merger Runner
 * ================
 *
 * Merges a task's GitHub pull request:
 * 1. Check the PR (already merged or closed) and move it to the chosen target branch
 * 2. Pull the target branch into the task branch in its worktree, since other tasks may have
 *    merged changes into it meanwhile
 * 3. When that merge conflicts, the merge agent (Claude Code) resolves it; the result must keep
 *    every line the target branch added in those files, or the agent gets a second pass
 * 4. Push the task branch and merge the PR with `gh pr merge --merge`
 *
 * A failed merge leaves the worktree as it was. All git/gh calls are async.
 */

import { git as runGit } from '../../../utils/git-exec';
import { runTool } from '../../../platform/runtime-exec';
import { runMergeAgent, type MergeAgentFn, type MissingTargetLines } from '../merge-agent';
import type { MergePRStep, WorktreeMergePRResult } from '../../../../shared/types/task';

export interface MergePRConfig {
  /** Project root directory (main git repo; gh runs here) */
  projectDir: string;
  /** Worktree directory (the task branch is checked out here) */
  worktreePath: string;
  prUrl: string;
  /** Branch to merge into; the PR's current base when omitted */
  targetBranch?: string;
  taskTitle?: string;
  taskDescription?: string;
  /** Claude profile for the merge agent */
  profileId?: string;
  /** The task's spec dir (model routing by task size) */
  specDir?: string;
  /** Workbench's data folder, ignored when checking for uncommitted changes */
  dataDir?: string;
  onProgress?: (step: MergePRStep, params?: Record<string, string | number>) => void;
  /** Runs gh (tests replace it) */
  gh?: (args: string[]) => Promise<string>;
  /** Resolves conflicts (tests replace it) */
  mergeAgent?: MergeAgentFn;
}

export type MergePRResult = WorktreeMergePRResult;

interface PullRequestView {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  baseRefName: string;
  headRefName: string;
}

const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;
/** Target lines too generic to tell whether they survived (braces, punctuation) */
const TRIVIAL_LINE = /^[\s{}()[\];,.]*$/;

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/** Lines the target branch added to each file (since `mergeBase`) that `HEAD` no longer has */
async function findMissingTargetLines(
  git: (args: string[]) => Promise<string>,
  files: string[],
  mergeBase: string,
  targetRef: string,
): Promise<MissingTargetLines[]> {
  const missing: MissingTargetLines[] = [];
  for (const file of files) {
    const diff = await git(['diff', '-U0', mergeBase, targetRef, '--', file]).catch(() => '');
    const added = diff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1).trim())
      .filter((line) => !TRIVIAL_LINE.test(line));
    if (added.length === 0) continue;
    const content = await git(['show', `HEAD:${file}`]).catch(() => '');
    const present = new Set(content.split('\n').map((line) => line.trim()));
    const lost = [...new Set(added.filter((line) => !present.has(line)))];
    if (lost.length) missing.push({ file, lines: lost });
  }
  return missing;
}

/** Merge a task's pull request after pulling its target branch into the task branch */
export async function mergePR(config: MergePRConfig): Promise<MergePRResult> {
  const { worktreePath, prUrl, projectDir, onProgress } = config;
  const git = async (args: string[]) =>
    (await runGit(args, { cwd: worktreePath, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
  const gh = config.gh ?? (async (args: string[]) =>
    (await runTool('gh', args, { cwd: projectDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })).stdout);
  const mergeAgent = config.mergeAgent ?? runMergeAgent;
  const dataDir = `${(config.dataDir || '.workbench').replace(/\\/g, '/')}/`;
  const isMerging = () => git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);

  // 1. The pull request
  onProgress?.('checking');
  let view: PullRequestView;
  try {
    view = JSON.parse(await gh(['pr', 'view', prUrl, '--json', 'state,baseRefName,headRefName'])) as PullRequestView;
  } catch (error) {
    return { success: false, error: `Could not read the pull request: ${errorText(error)}` };
  }
  if (view.state === 'MERGED') return { success: true, alreadyMerged: true, targetBranch: view.baseRefName };
  if (view.state !== 'OPEN') return { success: false, error: 'The pull request is closed' };
  const target = config.targetBranch?.trim() || view.baseRefName;
  const targetRef = `origin/${target}`;

  // A merge left over from an interrupted attempt starts over; other changes must be committed
  if (await isMerging()) await git(['merge', '--abort']).catch(() => undefined);
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no']))
    .split('\n')
    .filter((line) => line.trim() && !line.slice(3).startsWith(dataDir));
  if (dirty.length) {
    return { success: false, error: "The task's worktree has uncommitted changes. Commit or discard them before merging." };
  }

  if (target !== view.baseRefName) {
    try {
      await gh(['pr', 'edit', prUrl, '--base', target]);
    } catch (error) {
      return { success: false, error: `Could not change the pull request's target branch: ${errorText(error)}` };
    }
  }

  // 2. Pull the target branch into the task branch
  onProgress?.('pulling', { target });
  try {
    await git(['fetch', 'origin', target]);
  } catch (error) {
    return { success: false, error: `Could not fetch ${target}: ${errorText(error)}` };
  }
  const before = (await git(['rev-parse', 'HEAD'])).trim();
  const mergeBase = (await git(['merge-base', 'HEAD', targetRef]).catch(() => '')).trim();
  const rollback = async () => {
    if (await isMerging()) await git(['merge', '--abort']).catch(() => undefined);
    const head = (await git(['rev-parse', 'HEAD']).catch(() => before)).trim();
    if (head !== before) await git(['reset', '--hard', before]).catch(() => undefined);
  };

  let conflictedFiles: string[] = [];
  const summaries: string[] = [];
  try {
    await git(['merge', '--no-ff', '--no-edit', targetRef]);
  } catch (error) {
    conflictedFiles = (await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n').map((file) => file.trim()).filter(Boolean);
    if (conflictedFiles.length === 0) {
      await rollback();
      return { success: false, error: `Could not merge ${target} into the task branch: ${errorText(error)}` };
    }
  }

  // 3. Conflicts: the merge agent resolves them, then the result is checked
  if (conflictedFiles.length) {
    const agentInput = {
      worktreePath,
      branch: view.headRefName,
      targetRef,
      conflictedFiles,
      taskTitle: config.taskTitle,
      taskDescription: config.taskDescription,
      profileId: config.profileId,
      specDir: config.specDir,
    };
    try {
      onProgress?.('resolving', { count: conflictedFiles.length });
      const first = await mergeAgent(agentInput);
      summaries.push(first.summary);
      if (first.status !== 'resolved') throw new Error(`Claude Code could not resolve the conflicts: ${first.summary}`);

      onProgress?.('verifying');
      const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'])).trim();
      if (unmerged) throw new Error(`Conflicts remain in: ${unmerged.split('\n').join(', ')}`);
      for (const file of conflictedFiles) {
        const content = await git(['show', `:${file}`]).catch(() => git(['show', `HEAD:${file}`]).catch(() => ''));
        if (CONFLICT_MARKER.test(content)) throw new Error(`Conflict markers remain in ${file}`);
      }
      if (await isMerging()) await git(['commit', '--no-edit']);
      await git(['merge-base', '--is-ancestor', targetRef, 'HEAD']).catch(() => {
        throw new Error(`The merge did not include ${target}`);
      });

      // Every line the target added to the conflicted files must survive
      let missing = mergeBase ? await findMissingTargetLines(git, conflictedFiles, mergeBase, targetRef) : [];
      if (missing.length) {
        onProgress?.('resolving', { count: missing.length });
        const second = await mergeAgent({ ...agentInput, missingLines: missing });
        summaries.push(second.summary);
        if (second.status !== 'resolved') throw new Error(`Claude Code could not restore the changes from ${target}: ${second.summary}`);
        if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) {
          await git(['add', '-u']);
          await git(['commit', '-m', `Restore changes from ${target} lost in the merge`]);
        }
        const dropped = new Set(second.intentionallyDropped.map(({ file, line }) => `${file}\0${line.trim()}`));
        missing = (await findMissingTargetLines(git, conflictedFiles, mergeBase, targetRef))
          .map(({ file, lines }) => ({ file, lines: lines.filter((line) => !dropped.has(`${file}\0${line}`)) }))
          .filter(({ lines }) => lines.length);
        if (missing.length) {
          const list = missing.map(({ file, lines }) => `${file}: ${lines.slice(0, 3).join(' | ')}`).join('; ');
          throw new Error(`The merge would lose changes from ${target} (${list})`);
        }
      }
    } catch (error) {
      await rollback();
      return { success: false, conflictedFiles, summary: summaries.join('\n\n') || undefined, error: errorText(error) };
    }
  }

  // 4. Push the task branch and merge the PR
  onProgress?.('pushing');
  try {
    await git(['push', 'origin', `HEAD:refs/heads/${view.headRefName}`]);
  } catch (error) {
    return { success: false, conflictedFiles, error: `Could not push ${view.headRefName}: ${errorText(error)}` };
  }
  onProgress?.('merging');
  try {
    await gh(['pr', 'merge', prUrl, '--merge']);
  } catch (error) {
    return { success: false, conflictedFiles, error: `Could not merge the pull request: ${errorText(error)}` };
  }
  return { success: true, targetBranch: target, conflictedFiles, summary: summaries.join('\n\n') || undefined };
}
