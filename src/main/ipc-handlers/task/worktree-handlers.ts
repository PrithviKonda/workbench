import { handleIpc } from '../ipc-registry';
import { BrowserWindow } from 'electron';
import type { ConflictSeverity } from '../../../shared/types/task';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, DATA_DIR_NAMES, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, WorktreeStatus, WorktreeMergeResult, WorktreeDiscardResult, WorktreeListResult, WorktreeListItem, WorktreeCreatePROptions, WorktreeCreatePRResult, WorktreeMergePROptions, WorktreeMergePRResult, WorktreeLocalMergeResult, PullRequestState, Project, Task } from '../../../shared/types';
import path from 'path';
import { matchesExtensionGlob } from '../../utils/glob-markers';
import { existsSync, readdirSync, statSync, readFileSync, promises as fsPromises } from 'fs';
import { projectStore } from '../../project-store';

import { MergeOrchestrator } from '../../ai/merge/orchestrator';
import { createMergeResolverFn } from '../../ai/runners/merge-resolver';
import { createPR } from '../../ai/runners/github/pr-creator';
import { mergePR } from '../../ai/runners/github/pr-merger';
import { localMerge } from '../../worktree/local-merge';
import { taskHooks } from '../../task-hooks';
import { resetTaskRunState } from './plan-file-utils';
import { findTaskAndProject } from './shared';
import { git } from '../../utils/git-exec';
import { runTool, runToolScript } from '../../platform/runtime-exec';
import { isWslRuntime } from '../../platform/shell-runtime';
import {
  getTaskWorktreeDir,
  findTaskWorktree,
} from '../../worktree-paths';
import { persistPlanStatus, updateTaskMetadataFields } from './plan-file-utils';
import { refreshGitIndex } from '../../utils/git-isolation';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { taskStateManager } from '../../task-state-manager';
import { safeSendToRenderer } from '../utils';

// Regex pattern for validating git branch names
export const GIT_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

// Maximum PR title length (GitHub's limit is 256 characters)
const MAX_PR_TITLE_LENGTH = 256;

// Regex for validating PR title contains only printable characters
const PRINTABLE_CHARS_REGEX = /^[\x20-\x7E\u00A0-\uFFFF]*$/;

/**
 * Check if a repository is misconfigured as bare but has source files.
 * If so, automatically fix the configuration by unsetting core.bare.
 *
 * This can happen when git worktree operations incorrectly set bare=true,
 * or when users manually misconfigure the repository.
 *
 * @param projectPath - Path to check and potentially fix
 * @returns true if fixed, false if no fix needed or not fixable
 */
