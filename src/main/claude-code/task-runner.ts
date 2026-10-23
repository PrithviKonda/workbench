/**
 * Claude Code task runner
 * =======================
 *
 * Runs one Workbench task through the Claude Code CLI, in the task's git worktree:
 *
 *   triage    short read-only run: model, effort, plan or not (see triage.ts)
 *   plan      optional: `--permission-mode plan`, returns the plan as structured output
 *   implement resumes the same session with `--dangerously-skip-permissions` (the worktree
 *             isolates the run) and the triage model/effort
 *   validate  optional: same session runs the project's checks, reviews the diff with fresh
 *             eyes (/code-review or a subagent), commits, and returns a structured report
 *   revise    after "request changes": same session gets the reviewer's feedback, then validates
 *
 * Planning, implementation and validation share one Claude Code session, so the context built
 * while exploring carries into the work (Claude Code's "explore, plan, code" workflow). Claude
 * decides on its own when subagents, skills, MCP tools or the task list help.
 *
 * State lives in `<specDir>/claude_run.json` (ClaudeRunInfo) so a stopped, rate-limited or
 * crashed run continues where it left off.
 */

import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { engineCanRun, pickEngine, resolveClaudeEnv, type EngineKind } from './env';
import { CODEX_TASK_LIST_SERVER, codexModelFor, codexTaskListTools, readCodexModels } from './codex';
import { SECOND_OPINION_SERVER, secondOpinionPromptLine, secondOpinionTools } from './second-opinion';
import { defaultCodexHome, findCodexRollout, getBestCodexAccount } from '../claude-profile/codex-accounts';
import { openToolsSession } from '../insights/task-tools-server';
import { startClaudeProcess, type ClaudeProcessHandle } from './process';
import { buildMcpConfig } from './mcp-config';
import { triageTask, fixedTriage, applyPlanningPolicy } from './triage';
import { TaskLogWriter, summarizeToolInput } from './task-log';
import { buildParallelTasksPrompt } from '../task-changelog';
import { git } from '../utils/git-exec';
import { getWslInfo, toHostPath, toRuntimePath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { buildAttachmentBlocks } from '../insights/message-content';
import { detectClaudeLimitMessage, parseLimitResetTime } from './limit';
import {
  isApiRetry,
  isAssistantMessage,
  isInitMessage,
  isRateLimitEvent,
  isResultMessage,
  isTaskNotification,
  isTaskStarted,
  isUserMessage,
  type ClaudeResultMessage,
  type ClaudeStreamMessage,
  type ClaudeToolResultBlock,
  type ClaudeUserContentBlock,
} from './stream-types';
import { resolveModelRoute } from '../../shared/types/claude-code';
import type {
  ClaudeCodeTaskSettings,
  ClaudeEffort,
  ClaudeRunInfo,
  ClaudeRuntime,
  ClaudeRunPhase,
  ClaudeRunPhaseName,
  TaskTriage,
  ValidationReport,
} from '../../shared/types/claude-code';
import type { McpConnectorSettings } from '../../shared/types/settings';
import type { ExecutionPhase } from '../../shared/constants/phase-protocol';
import type { ImageAttachment, SubtaskStatus, TaskLogPhase } from '../../shared/types/task';
import { DATA_DIR_NAMES } from '../../shared/constants';

export const CLAUDE_RUN_FILE = 'claude_run.json';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Other attachments (PDFs, text files; text is also truncated when inlined) */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Tools whose file edits go to the task hooks (and so the project's task changelog) */
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// =============================================================================
// Public types
// =============================================================================

export interface TaskAttachment {
  /** Absolute path of the image file */
  path: string;
  filename: string;
  mimeType: string;
}

export interface TaskRunConfig {
  taskId: string;
  projectId?: string;
  specId: string;
  /** Main project spec dir: run state, logs and plan are written here */
  specDir: string;
  /** Worktree the Claude Code session works in */
  worktreePath: string;
  /**
   * The session works in its own git worktree (default). When false it works directly in the
   * project checkout, so permission checks stay on (auto mode) instead of being bypassed.
   */
  isolated?: boolean;
  branch: string;
  baseBranch: string;
  title: string;
  description: string;
  attachments: TaskAttachment[];
  /** Connector ids for the task (undefined = Connectors defaults) */
  connectorIds?: string[];
  connectorSettings?: McpConnectorSettings;
  settings: ClaudeCodeTaskSettings;
  /** The project's budget per task (`--max-budget-usd`, Settings > Project); unset = no cap */
  maxBudgetUsd?: number;
  /** Prompt section pointing Claude Code at the project's Graphify memory graph */
  graphifyPrompt?: string;
  /** Tells the session to save what it learns, when the project's self-improve switch is on */
  selfImprovePrompt?: string;
  /** The project's task changelog; each phase's prompt lists what the other tasks are changing */
  changelogPath?: string;
  /** Extra environment (e.g. GRAPHIFY_OUT, PATH with the graphify CLI) */
  extraEnv?: Record<string, string>;
  /** start: new or continued run; revise: apply reviewer feedback */
  mode: 'start' | 'revise';
  feedback?: string;
  feedbackAttachments?: TaskAttachment[];
  /** Claude profile to use (undefined = best available) */
  profileId?: string;
}

interface TaskRunProgress {
  phase: ExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
  message: string;
  currentSubtask?: string;
}

export interface TaskRunSubtask {
  id: string;
  title: string;
  description: string;
  status: SubtaskStatus;
}

export interface TaskRunCallbacks {
  /** Plain log line for the live terminal-style log */
  onLog?: (line: string) => void;
  onProgress?: (progress: TaskRunProgress) => void;
  /** Task state machine event (CODING_STARTED, QA_PASSED, RATE_LIMIT_HOLD, ...) */
  onTaskEvent?: (type: string, payload: Record<string, unknown>) => void;
  onRunInfo?: (info: ClaudeRunInfo) => void;
  /** Claude Code's task list (TaskCreate/TaskUpdate), mirrored as the task's subtasks */
  onSubtasks?: (subtasks: TaskRunSubtask[]) => void;
  /** Files the session edits (relative to the worktree, forward slashes), for the task hooks */
  onFilesEdited?: (files: string[]) => void;
}

type TaskRunStatus = 'completed' | 'failed' | 'rate_limited' | 'auth_failed' | 'stopped';

export interface TaskRunOutcome {
  status: TaskRunStatus;
  error?: string;
  rateLimit?: { message: string; resetAt?: string };
  validation?: ValidationReport;
}

// =============================================================================
// Prompts
// =============================================================================

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'The implementation plan in Markdown' },
  },
  required: ['plan'],
};

const VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'partial'] },
    summary: { type: 'string', description: 'Short summary for the reviewer: what changed, how it was verified, assumptions and follow-ups' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          passed: { type: 'boolean' },
          details: { type: 'string' },
        },
        required: ['name', 'passed'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          description: { type: 'string' },
          fixed: { type: 'boolean' },
        },
        required: ['severity', 'description', 'fixed'],
      },
    },
  },
  required: ['status', 'summary', 'checks', 'findings'],
};

function buildSystemPrompt(config: TaskRunConfig, specDirRelative: string, parallelTasksPrompt?: string): string {
  const sections = [
    `You are running autonomously inside Workbench, a desktop app that hands coding tasks to Claude Code. Nobody watches this session live and nobody can answer questions: make reasonable assumptions, state them in your final summary, and keep going.`,
    config.isolated === false
      ? `## Environment
- Your working directory is the user's project checkout on branch \`${config.branch}\` (this task runs without a separate worktree). Keep changes focused on the task.
- Never push, force-push, rewrite history, publish packages or deploy.
- Workbench keeps its own task files in \`${specDirRelative}\`. Don't modify or commit them.`
      : `## Environment
- Your working directory is an isolated git worktree on branch \`${config.branch}\`, created from \`${config.baseBranch}\`. Edits here never touch the user's main checkout. Stay inside this worktree.
- Permission checks are off because of that isolation. Still never push, force-push, rewrite the history of \`${config.baseBranch}\`, publish packages, deploy, or change anything outside the worktree.
- Workbench keeps its own task files in \`${specDirRelative}\`. Don't modify or commit them.`,
    `## How to work
- Follow the project's CLAUDE.md, conventions and existing patterns. Keep the change focused on the task.
- Track work with the task list (TaskCreate / TaskUpdate) only when it has several distinct steps worth tracking; skip it for small changes.
- Use subagents only when they help: broad searches whose raw output you don't need, or independent investigations that can run in parallel. Do the implementation itself in this conversation.
- Use skills and MCP tools when they fit the task.
- Verify your work with the project's own checks (tests, type checker, linter, build) for the code you changed, and fix failures you caused. Show evidence rather than asserting success.
- When the work is done, commit it in this worktree with a descriptive message. Don't push.
- End with a short summary for the reviewer: what changed, how you verified it, and any assumptions or follow-ups.`,
  ];
  const instructions = config.settings.customInstructions?.trim();
  if (instructions) sections.push(`## The user's instructions (follow these over the defaults above)\n${instructions}`);
  if (config.graphifyPrompt) sections.push(config.graphifyPrompt);
  if (config.selfImprovePrompt) sections.push(config.selfImprovePrompt);
  if (parallelTasksPrompt) sections.push(parallelTasksPrompt);
  return sections.join('\n\n');
}

function taskBlock(config: TaskRunConfig): string {
  return `<task title="${config.title.replace(/"/g, "'")}">\n${config.description}\n</task>`;
}

/**
 * What a discarded attempt got wrong, for a run started over from "Request changes" with
 * "Start over" ticked. Empty for a normal start and for a revision (which quotes the feedback
 * as the change to apply).
 */
function restartNotes(config: TaskRunConfig): string {
  const feedback = config.mode === 'start' ? config.feedback?.trim() : '';
  if (!feedback) return '';
  return `\n\nAn earlier attempt at this task was discarded and you are starting it over. The reviewer's notes on that attempt:

<feedback>
${feedback}
</feedback>`;
}

function verificationHint(triage: TaskTriage | undefined): string {
  if (triage?.verification.length) {
    return `the checks that apply to the code you changed (for example: ${triage.verification.map((v) => `\`${v}\``).join(', ')})`;
  }
  return `the checks that apply to the code you changed (the project's tests, type checker, linter or build)`;
}

// =============================================================================
// Runner
// =============================================================================

interface PhaseResult {
  result?: ClaudeResultMessage;
  rateLimit?: { message: string; resetAt?: string };
  authFailed?: boolean;
  stopped: boolean;
  error?: string;
  /** Spent on the other engine's second opinions during the phase */
  secondOpinionCostUsd?: number;
}

