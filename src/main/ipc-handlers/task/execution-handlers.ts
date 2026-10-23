import { handleIpc, onIpc } from '../ipc-registry';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir, resolveMaxParallelTasks } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, TaskReviewOptions, ImageAttachment, Task, Project, TaskLogs, TaskLogPhase, TaskPhaseLog } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { git } from '../../utils/git-exec';
import { AgentManager } from '../../agent';
import { fileWatcher } from '../../file-watcher';
import { findTaskAndProject } from './shared';
import { checkGitStatus } from '../../project-initializer';
import { initializeClaudeProfileManager, type ClaudeProfileManager } from '../../claude-profile-manager';
import { taskStateManager } from '../../task-state-manager';
import {
  getPlanPath,
  persistPlanStatus,
  createPlanIfNotExists,
  hasStartedImplementation,
  resetTaskToInitialState
} from './plan-file-utils';
import { discardTaskWorktree } from '../../utils/worktree-cleanup';
import { taskLogService } from '../../task-log-service';
import { archiveCurrentRun } from '../../task-run-archive';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { findTaskWorktree } from '../../worktree-paths';
import { projectStore } from '../../project-store';
import { detectWorktreeBranch } from '../../utils/git-isolation';
import { cancelFallbackTimer } from '../agent-events-handlers';
import { safeSendToRenderer } from '../utils';
import { readSettingsFile } from '../../settings-utils';
import { getAPIProfileEnv } from '../../services/profile';
import { hasSignedInCodexAccount } from '../../claude-profile/codex-accounts';
import { loadClaudeRunInfo } from '../../claude-code/task-runner';
import { rateLimitResumeScheduler, type HeldTaskRef } from '../../services/rate-limit-resume-scheduler';
import { clearRateLimitHold } from './rate-limit-hold';
import { taskQueue } from '../../services/task-queue';
import { taskQueueOrder } from '../../services/task-queue-order';
import { taskHooks } from '../../task-hooks';
import { XSTATE_ACTIVE_STATES } from '../../../shared/state-machines';


/**
 * Feedback typed in "Request changes" with "Start over" ticked, held until the task that was
 * reset actually starts (it may first wait in the queue for a free slot).
 */
const pendingRestartFeedback = new Map<string, { feedback?: string; feedbackImagePaths?: string[] }>();

const AUTH_REQUIRED_MESSAGE = 'Authentication required. Sign in to a Claude or ChatGPT (Codex) account, or activate an API profile, in Settings > Accounts before starting tasks.';

/** Image types accepted for review feedback (defense in depth - frontend also validates) */
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];

/**
 * Helper function to ensure profile manager is initialized.
 * Returns a discriminated union for type-safe error handling.
 */
async function ensureProfileManagerInitialized(): Promise<
  | { success: true; profileManager: ClaudeProfileManager }
  | { success: false; error: string }
> {
  try {
    const profileManager = await initializeClaudeProfileManager();
    return { success: true, profileManager };
  } catch (error) {
    console.error('[ensureProfileManagerInitialized] Failed to initialize:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to initialize profile manager. Please check file permissions and disk space. (${errorMessage})`
    };
  }
}

/**
 * Claude Code can run a task: a signed-in Claude profile, or an active API profile
 * (Anthropic-compatible endpoint).
 */
async function checkClaudeCodeAuth(): Promise<{ ok: true } | { ok: false; error: string }> {
  const initResult = await ensureProfileManagerInitialized();
  if (!initResult.success) {
    return { ok: false, error: initResult.error };
  }
  if (initResult.profileManager.hasValidAuth()) {
    return { ok: true };
  }
  // Codex runs with a signed-in ChatGPT/OpenAI account
  if (hasSignedInCodexAccount()) {
    return { ok: true };
  }
  try {
    if (Object.keys(await getAPIProfileEnv()).length > 0) {
      return { ok: true };
    }
  } catch {
    // Unreadable API profiles: treat as none
  }
  return { ok: false, error: AUTH_REQUIRED_MESSAGE };
}

