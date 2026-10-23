/**
 * Project metrics
 *
 * Spending per project for Settings > Accounts: the sum of every task's Claude Code run cost
 * (`totalCostUsd` in `<specDir>/claude_run.json`) in projects whose `.workbench` directory is
 * initialized. A task that was started over has also spent what its earlier runs cost, so the
 * runs kept under `previous_runs/` count too. Each run's steps carry their own cost and start
 * time, which also gives the project's spending per calendar day for the usage chart.
 *
 * Claude Code is also used on a project without running a task - an agent window, Insights, or
 * `claude` in a terminal - and that spends on the same account. Those sessions are found by the
 * directory they ran in (`claude-code/project-sessions.ts`), together with the ones a window
 * recorded itself (`agent-session-store.ts`), and what each cost per day is read from Claude Code's
 * own transcripts (`claude-code/session-spending.ts`). The sessions a task owns are left to the
 * task's own figures, so nothing is counted twice.
 *
 * A session is read once: what it had spent is kept with it and read again only when its
 * transcript has changed, so a refresh only reads what is new. All file access is async so the
 * main process stays responsive.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { getSpecsDir } from '../shared/constants';
import { appLog } from './app-logger';
import { CLAUDE_RUN_FILE } from './claude-code/task-runner';
import { PREVIOUS_RUNS_DIR } from './task-run-archive';
import {
  cacheAgentSessionSpending,
  readAgentSessions,
  recordFoundSessions,
  type AgentSessionRecord,
  type AgentSessionSpending,
} from './agent-session-store';
import { findProjectSessions } from './claude-code/project-sessions';
import {
  dayOf,
  findSessionTranscript,
  readTranscriptSpending,
  spentUsd,
  type SessionSpending,
  type TranscriptFile,
} from './claude-code/session-spending';
import { claudeConfigDirs } from './claude-profile/profile-config-dirs';
import { findCodexProjectSessions, readCodexRolloutSpending } from './claude-profile/codex-accounts';
import type { ClaudeRunInfo } from '../shared/types/claude-code';
import type { Project, ProjectCostMetrics, ProjectDailyCost } from '../shared/types';

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The run's state, or null when it never ran or its run file is unreadable */
async function readRun(runFile: string): Promise<Partial<ClaudeRunInfo> | null> {
  try {
    return JSON.parse(await fsp.readFile(runFile, 'utf-8')) as Partial<ClaudeRunInfo>;
  } catch {
    return null;
  }
}

function addSpending(byDay: Map<string, number>, day: string, costUsd: number): void {
  byDay.set(day, (byDay.get(day) ?? 0) + costUsd);
}

/**
 * Books one run's cost on the days it was spent: every step on the day it started, and anything
 * the total holds beyond the steps (older runs whose steps carry no cost) on the day the run was
 * last written. Returns what the run cost in total.
 */
function bookRunSpending(run: Partial<ClaudeRunInfo>, byDay: Map<string, number>): number {
  const total = spentUsd(run.totalCostUsd);
  const lastWritten = dayOf(run.updatedAt);
  let booked = 0;

  for (const phase of Array.isArray(run.phases) ? run.phases : []) {
    const costUsd = spentUsd(phase?.costUsd);
    const day = dayOf(phase?.startedAt) ?? lastWritten;
    if (!costUsd || !day) continue;
    addSpending(byDay, day, costUsd);
    booked += costUsd;
  }

  const rest = total - booked;
  if (rest > 0 && lastWritten) addSpending(byDay, lastWritten, rest);
  return total;
}

/** Run files of the runs a task was started over from */
async function previousRunFiles(specDir: string): Promise<string[]> {
  const archive = path.join(specDir, PREVIOUS_RUNS_DIR);
  try {
    const entries = await fsp.readdir(archive, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(archive, entry.name, CLAUDE_RUN_FILE));
  } catch {
    // Never started over
    return [];
  }
}

