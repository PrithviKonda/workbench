import { EventEmitter } from 'events';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentState } from './agent-state';
import type { ExecutionProgressData, StartTaskOptions } from './types';
import type { TaskEventPayload } from './task-event-schema';
import {
  ClaudeTaskRun,
  type TaskAttachment,
  type TaskRunConfig,
  type TaskRunOutcome,
} from '../claude-code/task-runner';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import { isClaudeRunFinished, loadClaudeRunInfo, resetClaudeRunInfo } from '../claude-code/task-runner';
import { detectClaudeLimitMessage } from '../claude-code/limit';
import { createOrGetWorktree } from '../worktree';
import { addToWorktree } from '../live-agent/project-setup';
import { readSettingsFile } from '../settings-utils';
import { getGraphifyPromptContext, isGraphifyEnabled } from '../graphify';
import { isSelfImproveEnabled, SELF_IMPROVE_NUDGE } from '../self-improve';
import { getAugmentedEnvAsync } from '../env-utils';
import { isWslRuntime } from '../platform/shell-runtime';
import { git } from '../utils/git-exec';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { isCodexAccountId, recordCodexRateLimit } from '../claude-profile/codex-accounts';
import { pickEngine } from '../claude-code/env';
import { getOperationRegistry } from '../claude-profile/operation-registry';
import { getAPIProfileEnv } from '../services/profile';
import { getSpecsDir } from '../../shared/constants';
import type { AppSettings } from '../../shared/types/settings';
import { appLog } from '../app-logger';
import { resolveBaseBranch } from '../utils/base-branch';
import { taskHooks } from '../task-hooks';
import { getTaskChangelogPath } from '../task-changelog';


/** Restarts after a rate limit or auth problem before giving up (prevents swap loops) */
const MAX_SWAPS_PER_TASK = 2;
/** How long killAll waits for runs to wind down */
const KILL_ALL_TIMEOUT_MS = 10_000;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

interface RunEntry {
  options: StartTaskOptions;
  projectId: string;
  taskId: string;
  /** Set once setup finished and the run was created */
  run?: ClaudeTaskRun;
  /** Claude profile the run was started on (undefined: best available at start) */
  profileId?: string;
  /** An API profile (Anthropic-compatible endpoint) is active: Claude profiles are not used */
  apiProfileActive: boolean;
  /** Stopped by killTask/restartTask: its outcome is not reported */
  killed: boolean;
  /** Settles when the run (and its state flush) finished */
  done: Promise<void>;
}

/**
 * AgentManager: runs tasks through the Claude Code CLI (ClaudeTaskRun) and turns the run's
 * callbacks into events for the IPC layer:
 *
 *   log, error, execution-progress, task-event (XState TaskEventPayload), run-info
 *   (claude_run.json), subtasks (Claude Code's task list), auth-failure, run-finished, exit
 */
/**
 * Runs are held per project and task: a task id is its spec id (`001-<slug>`), which each
 * project numbers from its own start, so two projects can hold the same one. Keying by the
 * task alone would let starting a task in one project stop a same-named run in another.
 */
const runKey = (projectId: string, taskId: string): string => `${projectId}\u0000${taskId}`;

export class AgentManager extends EventEmitter {
  private state = new AgentState();
  private runs = new Map<string, RunEntry>();
  /** Options of the latest run per project and task, for restarts after it ended */
  private lastOptions = new Map<string, StartTaskOptions>();
  /** Automatic restarts (profile swaps) per project and task since the user last started it */
  private swapCounts = new Map<string, number>();
  /** Last task event sequence per project and task (monotonic across runs and app restarts) */
  private sequences = new Map<string, number>();

  /**
   * The key a task's run is held under. Callers that know the project get exactly it;
   * the rest take the one run with that task id (projects rarely share one).
   */
  private keyOf(taskId: string, projectId?: string): string | undefined {
    if (projectId) {
      const key = runKey(projectId, taskId);
      return this.runs.has(key) || this.lastOptions.has(key) ? key : undefined;
    }
    for (const [key, entry] of this.runs) {
      if (entry.taskId === taskId) return key;
    }
    return undefined;
  }

  // ============================================
  // Task lifecycle
  // ============================================

  /**
   * Start (or continue) a task, or apply reviewer feedback (`mode: 'revise'`).
   * Run state lives in `<specDir>/claude_run.json`, so a started task continues where it
   * stopped (triage, plan and implementation aren't repeated once completed).
   */
  async startTask(taskId: string, options: StartTaskOptions): Promise<void> {
    return this.launch(taskId, options, false);
  }