/** Main spec directory of a task (run state, logs and the plan file live here) */
function getMainSpecDir(project: Project, task: Task): string {
  return path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
}

/** Whether Claude Code already started implementing this task (claude_run.json) */
function hasImplementationRun(project: Project, task: Task): boolean {
  const info = loadClaudeRunInfo(getMainSpecDir(project, task));
  return !!info?.phases.some((phase) => phase.name === 'implement' || phase.name === 'revise');
}

/** Empty phase logs, sent to the renderer when a retry deletes task_logs.json */
function emptyTaskLogs(specId: string): TaskLogs {
  const now = new Date().toISOString();
  const phase = (name: TaskLogPhase): TaskPhaseLog => ({
    phase: name,
    status: 'pending',
    started_at: null,
    completed_at: null,
    entries: []
  });
  return {
    spec_id: specId,
    created_at: now,
    updated_at: now,
    phases: { planning: phase('planning'), coding: phase('coding'), validation: phase('validation') }
  };
}

/**
 * Save review feedback images into `<specDir>/feedback_images/` and return their absolute paths.
 */
function saveFeedbackImages(specDir: string, images: ImageAttachment[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  const imagesDir = path.join(specDir, 'feedback_images');
  const saved: string[] = [];
  try {
    mkdirSync(imagesDir, { recursive: true });
  } catch (dirError) {
    console.error('[TASK_REVIEW] Failed to create images directory:', dirError);
    return [];
  }
  const resolvedImagesDir = path.resolve(imagesDir);
  for (const image of images) {
    try {
      if (!image.data) {
        console.warn('[TASK_REVIEW] Skipping image with no data:', image.filename);
        continue;
      }
      // Reject missing mimeType to prevent bypass attacks
      if (!image.mimeType || !ALLOWED_IMAGE_MIME_TYPES.includes(image.mimeType)) {
        console.warn('[TASK_REVIEW] Skipping image with missing or disallowed MIME type:', image.mimeType);
        continue;
      }
      // Sanitize filename to prevent path traversal attacks
      const sanitizedFilename = path.basename(image.filename);
      if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
        console.warn('[TASK_REVIEW] Skipping image with invalid filename:', image.filename);
        continue;
      }
      // Remove data URL prefix if present (e.g., "data:image/png;base64,")
      const base64Data = image.data.replace(/^data:image\/[^;]+;base64,/, '');
      const imagePath = path.join(imagesDir, sanitizedFilename);
      const resolvedPath = path.resolve(imagePath);
      if (!resolvedPath.startsWith(resolvedImagesDir + path.sep)) {
        console.warn('[TASK_REVIEW] Skipping image with path outside target directory:', image.filename);
        continue;
      }
      writeFileAtomicSync(imagePath, Buffer.from(base64Data, 'base64'));
      saved.push(resolvedPath);
    } catch (imgError) {
      console.error('[TASK_REVIEW] Failed to save image:', image.filename, imgError);
    }
  }
  return saved;
}

/**
 * Start queued tasks whenever a project has free In Progress slots (see services/task-queue.ts).
 * Passes are requested after every status change, and use the same start flow as TASK_START.
 */
