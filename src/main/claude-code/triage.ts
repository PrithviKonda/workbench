/**
 * Task triage
 * ===========
 *
 * Before a task runs, a short read-only Claude Code run looks at the task description and the
 * project and decides which model and effort fit, and whether the task should be planned first.
 * The rules follow Claude Code's own guidance:
 *
 * - Model and effort: https://code.claude.com/docs/en/model-config ("Guidance by task",
 *   "Choosing a level")
 * - Planning: https://code.claude.com/docs/en/best-practices ("Explore first, then plan, then
 *   code": plan when the approach is uncertain, the change spans multiple files or the code is
 *   unfamiliar; "if you could describe the diff in one sentence, skip the plan")
 */

import { readFileSync } from 'fs';
import path from 'path';
import { runClaudeText, READ_ONLY_TOOLS } from './run-text';
import type {
  ClaudeCodeTaskSettings,
  ClaudeEffort,
  ClaudeModelAlias,
  TaskScope,
  TaskTriage,
} from '../../shared/types/claude-code';
import { CLAUDE_EFFORTS } from '../../shared/types/claude-code';

const TRIAGE_SYSTEM_PROMPT = `You triage coding tasks for an autonomous Claude Code run. You do NOT do the task.
Look at the task and, briefly, at the project (structure, the files the task names, how it is tested), then decide how the task should run.

## Model
- haiku: simple, fast, well-scoped work with no ambiguity: renames, copy or text changes, config tweaks, following an existing pattern in one place. Never for bugs whose cause is unknown, and never when the task includes pasted logs, stack traces or large code.
- sonnet: day-to-day coding with a clear scope: a feature inside existing patterns, a bug with a known location, tests for existing code.
- opus: complex reasoning: changes across many modules, unclear root causes, concurrency, security, data migrations, performance work, anything where a wrong approach is expensive.
- fable: only for the hardest, longest-running or most ambiguous work (deep root-cause investigations, architecture changes, outage debugging). Only choose it when it is listed as allowed.

## Effort
- low: quick, mechanical changes a reviewer will check closely.
- medium: clear-scope day-to-day engineering (the default for most tasks).
- high: verification matters or edge cases are likely, such as bug fixes in existing code.
- xhigh: hard reasoning problems where depth clearly pays off.
- max: rarely; only very hard problems that need long autonomous work.
Prefer lowering effort over choosing a smaller model when a task is borderline.

## Planning
needsPlan is true when the approach is uncertain, the change touches several files or components, or the relevant code is unfamiliar and must be explored first.
needsPlan is false when the scope is clear and the change is small: if you can describe the diff in one sentence, skip the plan.

## Scope
trivial (one-line or text change), small (one file or a few lines), medium (a few files in one area), large (many files or areas, or new subsystems).

## Verification
List the concrete commands or checks that can verify this change in this project (for example the test command for the affected package, the type checker, the linter, the build). Only list commands you found evidence for in the project (package.json scripts, Makefile, pyproject, CI config). Use an empty list when there is nothing to run.

## Title
A short title for the task in sentence case, at most 8 words, no trailing period.

Spend at most a few tool calls exploring. Answer with the structured output only.`;

function buildSchema(allowedModels: readonly ClaudeModelAlias[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      model: { type: 'string', enum: [...allowedModels] },
      effort: { type: 'string', enum: [...CLAUDE_EFFORTS] },
      needsPlan: { type: 'boolean' },
      scope: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
      title: { type: 'string' },
      reasoning: { type: 'string', description: 'One or two sentences on why this model, effort and planning decision fit' },
      verification: { type: 'array', items: { type: 'string' } },
    },
    required: ['model', 'effort', 'needsPlan', 'scope', 'title', 'reasoning', 'verification'],
  };
}