  private async launch(taskId: string, startOptions: StartTaskOptions, isRestart: boolean): Promise<void> {
    // The project's Claude account (Settings > Project) unless the run is pinned to another one
    // (e.g. a restart after an account swap); none: the account in use
    const options: StartTaskOptions = {
      ...startOptions,
      profileId: startOptions.profileId ?? startOptions.project.settings?.claudeProfileId,
    };
    const { project } = options;
    const projectId = project.id;
    const key = runKey(projectId, taskId);

    // Only one run per task, in this project: a task of the same name in another project
    // keeps its own run
    const previous = this.runs.get(key);
    if (previous) {
      this.killTask(taskId, projectId);
      await previous.done;
    }
    if (!isRestart) this.swapCounts.delete(key);
    this.lastOptions.set(key, options);

    let resolveDone!: () => void;
    const entry: RunEntry = {
      options,
      projectId,
      taskId,
      profileId: options.profileId,
      apiProfileActive: false,
      killed: false,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
    };
    this.runs.set(key, entry);
    this.state.addRunning(taskId, projectId);

    let config: TaskRunConfig;
    try {
      config = await this.buildRunConfig(taskId, options);
      entry.apiProfileActive = await this.isApiProfileActive();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLog.error(`[AgentManager] Could not start task ${taskId}:`, message);
      if (this.runs.get(key) === entry) {
        this.runs.delete(key);
        this.state.removeRunning(taskId);
      }
      resolveDone();
      if (entry.killed) return;
      this.emit('log', taskId, `Could not start the task: ${message}\n`, projectId);
      this.emitTaskEvent(taskId, options, 'PLANNING_FAILED', { error: message, recoverable: true });
      this.emitError(taskId, message, projectId);
      this.emit('exit', taskId, 1, 'task-execution', projectId);
      return;
    }

    // Stopped while the worktree was being prepared
    if (entry.killed) {
      resolveDone();
      return;
    }

    const run = new ClaudeTaskRun(config, {
      onLog: (line) => {
        if (!entry.killed) this.emit('log', taskId, line.endsWith('\n') ? line : `${line}\n`, projectId);
      },
      onProgress: (progress) => {
        if (entry.killed) return;
        const data: ExecutionProgressData = {
          phase: progress.phase,
          phaseProgress: progress.phaseProgress,
          overallProgress: progress.overallProgress,
          message: progress.message,
          ...(progress.currentSubtask ? { currentSubtask: progress.currentSubtask } : {}),
        };
        this.emit('execution-progress', taskId, data, projectId);
      },
      onTaskEvent: (type, payload) => {
        if (entry.killed) return;
        const extra: Record<string, unknown> = { ...payload };
        if (type === 'RATE_LIMIT_HOLD') {
          const profileId = this.recordRateLimit(entry, payload);
          if (profileId) extra.profileId = profileId;
        }
        this.emitTaskEvent(taskId, options, type, extra);
      },
      onRunInfo: (info) => {
        if (entry.killed) return;
        if (info.sessionId) this.state.updateTaskSession(taskId, info.sessionId);
        this.emit('run-info', taskId, info, projectId);
      },
      onSubtasks: (subtasks) => {
        if (!entry.killed) this.emit('subtasks', taskId, subtasks, projectId);
      },
      onFilesEdited: (files) => {
        if (!entry.killed) taskHooks.emit('files-edited', { project: options.project, task: options.task, files });
      },
    });
    entry.run = run;

    this.registerWithOperationRegistry(taskId, entry);

    run.run()
      .then((outcome) => this.handleRunFinished(taskId, entry, outcome))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.handleRunFinished(taskId, entry, { status: 'failed', error: message });
      })
      .finally(resolveDone);
  }

  /**
   * Stop a task's run. Its outcome is not reported (callers send USER_STOPPED themselves).
   */
  killTask(taskId: string, projectId?: string): boolean {
    const key = this.keyOf(taskId, projectId);
    const entry = key ? this.runs.get(key) : undefined;
    if (!key || !entry) return false;
    entry.killed = true;
    entry.run?.stop();
    this.runs.delete(key);
    this.state.removeRunning(taskId);
    getOperationRegistry().unregisterOperation(taskId);
    return true;
  }

  /** Stop all runs and wait (bounded) for them to wind down */
  async killAll(): Promise<void> {
    const pending = Array.from(this.runs.values()).map((entry) => {
      this.killTask(entry.taskId, entry.projectId);
      return entry.done;
    });
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => setTimeout(resolve, KILL_ALL_TIMEOUT_MS)),
    ]);
  }

  /** Check if a task is running */
  isRunning(taskId: string, projectId?: string): boolean {
    const key = this.keyOf(taskId, projectId);
    return key !== undefined && this.runs.has(key);
  }

  /** Session of a running task's Claude Code run (undefined until the run started) */
  getRunSession(taskId: string, projectId?: string): { sessionId?: string; profileId?: string; configDir?: string } | undefined {
    const key = this.keyOf(taskId, projectId);
    return key ? this.runs.get(key)?.run?.session : undefined;
  }

  /** All running task IDs */
  getRunningTasks(): string[] {
    return Array.from(this.runs.values()).map((entry) => entry.taskId);
  }

  /**
   * Restart a task's run on another Claude profile (rate limit or proactive swap). The run
   * continues from its saved state. Returns false when the task can't be restarted.
   */
  restartTask(taskId: string, newProfileId?: string, projectId?: string): boolean {
    const key = this.keyOf(taskId, projectId);
    const options = (key ? this.runs.get(key)?.options ?? this.lastOptions.get(key) : undefined);
    if (!key || !options) {
      appLog.warn(`[AgentManager] restartTask: no run options for ${taskId}`);
      return false;
    }
    const swaps = this.swapCounts.get(key) ?? 0;
    if (swaps >= MAX_SWAPS_PER_TASK) {
      appLog.warn(`[AgentManager] restartTask: ${taskId} already restarted ${swaps} times, not restarting again`);
      return false;
    }
    this.swapCounts.set(key, swaps + 1);

    if (newProfileId) {
      const profileManager = getClaudeProfileManager();
      if (profileManager.getActiveProfile()?.id !== newProfileId) {
        profileManager.setActiveProfile(newProfileId);
      }
    }

    const previous = this.runs.get(key);
    this.killTask(taskId, options.project.id);
    const restartOptions: StartTaskOptions = { ...options, profileId: newProfileId ?? options.profileId };
    void (previous?.done ?? Promise.resolve()).then(() =>
      this.launch(taskId, restartOptions, true).catch((error) =>
        appLog.error(`[AgentManager] Restarting ${taskId} failed:`, error)
      )
    );
    return true;
  }

  // ============================================
  // Queue Routing Methods (Rate Limit Recovery)
  // ============================================

  /** Running tasks grouped by profile (queue routing) */
  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    return this.state.getRunningTasksByProfile();
  }

  /** Record which profile a task uses */
  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: 'proactive' | 'reactive' | 'manual'
  ): void {
    this.state.assignProfileToTask(taskId, profileId, profileName, reason);
  }

  /** Profile assignment of a task */
  getTaskProfileAssignment(taskId: string): { profileId: string; profileName: string; reason: string } | undefined {
    return this.state.getTaskProfileAssignment(taskId);
  }

  /** Update the Claude Code session ID of a task */
  updateTaskSession(taskId: string, sessionId: string): void {
    this.state.updateTaskSession(taskId, sessionId);
  }

  /** Claude Code session ID of a task */
  getTaskSessionId(taskId: string): string | undefined {
    return this.state.getTaskSessionId(taskId);
  }

  // ============================================
  // Internals
  // ============================================

  private async buildRunConfig(taskId: string, options: StartTaskOptions): Promise<TaskRunConfig> {
    const { project, task, mode } = options;
    const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);

    // The base branch a task was created with may have been deleted or renamed since; stand in
    // for it with a branch that still exists, so the task can still be started
    const wantedBaseBranch = task.metadata?.baseBranch || project.settings?.mainBranch || 'main';
    const { branch: baseBranch, missing } = await resolveBaseBranch(project.path, wantedBaseBranch, [
      project.settings?.mainBranch,
      'main',
      await this.getCurrentBranch(project.path),
    ]);
    if (missing) {
      const message = `Base branch "${missing}" no longer exists; starting from "${baseBranch}" instead.`;
      appLog.warn(`[AgentManager] ${message}`);
      this.emit('log', taskId, `${message}\n`, project.id);
    }

    let worktreePath: string;
    let branch: string;
    if (task.metadata?.useWorktree === false) {
      worktreePath = project.path;
      branch = await this.getCurrentBranch(project.path) ?? baseBranch;
    } else {
      const worktree = await createOrGetWorktree(
        project.path,
        task.specId,
        baseBranch,
        task.metadata?.useLocalBranch ?? false,
        task.metadata?.pushNewBranches ?? project.settings?.pushNewBranches !== false,
        project.autoBuildPath,
      );
      worktreePath = worktree.worktreePath;
      branch = worktree.branch;
      // Live agent: the project's Claude Code hooks (settings.local.json isn't checked out)
      try {
        addToWorktree(project.path, worktreePath);
      } catch (error) {
        appLog.warn('[AgentManager] Could not copy the Live agent hooks to the worktree:', error);
      }
    }

    const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
    const attachments: TaskAttachment[] = (task.metadata?.attachedImages ?? [])
      .filter((image) => !!image.path)
      .map((image) => {
        const absolute = path.isAbsolute(image.path!) ? image.path! : path.join(specDir, image.path!);
        return {
          path: absolute,
          filename: image.filename || path.basename(absolute),
          mimeType: image.mimeType || mimeTypeFor(absolute),
        };
      });
    const feedbackAttachments: TaskAttachment[] = (options.feedbackImagePaths ?? []).map((imagePath) => ({
      path: imagePath,
      filename: path.basename(imagePath),
      mimeType: mimeTypeFor(imagePath),
    }));

    const taskSettings = resolveClaudeCodeTaskSettings(settings.claudeCodeTasks);
    // Starting a task whose last run went all the way through begins a new run (fresh triage
    // and session) in the same worktree, instead of finishing again immediately
    if (mode === 'start' && isClaudeRunFinished(loadClaudeRunInfo(specDir), taskSettings.validation)) {
      resetClaudeRunInfo(specDir);
    }

    const config: TaskRunConfig = {
      taskId,
      projectId: project.id,
      specId: task.specId,
      specDir,
      worktreePath,
      isolated: task.metadata?.useWorktree !== false,
      branch,
      baseBranch,
      title: task.title || task.specId,
      description: task.description?.trim() || task.title || task.specId,
      attachments,
      connectorIds: Array.isArray(task.metadata?.mcpConnectors) ? task.metadata.mcpConnectors : undefined,
      connectorSettings: settings.mcpConnectors,
      settings: taskSettings,
      maxBudgetUsd: project.settings?.maxBudgetUsd,
      changelogPath: project.autoBuildPath ? getTaskChangelogPath(project.path, project.autoBuildPath) : undefined,
      mode,
      // revise: the change to apply. start: what a discarded attempt got wrong, when the
      // reviewer asked for the task to be started over
      ...(mode === 'revise' || options.feedback ? { feedback: options.feedback ?? '', feedbackAttachments } : {}),
      profileId: options.profileId,
    };

    if (isSelfImproveEnabled(project.settings)) config.selfImprovePrompt = SELF_IMPROVE_NUDGE;

    if (await isGraphifyEnabled(project.path)) {
      try {
        const graphify = await getGraphifyPromptContext(project.path);
        if (graphify) {
          config.graphifyPrompt = graphify.commandPrompt;
          // GRAPHIFY_OUT is a host path (translated when the run starts in WSL). In WSL graphify
          // comes from the distribution's login PATH, so no Windows PATH entry is added
          config.extraEnv = { GRAPHIFY_OUT: path.dirname(graphify.graph) };
          if (!isWslRuntime()) {
            const augmented = await getAugmentedEnvAsync([path.dirname(graphify.cli)]);
            if (augmented.PATH) config.extraEnv.PATH = augmented.PATH;
          }
        }
      } catch (error) {
        appLog.warn(`[AgentManager] Graphify context unavailable for ${taskId}:`, error);
      }
    }

    return config;
  }

  private async getCurrentBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      const branch = stdout.trim();
      return branch && branch !== 'HEAD' ? branch : null;
    } catch {
      return null;
    }
  }

  private async isApiProfileActive(): Promise<boolean> {
    try {
      return Object.keys(await getAPIProfileEnv()).length > 0;
    } catch {
      return false;
    }
  }

  /** Next task event sequence: increases per task, also across runs and app restarts */
  private nextSequence(taskId: string, projectId: string): number {
    const key = runKey(projectId, taskId);
    const next = Math.max((this.sequences.get(key) ?? 0) + 1, Date.now());
    this.sequences.set(key, next);
    return next;
  }

  private emitTaskEvent(taskId: string, options: StartTaskOptions, type: string, payload: Record<string, unknown>): void {
    const event: TaskEventPayload = {
      ...payload,
      type,
      taskId,
      specId: options.task.specId,
      projectId: options.project.id,
      timestamp: new Date().toISOString(),
      eventId: randomUUID(),
      sequence: this.nextSequence(taskId, options.project.id),
    };
    this.emit('task-event', taskId, event, options.project.id);
  }

  /**
   * Record a rate limit on the Claude profile the run used, so the next runs (and an
   * automatic swap) pick another profile. Returns that profile's ID.
   */
  private recordRateLimit(entry: RunEntry, payload: Record<string, unknown>): string | undefined {
    // A Codex run: the limit belongs to its ChatGPT/OpenAI account
    const runProfileId = entry.run?.session?.profileId;
    if (isCodexAccountId(runProfileId)) {
      const resetAt = typeof payload.resetAt === 'string' ? new Date(payload.resetAt) : null;
      recordCodexRateLimit(runProfileId!, resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : new Date(Date.now() + 60 * 60 * 1000));
      return runProfileId;
    }
    if (entry.apiProfileActive) return undefined;
    try {
      const profileManager = getClaudeProfileManager();
      const profileId = entry.profileId ?? profileManager.getActiveProfile()?.id;
      if (!profileId) return undefined;
      const message = typeof payload.message === 'string' ? payload.message : '';
      const resetText = detectClaudeLimitMessage(message)?.resetText;
      const resetAt = typeof payload.resetAt === 'string' ? new Date(payload.resetAt) : null;
      if (resetText) {
        profileManager.recordRateLimitEvent(profileId, resetText);
      } else if (resetAt && !Number.isNaN(resetAt.getTime())) {
        // Only the reset instant is known: record it as is (a formatted date would read as a
        // weekly limit)
        profileManager.recordRateLimitEvent(profileId, '', { resetAt });
      }
      return profileId;
    } catch (error) {
      appLog.warn('[AgentManager] Could not record the rate limit:', error);
      return undefined;
    }
  }

  private registerWithOperationRegistry(taskId: string, entry: RunEntry): void {
    if (entry.apiProfileActive) return;
    // Claude account swaps move Claude Code runs only; Codex runs swap among Codex accounts on a limit
    void pickEngine(entry.profileId).then((engine) => {
      if (engine === 'claude' && !entry.killed) this.registerClaudeOperation(taskId, entry);
    }).catch(() => undefined);
  }

  private registerClaudeOperation(taskId: string, entry: RunEntry): void {
    try {
      const profileManager = getClaudeProfileManager();
      const profile = entry.profileId ? profileManager.getProfile(entry.profileId) : profileManager.getActiveProfile();
      if (!profile) return;
      this.state.assignProfileToTask(taskId, profile.id, profile.name, entry.profileId ? 'reactive' : 'proactive');
      // No stopFn: restartTask stops the run itself
      getOperationRegistry().registerOperation(
        taskId,
        'task-execution',
        profile.id,
        profile.name,
        (newProfileId: string) => this.restartTask(taskId, newProfileId),
        { metadata: { projectPath: entry.options.project.path, specId: entry.options.task.specId } }
      );
    } catch (error) {
      appLog.warn('[AgentManager] Could not register the task for profile swaps:', error);
    }
  }

  /** 'error' without a listener would throw (EventEmitter semantics) */
  private emitError(taskId: string, message: string, projectId?: string): void {
    if (this.listenerCount('error') > 0) this.emit('error', taskId, message, projectId);
  }

  private handleRunFinished(taskId: string, entry: RunEntry, outcome: TaskRunOutcome): void {
    const key = runKey(entry.projectId, taskId);
    if (this.runs.get(key) === entry) {
      this.runs.delete(key);
      this.state.removeRunning(taskId);
      getOperationRegistry().unregisterOperation(taskId);
    }
    // Stopped by the user or replaced by a restart: nothing to report
    if (entry.killed || outcome.status === 'stopped') return;

    const { projectId } = entry;
    this.emit('run-finished', taskId, outcome, projectId);

    if (outcome.status === 'auth_failed') {
      this.emit('auth-failure', taskId, {
        profileId: isCodexAccountId(entry.run?.session?.profileId)
          ? entry.run?.session?.profileId
          : entry.apiProfileActive ? undefined : entry.profileId ?? getActiveProfileIdSafe(),
        failureType: 'invalid',
        message: outcome.error,
      });
    }
    if (outcome.status === 'failed' || outcome.status === 'auth_failed') {
      const message = outcome.error ?? 'The task failed';
      this.emit('execution-progress', taskId, {
        phase: 'failed',
        phaseProgress: 0,
        overallProgress: 0,
        message,
      } satisfies ExecutionProgressData, projectId);
      this.emitError(taskId, message, projectId);
    }

    this.emit('exit', taskId, outcome.status === 'completed' ? 0 : 1, 'task-execution', projectId);
  }
}

function mimeTypeFor(filePath: string): string {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

function getActiveProfileIdSafe(): string | undefined {
  try {
    return getClaudeProfileManager().getActiveProfile()?.id;
  } catch {
    return undefined;
  }
}