export class ClaudeTaskRun {
  private readonly runFile: string;
  private info: ClaudeRunInfo;
  private readonly log: TaskLogWriter;
  private current: ClaudeProcessHandle | null = null;
  private readonly abortController = new AbortController();
  private stopped = false;
  private subtasks: TaskRunSubtask[] = [];
  /** TaskCreate tool_use id -> subtask under construction */
  private pendingTaskCreates = new Map<string, TaskRunSubtask>();
  /** Main-thread tool_use id -> tool name, for matching results */
  private toolNames = new Map<string, string>();
  /** Agent tool_use id -> description, for labeling subagent activity in the log */
  private subagentLabels = new Map<string, string>();
  private rejectedRateLimitResetAt: string | undefined;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: TaskRunConfig, private readonly callbacks: TaskRunCallbacks = {}) {
    this.runFile = path.join(config.specDir, CLAUDE_RUN_FILE);
    this.info = loadClaudeRunInfo(config.specDir) ?? {
      version: 1,
      phases: [],
      subagents: [],
      totalCostUsd: 0,
      updatedAt: new Date().toISOString(),
    };
    this.info.worktreePath = config.worktreePath;
    this.log = new TaskLogWriter(config.specDir, config.specId);
  }

  /** Stop the run; the outcome resolves with status 'stopped' */
  /** Current session, profile and config dir of the run (they change on a profile swap) */
  get session(): { sessionId?: string; profileId?: string; configDir?: string } {
    return { sessionId: this.info.sessionId, profileId: this.info.profileId, configDir: this.info.configDir };
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
    this.current?.stop();
  }

  /** Run (or continue) the task to the end */
  async run(): Promise<TaskRunOutcome> {
    try {
      return await this.runSteps();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.stopped) return { status: 'stopped' };
      this.emitLog(`Run failed: ${message}`);
      this.callbacks.onTaskEvent?.('CODING_FAILED', { subtaskId: '', error: message, attemptCount: 1 });
      return { status: 'failed', error: message };
    } finally {
      this.flushInfo();
      this.log.saveNow();
    }
  }

  private async runSteps(): Promise<TaskRunOutcome> {
    const settings = this.config.settings;

    if (this.config.mode === 'revise') {
      // Each change request runs the same workflow: assess it (model and effort for the
      // change), apply it in the task's session, then validate
      const triaged = await this.runTriage(true);
      if (triaged) return triaged;
      const revised = await this.runSessionPhase('revise');
      if (revised) return revised;
      if (settings.validation) {
        const validated = await this.runSessionPhase('validate');
        if (validated) return validated;
      }
      return this.finish();
    }

    // 1. Triage
    if (!this.info.triage) {
      const triaged = await this.runTriage();
      if (triaged) return triaged;
    }
    const triage = this.info.triage!;

    // 2. Plan (only before implementation started)
    const implementStarted = this.info.phases.some((p) => p.name === 'implement');
    if (triage.needsPlan && !this.info.plan && !implementStarted) {
      const planned = await this.runSessionPhase('plan');
      if (planned) return planned;
    }

    // 3. Implement
    if (!this.hasCompleted('implement')) {
      const implemented = await this.runSessionPhase('implement');
      if (implemented) return implemented;
    }

    // 4. Validate
    if (settings.validation && !this.hasCompleted('validate')) {
      const validated = await this.runSessionPhase('validate');
      if (validated) return validated;
    }

    return this.finish();
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async runTriage(revision = false): Promise<TaskRunOutcome | null> {
    const { settings } = this.config;
    const label = revision ? 'Assessing the requested changes' : 'Assessing the task';
    this.emitProgress('planning', 0.05, label);
    this.log.startPhase('planning', label);
    const phase = this.beginPhase('triage', { model: settings.triageModel, effort: 'low' });

    let triage: TaskTriage;
    let triageCost: number | undefined;
    if (settings.triage === 'fixed') {
      triage = fixedTriage(settings, this.config.title, 'fixed', 'Fixed model and effort from Settings > Agents');
    } else {
      try {
        ({ triage, costUsd: triageCost } = await triageTask({
          description: revision
            ? `${this.config.description}\n\nThis task was already implemented. Assess only the follow-up change the reviewer requested:\n${this.config.feedback ?? ''}`
            : `${this.config.description}${restartNotes(this.config)}`,
          cwd: this.config.worktreePath,
          attachmentNames: (revision ? this.config.feedbackAttachments ?? [] : this.config.attachments).map((a) => a.filename),
          settings,
          abortSignal: this.abortController.signal,
          profileId: this.config.profileId,
        }));
      } catch (error) {
        if (this.stopped) return { status: 'stopped' };
        const message = error instanceof Error ? error.message : String(error);
        const limit = detectClaudeLimitMessage(message);
        if (limit) return this.rateLimited('triage', phase, { message: limit.message, resetAt: this.resetAt(limit.resetText) });
        this.emitLog(`Triage failed, using the default model: ${message}`);
        triage = fixedTriage(settings, this.config.title, 'fallback', `Triage failed (${message}); used the default model and effort`);
      }
    }
    triage = applyPlanningPolicy(triage, settings);
    if (revision) {
      // A change request is applied directly in the session (no separate plan) and keeps the title
      triage = { ...triage, needsPlan: false, title: this.info.triage?.title || this.config.title };
    }
    this.info.triage = triage;
    this.endPhase(phase, triageCost !== undefined ? { costUsd: triageCost } : {});
    this.updateTotalCost();
    this.log.add('planning', 'info',
      `Model ${triage.model}, effort ${triage.effort}, ${triage.needsPlan ? 'plan first' : 'no plan'} (${triage.scope})`,
      { detail: triage.reasoning || undefined });
    this.emitLog(`Triage: ${triage.model} / ${triage.effort} / ${triage.needsPlan ? 'plan first' : 'no plan'}. ${triage.reasoning}`);
    this.saveInfo();
    return null;
  }

  /** Run a Claude Code session step; returns an outcome when the run must stop */
  private async runSessionPhase(name: Exclude<ClaudeRunPhaseName, 'triage'>): Promise<TaskRunOutcome | null> {
    const triage = this.info.triage ?? fixedTriage(this.config.settings, this.config.title, 'fallback', 'No triage recorded');
    // Settings > Agents > Model routing for this step and the task's size; unset fields stay automatic
    const route = resolveModelRoute(this.config.settings.modelRouting, name === 'revise' ? 'implement' : name, triage.scope);
    let model: string = route.model ?? (name === 'plan' ? (triage.model === 'fable' ? 'fable' : 'opus') : triage.model);
    const effort: ClaudeEffort = route.effort
      ?? (name === 'plan' && (triage.effort === 'low' || triage.effort === 'medium') ? 'high' : triage.effort);
    const logPhase: TaskLogPhase = name === 'plan' ? 'planning' : name === 'validate' ? 'validation' : 'coding';

    // A session lives in the runtime it ran in (native or WSL); after a switch, start a new one
    await whenShellRuntimeReady();
    const runtime = currentRuntime();
    if (this.info.sessionId && (this.info.runtime ?? 'native') !== runtime) {
      this.emitLog(`Claude Code now runs ${runtime === 'wsl' ? 'in WSL' : 'natively'}, so this step starts a new session`);
      this.info.sessionId = undefined;
    }
    if (this.info.runtime !== runtime) {
      this.info.runtime = runtime;
      this.saveInfo();
    }
    // Same for the agent CLI: a Claude Code session can't continue in Codex or the other way round
    const engine = route.engine ?? (await pickEngine(this.config.profileId ?? this.info.profileId));
    if (this.info.sessionId && (this.info.engine ?? 'claude') !== engine) {
      this.emitLog(`This step runs in ${engine === 'codex' ? 'Codex' : 'Claude Code'}, so it starts a new session`);
      this.info.sessionId = undefined;
      this.info.profileId = undefined;
    }
    if ((this.info.engine ?? 'claude') !== engine) {
      this.info.engine = engine;
      this.saveInfo();
    }
    // Codex: the tier triage picked as the Codex model it maps to, so logs and costs name the real model
    if (engine === 'codex') {
      const home = getBestCodexAccount({ pinnedId: this.config.profileId ?? this.info.profileId })?.configDir ?? defaultCodexHome();
      model = codexModelFor(model, readCodexModels(home)) ?? model;
    }

    const resumeSessionId = this.info.sessionId;
    const continuing = name === 'implement' && this.info.phases.some((p) => p.name === 'implement');
    const label = {
      plan: 'Planning',
      implement: continuing ? 'Continuing implementation' : 'Implementing',
      validate: 'Validating',
      revise: 'Applying requested changes',
    }[name];

    if (name === 'plan') {
      this.emitProgress('planning', 0.15, label);
      this.log.startPhase('planning', `${label} (${model}, ${effort})`);
    } else if (name === 'implement' || name === 'revise') {
      this.callbacks.onTaskEvent?.('CODING_STARTED', { subtaskId: '', subtaskDescription: label });
      this.emitProgress('coding', 0.2, label);
      this.log.startPhase('coding', `${label} (${model}, ${effort})`);
    } else {
      this.callbacks.onTaskEvent?.('QA_STARTED', { iteration: 1, maxIterations: 1 });
      this.emitProgress('qa_review', 0.85, label);
      this.log.startPhase('validation', `${label} (${model}, ${effort})`);
    }

    const sessionId = resumeSessionId ?? randomUUID();
    const phase = this.beginPhase(name, {
      model,
      effort,
      permissionMode: name === 'plan' ? 'plan' : this.config.isolated === false ? 'auto' : 'bypassPermissions',
      sessionId,
    });
    // Codex names its thread itself (the init message brings the id); a made-up id couldn't be resumed
    if (!this.info.sessionId && engine !== 'codex') this.info.sessionId = sessionId;
    this.saveInfo();

    const outcome = await this.runClaude({
      name,
      model,
      effort,
      sessionId,
      resume: !!resumeSessionId,
      engine,
      input: this.buildInput(name, continuing, !!resumeSessionId),
      jsonSchema: name === 'plan' ? PLAN_SCHEMA : name === 'validate' ? VALIDATION_SCHEMA : undefined,
      logPhase,
    });
    if (outcome.secondOpinionCostUsd) phase.secondOpinionCostUsd = outcome.secondOpinionCostUsd;

    if (outcome.stopped) {
      this.endPhase(phase, { isError: true, error: 'Stopped' });
      this.log.endPhase(logPhase, 'stopped', 'Stopped');
      return { status: 'stopped' };
    }
    if (outcome.rateLimit) return this.rateLimited(name, phase, outcome.rateLimit);
    if (outcome.authFailed) {
      const error = engine === 'codex'
        ? 'Codex is not signed in or the sign-in expired. Sign in to the ChatGPT account again in Settings > Accounts.'
        : 'Claude Code is not signed in or the sign-in expired. Re-authenticate the account in Settings > Accounts.';
      this.endPhase(phase, { isError: true, error });
      this.log.endPhase(logPhase, false, error);
      this.failEvent(name, error);
      return { status: 'auth_failed', error };
    }

    const result = outcome.result;
    if (!result || result.is_error || result.subtype !== 'success') {
      const error = outcome.error
        || result?.errors?.join('; ')
        || (result?.subtype === 'error_max_budget_usd' ? 'The task reached its budget limit (Settings > Project)' : '')
        || result?.result
        || 'Claude Code stopped with an error';
      this.endPhase(phase, { isError: true, error }, result);
      this.log.endPhase(logPhase, false, error);
      this.failEvent(name, error);
      return { status: 'failed', error };
    }

    this.endPhase(phase, {}, result);
    if (name === 'plan') {
      const structured = result.structured_output as { plan?: unknown } | undefined;
      const plan = typeof structured?.plan === 'string' && structured.plan.trim() ? structured.plan : (result.result ?? '');
      this.info.plan = plan;
      writeFileSafe(path.join(this.config.specDir, 'plan.md'), plan);
      this.log.add('planning', 'success', 'Plan ready', { detail: plan, collapsed: true });
      this.log.endPhase('planning', true, 'Plan ready');
    } else if (name === 'validate') {
      const report = normalizeValidation(result.structured_output, result.result);
      this.info.validation = report;
      this.info.summary = report.summary || this.info.summary;
      this.log.add('validation', report.status === 'failed' ? 'error' : 'success', `Validation ${report.status}`, {
        detail: report.summary,
      });
      this.log.endPhase('validation', report.status !== 'failed', `Validation ${report.status}`);
    } else {
      this.info.summary = result.result?.trim() || this.info.summary;
      this.log.endPhase('coding', true, name === 'revise' ? 'Changes applied' : 'Implementation finished');
      if (name === 'revise') this.info.validation = undefined;
    }
    this.saveInfo();
    return null;
  }

  private async finish(): Promise<TaskRunOutcome> {
    await this.commitLeftovers();
    const validation = this.info.validation;
    this.emitProgress('complete', 1, 'Ready for review');
    if (validation?.status === 'failed') {
      this.callbacks.onTaskEvent?.('QA_FAILED', {
        iteration: 1,
        issueCount: validation.findings.filter((f) => !f.fixed).length || 1,
        issues: validation.findings.filter((f) => !f.fixed).map((f) => f.description),
      });
    } else {
      this.callbacks.onTaskEvent?.('QA_PASSED', { iteration: 1, testsRun: {} });
    }
    return { status: 'completed', validation };
  }

  // ---------------------------------------------------------------------------
  // Claude Code process
  // ---------------------------------------------------------------------------

  private buildInput(name: Exclude<ClaudeRunPhaseName, 'triage'>, continuing: boolean, resume: boolean): ClaudeUserContentBlock[] {
    const triage = this.info.triage;
    const blocks: ClaudeUserContentBlock[] = [];
    let text: string;

    switch (name) {
      case 'plan':
        text = `${taskBlock(this.config)}${restartNotes(this.config)}

Explore the codebase as needed and produce an implementation plan for this task. Don't change any files yet.
The plan should name the files to change, the approach and why, edge cases, and how to verify the result (${verificationHint(triage)}).`;
        break;
      case 'implement':
        if (continuing && resume) {
          text = `Continue the task from where you left off. Check \`git status\` and \`git log\` to see what is already done, then finish the work.`;
        } else if (this.info.plan && resume) {
          text = `The plan is approved. Implement it now, verify it with ${verificationHint(triage)}, and commit the result.`;
        } else if (continuing || this.info.plan) {
          // A new session for work that started in another one (the runtime changed): the task,
          // the approved plan and what was done so far go with the first message
          const plan = this.info.plan ? `\n\nThe approved implementation plan:\n\n<plan>\n${this.info.plan}\n</plan>` : '';
          const started = continuing
            ? '\n\nAn earlier session already worked on this task in this worktree. Check `git status` and `git log` to see what is already done.'
            : '';
          text = `${taskBlock(this.config)}${restartNotes(this.config)}${plan}${started}

Implement this task${plan ? ' as planned' : ''}. Verify it with ${verificationHint(triage)}, then commit the result.`;
        } else {
          text = `${taskBlock(this.config)}${restartNotes(this.config)}

Implement this task. Verify it with ${verificationHint(triage)}, then commit the result.`;
        }
        break;
      case 'validate':
        text = `${resume ? '' : `${taskBlock(this.config)}\n\n`}Before handing this off, validate the work:
1. Run ${verificationHint(triage)}. Fix failures your change caused.
2. Review the full change against \`${this.config.baseBranch}\` (\`git diff ${this.config.baseBranch}...HEAD\` plus any uncommitted changes) with fresh eyes. Use the /code-review skill if it's available; otherwise use a subagent that sees only the diff and the task, or if you have neither, review the diff yourself as a skeptical reviewer who didn't write it. Fix only findings that affect correctness or the task's requirements; don't gold-plate.
3. Commit any remaining changes.
Then return the report: status "passed" when the change works and the checks pass, "partial" when some checks couldn't run, "failed" when something is still broken.`;
        break;
      case 'revise':
        text = `${resume ? '' : `${taskBlock(this.config)}\n\n`}The reviewer requested changes:

<feedback>
${this.config.feedback ?? ''}
</feedback>

Apply them, verify with ${verificationHint(triage)}, and commit the result.`;
        break;
    }
    blocks.push({ type: 'text', text });

    // The task's attachments go with the session's first turn; feedback images with the revision.
    // Like the Claude chat: images as images, PDFs as documents, text files inlined
    const attachments = name === 'revise'
      ? [...(resume ? [] : this.config.attachments), ...(this.config.feedbackAttachments ?? [])]
      : resume ? [] : [...this.config.attachments, ...(this.config.feedbackAttachments ?? [])];
    const files: ImageAttachment[] = [];
    for (const attachment of attachments) {
      try {
        const data = readFileSync(attachment.path);
        const limit = attachment.mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
        if (data.byteLength > limit) {
          this.emitLog(`${attachment.filename} is too large to attach`);
          continue;
        }
        files.push({
          id: attachment.filename,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: data.byteLength,
          data: data.toString('base64'),
        });
      } catch {
        this.emitLog(`Could not attach ${attachment.filename}`);
      }
    }
    blocks.push(...buildAttachmentBlocks(files));
    return blocks;
  }

  private async runClaude(params: {
    name: Exclude<ClaudeRunPhaseName, 'triage'>;
    model: string;
    effort: ClaudeEffort;
    sessionId: string;
    resume: boolean;
    engine: EngineKind;
    input: ClaudeUserContentBlock[];
    jsonSchema?: Record<string, unknown>;
    logPhase: TaskLogPhase;
  }): Promise<PhaseResult> {
    if (this.stopped) return { stopped: true };
    const { settings } = this.config;
    // Stay on the profile that holds the session transcript, unless the caller switched profiles
    // (rate-limit swap); then the transcript is copied to the new profile below
    const { command, env, profileId, engine } = await resolveClaudeEnv({
      engine: params.engine,
      profileId: this.config.profileId ?? (params.resume ? this.info.profileId : undefined),
      extraEnv: {
        ...(this.config.extraEnv ?? {}),
        // Make the task list available on every model, so Claude can track multi-step work
        // and the app can show it as the task's subtasks
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      },
    });

    // Host path of the config dir (the transcript is copied with Windows file APIs, also in WSL)
    const configDir = engine === 'codex'
      ? env.CODEX_HOME || defaultCodexHome()
      : env.CLAUDE_CONFIG_DIR ? toHostPath(env.CLAUDE_CONFIG_DIR) : defaultClaudeConfigDir();
    if (params.resume && this.info.configDir && this.info.configDir !== configDir) {
      if (engine === 'codex') {
        copyCodexRollout(params.sessionId, this.info.configDir, configDir);
      } else {
        copySessionTranscript(params.sessionId, this.info.configDir, configDir);
      }
    }
    if (this.info.profileId !== profileId || this.info.configDir !== configDir) {
      this.info.profileId = profileId;
      this.info.configDir = configDir;
      this.saveInfo();
    }
    const specDirRelative = (getWslInfo() ? path.posix : path).join('.workbench', DATA_DIR_NAMES.tasks, this.config.specId);
    // Read at every phase, so a resumed session learns what the other tasks changed meanwhile
    const parallelTasksPrompt = this.config.changelogPath
      ? await buildParallelTasksPrompt(this.config.changelogPath, this.config.specId, path.dirname(this.config.specDir), toRuntimePath(this.config.changelogPath))
      : undefined;
    // Second opinions from the other engine (Settings > Agents), when it can run
    const otherEngine: EngineKind = engine === 'codex' ? 'claude' : 'codex';
    let secondOpinionCostUsd = 0;
    const ask = settings.crossEngineAsk !== false && await engineCanRun(otherEngine)
      ? secondOpinionTools(otherEngine, this.config.worktreePath, (cost) => { secondOpinionCostUsd += cost; }, this.abortController.signal)
      : null;
    const systemPrompt = buildSystemPrompt(this.config, specDirRelative, parallelTasksPrompt);
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', params.model,
      '--effort', params.effort,
      '--permission-prompts', 'none',
      '--append-system-prompt', ask ? `${systemPrompt}\n\n${secondOpinionPromptLine(otherEngine)}` : systemPrompt,
      '--name', `${this.config.specId}: ${this.info.triage?.title || this.config.title}`.slice(0, 120),
    ];
    if (params.name === 'plan') {
      args.push('--permission-mode', 'plan');
    } else if (this.config.isolated === false) {
      // Not isolated: a classifier reviews actions instead of skipping all checks
      args.push('--permission-mode', 'auto');
    } else {
      args.push('--dangerously-skip-permissions');
    }
    if (params.resume) {
      args.push('--resume', params.sessionId);
    } else {
      args.push('--session-id', params.sessionId);
    }
    if (params.jsonSchema) args.push('--json-schema', JSON.stringify(params.jsonSchema));
    if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    if (settings.fallbackModel?.trim()) args.push('--fallback-model', settings.fallbackModel.trim());
    const mcpConfig = buildMcpConfig(this.config.connectorIds, this.config.connectorSettings);
    // Codex has no task list in headless runs: Workbench serves TaskCreate/TaskUpdate for this phase
    const taskList = engine === 'codex' ? codexTaskListTools() : null;
    const taskListSession = taskList ? await openToolsSession(taskList.tools, taskList.call) : null;
    if (taskListSession) mcpConfig.mcpServers[CODEX_TASK_LIST_SERVER] = taskListSession.mcpServer;
    const askSession = ask ? await openToolsSession(ask.tools, ask.call) : null;
    if (askSession) {
      mcpConfig.mcpServers[SECOND_OPINION_SERVER] = askSession.mcpServer;
      // Plan mode asks before MCP tools; Codex's MCP tools need no rule
      if (engine !== 'codex') args.push('--allowedTools', `mcp__${SECOND_OPINION_SERVER}__*`);
    }
    if (Object.keys(mcpConfig.mcpServers).length > 0) args.push('--mcp-config', JSON.stringify(mcpConfig));

    this.rejectedRateLimitResetAt = undefined;
    let rateLimit: PhaseResult['rateLimit'];
    let authFailed = false;

    this.current = startClaudeProcess({
      command,
      engine,
      args,
      cwd: this.config.worktreePath,
      env,
      input: params.input,
      abortSignal: this.abortController.signal,
      onMessage: (message) => {
        const signal = this.handleMessage(message, params.logPhase);
        if (signal === 'rate_limit' && !rateLimit) rateLimit = { message: engine === 'codex' ? 'ChatGPT usage limit reached' : 'Claude usage limit reached' };
        if (signal === 'auth') authFailed = true;
      },
      onStderr: (chunk) => {
        const line = chunk.trim();
        if (line) this.emitLog(line);
      },
    });
    const outcome = await this.current.done;
    this.current = null;
    taskListSession?.close();
    askSession?.close();
    const asked = secondOpinionCostUsd > 0 ? { secondOpinionCostUsd } : {};

    if (this.stopped || outcome.aborted) return { stopped: true, ...asked };

    const result = outcome.result;
    if (result) {
      const limit = detectClaudeLimitMessage(result.result) ?? detectClaudeLimitMessage(result.errors?.join(' '));
      if (limit) {
        rateLimit = { message: limit.message, resetAt: this.resetAt(limit.resetText) };
      } else if (result.is_error && result.api_error_status === 429) {
        rateLimit = rateLimit ?? { message: result.result || 'Rate limited' };
      } else if (result.is_error && (result.api_error_status === 401 || result.api_error_status === 403)) {
        authFailed = true;
      }
    }
    if (rateLimit && !rateLimit.resetAt) rateLimit.resetAt = this.rejectedRateLimitResetAt;
    if (rateLimit) return { rateLimit, stopped: false, result, ...asked };
    if (authFailed) return { authFailed, stopped: false, result, ...asked };
    if (!result) {
      const error = outcome.stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${outcome.exitCode}`;
      return { stopped: false, error, ...asked };
    }
    return { result, stopped: false, ...asked };
  }

  /** Apply one stream message; returns a signal for rate-limit or auth problems */
  private handleMessage(message: ClaudeStreamMessage, logPhase: TaskLogPhase): 'rate_limit' | 'auth' | undefined {
    if (isInitMessage(message)) {
      this.info.init = {
        claudeCodeVersion: message.claude_code_version,
        model: message.model,
        permissionMode: message.permissionMode,
        cwd: message.cwd ? toHostPath(message.cwd) : message.cwd,
        tools: message.tools ?? [],
        agents: message.agents ?? [],
        skills: message.skills ?? [],
        slashCommands: message.slash_commands ?? [],
        mcpServers: message.mcp_servers ?? [],
        plugins: (message.plugins ?? []).map((p) => p.name),
      };
      if (message.session_id) this.info.sessionId = message.session_id;
      this.saveInfo();
      return undefined;
    }

    if (isAssistantMessage(message)) {
      if (message.error === 'rate_limit') return 'rate_limit';
      if (message.error === 'authentication_failed' || message.error === 'oauth_org_not_allowed') return 'auth';
      const inSubagent = message.parent_tool_use_id !== null;
      const subphase = inSubagent ? this.subagentLabels.get(message.parent_tool_use_id!) ?? 'Subagent' : undefined;
      for (const block of message.message.content) {
        if (block.type === 'text' && 'text' in block && block.text.trim()) {
          if (!inSubagent) {
            this.log.add(logPhase, 'text', block.text.trim());
            this.emitLog(block.text.trim());
          }
        } else if (block.type === 'tool_use' && 'name' in block) {
          this.onToolUse(block.id, block.name, block.input ?? {}, logPhase, inSubagent, subphase);
        }
      }
      return undefined;
    }

    if (isUserMessage(message) && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') this.onToolResult(block as ClaudeToolResultBlock, logPhase, message.parent_tool_use_id !== null);
      }
      return undefined;
    }

    if (isTaskStarted(message) && !message.ambient && message.task_type === 'local_agent') {
      if (!this.info.subagents.some((s) => s.id === (message.tool_use_id ?? message.task_id))) {
        this.info.subagents.push({
          id: message.tool_use_id ?? message.task_id,
          description: message.description,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        this.saveInfo();
      }
      return undefined;
    }

    if (isTaskNotification(message) && !message.ambient) {
      const sub = this.info.subagents.find((s) => s.id === message.task_id);
      if (sub) {
        sub.status = message.status;
        sub.endedAt = new Date().toISOString();
        this.saveInfo();
      }
      return undefined;
    }

    if (isRateLimitEvent(message) && message.rate_limit_info.status === 'rejected' && message.rate_limit_info.resetsAt) {
      this.rejectedRateLimitResetAt = new Date(message.rate_limit_info.resetsAt * 1000).toISOString();
      return undefined;
    }

    if (isApiRetry(message)) {
      this.emitLog(`API ${message.error}, retrying (${message.attempt}/${message.max_retries})`);
      return undefined;
    }

    if (isResultMessage(message) && message.session_id) {
      this.info.sessionId = message.session_id;
    }
    return undefined;
  }

  private onToolUse(id: string, name: string, input: Record<string, unknown>, logPhase: TaskLogPhase, inSubagent: boolean, subphase?: string): void {
    const summary = summarizeToolInput(name, input);
    this.log.add(logPhase, 'tool_start', `${name}${summary ? `: ${summary}` : ''}`, {
      tool_name: name,
      tool_input: summary,
      tool_use_id: id,
      ...(subphase ? { subphase } : {}),
    });
    this.reportEditedFile(name, input);
    if (inSubagent) return;
    this.toolNames.set(id, name);
    this.emitLog(`${name}${summary ? ` ${summary}` : ''}`);

    if (name === 'Agent' || name === 'Task') {
      const description = typeof input.description === 'string' ? input.description : 'Subagent';
      this.subagentLabels.set(id, `Subagent: ${description}`);
      if (!this.info.subagents.some((s) => s.id === id)) {
        this.info.subagents.push({
          id,
          description,
          type: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        this.saveInfo();
      }
    } else if (name === 'TaskCreate') {
      this.pendingTaskCreates.set(id, {
        id: String(this.subtasks.length + this.pendingTaskCreates.size + 1),
        title: typeof input.subject === 'string' ? input.subject : 'Step',
        description: typeof input.description === 'string' ? input.description : '',
        status: 'pending',
      });
    } else if (name === 'TaskUpdate') {
      const taskId = String(input.taskId ?? input.id ?? '');
      const subtask = this.subtasks.find((s) => s.id === taskId);
      if (subtask) {
        const status = String(input.status ?? '');
        if (status === 'deleted') {
          this.subtasks = this.subtasks.filter((s) => s !== subtask);
        } else if (status === 'in_progress' || status === 'completed' || status === 'pending') {
          subtask.status = status;
        }
        if (typeof input.subject === 'string') subtask.title = input.subject;
        this.emitSubtasks();
      }
    }
  }

  /** Report a file the session (or one of its subagents) is editing inside the worktree */
  private reportEditedFile(name: string, input: Record<string, unknown>): void {
    if (!FILE_EDIT_TOOLS.has(name)) return;
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== 'string' || !target) return;
    // In WSL the session reports Linux paths (/mnt/c/...); compare them as host paths
    const hostTarget = toHostPath(target);
    const relative = path.relative(this.config.worktreePath, path.resolve(this.config.worktreePath, hostTarget));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    this.callbacks.onFilesEdited?.([relative.split(path.sep).join('/')]);
  }

  private onToolResult(block: ClaudeToolResultBlock, logPhase: TaskLogPhase, inSubagent: boolean): void {
    const text = typeof block.content === 'string'
      ? block.content
      : (block.content ?? []).map((c) => c.text ?? '').join('\n');
    const name = this.toolNames.get(block.tool_use_id);
    if (inSubagent || !name) return;
    this.log.add(logPhase, 'tool_end', `${name} ${block.is_error ? 'failed' : 'done'}`, {
      tool_name: name,
      tool_use_id: block.tool_use_id,
      detail: text || undefined,
      collapsed: true,
    });

    if (name === 'Agent' || name === 'Task') {
      const sub = this.info.subagents.find((s) => s.id === block.tool_use_id);
      if (sub && sub.status === 'running' && !/running in the background|launched/i.test(text)) {
        sub.status = block.is_error ? 'failed' : 'completed';
        sub.endedAt = new Date().toISOString();
        this.saveInfo();
      }
    } else if (name === 'TaskCreate') {
      const pending = this.pendingTaskCreates.get(block.tool_use_id);
      this.pendingTaskCreates.delete(block.tool_use_id);
      if (pending && !block.is_error) {
        const idMatch = text.match(/#\s*(\d+)/) ?? text.match(/\b(?:id|task)\D{0,3}(\d+)/i);
        if (idMatch) pending.id = idMatch[1];
        this.subtasks.push(pending);
        this.emitSubtasks();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private hasCompleted(name: ClaudeRunPhaseName): boolean {
    return this.info.phases.some((p) => p.name === name && p.endedAt && !p.isError);
  }

  private beginPhase(name: ClaudeRunPhaseName, fields: Partial<ClaudeRunPhase>): ClaudeRunPhase {
    const phase: ClaudeRunPhase = { name, startedAt: new Date().toISOString(), ...fields };
    this.info.phases.push(phase);
    this.saveInfo();
    return phase;
  }

  private endPhase(phase: ClaudeRunPhase, fields: Partial<ClaudeRunPhase>, result?: ClaudeResultMessage): void {
    let costUsd = phase.costUsd;
    const asked = phase.secondOpinionCostUsd ?? 0;
    if (result?.total_cost_usd !== undefined && result.cost_scope === 'run') {
      costUsd = result.total_cost_usd + asked;
    } else if (result?.total_cost_usd !== undefined) {
      // A resumed session reports its cumulative cost: this phase's share is the difference
      // (second opinions are billed apart from the session)
      const earlier = this.info.phases
        .filter((p) => p !== phase && p.name !== 'triage' && p.sessionId === (result.session_id ?? phase.sessionId))
        .reduce((sum, p) => sum + (p.costUsd ?? 0) - (p.secondOpinionCostUsd ?? 0), 0);
      costUsd = Math.max(result.total_cost_usd - earlier, 0) + asked;
    }
    Object.assign(phase, {
      endedAt: new Date().toISOString(),
      ...(result ? {
        costUsd,
        durationMs: result.duration_ms,
        numTurns: result.num_turns,
        sessionId: result.session_id ?? phase.sessionId,
      } : asked ? { costUsd: (costUsd ?? 0) + asked } : {}),
    }, fields);
    this.updateTotalCost();
    this.saveInfo();
  }

  private updateTotalCost(): void {
    this.info.totalCostUsd = this.info.phases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);
  }

  private rateLimited(name: ClaudeRunPhaseName, phase: ClaudeRunPhase, limit: { message: string; resetAt?: string }): TaskRunOutcome {
    const error = `Usage limit reached: ${limit.message}`;
    this.endPhase(phase, { isError: true, error });
    this.emitLog(error);
    this.log.add(name === 'validate' ? 'validation' : name === 'implement' || name === 'revise' ? 'coding' : 'planning', 'error', error);
    this.callbacks.onTaskEvent?.('RATE_LIMIT_HOLD', {
      resetAt: limit.resetAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      message: limit.message,
      phase: name === 'validate' ? 'qa_review' : name === 'plan' || name === 'triage' ? 'planning' : 'coding',
    });
    return { status: 'rate_limited', rateLimit: limit, error };
  }

  private failEvent(name: ClaudeRunPhaseName, error: string): void {
    if (name === 'plan' || name === 'triage') {
      this.callbacks.onTaskEvent?.('PLANNING_FAILED', { error, recoverable: true });
    } else if (name === 'validate') {
      this.callbacks.onTaskEvent?.('QA_AGENT_ERROR', { iteration: 1, consecutiveErrors: 1, error });
    } else {
      this.callbacks.onTaskEvent?.('CODING_FAILED', { subtaskId: '', error, attemptCount: 1 });
    }
  }

  private resetAt(resetText: string | null): string | undefined {
    if (!resetText) return undefined;
    return parseLimitResetTime(resetText)?.toISOString();
  }

  /** Commit changes Claude left uncommitted, so the review shows the full result */
  private async commitLeftovers(): Promise<void> {
    const cwd = this.config.worktreePath;
    try {
      const { stdout } = await git(['status', '--porcelain', '--', '.', ':(exclude).workbench'], { cwd });
      if (!stdout.trim()) return;
      await git(['add', '-A', '--', '.', ':(exclude).workbench'], { cwd });
      const title = this.info.triage?.title || this.config.title;
      await git(['commit', '-m', title, '--no-verify'], { cwd });
      this.emitLog('Committed remaining changes');
    } catch (error) {
      this.emitLog(`Could not commit remaining changes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitLog(line: string): void {
    this.callbacks.onLog?.(line);
  }

  private emitProgress(phase: ExecutionPhase, overall: number, message: string): void {
    this.callbacks.onProgress?.({
      phase,
      phaseProgress: 0,
      overallProgress: Math.round(overall * 100),
      message,
    });
  }

  private emitSubtasks(): void {
    this.callbacks.onSubtasks?.(this.subtasks.map((s) => ({ ...s })));
    const active = this.subtasks.find((s) => s.status === 'in_progress');
    if (active) {
      const done = this.subtasks.filter((s) => s.status === 'completed').length;
      this.callbacks.onProgress?.({
        phase: 'coding',
        phaseProgress: Math.round((done / Math.max(this.subtasks.length, 1)) * 100),
        overallProgress: 20 + Math.round((done / Math.max(this.subtasks.length, 1)) * 60),
        message: active.title,
        currentSubtask: active.id,
      });
    }
  }

  private saveInfo(): void {
    this.info.updatedAt = new Date().toISOString();
    this.callbacks.onRunInfo?.(structuredClone(this.info));
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flushInfo(), 300);
  }

  private flushInfo(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeFileSafe(this.runFile, JSON.stringify(this.info, null, 2));
  }
}

