/**
 * Tests for AgentManager: wiring of ClaudeTaskRun (Claude Code task runner) to manager events
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { Project, Task } from '../../shared/types';
import type { TaskRunCallbacks, TaskRunConfig, TaskRunOutcome } from '../claude-code/task-runner';

interface MockRun {
  config: TaskRunConfig;
  callbacks: TaskRunCallbacks;
  stop: ReturnType<typeof vi.fn>;
  finish: (outcome: TaskRunOutcome) => void;
}

const runs: MockRun[] = [];

vi.mock('../claude-code/env', () => ({ pickEngine: vi.fn(async () => 'claude') }));
vi.mock('../claude-code/task-runner', () => ({
  ClaudeTaskRun: class {
    private resolve!: (outcome: TaskRunOutcome) => void;
    private readonly done: Promise<TaskRunOutcome>;
    stop = vi.fn(() => this.resolve({ status: 'stopped' }));
    constructor(config: TaskRunConfig, callbacks: TaskRunCallbacks) {
      this.done = new Promise((resolve) => { this.resolve = resolve; });
      runs.push({ config, callbacks, stop: this.stop, finish: (outcome) => this.resolve(outcome) });
    }
    run() {
      return this.done;
    }
  },
  loadClaudeRunInfo: vi.fn(() => null),
  resetClaudeRunInfo: vi.fn(),
  isClaudeRunFinished: vi.fn(() => false),
}));

vi.mock('../worktree', () => ({
  createOrGetWorktree: vi.fn(async (_projectPath: string, specId: string) => ({
    worktreePath: `/project/.workbench/worktrees/tasks/${specId}`,
    branch: `workbench/${specId}`,
  })),
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(() => ({ claudeCodeTasks: { triage: 'fixed', fixedModel: 'opus' } })),
}));

vi.mock('../graphify', () => ({
  getGraphifyPromptContext: vi.fn(async () => null),
  isGraphifyEnabled: vi.fn(async () => false),
}));

vi.mock('../env-utils', () => ({
  getAugmentedEnvAsync: vi.fn(async () => ({ PATH: '/usr/bin' })),
}));

vi.mock('../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => 'git'),
  getToolPathAsync: vi.fn(async () => 'git'),
}));

const profileManager = {
  getActiveProfile: vi.fn(() => ({ id: 'profile-a', name: 'Account A' })),
  getProfile: vi.fn((id: string) => ({ id, name: `Account ${id}` })),
  setActiveProfile: vi.fn(),
  recordRateLimitEvent: vi.fn(),
};
vi.mock('../claude-profile-manager', () => ({
  getClaudeProfileManager: () => profileManager,
}));

const registry = { registerOperation: vi.fn(), unregisterOperation: vi.fn() };
vi.mock('../claude-profile/operation-registry', () => ({
  getOperationRegistry: () => registry,
}));

vi.mock('../services/profile', () => ({
  getAPIProfileEnv: vi.fn(async () => ({})),
}));

vi.mock('../app-logger', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentManager } from './agent-manager';

const project = {
  id: 'project-1',
  name: 'Project',
  path: '/project',
  autoBuildPath: '.workbench',
  settings: { mainBranch: 'develop' },
} as unknown as Project;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '001-add-login',
    specId: '001-add-login',
    projectId: 'project-1',
    title: 'Add login',
    description: 'Add a login page',
    status: 'backlog',
    subtasks: [],
    logs: [],
    metadata: {
      attachedImages: [{ id: 'img', filename: 'mock.png', mimeType: 'image/png', size: 1, path: 'attachments/mock.png' }],
      mcpConnectors: ['context7'],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

/** Wait until the manager created the run (setup is async) */
async function nextRun(count: number): Promise<MockRun> {
  await vi.waitFor(() => expect(runs.length).toBe(count));
  return runs[count - 1];
}