/** What one task has cost: its current run plus every run it was started over from */
async function readTaskRuns(specDir: string): Promise<Array<Partial<ClaudeRunInfo> | null>> {
  const runFiles = [path.join(specDir, CLAUDE_RUN_FILE), ...(await previousRunFiles(specDir))];
  return Promise.all(runFiles.map(readRun));
}

/** The Claude Code sessions a task's runs own, whose cost the run figures already carry */
function taskSessionIds(runs: Array<Partial<ClaudeRunInfo> | null>): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (!run) continue;
    if (run.sessionId) ids.add(run.sessionId);
    for (const phase of Array.isArray(run.phases) ? run.phases : []) {
      if (phase?.sessionId) ids.add(phase.sessionId);
    }
  }
  return ids;
}

/** What a reading of a session's transcript, or the reading kept from last time, says it spent */
function cachedSpending(cached: AgentSessionSpending | undefined): SessionSpending {
  if (!cached) return { totalCostUsd: 0, byDay: new Map() };
  return { totalCostUsd: spentUsd(cached.totalCostUsd), byDay: new Map(Object.entries(cached.days ?? {})) };
}

/** Whether what was read from this transcript last time still describes the file on disk */
function isCurrent(cached: AgentSessionSpending | undefined, transcript: TranscriptFile): boolean {
  return (
    !!cached &&
    cached.transcript === transcript.file &&
    cached.size === transcript.size &&
    cached.modifiedMs === transcript.modifiedMs
  );
}

/** A session to count, with the transcript it is read from when there still is one */
interface CountableSession {
  session: AgentSessionRecord;
  transcript: TranscriptFile | null;
}

/**
 * The project's Claude Code sessions: the ones its windows recorded, plus every other session that
 * ran in the project and is not a task's. Sessions found for the first time are written to the
 * project's store, so the next refresh reads only the transcripts that changed.
 */
async function countableSessions(project: Project, taskSessions: Set<string>): Promise<CountableSession[]> {
  const recorded = await readAgentSessions(project.path);
  // A session started on one account can end up under another's config dir after a swap
  const configDirs = claudeConfigDirs(recorded.map((session) => session.configDir));
  const countable: CountableSession[] = [];
  const skipUnder = [path.join(project.path, project.autoBuildPath || '.workbench', 'worktrees')];
  // Codex threads (agent windows, the ChatGPT page, `codex` in a terminal) keep rollout files instead
  const codex = await findCodexProjectSessions(project.path, { skip: taskSessions, skipUnder });
  const codexById = new Map(codex.map((session) => [session.sessionId, session]));

  for (const session of recorded) {
    // A window that continued a task's session: the task's own figures already carry its cost
    if (taskSessions.has(session.sessionId)) continue;
    countable.push({
      session,
      transcript:
        codexById.get(session.sessionId) ?? (await findSessionTranscript(session.sessionId, configDirs, session.cwd)),
    });
  }

  const recordedIds = new Set(recorded.map((session) => session.sessionId));
  const found = [
    ...(await findProjectSessions(project.path, configDirs, {
      skip: new Set([...taskSessions, ...recordedIds]),
      skipUnder,
    })),
    ...codex.filter((session) => !recordedIds.has(session.sessionId)),
  ];
  // Nothing records when a session Workbench did not start began; its last write is all there is
  const records = found.map((session) => ({
    sessionId: session.sessionId,
    configDir: session.configDir,
    cwd: session.cwd,
    startedAt: new Date(session.modifiedMs).toISOString(),
  }));
  countable.push(...records.map((session, index) => ({ session, transcript: found[index] })));
  await recordFoundSessions(project.path, records);

  return countable;
}

/**
 * Books what the project's Claude Code sessions spent on the days they spent it, from their
 * transcripts. Returns their total.
 *
 * The transcripts are read one at a time (a project can hold hundreds of sessions and a transcript
 * can be large), and a session whose transcript has not changed since the last refresh is not read
 * again - what it spent is kept with the session.
 */