async function fixMisconfiguredBareRepo(projectPath: string): Promise<boolean> {
  try {
    // Check if bare=true is set
    const bareConfig = (await git(
      ['config', '--get', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8' }
    )).stdout.trim().toLowerCase();

    if (bareConfig !== 'true') {
      return false; // Not marked as bare, nothing to fix
    }

    // Check if there are source files (indicating misconfiguration)
    // A truly bare repo would only have git internals, not source code
    // This covers multiple ecosystems: JS/TS, Python, Rust, Go, Java, C#, etc.
    //
    // Markers are separated into exact matches and glob patterns for efficiency.
    // Exact matches use existsSync() directly, while glob patterns are matched
    // against a cached directory listing.
    const EXACT_MARKERS = [
      // JavaScript/TypeScript ecosystem
      'package.json', 'apps', 'src',
      // Python ecosystem
      'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile',
      // Rust ecosystem
      'Cargo.toml',
      // Go ecosystem
      'go.mod', 'go.sum', 'cmd', 'main.go',
      // Java/JVM ecosystem
      'pom.xml', 'build.gradle', 'build.gradle.kts',
      // Ruby ecosystem
      'Gemfile', 'Rakefile',
      // PHP ecosystem
      'composer.json',
      // General project markers
      'Makefile', 'CMakeLists.txt', 'README.md', 'LICENSE'
    ];

    const GLOB_MARKERS = [
      // .NET/C# ecosystem - patterns that need glob matching
      '*.csproj', '*.sln', '*.fsproj'
    ];

    // Check exact matches first (fast path)
    const hasExactMatch = EXACT_MARKERS.some(marker =>
      existsSync(path.join(projectPath, marker))
    );

    if (hasExactMatch) {
      // Found a project marker, proceed to fix
    } else {
      // Check glob patterns - read directory once and cache for all patterns
      let directoryFiles: string[] | null = null;
      const MAX_FILES_TO_CHECK = 500; // Limit to avoid reading huge directories

      const hasGlobMatch = GLOB_MARKERS.some(pattern => {
        // Validate pattern - only support simple glob patterns for security
        if (pattern.includes('..') || pattern.includes('/')) {
          console.warn(`[GIT] Unsupported glob pattern ignored: ${pattern}`);
          return false;
        }

        // Lazy-load directory listing, cached across patterns
        if (directoryFiles === null) {
          try {
            const allFiles = readdirSync(projectPath);
            // Limit to first N entries to avoid performance issues
            directoryFiles = allFiles.slice(0, MAX_FILES_TO_CHECK);
            if (allFiles.length > MAX_FILES_TO_CHECK) {
              console.warn(`[GIT] Directory has ${allFiles.length} entries, checking only first ${MAX_FILES_TO_CHECK}`);
            }
          } catch (error) {
            // Log the error for debugging instead of silently swallowing
            console.warn(`[GIT] Failed to read directory ${projectPath}:`, error instanceof Error ? error.message : String(error));
            directoryFiles = [];
          }
        }

        return directoryFiles.some(file => matchesExtensionGlob(file, pattern));
      });

      if (!hasGlobMatch) {
        return false; // Legitimately bare repo
      }
    }

    // Fix the misconfiguration
    console.warn('[GIT] Detected misconfigured bare repository with source files. Auto-fixing by unsetting core.bare...');
    await git(
      ['config', '--unset', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8' }
    );
    console.warn('[GIT] Fixed: core.bare has been unset. Git operations should now work correctly.');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a valid git working tree (not a bare repository).
 * Returns true if the path is inside a git repository with a working tree.
 *
 * NOTE: This is a pure check with no side-effects. If you need to fix
 * misconfigured bare repos before an operation, call fixMisconfiguredBareRepo()
 * explicitly before calling this function.
 *
 * @param projectPath - Path to check
 * @returns true if it's a valid working tree, false if bare or not a git repo
 */
async function isGitWorkTree(projectPath: string): Promise<boolean> {
  try {
    // Use git rev-parse --is-inside-work-tree which returns "true" for working trees
    // and fails for bare repos or non-git directories
    const { stdout: result } = await git(
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: projectPath, encoding: 'utf-8' }
    );
    return result.trim() === 'true';
  } catch {
    // Not a working tree (could be bare repo or not a git repo at all)
    return false;
  }
}

/**
 * Read the stored base branch from task_metadata.json
 * This is the branch the task was created from (set by user during task creation)
 */
function getTaskBaseBranch(specDir: string): string | undefined {
  // Defensive check for undefined input
  if (!specDir || typeof specDir !== 'string') {
    console.error('[getTaskBaseBranch] specDir is undefined or not a string');
    return undefined;
  }

  try {
    const metadataPath = path.join(specDir, 'task_metadata.json');
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      // Return baseBranch if explicitly set (not the __project_default__ marker)
      // Also validate it's a valid branch name to prevent malformed git commands
      if (metadata.baseBranch &&
          metadata.baseBranch !== '__project_default__' &&
          GIT_BRANCH_REGEX.test(metadata.baseBranch)) {
        // Strip remote prefix if present (e.g., "origin/feat/x" → "feat/x")
        const branch = metadata.baseBranch.replace(/^origin\//, '');
        return branch;
      }
    }
  } catch (e) {
    console.warn('[getTaskBaseBranch] Failed to read task metadata:', e);
  }
  return undefined;
}

/**
 * Get the effective base branch for a task with proper fallback chain.
 * Priority:
 * 1. Task metadata baseBranch (explicit task-level override from task_metadata.json)
 * 2. Project settings mainBranch (project-level default)
 * 3. Git default branch detection (main/master)
 * 4. Fallback to 'main'
 *
 * This should be used instead of getting the current HEAD branch,
 * as the user may be on a feature branch when viewing worktree status.
 */
async function getEffectiveBaseBranch(projectPath: string, specId: string, projectMainBranch?: string): Promise<string> {
  // Defensive check for undefined inputs
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[getEffectiveBaseBranch] projectPath is undefined or not a string');
    return 'main';
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[getEffectiveBaseBranch] specId is undefined or not a string');
    return 'main';
  }

  // 1. Try task metadata baseBranch
  const specDir = path.join(projectPath, '.workbench', DATA_DIR_NAMES.tasks, specId);
  const taskBaseBranch = getTaskBaseBranch(specDir);
  if (taskBaseBranch) {
    return taskBaseBranch;
  }

  // 2. Try project settings mainBranch
  if (projectMainBranch && GIT_BRANCH_REGEX.test(projectMainBranch)) {
    return projectMainBranch;
  }

  // 3. Try to detect main/master branch (in WSL both checks share one launch)
  if (isWslRuntime()) {
    const [main, master] = await runToolScript('git', [['rev-parse', '--verify', 'main'], ['rev-parse', '--verify', 'master']], {
      cwd: projectPath,
      encoding: 'utf-8',
    });
    if (main.code === 0) return 'main';
    if (master.code === 0) return 'master';
    return 'main';
  }
  for (const branch of ['main', 'master']) {
    try {
      await git(['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
      });
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // 4. Fallback to 'main'
  return 'main';
}

// ============================================
// Helper functions for TASK_WORKTREE_CREATE_PR
// ============================================

/**
 * Result of updating task status after PR creation
 */
interface TaskStatusUpdateResult {
  mainProjectStatus: boolean;
  mainProjectMetadata: boolean;
  worktreeStatus: boolean;
  worktreeMetadata: boolean;
}

/**
 * Update task status (PR Created: it stays in Human Review until the PR is merged) and metadata
 * after PR creation. Updates both main project and worktree locations
 * @returns Result object indicating which updates succeeded/failed
 */
async function updateTaskStatusAfterPRCreation(
  specDir: string,
  worktreePath: string | null,
  prUrl: string,
  autoBuildPath: string | undefined,
  specId: string,
  debug: (...args: unknown[]) => void
): Promise<TaskStatusUpdateResult> {
  const result: TaskStatusUpdateResult = {
    mainProjectStatus: false,
    mainProjectMetadata: false,
    worktreeStatus: false,
    worktreeMetadata: false
  };

  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  const metadataPath = path.join(specDir, 'task_metadata.json');

  // Await status persistence to ensure completion before resolving
  try {
    const persisted = await persistPlanStatus(planPath, 'pr_created');
    result.mainProjectStatus = persisted;
    debug('Main project status persisted to pr_created:', persisted);
  } catch (err) {
    debug('Failed to persist main project status:', err);
  }

  // Update metadata with prUrl in main project
  result.mainProjectMetadata = updateTaskMetadataFields(metadataPath, { prUrl, prState: 'open' });
  debug('Main project metadata updated with prUrl:', result.mainProjectMetadata);

  // Also persist to WORKTREE location (worktree takes priority when loading tasks)
  // This ensures the status persists after refresh since getTasks() prefers worktree version
  if (worktreePath) {
    const specsBaseDir = getSpecsDir(autoBuildPath);
    const worktreePlanPath = path.join(worktreePath, specsBaseDir, specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const worktreeMetadataPath = path.join(worktreePath, specsBaseDir, specId, 'task_metadata.json');

    try {
      const persisted = await persistPlanStatus(worktreePlanPath, 'pr_created');
      result.worktreeStatus = persisted;
      debug('Worktree status persisted to pr_created:', persisted);
    } catch (err) {
      debug('Failed to persist worktree status:', err);
    }

    result.worktreeMetadata = updateTaskMetadataFields(worktreeMetadataPath, { prUrl, prState: 'open' });
    debug('Worktree metadata updated with prUrl:', result.worktreeMetadata);
  }

  return result;
}

/**
 * Generic retry wrapper with exponential backoff
 * @param operation - Async function to execute with retry
 * @param options - Retry configuration options
 * @returns Result of the operation or throws after all retries
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const { maxRetries: rawMaxRetries = 3, baseDelayMs = 100, onRetry, shouldRetry } = options;

  // Ensure at least one attempt is made (clamp to minimum of 1)
  const maxRetries = Math.max(1, rawMaxRetries);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      if (isLastAttempt) {
        throw error;
      }

      // Notify about retry
      onRetry?.(attempt, error);

      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('Retry loop exited unexpectedly');
}

/**
 * Register worktree management handlers
 */
export function registerWorktreeHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  /**
   * Get the worktree status for a task
   * Per-spec architecture: Each spec has its own worktree at .workbench/worktrees/tasks/{spec-name}/
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_STATUS,
    async (_, taskId: string): Promise<IPCResult<WorktreeStatus>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .workbench/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return {
            success: true,
            data: { exists: false }
          };
        }

        // Get branch info from git
        try {
          // Get base branch using proper fallback chain:
          // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
          const baseBranch = await getEffectiveBaseBranch(project.path, task.specId, project.settings?.mainBranch);

          // Current branch, commit count and diff stats (cross-platform - no shell syntax). Polled
          // for every task, so in WSL the three share one launch (one after the other natively).
          // The working-tree diff against baseBranch captures ALL changes (committed and
          // uncommitted), so the UI shows file stats before the agent commits its work.
          const [branchResult, countResult, diffResult] = await runToolScript('git', [
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            ['rev-list', '--count', `${baseBranch}..HEAD`],
            ['diff', '--stat', baseBranch],
          ], { cwd: worktreePath, encoding: 'utf-8' });
          if (branchResult.code !== 0) throw new Error(branchResult.stderr.trim() || 'git rev-parse failed');
          const branch = branchResult.stdout.trim();

          const commitCount = countResult.code === 0 ? parseInt(countResult.stdout.trim(), 10) || 0 : 0;

          let filesChanged = 0;
          let additions = 0;
          let deletions = 0;
          if (diffResult.code === 0) {
            // Parse the summary line (e.g., "3 files changed, 50 insertions(+), 10 deletions(-)")
            const summaryMatch = diffResult.stdout.trim().match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
            if (summaryMatch) {
              filesChanged = parseInt(summaryMatch[1], 10) || 0;
              additions = parseInt(summaryMatch[2], 10) || 0;
              deletions = parseInt(summaryMatch[3], 10) || 0;
            }
          }

          return {
            success: true,
            data: {
              exists: true,
              worktreePath,
              branch,
              baseBranch,
              commitCount,
              filesChanged,
              additions,
              deletions
            }
          };
        } catch (gitError) {
          console.error('Git error getting worktree status:', gitError);
          return {
            success: true,
            data: { exists: true, worktreePath }
          };
        }
      } catch (error) {
        console.error('Failed to get worktree status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get worktree status'
        };
      }
    }
  );

  /**
   * Merge the worktree changes into the main branch
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_MERGE,
    async (_, taskId: string, options?: { noCommit?: boolean }): Promise<IPCResult<WorktreeMergeResult>> => {
      const isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
      const debug = (...args: unknown[]) => {
        if (isDebugMode) {
          console.warn('[MERGE DEBUG]', ...args);
        }
      };

      try {
        debug('Handler called with taskId:', taskId, 'options:', options);

        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          debug('Task or project not found');
          return { success: false, error: 'Task not found' };
        }

        debug('Found task:', task.specId, 'project:', project.path);

        const specDir = path.join(project.path, project.autoBuildPath || '.workbench', DATA_DIR_NAMES.tasks, task.specId);
        const worktreePath = findTaskWorktree(project.path, task.specId);

        // Auto-fix any misconfigured bare repo before merge operation
        // This prevents issues where git operations fail due to incorrect bare=true config
        if (await fixMisconfiguredBareRepo(project.path)) {
          debug('Fixed misconfigured bare repository at:', project.path);
        }

        // Determine base branch with proper priority:
        // 1. Task metadata baseBranch (explicit task-level override)
        // 2. Project settings mainBranch (project-level default)
        // 3. Default to 'main'
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const projectMainBranch = project.settings?.mainBranch;
        const effectiveBaseBranch = taskBaseBranch || projectMainBranch || 'main';
        debug('Using base branch:', effectiveBaseBranch,
          `(source: ${taskBaseBranch ? 'task metadata' : projectMainBranch ? 'project settings' : 'default'})`);

        // Emit initial progress event so renderer shows the merge has started
        const emitProgress = (stage: string, percent: number, message: string, details: Record<string, unknown> = {}) => {
          safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_MERGE_PROGRESS, taskId, {
            type: 'progress',
            stage,
            percent,
            message,
            details
          });
        };

        emitProgress('analyzing', 0, 'Starting merge engine');

        // AI conflict resolution runs through Claude Code
        const aiResolverFn = createMergeResolverFn('sonnet', 'low', specDir);

        // Create the merge orchestrator
        const storageDir = path.join(project.path, project.autoBuildPath || '.workbench');
        const orchestrator = new MergeOrchestrator({
          projectDir: project.path,
          storageDir,
          enableAi: true,
          aiResolver: aiResolverFn,
          dryRun: false,
        });

        // Run the merge with progress callbacks
        let mergeSucceeded = false;
        let mergeError: string | undefined;

        try {
          const report = await orchestrator.mergeTask(
            task.specId,
            worktreePath ?? undefined,
            effectiveBaseBranch,
            (stage, percent, message, details) => {
              emitProgress(stage, percent, message, details ?? {});
            }
          );

          debug('Merge report:', {
            success: report.success,
            stats: report.stats,
            error: report.error,
            fileResults: report.fileResults.size
          });

          if (report.success) {
            // Apply merged content to the project directory
            const applied = orchestrator.applyToProject(report);
            debug('Applied merge to project:', applied);

            if (applied) {
              // Stage all changed files
              try {
                await git(['add', '-A'], {
                  cwd: project.path,
                  encoding: 'utf-8',
                  isolated: true
                });
                debug('Staged merged files');
              } catch (gitErr) {
                debug('Failed to stage merged files:', gitErr);
              }

              mergeSucceeded = true;
            } else {
              mergeError = 'Failed to apply merged files to project directory';
            }
          } else {
            mergeError = report.error ?? 'Merge failed';
          }
        } catch (err) {
          mergeError = err instanceof Error ? err.message : String(err);
          debug('Merge orchestrator threw:', mergeError);
          emitProgress('error', 0, `Merge failed: ${mergeError}`);
        }

        // Post-merge: check git status, update plan files, clean worktree

            // Get git status after merge (only if project is a working tree, not a bare repo)
            if (await isGitWorkTree(project.path)) {
              try {
                const { stdout: gitStatusAfter } = await git(['status', '--short'], { cwd: project.path, encoding: 'utf-8' });
                debug('Git status AFTER merge in main project:\n', gitStatusAfter || '(clean)');
                const { stdout: gitDiffStaged } = await git(['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' });
                debug('Staged changes:\n', gitDiffStaged || '(none)');
              } catch (e) {
                debug('Failed to get git status after:', e);
              }
            } else {
              debug('Project is a bare repository - skipping git status check (this is normal for worktree-based projects)');
            }

            if (mergeSucceeded) {
              const isStageOnly = options?.noCommit === true;

              // Verify changes were actually staged when stage-only mode is requested
              // This prevents false positives when merge was already committed previously
              let hasActualStagedChanges = false;
              let mergeAlreadyCommitted = false;

              if (isStageOnly) {
                // Only check staged changes if project is a working tree (not bare repo)
                if (await isGitWorkTree(project.path)) {
                  try {
                    const { stdout: gitDiffStaged } = await git(['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' });
                    hasActualStagedChanges = gitDiffStaged.trim().length > 0;
                    debug('Stage-only verification: hasActualStagedChanges:', hasActualStagedChanges);

                    if (!hasActualStagedChanges) {
                      // Check if worktree branch was already merged (merge commit exists)
                      const specBranch = `workbench/${task.specId}`;
                      try {
                        // Check if current branch contains all commits from spec branch
                        // git merge-base --is-ancestor returns exit code 0 if true, 1 if false
                        await git(
                          ['merge-base', '--is-ancestor', specBranch, 'HEAD'],
                          { cwd: project.path, encoding: 'utf-8' }
                        );
                        // If we reach here, the command succeeded (exit code 0) - branch is merged
                        mergeAlreadyCommitted = true;
                        debug('Merge already committed check:', mergeAlreadyCommitted);
                      } catch {
                        // Exit code 1 means not merged, or branch may not exist
                        mergeAlreadyCommitted = false;
                        debug('Could not check merge status, assuming not merged');
                      }
                    }
                  } catch (e) {
                    debug('Failed to verify staged changes:', e);
                  }
                } else {
                  // For bare repos, skip staging verification - merge happens in worktree
                  debug('Project is a bare repository - skipping staged changes verification');
                }
              }

              // Determine actual status based on verification
              let newStatus: string;
              let planStatus: string;
              let message: string;
              let staged: boolean;

              if (isStageOnly && !hasActualStagedChanges && mergeAlreadyCommitted) {
                // Stage-only was requested but merge was already committed previously
                // Keep in human_review and let user explicitly mark as done (which will trigger cleanup confirmation)
                // This ensures user is in control of when the worktree is deleted
                newStatus = 'human_review';
                planStatus = 'review';
                message = 'Changes were already merged and committed. You can mark this task as complete when ready.';
                staged = false;
                debug('Stage-only requested but merge already committed. Keeping in human_review for user to confirm completion.');
                // NOTE: We intentionally do NOT auto-clean the worktree here.
                // User can drag the task to "Done" column which will show a confirmation dialog
                // asking if they want to delete the worktree and mark complete.
              } else if (isStageOnly && !hasActualStagedChanges) {
                // Stage-only was requested but no changes to stage (and not committed)
                // This could mean nothing to merge or an error - keep in human_review for investigation
                newStatus = 'human_review';
                planStatus = 'review';
                message = 'No changes to stage. The worktree may have no differences from the current branch.';
                staged = false;
                debug('Stage-only requested but no changes to stage.');
              } else if (isStageOnly) {
                // Stage-only with actual staged changes - expected success case
                newStatus = 'human_review';
                planStatus = 'review';
                message = 'Changes staged in main project. Review with git status and commit when ready.';
                staged = true;
              } else {
                // Full merge (not stage-only)
                newStatus = 'done';
                planStatus = 'completed';
                message = 'Changes merged successfully';
                staged = false;

                // Clean up worktree after successful full merge (fixes #243)
                // This allows drag-to-Done workflow since TASK_UPDATE_STATUS blocks 'done' when worktree exists
                // Uses shared cleanup utility for robust Windows support (fixes #1539)
                if (worktreePath && existsSync(worktreePath)) {
                  const cleanupResult = await cleanupWorktree({
                    worktreePath,
                    projectPath: project.path,
                    specId: task.specId,
                    logPrefix: '[TASK_WORKTREE_MERGE]',
                    deleteBranch: true
                  });

                  if (cleanupResult.success) {
                    debug('Worktree cleaned up after full merge:', worktreePath);
                    if (cleanupResult.branch) {
                      debug('Task branch deleted:', cleanupResult.branch);
                    }
                  } else {
                    debug('Worktree cleanup failed (non-fatal):', cleanupResult.warnings);
                    // Non-fatal - merge succeeded, cleanup can be done manually
                  }

                  // Log any warnings for debugging
                  if (cleanupResult.warnings.length > 0) {
                    debug('Cleanup warnings:', cleanupResult.warnings);
                  }
                }
              }

              debug('Merge result. isStageOnly:', isStageOnly, 'newStatus:', newStatus, 'staged:', staged);
              const reviewReason = newStatus === 'human_review' ? 'completed' : undefined;

              // Generate AI commit message if staging succeeded
              let suggestedCommitMessage: string | undefined;
              if (staged) {
                try {
                  // Get diff summary and changed files for context
                  let diffSummary = '';
                  let filesChangedList: string[] = [];

                  if (await isGitWorkTree(project.path)) {
                    try {
                      const [diffResult, nameOnlyResult] = await Promise.all([
                        git(['diff', '--staged', '--stat'], { cwd: project.path, encoding: 'utf-8' }),
                        git(['diff', '--staged', '--name-only'], { cwd: project.path, encoding: 'utf-8' }),
                      ]);
                      diffSummary = diffResult.stdout.trim();
                      const nameOnly = nameOnlyResult.stdout.trim();
                      filesChangedList = nameOnly ? nameOnly.split('\n') : [];
                    } catch (e) {
                      debug('Failed to get staged diff for commit message:', e);
                    }
                  }

                  const { generateCommitMessage } = await import('../../ai/runners/commit-message');
                  suggestedCommitMessage = await generateCommitMessage({
                    specName: task.specId,
                    specDir,
                    taskTitle: task.title,
                    taskDescription: task.metadata?.userDescription || task.description,
                    githubIssue: task.metadata?.githubIssueNumber,
                    diffSummary,
                    filesChanged: filesChangedList,
                  });
                  debug('Generated commit message:', suggestedCommitMessage?.substring(0, 100));
                } catch (e) {
                  debug('Failed to generate commit message:', e);
                }
              }

              // Persist the status change to implementation_plan.json
              // Issue #243: We must update BOTH the main project's plan AND the worktree's plan (if it exists)
              // because ProjectStore prefers the worktree version when deduplicating tasks.
              // OPTIMIZATION: Use async I/O and parallel updates to prevent UI blocking
              // NOTE: The worktree has the same directory structure as main project
              const planPaths: { path: string; isMain: boolean }[] = [
                { path: path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), isMain: true },
              ];
              // Add worktree plan path if worktree exists
              if (worktreePath) {
                const worktreeSpecDir = path.join(worktreePath, project.autoBuildPath || '.workbench', DATA_DIR_NAMES.tasks, task.specId);
                planPaths.push({ path: path.join(worktreeSpecDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), isMain: false });
              }

              const { promises: fsPromises } = require('fs');

              // Update plan file with retry logic for transient failures
              // Uses EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
              const updatePlanWithRetry = async (planPath: string, isMain: boolean): Promise<boolean> => {
                // Helper to check if error is ENOENT (file not found)
                const isFileNotFound = (err: unknown): boolean =>
                  !!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');

                try {
                  await withRetry(
                    async () => {
                      const planContent = await fsPromises.readFile(planPath, 'utf-8');
                      const plan = JSON.parse(planContent);
                      plan.status = newStatus;
                      plan.planStatus = planStatus;
                      plan.reviewReason = reviewReason;
                      plan.updated_at = new Date().toISOString();
                      if (staged) {
                        plan.stagedAt = new Date().toISOString();
                        plan.stagedInMainProject = true;
                      }
                      await fsPromises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

                      // Verify the write succeeded by reading back
                      const verifyContent = await fsPromises.readFile(planPath, 'utf-8');
                      const verifyPlan = JSON.parse(verifyContent);
                      if (verifyPlan.status !== newStatus || verifyPlan.planStatus !== planStatus) {
                        throw new Error('Write verification failed - status mismatch');
                      }
                    },
                    {
                      maxRetries: 3,
                      baseDelayMs: 100,
                      shouldRetry: (err) => !isFileNotFound(err) // Don't retry if file doesn't exist
                    }
                  );
                  return true;
                } catch (err) {
                  // File doesn't exist - nothing to update (not an error)
                  if (isFileNotFound(err)) {
                    return true;
                  }
                  // Only log error if main plan fails; worktree plan might legitimately be missing or read-only
                  if (isMain) {
                    console.error('Failed to persist task status to main plan after retries:', err);
                  } else {
                    debug('Failed to persist task status to worktree plan (non-critical):', err);
                  }
                  return false;
                }
              };

              const updatePlans = async () => {
                const results = await Promise.all(
                  planPaths.map(({ path: planPath, isMain }) =>
                    updatePlanWithRetry(planPath, isMain)
                  )
                );
                // Log if main plan update failed (first element)
                if (!results[0]) {
                  console.warn('Background plan update: main plan write may not have persisted');
                }
              };

              // IMPORTANT: Wait for plan updates to complete before responding (fixes #243)
              // Previously this was "fire and forget" which caused a race condition:
              // resolve() would return before files were written, and UI refresh would read old status
              try {
                await updatePlans();
              } catch (err) {
                debug('Plan update failed:', err);
                // Non-fatal: UI will still update, but status may not persist across refresh
              }

              // Route status change through TaskStateManager (XState) to avoid dual emission
              taskStateManager.handleManualStatusChange(taskId, newStatus as any, task, project);

              return {
                success: true,
                data: {
                  success: true,
                  message,
                  staged,
                  projectPath: staged ? project.path : undefined,
                  suggestedCommitMessage
                }
              };
            } else {
              // Merge failed - return error to renderer
              debug('Merge failed. mergeError:', mergeError);
              return {
                success: true,
                data: {
                  success: false,
                  message: mergeError ?? 'Merge failed',
                  conflictFiles: undefined
                }
              };
            }
      } catch (error) {
        console.error('[MERGE] Exception in merge handler:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to merge worktree'
        };
      }
    }
  );

  /**
   * Preview merge conflicts before actually merging
   * Uses the TypeScript MergeOrchestrator to analyze potential conflicts without applying changes
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_MERGE_PREVIEW,
    async (_, taskId: string): Promise<IPCResult<WorktreeMergeResult>> => {
      console.warn('[IPC] TASK_WORKTREE_MERGE_PREVIEW called with taskId:', taskId);
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          console.error('[IPC] Task not found:', taskId);
          return { success: false, error: 'Task not found' };
        }
        console.warn('[IPC] Found task:', task.specId, 'project:', project.name);

        // Check for uncommitted changes in the main project (only if not a bare repo)
        let hasUncommittedChanges = false;
        let uncommittedFiles: string[] = [];
        if (await isGitWorkTree(project.path)) {
          try {
            await refreshGitIndex(project.path);

            const { stdout: gitStatus } = await git(['status', '--porcelain'], {
              cwd: project.path,
              encoding: 'utf-8'
            });

            if (gitStatus?.trim()) {
              // Parse the status output to get file names
              // Format: XY filename (where X and Y are status chars, then space, then filename)
              uncommittedFiles = gitStatus
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.substring(3).trim()) // Skip 2 status chars + 1 space, trim any trailing whitespace
                .filter(file => file); // Remove empty strings from short/malformed status lines

              hasUncommittedChanges = uncommittedFiles.length > 0;
            }
          } catch (e) {
            console.error('[IPC] Failed to check git status:', e);
          }
        } else {
          console.warn('[IPC] Project is a bare repository - skipping uncommitted changes check');
        }

        // Determine base branch with proper priority:
        // 1. Task metadata baseBranch (explicit task-level override)
        // 2. Project settings mainBranch (project-level default)
        // 3. Default to 'main'
        const specDir = path.join(project.path, project.autoBuildPath || '.workbench', DATA_DIR_NAMES.tasks, task.specId);
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const projectMainBranch = project.settings?.mainBranch;
        const effectiveBaseBranch = taskBaseBranch || projectMainBranch || 'main';
        console.warn('[IPC] Using base branch for preview:', effectiveBaseBranch,
          `(source: ${taskBaseBranch ? 'task metadata' : projectMainBranch ? 'project settings' : 'default'})`);

        // Run preview using the TypeScript MergeOrchestrator in dry-run mode
        // (no AI resolver needed for preview — only conflict detection and analysis)
        const storageDir = path.join(project.path, project.autoBuildPath || '.workbench');
        const orchestrator = new MergeOrchestrator({
          projectDir: project.path,
          storageDir,
          enableAi: false,
          dryRun: true,
        });

        // Refresh evolution data from git before previewing.
        // previewMerge() only reads from the in-memory evolutions map (loaded from file_evolution.json).
        // Without refreshFromGit(), the map is stale/empty for tasks whose evolution wasn't previously tracked.
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          console.warn('[IPC] Refreshing evolution data from worktree:', worktreePath);
          await orchestrator.evolutionTracker.refreshFromGit(task.specId, worktreePath, effectiveBaseBranch);
        } else {
          console.warn('[IPC] No worktree found for preview — evolution data may be stale');
        }

        console.warn('[IPC] Running TypeScript merge preview for task:', task.specId);
        const previewResult = orchestrator.previewMerge([task.specId]);

        const summary = previewResult['summary'] as Record<string, number> | undefined;
        const rawConflicts = previewResult['conflicts'] as Array<Record<string, unknown>> | undefined;
        const filesToMerge = previewResult['files_to_merge'] as string[] | undefined;

        // Map orchestrator conflict format to frontend MergeConflict shape
        const mergeConflicts = (rawConflicts || []).map((c) => ({
          file: String(c['file'] ?? ''),
          location: String(c['location'] ?? ''),
          tasks: Array.isArray(c['tasks']) ? (c['tasks'] as string[]) : [],
          severity: (c['severity'] ?? 'low') as ConflictSeverity,
          canAutoMerge: Boolean(c['can_auto_merge']),
          strategy: c['strategy'] != null ? String(c['strategy']) : undefined,
          reason: String(c['reason'] ?? ''),
        }));

        return {
          success: true,
          data: {
            success: true,
            message: 'Preview completed',
            preview: {
              files: filesToMerge || [],
              conflicts: mergeConflicts,
              summary: {
                totalFiles: summary?.['total_files'] ?? 0,
                conflictFiles: summary?.['conflict_files'] ?? 0,
                totalConflicts: summary?.['total_conflicts'] ?? 0,
                autoMergeable: summary?.['auto_mergeable'] ?? 0,
                hasGitConflicts: false,
              },
              // Include uncommitted changes info for the frontend
              uncommittedChanges: hasUncommittedChanges ? {
                hasChanges: true,
                files: uncommittedFiles,
                count: uncommittedFiles.length,
              } : null,
            },
          },
        };
      } catch (error) {
        console.error('[IPC] TASK_WORKTREE_MERGE_PREVIEW error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to preview merge'
        };
      }
    }
  );

  /**
   * Discard the worktree changes
   * Per-spec architecture: Each spec has its own worktree at .workbench/worktrees/tasks/{spec-name}/
   *
   * Note: Uses the shared cleanupWorktree utility which handles Windows-specific issues
   * where `git worktree remove --force` fails when the directory contains untracked files.
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_DISCARD,
    async (_, taskId: string, skipStatusChange?: boolean): Promise<IPCResult<WorktreeDiscardResult>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        // Find worktree at .workbench/worktrees/tasks/{spec-name}/
        const worktreePath = findTaskWorktree(project.path, task.specId);

        if (!worktreePath) {
          return {
            success: true,
            data: {
              success: true,
              message: 'No worktree to discard'
            }
          };
        }

        // Use the shared cleanup utility for robust, cross-platform worktree deletion
        const cleanupResult = await cleanupWorktree({
          worktreePath,
          projectPath: project.path,
          specId: task.specId,
          logPrefix: '[TASK_WORKTREE_DISCARD]',
          deleteBranch: true
        });

        if (!cleanupResult.success) {
          console.error('[TASK_WORKTREE_DISCARD] Cleanup failed:', cleanupResult.warnings);
          return {
            success: false,
            error: `Failed to discard worktree: ${cleanupResult.warnings.join('; ')}`
          };
        }

        // Log any non-fatal warnings
        if (cleanupResult.warnings.length > 0) {
          console.warn('[TASK_WORKTREE_DISCARD] Cleanup warnings:', cleanupResult.warnings);
        }

        // The Claude Code session ran in the discarded worktree: start over next time
        resetTaskRunState(project, task);

        // Only send status change to backlog if not skipped
        // (skip when caller will set a different status, e.g., 'done')
        if (!skipStatusChange) {
          // Route through TaskStateManager (XState) to avoid dual emission
          taskStateManager.handleManualStatusChange(taskId, 'backlog', task, project);
        }

        return {
          success: true,
          data: {
            success: true,
            message: 'Worktree discarded successfully'
          }
        };
      } catch (error) {
        console.error('Failed to discard worktree:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to discard worktree'
        };
      }
    }
  );

  /**
   * List all spec worktrees for a project
   * Per-spec architecture: Each spec has its own worktree at .workbench/worktrees/tasks/{spec-name}/
   */
  handleIpc(
    IPC_CHANNELS.TASK_LIST_WORKTREES,
    async (_, projectId: string): Promise<IPCResult<WorktreeListResult>> => {
      try {
        // Validate projectId
        if (!projectId || typeof projectId !== 'string') {
          console.error('listWorktrees: Invalid projectId:', projectId);
          return { success: false, error: 'Invalid projectId' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

// Validate project.path
        if (!project.path || typeof project.path !== 'string') {
          console.error('listWorktrees: Project path is invalid:', project.path);
          return { success: false, error: 'Project path is invalid' };
        }

        const worktreesDir = getTaskWorktreeDir(project.path);

        // Fetch tasks once before iterating (avoids repeated lookups per entry)
        // Used for orphan detection - worktrees without a matching task are orphaned
        const tasks = projectStore.getTasks(projectId);
        // Track if task lookup was successful (empty array with existing specs dir = lookup failed)
        const mainSpecsDir = path.join(project.path, '.workbench', DATA_DIR_NAMES.tasks);
        const taskLookupSuccessful = tasks.length > 0 || !existsSync(mainSpecsDir);

        // Helper to process a single worktree entry (async)
        const processWorktreeEntry = async (entry: string, entryPath: string): Promise<WorktreeListItem | null> => {
          try {
            // Get base branch using proper fallback chain:
            // 1. Task metadata baseBranch, 2. Project settings mainBranch, 3. main/master detection
            // Note: We do NOT use current HEAD as that may be a feature branch
            const baseBranch = await getEffectiveBaseBranch(project.path, entry, project.settings?.mainBranch);

            // Branch, commit count and diff stats (async, cross-platform - no shell syntax); in
            // WSL the three share one launch
            const [branchResult, countResult, diffResult] = await runToolScript('git', [
              ['rev-parse', '--abbrev-ref', 'HEAD'],
              ['rev-list', '--count', `${baseBranch}..HEAD`],
              ['diff', '--shortstat', `${baseBranch}...HEAD`],
            ], { cwd: entryPath, encoding: 'utf-8' });
            if (branchResult.code !== 0) throw new Error(branchResult.stderr.trim() || 'git rev-parse failed');
            const branch = branchResult.stdout.trim();

            const commitCount = countResult.code === 0 ? parseInt(countResult.stdout.trim(), 10) || 0 : 0;

            let filesChanged = 0;
            let additions = 0;
            let deletions = 0;
            if (diffResult.code === 0) {
              const diffStat = diffResult.stdout.trim();
              const filesMatch = diffStat.match(/(\d+) files? changed/);
              const addMatch = diffStat.match(/(\d+) insertions?/);
              const delMatch = diffStat.match(/(\d+) deletions?/);

              if (filesMatch) filesChanged = parseInt(filesMatch[1], 10) || 0;
              if (addMatch) additions = parseInt(addMatch[1], 10) || 0;
              if (delMatch) deletions = parseInt(delMatch[1], 10) || 0;
            }

            // Check if there's a task associated with this worktree
            // A worktree without a task is considered orphaned (can happen if task was deleted)
            // Only mark as orphaned if task lookup was successful (avoid false positives)
            const hasTask = tasks.some(t => t.specId === entry);

            return {
              specName: entry,
              path: entryPath,
              branch,
              baseBranch,
              commitCount,
              filesChanged,
              additions,
              deletions,
              isOrphaned: taskLookupSuccessful ? !hasTask : false
            };
          } catch (gitError) {
            // FIX: Don't skip worktree if git fails - it may be orphaned/corrupted
            // Include it so it can be managed (deleted if orphaned)
            const hasTask = tasks.some(t => t.specId === entry);
            console.warn(`[Worktree] Git commands failed for ${entry}, hasTask=${hasTask}:`, gitError);
            // Note: branch is empty - renderer should handle based on isOrphaned flag
            return {
              specName: entry,
              path: entryPath,
              branch: '',
              baseBranch: '',
              commitCount: 0,
              filesChanged: 0,
              additions: 0,
              deletions: 0,
              isOrphaned: taskLookupSuccessful ? !hasTask : false
            };
          }
        };

        // Scan worktrees directory (async)
        if (!existsSync(worktreesDir)) {
          return { success: true, data: { worktrees: [] } };
        }

        const entries = await fsPromises.readdir(worktreesDir);

        // Process all worktrees in parallel for better performance
        const worktreePromises = entries.map(async (entry) => {
          const entryPath = path.join(worktreesDir, entry);
          try {
            const stat = await fsPromises.stat(entryPath);
            if (stat.isDirectory()) {
              return processWorktreeEntry(entry, entryPath);
            }
          } catch {
            // Skip entries that can't be stat'd
          }
          return null;
        });

        const results = await Promise.all(worktreePromises);
        const worktrees = results.filter((w): w is WorktreeListItem => w !== null);

        return { success: true, data: { worktrees } };
      } catch (error) {
        console.error('Failed to list worktrees:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list worktrees'
        };
      }
    }
  );

  /**
   * Clear the staged state for a task
   * This allows the user to re-stage changes if needed
   */
  handleIpc(
    IPC_CHANNELS.TASK_CLEAR_STAGED_STATE,
    async (_, taskId: string): Promise<IPCResult<{ cleared: boolean }>> => {
      try {
        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          return { success: false, error: 'Task not found' };
        }

        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const specDir = path.join(project.path, specsBaseDir, task.specId);
        const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

        // Use EAFP pattern (try/catch) instead of LBYL (existsSync check) to avoid TOCTOU race conditions
        const { promises: fsPromises } = require('fs');
        const isFileNotFound = (err: unknown): boolean =>
          !!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');

        // Read, update, and write the plan file
        let planContent: string;
        try {
          planContent = await fsPromises.readFile(planPath, 'utf-8');
        } catch (readErr) {
          if (isFileNotFound(readErr)) {
            return { success: false, error: 'Implementation plan not found' };
          }
          throw readErr;
        }

        const plan = JSON.parse(planContent);

        // Clear the staged state flags
        delete plan.stagedInMainProject;
        delete plan.stagedAt;
        plan.updated_at = new Date().toISOString();

        await fsPromises.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');

        // Also update worktree plan if it exists
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          const worktreePlanPath = path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
          try {
            const worktreePlanContent = await fsPromises.readFile(worktreePlanPath, 'utf-8');
            const worktreePlan = JSON.parse(worktreePlanContent);
            delete worktreePlan.stagedInMainProject;
            delete worktreePlan.stagedAt;
            worktreePlan.updated_at = new Date().toISOString();
            await fsPromises.writeFile(worktreePlanPath, JSON.stringify(worktreePlan, null, 2), 'utf-8');
          } catch (e) {
            // Non-fatal - worktree plan update is best-effort
            // ENOENT is expected when worktree has no plan file
            if (!isFileNotFound(e)) {
              console.warn('[CLEAR_STAGED_STATE] Failed to update worktree plan:', e);
            }
          }
        }

        // Invalidate tasks cache to force reload
        projectStore.invalidateTasksCache(project.id);

        return { success: true, data: { cleared: true } };
      } catch (error) {
        console.error('Failed to clear staged state:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear staged state'
        };
      }
    }
  );

  /**
   * Create a Pull Request from the worktree branch
   * Pushes the branch to origin and creates a GitHub PR using gh CLI
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_CREATE_PR,
    async (_, taskId: string, options?: WorktreeCreatePROptions): Promise<IPCResult<WorktreeCreatePRResult>> => {
      const isDebugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
      const debug = (...args: unknown[]) => {
        if (isDebugMode) {
          console.warn('[CREATE_PR DEBUG]', ...args);
        }
      };

      try {
        debug('Handler called with taskId:', taskId, 'options:', options);

        const { task, project } = findTaskAndProject(taskId);
        if (!task || !project) {
          debug('Task or project not found');
          return { success: false, error: 'Task not found' };
        }

        debug('Found task:', task.specId, 'project:', project.path);

        const specDir = path.join(project.path, project.autoBuildPath || '.workbench', DATA_DIR_NAMES.tasks, task.specId);

        // Use EAFP pattern - try to read specDir and catch ENOENT
        try {
          statSync(specDir);
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
            debug('Spec directory not found:', specDir);
            return { success: false, error: 'Spec directory not found' };
          }
          throw err; // Re-throw unexpected errors
        }

        // Check worktree exists before creating PR
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (!worktreePath) {
          debug('No worktree found for spec:', task.specId);
          return { success: false, error: 'No worktree found for this task' };
        }
        debug('Worktree path:', worktreePath);

        // Validate options
        if (options?.targetBranch && !GIT_BRANCH_REGEX.test(options.targetBranch)) {
          return { success: false, error: 'Invalid target branch name' };
        }
        if (options?.title) {
          if (options.title.length > MAX_PR_TITLE_LENGTH) {
            return { success: false, error: `PR title exceeds maximum length of ${MAX_PR_TITLE_LENGTH} characters` };
          }
          if (!PRINTABLE_CHARS_REGEX.test(options.title)) {
            return { success: false, error: 'PR title contains invalid characters' };
          }
        }

        // Determine base branch and branch name
        const taskBaseBranch = getTaskBaseBranch(specDir);
        const baseBranch = options?.targetBranch || taskBaseBranch || 'main';
        const branchName = `workbench/${task.specId}`;
        const prTitle = options?.title?.trim() || undefined;

        if (taskBaseBranch) {
          debug('Using stored base branch:', taskBaseBranch);
        }

        debug('Creating PR via TypeScript runner:', { branchName, baseBranch, prTitle });

        // Run the TypeScript PR creator
        const result = await createPR({
          projectDir: project.path,
          worktreePath,
          specId: task.specId,
          specDir,
          taskTitle: task.title,
          taskDescription: task.metadata?.userDescription || task.description,
          branchName,
          baseBranch,
          title: prTitle,
          draft: options?.draft,
        });

        debug('PR creation result:', result);

        if (result.success && result.prUrl && !result.alreadyExists) {
          // Human Review -> PR Created through the state machine (task hooks, renderer), then
          // persisted in both locations even when the machine was in another state
          taskStateManager.handleUiEvent(taskId, { type: 'CREATE_PR' }, task, project);
          taskStateManager.handleUiEvent(taskId, { type: 'PR_CREATED', prUrl: result.prUrl }, task, project);
          await updateTaskStatusAfterPRCreation(
            specDir,
            worktreePath,
            result.prUrl,
            project.autoBuildPath,
            task.specId,
            debug
          );
        } else if (result.alreadyExists) {
          debug('PR already exists, not updating task status');
        }

        if (result.success) {
          return {
            success: true,
            data: {
              success: true,
              prUrl: result.prUrl,
              alreadyExists: result.alreadyExists
            }
          };
        }

        return {
          success: false,
          error: result.error || 'Failed to create PR'
        };
      } catch (error) {
        console.error('[CREATE_PR] Exception in handler:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create PR'
        };
      }
    }
  );

  /**
   * Merge a task's pull request: pull the target branch into the task branch (Claude Code
   * resolves conflicts without losing changes other tasks merged), push it and merge the PR.
   * A merged PR moves the task to Done.
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_MERGE_PR,
    async (_, taskId: string, options?: WorktreeMergePROptions): Promise<IPCResult<WorktreeMergePRResult>> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) return { success: false, error: 'Task not found' };
      const prUrl = task.metadata?.prUrl;
      if (!prUrl) return { success: false, error: 'This task has no pull request' };
      if (task.status === 'in_progress' || task.status === 'ai_review') {
        return { success: false, error: 'Stop the task before merging its pull request' };
      }
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (!worktreePath) return { success: false, error: 'No worktree found for this task' };
      if (options?.targetBranch && !GIT_BRANCH_REGEX.test(options.targetBranch)) {
        return { success: false, error: 'Invalid target branch name' };
      }
      if (mergingPRs.has(taskId)) return { success: false, error: 'This pull request is already being merged' };

      mergingPRs.add(taskId);
      try {
        const result = await mergePR({
          projectDir: project.path,
          worktreePath,
          prUrl,
          targetBranch: options?.targetBranch,
          taskTitle: task.title,
          taskDescription: task.metadata?.userDescription || task.description,
          profileId: project.settings?.claudeProfileId,
          specDir: path.join(project.path, project.autoBuildPath || '.workbench', DATA_DIR_NAMES.tasks, task.specId),
          dataDir: project.autoBuildPath,
          onProgress: (step, params) =>
            safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_MERGE_PR_PROGRESS, taskId, { step, params }),
        });
        if (result.success) await recordPRMerged(task, project, worktreePath);
        return { success: true, data: result };
      } catch (error) {
        console.error('[MERGE_PR] Exception in handler:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to merge the pull request' };
      } finally {
        mergingPRs.delete(taskId);
      }
    }
  );

  /** Read a task's PR state from GitHub and store it in the task metadata */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_PR_STATE,
    async (_, taskId: string): Promise<IPCResult<PullRequestState>> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) return { success: false, error: 'Task not found' };
      const prUrl = task.metadata?.prUrl;
      if (!prUrl) return { success: false, error: 'This task has no pull request' };
      try {
        const { stdout } = await runTool('gh', ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], {
          cwd: project.path,
          encoding: 'utf-8',
          timeout: 30000,
        });
        const state = stdout.trim().toLowerCase();
        if (state !== 'open' && state !== 'merged' && state !== 'closed') {
          return { success: false, error: `Unknown pull request state: ${stdout.trim()}` };
        }
        writeTaskMetadataFields(project, task, findTaskWorktree(project.path, task.specId), { prState: state });
        return { success: true, data: state };
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr;
        return { success: false, error: String(stderr || (error instanceof Error ? error.message : error)).trim() };
      }
    }
  );

  /**
   * Merge a task's branch into its base branch with plain git, in the project itself.
   * Nothing is pushed and no pull request is involved; a merged task moves to Done.
   */
  handleIpc(
    IPC_CHANNELS.TASK_WORKTREE_MERGE_LOCAL,
    async (_, taskId: string): Promise<IPCResult<WorktreeLocalMergeResult>> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) return { success: false, error: 'Task not found' };
      if (task.status === 'in_progress' || task.status === 'ai_review') {
        return { success: false, error: 'Stop the task before merging its branch' };
      }
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (!worktreePath) return { success: false, error: 'No worktree found for this task' };
      const targetBranch = await getEffectiveBaseBranch(project.path, task.specId, project.settings?.mainBranch);
      if (!GIT_BRANCH_REGEX.test(targetBranch)) return { success: false, error: `Invalid base branch name: ${targetBranch}` };
      if (localMerges.has(taskId)) return { success: false, error: "This task's branch is already being merged" };

      localMerges.add(taskId);
      try {
        const result = await localMerge({
          projectDir: project.path,
          worktreePath,
          targetBranch,
          dataDir: project.autoBuildPath,
        });
        if (result.success) await markTaskDone(task, project, worktreePath);
        return { success: true, data: result };
      } catch (error) {
        console.error('[MERGE_LOCAL] Exception in handler:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to merge the task branch' };
      } finally {
        localMerges.delete(taskId);
      }
    }
  );
}