// =============================================================================
// Persistence helpers
// =============================================================================

/** Where Claude Code runs now */
function currentRuntime(): ClaudeRuntime {
  return getWslInfo() ? 'wsl' : 'native';
}

/** Claude Code's default config dir (`~/.claude`) as a host path: the Linux home's in WSL */
function defaultClaudeConfigDir(): string {
  const wsl = getWslInfo();
  return wsl ? toHostPath(path.posix.join(wsl.home, '.claude')) : path.join(os.homedir(), '.claude');
}

/**
 * Copy a session transcript (`<configDir>/projects/<project>/<sessionId>.jsonl`) to another
 * Claude config dir, so the session can be resumed on a different profile
 */
function copySessionTranscript(sessionId: string, fromConfigDir: string, toConfigDir: string): void {
  try {
    const projectsDir = path.join(fromConfigDir, 'projects');
    for (const project of readdirSync(projectsDir)) {
      const source = path.join(projectsDir, project, `${sessionId}.jsonl`);
      if (!existsSync(source)) continue;
      const targetDir = path.join(toConfigDir, 'projects', project);
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(source, path.join(targetDir, `${sessionId}.jsonl`));
      return;
    }
  } catch (error) {
    console.warn('[ClaudeTaskRun] Could not copy the session transcript to the new profile:', error);
  }
}