describe('AgentManager', () => {
  let manager: AgentManager;

  beforeEach(() => {
    runs.length = 0;
    vi.clearAllMocks();
    manager = new AgentManager();
  });

  it('builds the run config from the task, project and settings', async () => {
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    expect(run.config.worktreePath).toBe('/project/.workbench/worktrees/tasks/001-add-login');
    expect(run.config.branch).toBe('workbench/001-add-login');
    expect(run.config.baseBranch).toBe('develop');
    expect(run.config.specDir).toBe(path.join('/project', '.workbench', 'tasks', '001-add-login'));
    expect(run.config.attachments).toEqual([{
      path: path.join('/project', '.workbench', 'tasks', '001-add-login', 'attachments', 'mock.png'),
      filename: 'mock.png',
      mimeType: 'image/png',
    }]);
    expect(run.config.connectorIds).toEqual(['context7']);
    expect(run.config.settings.triage).toBe('fixed');
    expect(run.config.settings.fixedModel).toBe('opus');
    expect(run.config.mode).toBe('start');
    expect(manager.isRunning('001-add-login')).toBe(true);
    expect(registry.registerOperation).toHaveBeenCalledWith(
      '001-add-login', 'task-execution', 'profile-a', 'Account A', expect.any(Function), expect.anything()
    );
  });

  it('runs in the project directory when worktrees are off', async () => {
    const task = makeTask({ metadata: { useWorktree: false } } as Partial<Task>);
    await manager.startTask(task.id, { project, task, mode: 'start' });
    const run = await nextRun(1);
    expect(run.config.worktreePath).toBe('/project');
  });

  it('passes reviewer feedback and its images in revise mode', async () => {
    await manager.startTask('001-add-login', {
      project,
      task: makeTask(),
      mode: 'revise',
      feedback: 'Use the shared button',
      feedbackImagePaths: ['/tmp/shot.jpg'],
    });
    const run = await nextRun(1);
    expect(run.config.mode).toBe('revise');
    expect(run.config.feedback).toBe('Use the shared button');
    expect(run.config.feedbackAttachments).toEqual([{ path: '/tmp/shot.jpg', filename: 'shot.jpg', mimeType: 'image/jpeg' }]);
  });

  it('forwards run callbacks as manager events', async () => {
    const events: Array<[string, unknown[]]> = [];
    for (const name of ['log', 'execution-progress', 'task-event', 'run-info', 'subtasks']) {
      manager.on(name, (...args: unknown[]) => events.push([name, args]));
    }
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    run.callbacks.onLog?.('Reading files');
    run.callbacks.onProgress?.({ phase: 'coding', phaseProgress: 10, overallProgress: 30, message: 'Implementing' });
    run.callbacks.onTaskEvent?.('CODING_STARTED', { subtaskId: '', subtaskDescription: 'Implementing' });
    run.callbacks.onTaskEvent?.('QA_STARTED', { iteration: 1, maxIterations: 1 });
    run.callbacks.onRunInfo?.({ version: 1, sessionId: 'session-1', phases: [], subagents: [], totalCostUsd: 0, updatedAt: '' });
    run.callbacks.onSubtasks?.([{ id: '1', title: 'Step', description: '', status: 'pending' }]);

    expect(events.find(([n]) => n === 'log')?.[1]).toEqual(['001-add-login', 'Reading files\n', 'project-1']);
    expect(events.find(([n]) => n === 'execution-progress')?.[1][1]).toMatchObject({ phase: 'coding', overallProgress: 30 });
    const taskEvents = events.filter(([n]) => n === 'task-event').map(([, args]) => args[1] as Record<string, unknown>);
    expect(taskEvents.map((e) => e.type)).toEqual(['CODING_STARTED', 'QA_STARTED']);
    expect(taskEvents[0]).toMatchObject({ taskId: '001-add-login', specId: '001-add-login', projectId: 'project-1' });
    expect(taskEvents[1].sequence as number).toBeGreaterThan(taskEvents[0].sequence as number);
    expect(events.some(([n]) => n === 'run-info')).toBe(true);
    expect(manager.getTaskSessionId('001-add-login')).toBe('session-1');
    expect(events.find(([n]) => n === 'subtasks')?.[1][1]).toHaveLength(1);
  });

  it('emits exit 0 when the run completes and exit 1 with an error when it fails', async () => {
    const exits: Array<number | null> = [];
    const errors: string[] = [];
    manager.on('exit', (_taskId: string, code: number | null) => exits.push(code));
    manager.on('error', (_taskId: string, error: string) => errors.push(error));

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    (await nextRun(1)).finish({ status: 'completed' });
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(manager.isRunning('001-add-login')).toBe(false);

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    (await nextRun(2)).finish({ status: 'failed', error: 'Claude Code stopped with an error' });
    await vi.waitFor(() => expect(exits).toEqual([0, 1]));
    expect(errors).toEqual(['Claude Code stopped with an error']);
  });

  it('emits auth-failure when Claude Code is not signed in', async () => {
    const failures: unknown[] = [];
    manager.on('auth-failure', (_taskId: string, failure: unknown) => failures.push(failure));
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    (await nextRun(1)).finish({ status: 'auth_failed', error: 'Not signed in' });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ profileId: 'profile-a', message: 'Not signed in' });
  });

  it('stops a run without reporting its outcome', async () => {
    const exits: unknown[] = [];
    manager.on('exit', (...args: unknown[]) => exits.push(args));
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    expect(manager.killTask('001-add-login')).toBe(true);
    expect(run.stop).toHaveBeenCalled();
    expect(manager.isRunning('001-add-login')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exits).toEqual([]);
  });

  it('keeps the runs of same-named tasks in two projects apart', async () => {
    // Each project numbers its tasks from 001, so the same id turns up in both
    const other = { ...project, id: 'project-2', path: '/other' } as unknown as Project;

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);

    await manager.startTask('001-add-login', {
      project: other,
      task: makeTask({ projectId: 'project-2' }),
      mode: 'start',
    });
    const second = await nextRun(2);

    // Starting the second project's task leaves the first project's run alone
    expect(first.stop).not.toHaveBeenCalled();
    expect(manager.isRunning('001-add-login', 'project-1')).toBe(true);
    expect(manager.isRunning('001-add-login', 'project-2')).toBe(true);
    expect(manager.getRunningTasks()).toEqual(['001-add-login', '001-add-login']);

    // And stopping one stops only that project's run
    expect(manager.killTask('001-add-login', 'project-2')).toBe(true);
    expect(second.stop).toHaveBeenCalled();
    expect(first.stop).not.toHaveBeenCalled();
    expect(manager.isRunning('001-add-login', 'project-1')).toBe(true);
    expect(manager.isRunning('001-add-login', 'project-2')).toBe(false);
  });

  it('records a rate limit on the profile the run used and tags the event with it', async () => {
    const taskEvents: Array<Record<string, unknown>> = [];
    manager.on('task-event', (_taskId: string, event: Record<string, unknown>) => taskEvents.push(event));
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const run = await nextRun(1);

    run.callbacks.onTaskEvent?.('RATE_LIMIT_HOLD', {
      resetAt: '2026-10-10T18:30:00.000Z',
      message: "You've hit your session limit · resets 8:30pm (Asia/Yerevan)",
      phase: 'coding',
    });

    expect(profileManager.recordRateLimitEvent).toHaveBeenCalledWith('profile-a', '8:30pm (Asia/Yerevan)');
    expect(taskEvents[0]).toMatchObject({ type: 'RATE_LIMIT_HOLD', profileId: 'profile-a', phase: 'coding' });
  });

  it('restarts a run on another profile once the previous run settled', async () => {
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    const first = await nextRun(1);

    expect(manager.restartTask('001-add-login', 'profile-b')).toBe(true);
    expect(first.stop).toHaveBeenCalled();
    expect(profileManager.setActiveProfile).toHaveBeenCalledWith('profile-b');

    const second = await nextRun(2);
    expect(second.config.profileId).toBe('profile-b');
    expect(manager.isRunning('001-add-login')).toBe(true);
  });

  it('gives up restarting after repeated swaps', async () => {
    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });
    await nextRun(1);
    expect(manager.restartTask('001-add-login', 'profile-b')).toBe(true);
    await nextRun(2);
    expect(manager.restartTask('001-add-login', 'profile-c')).toBe(true);
    await nextRun(3);
    expect(manager.restartTask('001-add-login', 'profile-d')).toBe(false);
  });

  it('reports a failed start when the worktree cannot be created', async () => {
    const { createOrGetWorktree } = await import('../worktree');
    vi.mocked(createOrGetWorktree).mockRejectedValueOnce(new Error('git worktree add failed'));
    const taskEvents: Array<Record<string, unknown>> = [];
    const exits: Array<number | null> = [];
    manager.on('task-event', (_taskId: string, event: Record<string, unknown>) => taskEvents.push(event));
    manager.on('exit', (_taskId: string, code: number | null) => exits.push(code));
    manager.on('error', () => undefined);

    await manager.startTask('001-add-login', { project, task: makeTask(), mode: 'start' });

    expect(runs).toHaveLength(0);
    expect(taskEvents[0]).toMatchObject({ type: 'PLANNING_FAILED', error: 'git worktree add failed' });
    expect(exits).toEqual([1]);
    expect(manager.isRunning('001-add-login')).toBe(false);
  });
});