/** Tasks whose pull request is being merged */
const mergingPRs = new Set<string>();

/** Tasks whose branch is being merged locally */
const localMerges = new Set<string>();

/** Set fields of a task's metadata in the main project and its worktree */
function writeTaskMetadataFields(project: Project, task: Task, worktreePath: string | null, fields: Record<string, unknown>): void {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  updateTaskMetadataFields(path.join(project.path, specsBaseDir, task.specId, 'task_metadata.json'), fields);
  if (worktreePath) updateTaskMetadataFields(path.join(worktreePath, specsBaseDir, task.specId, 'task_metadata.json'), fields);
}

/** A merged PR: remember it and move the task to Done */
async function recordPRMerged(task: Task, project: Project, worktreePath: string): Promise<void> {
  writeTaskMetadataFields(project, task, worktreePath, { prState: 'merged' });
  await markTaskDone(task, project, worktreePath);
}

/** Move a merged task to Done (state machine, else the plan files) */
async function markTaskDone(task: Task, project: Project, worktreePath: string): Promise<void> {
  taskStateManager.handleUiEvent(task.id, { type: 'MARK_DONE' }, task, project);
  if (taskStateManager.getCurrentState(task.id) !== 'done') {
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    await persistPlanStatus(path.join(project.path, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), 'done', project.id);
    await persistPlanStatus(path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN), 'done');
    taskHooks.emit('state', { project, task, status: 'done' });
  }
  projectStore.invalidateTasksCache(project.id);
}