/** Copy a Codex thread's session file to another account's CODEX_HOME, so the thread resumes there */
function copyCodexRollout(threadId: string, fromHome: string, toHome: string): void {
  try {
    const source = findCodexRollout(fromHome, threadId);
    if (!source) return;
    const target = path.join(toHome, path.relative(fromHome, source));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  } catch (error) {
    console.warn('[ClaudeTaskRun] Could not copy the Codex session to the new account:', error);
  }
}

function writeFileSafe(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, file);
  } catch (error) {
    console.error('[ClaudeTaskRun] Failed to write', file, error);
  }
}

/** Read a task's run state (`claude_run.json`), or null when the task never ran */
export function loadClaudeRunInfo(specDir: string): ClaudeRunInfo | null {
  const file = path.join(specDir, CLAUDE_RUN_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ClaudeRunInfo;
    if (parsed?.version !== 1 || !Array.isArray(parsed.phases)) return null;
    parsed.subagents = parsed.subagents ?? [];
    parsed.totalCostUsd = parsed.totalCostUsd ?? 0;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether a run went all the way through: its last step is a finished validation, or a finished
 * implementation/revision when validation is off. Starting such a task again begins a new run.
 */
export function isClaudeRunFinished(info: ClaudeRunInfo | null, validation: boolean): boolean {
  const last = info?.phases.at(-1);
  if (!last?.endedAt || last.isError) return false;
  if (last.name === 'validate') return true;
  return !validation && (last.name === 'implement' || last.name === 'revise');
}

/** Forget a task's run state so the next start triages and runs from scratch */
export function resetClaudeRunInfo(specDir: string): void {
  writeFileSafe(path.join(specDir, CLAUDE_RUN_FILE), JSON.stringify({
    version: 1,
    phases: [],
    subagents: [],
    totalCostUsd: 0,
    updatedAt: new Date().toISOString(),
  } satisfies ClaudeRunInfo, null, 2));
}

function normalizeValidation(structured: unknown, fallbackText?: string): ValidationReport {
  const raw = (structured ?? {}) as Partial<ValidationReport>;
  const status = raw.status === 'passed' || raw.status === 'failed' || raw.status === 'partial' ? raw.status : 'partial';
  return {
    status,
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : (fallbackText ?? ''),
    checks: Array.isArray(raw.checks) ? raw.checks.filter((c) => c && typeof c.name === 'string') : [],
    findings: Array.isArray(raw.findings) ? raw.findings.filter((f) => f && typeof f.description === 'string') : [],
  };
}