function configureTaskQueue(agentManager: AgentManager, startTask: (taskId: string) => Promise<void>): void {
  taskQueue.configure({
    listProjectIds: () => projectStore.getProjects().map((p) => p.id),
    listTasks: (projectId) => projectStore.getTasks(projectId),
    getMaxParallelTasks: (projectId) => resolveMaxParallelTasks(
      (readSettingsFile() as { maxParallelTasks?: number } | undefined)?.maxParallelTasks,
      projectStore.getProject(projectId)?.settings?.maxParallelTasks
    ),
    getQueueOrder: (projectId) => taskQueueOrder.get(projectId),
    isTaskRunning: (taskId) => agentManager.isRunning(taskId),
    startTask: async (taskId) => {
      await startTask(taskId);
      // startTask reports problems (git, auth) to the renderer; it started when the machine is active
      return XSTATE_ACTIVE_STATES.has(taskStateManager.getCurrentState(taskId) ?? '');
    },
  });
  // Any status change may free a slot (a task leaving In Progress) or queue a task
  taskStateManager.setStatusChangeListener((_taskId, _status, projectId) => taskQueue.request(projectId));
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  /** Send a task error to the windows; `projectId` keeps it out of other projects' windows */
  const sendTaskError = (taskId: string, error: string, projectId?: string): void => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, projectId);
  };

  /** Hand a task to Claude Code and watch its plan file (subtasks, status) */
  const launchRun = (
    taskId: string,
    task: Task,
    project: Project,
    mode: 'start' | 'revise',
    feedback?: string,
    feedbackImagePaths?: string[]
  ): void => {
    // Cancel any pending fallback timer from a previous run's exit, so it can't
    // stop the new run
    cancelFallbackTimer(taskId);

    fileWatcher.watch(taskId, getMainSpecDir(project, task)).catch((err) => {
      console.error(`[TASK_START] Failed to watch spec dir for ${taskId}:`, err);
    });

    agentManager.startTask(taskId, { project, task, mode, feedback, feedbackImagePaths }).catch((err) => {
      console.error(`[TASK_START] Failed to start ${taskId}:`, err);
      sendTaskError(taskId, err instanceof Error ? err.message : String(err), project.id);
    });
  };

  /**
   * Start (or continue) a task. Shared by the TASK_START IPC handler and the
   * rate-limit resume scheduler. The Claude Code run continues from its saved
   * state (claude_run.json), so a resumed task doesn't triage or plan again.
   */
  const startTask = async (taskId: string): Promise<void> => {
    console.warn('[TASK_START] Received request for taskId:', taskId);

    // First search all projects to find the task, then verify the project matches
    // task.projectId to prevent cross-project contamination
    const { task, project: foundProject } = findTaskAndProject(taskId);
    if (!task || !foundProject) {
      console.warn('[TASK_START] Task or project not found for taskId:', taskId);
      sendTaskError(taskId, 'Task or project not found');
      return;
    }
    const project = (task.projectId && task.projectId !== foundProject.id)
      ? (projectStore.getProject(task.projectId) ?? foundProject)
      : foundProject;

    // Git is required for worktree-based runs
    const gitStatus = await checkGitStatus(project.path);
    if (!gitStatus.isGitRepo) {
      sendTaskError(
        taskId,
        'Git repository required. Please run "git init" in your project directory. Workbench uses git worktrees for isolated builds.',
        project.id
      );
      return;
    }
    if (!gitStatus.hasCommits) {
      sendTaskError(
        taskId,
        'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").',
        project.id
      );
      return;
    }

    const auth = await checkClaudeCodeAuth();
    if (!auth.ok) {
      console.warn('[TASK_START] No usable Claude Code authentication');
      sendTaskError(taskId, auth.error, project.id);
      return;
    }

    // Starting (manually or via the resume scheduler) releases any rate-limit hold
    clearRateLimitHold(project, task, getMainWindow);

    // Clear stale tracking state from any previous run so that:
    // - terminalEventSeen doesn't suppress future PROCESS_EXITED events
    // - lastSequenceByTask doesn't drop events from the new run
    taskStateManager.prepareForRestart(taskId);

    // Move the card to In Progress right away. XState is the source of truth (task data
    // is the fallback after an app restart):
    // - queued (rate-limit hold released) / fresh start: PLANNING_STARTED
    // - human_review / error: USER_RESUMED (coding) when implementation already started,
    //   otherwise PLANNING_STARTED (the run triages/plans first)
    const currentXState = taskStateManager.getCurrentState(taskId);
    const resumable = currentXState
      ? currentXState === 'human_review' || currentXState === 'error'
      : task.status === 'human_review' || task.status === 'error';
    const event = resumable && hasImplementationRun(project, task) ? 'USER_RESUMED' : 'PLANNING_STARTED';
    console.warn('[TASK_START] XState:', currentXState, '| task status:', task.status, '->', event);
    taskStateManager.handleUiEvent(taskId, { type: event }, task, project);

    // A task reset by "Start over" carries the reviewer's feedback into its fresh run
    const restart = pendingRestartFeedback.get(taskId);
    pendingRestartFeedback.delete(taskId);
    launchRun(taskId, task, project, 'start', restart?.feedback, restart?.feedbackImagePaths);
  };

  /**
   * Start a task
   */
  onIpc(
    IPC_CHANNELS.TASK_START,
    async (_, taskId: string, _options?: TaskStartOptions) => {
      if (!getMainWindow()) {
        console.warn('[TASK_START] No main window found');
        return;
      }
      await startTask(taskId);
    }
  );

  /** Whether the project already runs as many tasks as it may in parallel (not counting `taskId`) */
  const isAtParallelLimit = (project: Project, taskId: string): boolean => {
    const appMaxParallel = (readSettingsFile() as { maxParallelTasks?: number } | undefined)?.maxParallelTasks;
    const maxParallel = resolveMaxParallelTasks(appMaxParallel, project.settings?.maxParallelTasks);
    const inProgressCount = projectStore.getTasks(project.id).filter(
      (t) => t.id !== taskId && t.status === 'in_progress' && !t.metadata?.archivedAt
    ).length;
    return inProgressCount >= maxParallel;
  };

  /**
   * Start a task over from a clean slate: discard its worktree and branch (all commits and
   * uncommitted changes), reset its spec dir to what TASK_CREATE wrote (task_metadata.json,
   * attachments/, a fresh implementation_plan.json), forget its state machine, then start
   * it like TASK_START does, or queue it when the parallel task limit is reached.
   *
   * Used by Retry and by "Request changes" with "Start over" ticked; in the latter case the
   * reviewer's feedback and images are kept for the fresh run.
   */
  const restartTaskFromScratch = async (
    taskId: string,
    options?: { feedback?: string; images?: ImageAttachment[] }
  ): Promise<IPCResult<{ action: 'started' | 'queued' }>> => {
    pendingRestartFeedback.delete(taskId);
    const { task, project: foundProject } = findTaskAndProject(taskId);
    if (!task || !foundProject) {
      return { success: false, error: 'Task not found' };
    }
    const project = (task.projectId && task.projectId !== foundProject.id)
      ? (projectStore.getProject(task.projectId) ?? foundProject)
      : foundProject;

    if (agentManager.isRunning(taskId)) {
      return { success: false, error: 'The task is still running. Stop it before retrying.' };
    }

    // Check that the task can start before throwing its work away
    const gitStatus = await checkGitStatus(project.path);
    if (!gitStatus.isGitRepo || !gitStatus.hasCommits) {
      return { success: false, error: gitStatus.error || 'Git repository with commits required to run tasks.' };
    }
    const auth = await checkClaudeCodeAuth();
    if (!auth.ok) {
      return { success: false, error: auth.error };
    }

    try {
      cancelFallbackTimer(taskId);
      await fileWatcher.unwatch(taskId).catch(() => undefined);
      clearRateLimitHold(project, task, getMainWindow);

      // 1. Revert the code: remove the worktree and its branch. Tasks that run in the
      //    project folder itself (useWorktree: false) keep their changes there.
      if (task.metadata?.useWorktree !== false) {
        const removed = await discardTaskWorktree(project.path, task.specId, '[TASK_RESTART]');
        if (!removed.success) {
          return { success: false, error: `Failed to remove the task's worktree: ${removed.warnings.join('; ')}` };
        }
      }

      // 2. Keep the run that is being thrown away, so the task dialog can still show what
      //    happened in it, then forget it: the state machine is rebuilt from the reset plan file
      const specDir = getMainSpecDir(project, task);
      archiveCurrentRun(specDir);
      taskStateManager.clearTask(taskId);
      const queue = isAtParallelLimit(project, taskId);
      await resetTaskToInitialState(project, task, { status: queue ? 'queue' : 'backlog' });

      taskLogService.clearCache(specDir);
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOGS_CHANGED, task.specId, emptyTaskLogs(task.specId), project.id);

      // 3. Tell the fresh run what the discarded attempt got wrong. Images are saved after
      //    the reset, which empties the spec dir of everything a run produced
      const feedback = options?.feedback?.trim();
      if (feedback || options?.images?.length) {
        pendingRestartFeedback.set(taskId, {
          feedback,
          feedbackImagePaths: saveFeedbackImages(specDir, options?.images)
        });
      }

      // 4. Start over (or wait in the queue for a free slot)
      if (queue) {
        console.warn(`[TASK_RESTART] Parallel task limit reached; ${taskId} reset and queued`);
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, 'queue', project.id);
        taskHooks.emit('state', { project, task, status: 'queue' });
        return { success: true, data: { action: 'queued' } };
      }
      console.warn(`[TASK_RESTART] ${taskId} reset; starting it again`);
      await startTask(taskId);
      return { success: true, data: { action: 'started' } };
    } catch (error) {
      console.error('[TASK_RESTART] Failed to retry task:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to retry task' };
    }
  };

  handleIpc(
    IPC_CHANNELS.TASK_RETRY,
    (_, taskId: string): Promise<IPCResult<{ action: 'started' | 'queued' }>> => restartTaskFromScratch(taskId)
  );

  /**
   * Resume a task whose rate-limit hold expired (called by the main-process scheduler).
   * Respects the project's parallel task limit: when full, the hold is cleared and
   * the task stays queued so normal queue promotion starts it when a slot frees up.
   */
  const resumeHeldTask = async (taskId: string, projectId: string): Promise<void> => {
    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return;
    if (!task.rateLimitHold || task.status !== 'queue') {
      // Hold already released (user started/moved the task)
      return;
    }
    if (agentManager.isRunning(taskId)) {
      clearRateLimitHold(project, task, getMainWindow);
      return;
    }

    if (isAtParallelLimit(project, taskId)) {
      console.warn(`[RateLimitResume] Hold expired for ${taskId} but the parallel task limit is reached; leaving it queued`);
      clearRateLimitHold(project, task, getMainWindow);
      return;
    }

    console.warn(`[RateLimitResume] Hold expired for ${taskId}, resuming`);
    await startTask(taskId);
  };

  rateLimitResumeScheduler.configure({
    listHeldTasks: () => {
      const refs: HeldTaskRef[] = [];
      for (const project of projectStore.getProjects()) {
        for (const task of projectStore.getTasks(project.id)) {
          if (task.status === 'queue' && task.rateLimitHold) {
            refs.push({ taskId: task.id, projectId: project.id, resetAt: task.rateLimitHold.resetAt });
          }
        }
      }
      return refs;
    },
    // Serialized with queue promotion so both can't fill the same free slot
    resumeTask: (taskId, projectId) => taskQueue.runExclusive(projectId, () => resumeHeldTask(taskId, projectId)),
  });

  configureTaskQueue(agentManager, startTask);

  // The board's Queue column order (top first): the queue starts the top task first
  onIpc(IPC_CHANNELS.TASK_QUEUE_ORDER_SET, (_, projectId: string, order: string[]) => {
    if (typeof projectId !== 'string' || !Array.isArray(order)) return;
    taskQueueOrder.set(projectId, order);
  });

  /**
   * Stop a task
   */
  onIpc(IPC_CHANNELS.TASK_STOP, (_, taskId: string) => {
    agentManager.killTask(taskId);
    fileWatcher.unwatch(taskId).catch((err) => {
      console.error('[TASK_STOP] Failed to unwatch:', err);
    });

    const { task, project } = findTaskAndProject(taskId);
    if (!task || !project) return;

    // Stopped before implementation started: back to backlog; otherwise to review
    const hasPlan = hasStartedImplementation(project, task);
    taskStateManager.handleUiEvent(taskId, { type: 'USER_STOPPED', hasPlan }, task, project);

    // Clear stale tracking state so a subsequent restart works correctly
    taskStateManager.prepareForRestart(taskId);
  });

  /**
   * Review a task: approve (done) or request changes, which Claude Code applies in the
   * task's session before validating again. With `startOver` the worktree is discarded
   * instead and the task is redone from scratch, told what the attempt got wrong.
   */
  handleIpc(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string,
      images?: ImageAttachment[],
      options?: TaskReviewOptions
    ): Promise<IPCResult> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      if (approved) {
        taskStateManager.handleUiEvent(taskId, { type: 'MARK_DONE' }, task, project);
        return { success: true };
      }

      if (agentManager.isRunning(taskId)) {
        return { success: false, error: 'The task is still running. Stop it before requesting changes.' };
      }

      const auth = await checkClaudeCodeAuth();
      if (!auth.ok) {
        return { success: false, error: auth.error };
      }

      // Changes staged in the main project (stage-only merge) are discarded: the work
      // continues in the task's worktree (a fresh one with "Start over")
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath && task.stagedInMainProject) {
        const gitOptions = { cwd: project.path, isolated: true };
        try {
          await git(['reset', 'HEAD'], gitOptions);
          await git(['checkout', '--', '.'], gitOptions);
          // Exclude .workbench to preserve specs and worktree data
          await git(['clean', '-fd', '-e', '.workbench'], gitOptions);
          console.warn('[TASK_REVIEW] Main project restored to pre-merge state');
        } catch (error) {
          console.warn('[TASK_REVIEW] Could not discard staged changes in the main project:', error);
        }
      }

      // "Start over": throw the attempt away (worktree, branch and run history) and redo the
      // task from scratch, with the feedback as the reviewer's notes on the discarded attempt
      if (options?.startOver) {
        const restarted = await restartTaskFromScratch(taskId, { feedback, images });
        return restarted.success ? { success: true } : { success: false, error: restarted.error };
      }

      const feedbackImagePaths = saveFeedbackImages(getMainSpecDir(project, task), images);

      // Clear stale tracking state before starting the revision
      taskStateManager.prepareForRestart(taskId);
      taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);

      launchRun(taskId, task, project, 'revise', feedback?.trim() || 'No feedback provided', feedbackImagePaths);
      return { success: true };
    }
  );

  /**
   * Update task status manually
   * Options:
   * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
   */
  handleIpc(
    IPC_CHANNELS.TASK_UPDATE_STATUS,
    async (
      _,
      taskId: string,
      status: TaskStatus,
      options?: { forceCleanup?: boolean; keepWorktree?: boolean }
    ): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }> => {
      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // 'done' can only be set through the merge handler UNLESS there's no worktree
      // (already merged/discarded or failed), forceCleanup is requested (user confirmed
      // deleting the worktree) or keepWorktree is requested
      if (status === 'done') {
        const worktreePath = findTaskWorktree(project.path, task.specId);
        if (worktreePath) {
          if (options?.keepWorktree) {
            console.warn(`[TASK_UPDATE_STATUS] Marking task ${taskId} as done while keeping worktree at ${worktreePath}`);
          } else if (options?.forceCleanup) {
            console.warn(`[TASK_UPDATE_STATUS] Cleaning up worktree for task ${taskId} (user confirmed)`);
            try {
              // Validate the detected branch matches the expected pattern, so a corrupted
              // or orphaned worktree can't make us delete the wrong branch
              const { branch, usingFallback: usingFallbackBranch } = await detectWorktreeBranch(
                worktreePath,
                task.specId,
                { timeout: 30000, logPrefix: '[TASK_UPDATE_STATUS]' }
              );
              await git(['worktree', 'remove', '--force', worktreePath], {
                cwd: project.path,
                timeout: 30000,
                isolated: true
              });
              console.warn(`[TASK_UPDATE_STATUS] Worktree removed: ${worktreePath}`);
              try {
                await git(['branch', '-D', branch], {
                  cwd: project.path,
                  timeout: 30000,
                  isolated: true
                });
                console.warn(`[TASK_UPDATE_STATUS] Branch deleted: ${branch}`);
              } catch (branchDeleteError) {
                console.warn(
                  usingFallbackBranch
                    ? `[TASK_UPDATE_STATUS] Could not delete branch ${branch} using fallback pattern. Actual branch may still exist and need manual cleanup.`
                    : `[TASK_UPDATE_STATUS] Could not delete branch ${branch} (may not exist or be checked out elsewhere)`,
                  branchDeleteError
                );
              }
            } catch (cleanupError) {
              console.error(`[TASK_UPDATE_STATUS] Failed to cleanup worktree:`, cleanupError);
              return {
                success: false,
                error: `Failed to cleanup worktree: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
              };
            }
          } else {
            // Worktree exists but no forceCleanup - ask the user to confirm
            return {
              success: false,
              worktreeExists: true,
              worktreePath: worktreePath,
              error: "A worktree still exists for this task. Would you like to delete it and mark the task as complete?"
            };
          }
        }
      }

      const planPath = getPlanPath(project, task);

      try {
        // Manually moving a held task out of the queue releases its rate-limit hold
        if (status !== 'queue') {
          clearRateLimitHold(project, task, getMainWindow);
        }

        // Stop the run when the task is moved away from In Progress (e.g., back to backlog)
        // BEFORE the machine transition, so the run's late events can't move it back
        if (status !== 'in_progress' && agentManager.isRunning(taskId, project.id)) {
          console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
          agentManager.killTask(taskId, project.id);
          fileWatcher.unwatch(taskId).catch(() => undefined);
        }

        if (status === 'in_progress' && !agentManager.isRunning(taskId, project.id)) {
          // Check git status and auth before the card moves
          const gitStatusCheck = await checkGitStatus(project.path);
          if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
            const error = gitStatusCheck.error || 'Git repository with commits required to run tasks.';
            sendTaskError(taskId, error, project.id);
            return { success: false, error };
          }
          const auth = await checkClaudeCodeAuth();
          if (!auth.ok) {
            sendTaskError(taskId, auth.error, project.id);
            return { success: false, error: auth.error };
          }
          taskStateManager.prepareForRestart(taskId);
        }

        const handledByMachine = taskStateManager.handleManualStatusChange(taskId, status, task, project);
        if (!handledByMachine) {
          // Thread-safe plan file update (legacy/manual override)
          const persisted = await persistPlanStatus(planPath, status, project.id);
          if (!persisted) {
            await createPlanIfNotExists(planPath, task, status);
            projectStore.invalidateTasksCache(project.id);
          }
          taskHooks.emit('state', { project, task, status });
        }

        // Auto-start the task when it is moved to In Progress and isn't running
        if (status === 'in_progress' && !agentManager.isRunning(taskId, project.id)) {
          console.warn('[TASK_UPDATE_STATUS] Auto-starting task:', taskId);
          launchRun(taskId, task, project, 'start');
          safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, 'in_progress', project.id);
        }

        // A task moved to the queue (or out of In Progress) may be startable right away
        taskQueue.request(project.id);

        return { success: true };
      } catch (error) {
        console.error('Failed to update task status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update task status'
        };
      }
    }
  );

  /**
   * Check if a task is actually running (has an active run)
   */
  handleIpc(
    IPC_CHANNELS.TASK_CHECK_RUNNING,
    async (_, taskId: string): Promise<IPCResult<boolean>> => {
      return { success: true, data: agentManager.isRunning(taskId) };
    }
  );

  /**
   * Recover a stuck task (status says in_progress but nothing is running).
   * Moves it to review when Claude Code finished implementing, otherwise back to the
   * backlog (or the requested status), and optionally restarts it.
   */
  handleIpc(
    IPC_CHANNELS.TASK_RECOVER_STUCK,
    async (
      _,
      taskId: string,
      options?: { targetStatus?: TaskStatus; autoRestart?: boolean }
    ): Promise<IPCResult<{ taskId: string; recovered: boolean; newStatus: TaskStatus; message: string; autoRestarted?: boolean }>> => {
      const autoRestart = options?.autoRestart ?? false;

      if (agentManager.isRunning(taskId)) {
        return {
          success: false,
          error: 'Task is still running. Stop it first before recovering.',
          data: { taskId, recovered: false, newStatus: 'in_progress', message: 'Task is still running' }
        };
      }

      const { task, project } = findTaskAndProject(taskId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // Where the run got to decides the recovery status
      const runInfo = loadClaudeRunInfo(getMainSpecDir(project, task));
      const implemented = !!runInfo?.phases.some(
        (p) => (p.name === 'implement' || p.name === 'revise') && p.endedAt && !p.isError
      );
      let newStatus: TaskStatus = options?.targetStatus ?? (implemented ? 'human_review' : 'backlog');

      // Plan files to update: main spec dir and the worktree copy
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const planPaths = [getPlanPath(project, task)];
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        const worktreePlanPath = path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
        if (existsSync(worktreePlanPath)) planPaths.push(worktreePlanPath);
      }

      const writeRecoveredStatus = (status: TaskStatus): boolean => {
        let wrote = false;
        for (const planPath of planPaths) {
          try {
            let plan: Record<string, unknown> = {};
            try {
              plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
            } catch (readError) {
              if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
            }
            plan.status = status;
            plan.planStatus = status === 'done' ? 'completed'
              : status === 'in_progress' ? 'in_progress'
              : status === 'ai_review' || status === 'human_review' ? 'review'
              : 'pending';
            // Keep executionPhase/xstateState in sync: project-store restores from them
            plan.xstateState = status === 'in_progress' ? 'coding' : status;
            plan.executionPhase = status === 'human_review' || status === 'done' ? 'complete'
              : status === 'in_progress' ? 'coding'
              : 'idle';
            if (status === 'human_review') plan.reviewReason = implemented ? 'completed' : 'stopped';
            plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;
            plan.updated_at = new Date().toISOString();
            writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
            wrote = true;
          } catch (writeError) {
            console.error(`[Recovery] Failed to write plan file at ${planPath}:`, writeError);
          }
        }
        projectStore.invalidateTasksCache(project.id);
        return wrote;
      };

      try {
        if (!writeRecoveredStatus(newStatus)) {
          return { success: false, error: 'Failed to write plan file during recovery' };
        }
        // The XState actor still thinks the task is active: rebuild it from the files
        taskStateManager.clearTask(taskId);

        fileWatcher.unwatch(taskId).catch((err) => {
          console.error('[TASK_RECOVER_STUCK] Failed to unwatch:', err);
        });

        let autoRestarted = false;
        let restartProblem: string | undefined;
        if (autoRestart) {
          const gitStatusForRestart = await checkGitStatus(project.path);
          const auth = gitStatusForRestart.isGitRepo && gitStatusForRestart.hasCommits
            ? await checkClaudeCodeAuth()
            : { ok: false as const, error: gitStatusForRestart.error || 'Git repository with commits required.' };
          if (!auth.ok) {
            restartProblem = auth.error;
          } else {
            const { task: freshTask } = findTaskAndProject(taskId, project.id);
            const restartTask = freshTask ?? task;
            taskStateManager.handleUiEvent(
              taskId,
              { type: implemented ? 'USER_RESUMED' : 'PLANNING_STARTED' },
              restartTask,
              project
            );
            launchRun(taskId, restartTask, project, 'start');
            newStatus = 'in_progress';
            autoRestarted = true;
          }
        }

        safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, newStatus, project.id);

        return {
          success: true,
          data: {
            taskId,
            recovered: true,
            newStatus,
            message: autoRestarted
              ? 'Task recovered and restarted successfully'
              : restartProblem
                ? `Task recovered but cannot restart: ${restartProblem}`
                : `Task recovered successfully and moved to ${newStatus}`,
            autoRestarted
          }
        };
      } catch (error) {
        console.error('Failed to recover stuck task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recover task'
        };
      }
    }
  );
}

// Re-exported for callers that reset a task's run (e.g. discarding its worktree)
;