async function bookSessionSpending(project: Project, taskSessions: Set<string>, byDay: Map<string, number>): Promise<number> {
  const sessions = await countableSessions(project, taskSessions);
  if (sessions.length === 0) return 0;

  const read = new Map<string, AgentSessionSpending>();
  let total = 0;

  for (const { session, transcript } of sessions) {
    let spending: SessionSpending;
    if (!transcript || isCurrent(session.spent, transcript)) {
      // Unchanged, or gone: what was read from it last time is what the session spent
      spending = cachedSpending(session.spent);
    } else {
      spending = path.basename(transcript.file).startsWith('rollout-')
        ? await readCodexRolloutSpending(transcript.file)
        : await readTranscriptSpending(transcript.file);
      read.set(session.sessionId, {
        totalCostUsd: spending.totalCostUsd,
        days: Object.fromEntries(spending.byDay),
        transcript: transcript.file,
        size: transcript.size,
        modifiedMs: transcript.modifiedMs,
      });
    }
    total += spending.totalCostUsd;
    for (const [day, costUsd] of spending.byDay) addSpending(byDay, day, costUsd);
  }

  await cacheAgentSessionSpending(project.path, read);
  return total;
}

/** Projects whose sessions have been read once since the app started */
const warmed = new Set<string>();

/**
 * Reads a project's sessions once when it is opened, so Metrics is up to date the first time it is
 * looked at rather than reading hundreds of megabytes of transcripts while the user waits. The
 * readings are kept with the sessions, so this runs in the background and only ever does the work
 * once per project; afterwards a refresh reads only what changed. `onWarm` is called when a
 * project's spending has been read, so a Metrics page that is open shows it.
 */
export function warmProjectMetrics(projects: Project[], onWarm: () => void): void {
  const pending = projects.filter((project) => !warmed.has(project.path));
  if (pending.length === 0) return;
  for (const project of pending) warmed.add(project.path);

  void (async () => {
    for (const project of pending) {
      try {
        await getProjectCostMetrics([project]);
        onWarm();
      } catch (error) {
        // Reading again is harmless, so a project that failed may be read on the next refresh
        warmed.delete(project.path);
        appLog.warn(`[ProjectMetrics] Could not read the sessions of ${project.path}:`, error);
      }
    }
  })();
}

/** Spending per day, oldest first; days without spending are left out */
function toDailyCosts(byDay: Map<string, number>): ProjectDailyCost[] {
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, costUsd]) => ({ date, costUsd }));
}

/** Task count, total run cost and spending per day of each initialized project */
export async function getProjectCostMetrics(projects: Project[]): Promise<ProjectCostMetrics[]> {
  const results = await Promise.all(
    projects.map(async (project): Promise<ProjectCostMetrics | null> => {
      const workbenchDir = path.join(project.path, project.autoBuildPath || '.workbench');
      if (!(await isDirectory(workbenchDir))) return null;

      const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
      let specDirs: string[] = [];
      try {
        const entries = await fsp.readdir(specsDir, { withFileTypes: true });
        specDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(specsDir, entry.name));
      } catch {
        // No specs yet
      }

      const runs = (await Promise.all(specDirs.map(readTaskRuns))).flat();
      const byDay = new Map<string, number>();
      const taskCostUsd = runs.reduce((sum, run) => (run ? sum + bookRunSpending(run, byDay) : sum), 0);
      const totalCostUsd = taskCostUsd + (await bookSessionSpending(project, taskSessionIds(runs), byDay));

      return {
        projectId: project.id,
        name: project.name,
        path: project.path,
        taskCount: specDirs.length,
        totalCostUsd,
        daily: toDailyCosts(byDay),
      };
    })
  );
  return results.filter((metrics): metrics is ProjectCostMetrics => metrics !== null);
}
