/**
 * The project index: the project's CLAUDE.md, written by Claude Code's own `/init`.
 *
 * Every agent session in a project reads its CLAUDE.md before anything else, so that file is what
 * the project is indexed as for the agents. Writing it by hand is work the agent can do better:
 * a short triage run with `/init` reads the codebase and writes what a session needs to know.
 * It is re-runnable, which is how a project folds in what changed since the last one.
 */

import { readFile, rm, stat } from 'fs/promises';
import path from 'path';
import type { ProjectIndexInfo } from '../shared/types/cli';
import type { AppSettings } from '../shared/types/settings';
import { appLog } from './app-logger';
import { READ_ONLY_TOOLS, runClaudeText } from './claude-code/run-text';
import { resolveClaudeCodeTaskSettings } from './claude-code/settings';
import { readSettingsFile } from './settings-utils';

/** What `/init` writes, and what every session in the project reads */
const CLAUDE_MD = 'CLAUDE.md';

/** Enough reasoning to tell what a session needs to know from what it can read for itself */
const EFFORT = 'medium';
/** Reading a codebase takes a while; a run that is still going after this is stuck */
const TIMEOUT_MS = 10 * 60 * 1000;

/** One build per project at a time; a second request joins the first */
const inFlight = new Map<string, Promise<ProjectIndexInfo>>();

const claudeMdPath = (projectPath: string) => path.join(projectPath, CLAUDE_MD);

/** Stats of the project's CLAUDE.md, or null when it has none */
export async function readProjectIndexInfo(projectPath: string): Promise<ProjectIndexInfo | null> {
  const file = claudeMdPath(projectPath);
  try {
    const stats = await stat(file);
    if (!stats.isFile()) return null;
    const content = await readFile(file, 'utf-8');
    // The file is the truth about when it was written: it is as often edited by hand as rebuilt
    return { lines: content.split('\n').length, builtAt: stats.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Whether a build is running for the project */
export function isProjectIndexBuilding(projectPath: string): boolean {
  return inFlight.has(path.resolve(projectPath));
}

async function run(projectPath: string, profileId?: string): Promise<ProjectIndexInfo> {
  const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
  const { triageModel } = resolveClaudeCodeTaskSettings(settings.claudeCodeTasks);

  await runClaudeText({
    step: 'helpers',
    prompt: `/init`,
    model: triageModel,
    effort: EFFORT,
    cwd: projectPath,
    // `/init` is a command, so the prompt has to keep its slash
    slashCommands: true,
    tools: [...READ_ONLY_TOOLS, 'Write', 'Edit', 'Bash'],
    // It reads the project and writes the one file; the git reads are how it sees the conventions
    allowedTools: ['Write', 'Edit', 'Bash(git ls-files *)', 'Bash(git log *)'],
    maxTurns: 40,
    timeoutMs: TIMEOUT_MS,
    profileId,
  });

  const info = await readProjectIndexInfo(projectPath);
  if (!info) throw new Error(`The run finished without writing ${CLAUDE_MD}`);
  appLog.info(`[ProjectIndex] Wrote ${CLAUDE_MD} for ${projectPath}: ${info.lines} line(s)`);
  return info;
}

/**
 * Switch the project index off: remove the project's CLAUDE.md, stopping a build that is writing
 * it first. The file is the switch, so leaving it behind would switch itself back on.
 */
export async function deleteProjectIndex(projectPath: string): Promise<void> {
  await inFlight.get(path.resolve(projectPath))?.catch(() => undefined);
  await rm(claudeMdPath(projectPath), { force: true });
  appLog.info(`[ProjectIndex] Removed ${CLAUDE_MD} from ${projectPath}`);
}

/**
 * Build (or rebuild) the project's CLAUDE.md with `/init`. Concurrent callers join the build
 * already running rather than starting a second one.
 */
export function buildProjectIndex(projectPath: string, profileId?: string): Promise<ProjectIndexInfo> {
  const key = path.resolve(projectPath);
  const running = inFlight.get(key);
  if (running) return running;

  const build = run(projectPath, profileId).finally(() => inFlight.delete(key));
  inFlight.set(key, build);
  return build;
}