export interface TriageInput {
  description: string;
  /** Project (or worktree) directory the triage run may read */
  cwd: string;
  /** Names of the files attached to the task, so triage knows about that context */
  attachmentNames?: string[];
  settings: ClaudeCodeTaskSettings;
  abortSignal?: AbortSignal;
  profileId?: string;
}

/** Decision used when triage is off or fails */
export function fixedTriage(settings: ClaudeCodeTaskSettings, title: string, source: 'fixed' | 'fallback', reasoning: string): TaskTriage {
  return {
    model: settings.fixedModel,
    effort: settings.fixedEffort,
    needsPlan: settings.planning === 'always',
    scope: 'medium',
    title,
    reasoning,
    verification: [],
    source,
  };
}

/** Apply the planning policy from settings to a triage decision */
export function applyPlanningPolicy(triage: TaskTriage, settings: ClaudeCodeTaskSettings): TaskTriage {
  if (settings.planning === 'always') return { ...triage, needsPlan: true };
  if (settings.planning === 'never') return { ...triage, needsPlan: false };
  return triage;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

/** The scripts a project's package.json defines, or null when there is no readable one */
function packageScripts(cwd: string): Set<string> | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return new Set(parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : []);
  } catch {
    return null;
  }
}

/**
 * Drop `npm run <script>` commands the project doesn't define. Triage is told to list only
 * commands it found evidence for, but it does sometimes name a conventional script that isn't
 * there (`npm run typecheck`); the run then treats that command as a check and can report it
 * as passing although it only ever printed "Missing script".
 */
function keepRunnableChecks(verification: string[], cwd: string): string[] {
  const scripts = packageScripts(cwd);
  if (!scripts) return verification;
  return verification.filter((command) => {
    const script = /^\s*(?:npm|yarn|pnpm|bun)\s+run\s+([\w:.-]+)/.exec(command)?.[1];
    return !script || scripts.has(script);
  });
}

/** Assess a task and pick model, effort and planning */
export async function triageTask(input: TriageInput): Promise<{ triage: TaskTriage; costUsd?: number }> {
  const { settings } = input;
  const allowedModels: ClaudeModelAlias[] = settings.allowFable
    ? ['haiku', 'sonnet', 'opus', 'fable']
    : ['haiku', 'sonnet', 'opus'];

  const attachments = input.attachmentNames?.length
    ? `\n\nThe task has ${input.attachmentNames.length} attached file(s): ${input.attachmentNames.join(', ')}.`
    : '';
  const prompt = `Allowed models: ${allowedModels.join(', ')}.\n\n<task>\n${input.description}\n</task>${attachments}`;

  const result = await runClaudeText({
    step: 'triage',
    prompt,
    appendSystemPrompt: TRIAGE_SYSTEM_PROMPT,
    model: settings.triageModel,
    effort: 'low',
    jsonSchema: buildSchema(allowedModels),
    cwd: input.cwd,
    tools: READ_ONLY_TOOLS,
    maxTurns: 12,
    timeoutMs: 3 * 60 * 1000,
    abortSignal: input.abortSignal,
    profileId: input.profileId,
  });

  const raw = (result.structured ?? {}) as Record<string, unknown>;
  const model = isOneOf(raw.model, allowedModels) ? raw.model : settings.fixedModel;
  const effort: ClaudeEffort = isOneOf(raw.effort, CLAUDE_EFFORTS) ? raw.effort : settings.fixedEffort;
  const scope: TaskScope = isOneOf(raw.scope, ['trivial', 'small', 'medium', 'large'] as const) ? raw.scope : 'medium';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().replace(/\.$/, '') : '';
  const verification = keepRunnableChecks(
    Array.isArray(raw.verification)
      ? raw.verification.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [],
    input.cwd,
  );

  const triage = applyPlanningPolicy({
    model,
    effort,
    needsPlan: raw.needsPlan === true,
    scope,
    title,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    verification,
    source: 'auto',
  }, settings);
  return { triage, costUsd: result.costUsd };
}
