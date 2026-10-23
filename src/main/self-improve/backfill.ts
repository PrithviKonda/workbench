/**
 * The memory index: the project's first set of memories, built from the sessions it already had.
 *
 * Switching self-improve on only changes what later sessions do, so a project that has been worked
 * on for weeks would start empty while every preference the user already stated sits in transcripts
 * nobody reads. This pass reads those transcripts once and writes what they taught, as if the feature
 * had been on all along. It is also re-runnable by hand, which is how a user folds in sessions that
 * happened while the switch was off.
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { SelfImproveIndexInfo } from '../../shared/types/cli';
import { appLog } from '../app-logger';
import { runClaudeText } from '../claude-code/run-text';
import { getCompengDir } from './paths';
import { countMemories, MAX_MEMORIES, writeMemories, type MemoryDraft } from './memory-writer';
import { findProjectTranscripts, readUserTurns } from './transcripts';

/** Stats of the last build, beside the memories themselves */
const INDEX_INFO_FILE = 'index.json';

/** Bounds on one build, so the pass stays cheap however long the project has been worked on */
const MAX_SESSIONS = 40;
const MAX_CHARS_PER_SESSION = 12_000;
const MAX_CHARS_TOTAL = 120_000;

/** The model this runs on: the judgment is narrow and the input is long, so it runs cheap */
const MODEL = 'haiku';
/** Enough reasoning to tell a durable preference from a one-off instruction, and no more */
const EFFORT = 'medium';

/** One build per project at a time; a second request joins the first */
const inFlight = new Map<string, Promise<SelfImproveIndexInfo>>();

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['memories'],
  properties: {
    memories: {
      type: 'array',
      maxItems: MAX_MEMORIES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'title', 'description', 'type', 'body'],
        properties: {
          name: { type: 'string', description: 'kebab-case slug, no extension' },
          title: { type: 'string', description: 'Short title for the index line' },
          description: { type: 'string', description: 'One line stating the rule, used for recall' },
          type: { type: 'string', enum: ['feedback', 'project', 'user', 'reference'] },
          body: {
            type: 'string',
            description: 'The rule as an imperative, then a **Why:** line and a **How to apply:** line',
          },
        },
      },
    },
  },
} as const;

function buildPrompt(sessions: { turns: string[] }[], existing: string[]): string {
  const transcript = sessions
    .map((session, index) => `<session n="${index + 1}">\n${session.turns.join('\n---\n')}\n</session>`)
    .join('\n\n');

  return `You are building the first set of project memories for a codebase, from what the user said in past Claude Code sessions. Only their own turns are shown, oldest first within each session, newest session first.

Find the durable preferences, rules and conventions the user stated: the things a future session would otherwise get wrong again. Write each one as a memory.

Rules:
- A memory earns its place only when losing it would plausibly make a later session repeat a mistake or redo an investigation. Completion, effort and repetition on their own do not qualify.
- Skip anything a reader would get from the code, the tests, the types or CLAUDE.md. Skip anything that mattered only to one task: a specific bug, a file being edited, a one-off instruction.
- A correction the user had to give more than once is the strongest signal. A preference stated once but stated as a rule ("always", "never", "from now on") also qualifies.
- When two statements contradict, the later session wins; write only the later one.
- Write each memory as a general instruction in the words the user used. Never quote the conversation, never name a person, and never record secrets, credentials, paths to private data or anything that looks like a token.
- Prefer \`type: feedback\` for a preference or correction, \`project\` for a standing fact about how the project is worked on, \`user\` for how this person likes to work, \`reference\` for where information lives.
- At most ${MAX_MEMORIES} memories, and fewer is better. Return an empty list when nothing qualifies; that is a correct answer.
${existing.length > 0 ? `\nThese memories already exist, so do not restate them: ${existing.join(', ')}.\n` : ''}
${transcript}`;
}

/** Where the build's stats live */
const infoPath = (projectPath: string) => path.join(getCompengDir(projectPath), INDEX_INFO_FILE);

/** The last build's stats, or null when the project has never built one */
export async function readMemoryIndexInfo(projectPath: string): Promise<SelfImproveIndexInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(infoPath(projectPath), 'utf-8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const info = parsed as SelfImproveIndexInfo;
    // The index is the truth about how many memories there are; the file only records the build
    return { ...info, memories: await countMemories(projectPath) };
  } catch {
    return null;
  }
}

/** Whether a build is running for the project */
export function isMemoryIndexBuilding(projectPath: string): boolean {
  return inFlight.has(path.resolve(projectPath));
}

/**
 * Settle once no build is writing into the project's memory directory, so a caller that is about
 * to move those files does not race one. A failed build is not this caller's problem.
 */
export async function waitForMemoryIndexBuild(projectPath: string): Promise<void> {
  await inFlight.get(path.resolve(projectPath))?.catch(() => undefined);
}

async function run(projectPath: string, profileId?: string): Promise<SelfImproveIndexInfo> {
  const transcripts = await findProjectTranscripts(projectPath, { maxSessions: MAX_SESSIONS });

  const sessions: { turns: string[] }[] = [];
  let used = 0;
  for (const transcript of transcripts) {
    if (used >= MAX_CHARS_TOTAL) break;
    const budget = Math.min(MAX_CHARS_PER_SESSION, MAX_CHARS_TOTAL - used);
    const turns = await readUserTurns(transcript.file, budget);
    if (turns.length === 0) continue;
    sessions.push({ turns });
    used += turns.reduce((total, turn) => total + turn.length, 0);
  }

  let written: string[] = [];
  if (sessions.length > 0) {
    const existing = await countMemories(projectPath);
    const result = await runClaudeText({
      step: 'helpers',
      prompt: buildPrompt(sessions, []),
      model: MODEL,
      effort: EFFORT,
      jsonSchema: schema as unknown as Record<string, unknown>,
      profileId,
      cwd: projectPath,
    });
    const drafts = (result.structured as { memories?: MemoryDraft[] } | undefined)?.memories ?? [];
    if (drafts.length > 0) written = await writeMemories(projectPath, drafts.slice(0, MAX_MEMORIES - existing));
  }

  const info: SelfImproveIndexInfo = {
    memories: await countMemories(projectPath),
    sessionsScanned: sessions.length,
    builtAt: new Date().toISOString(),
  };
  await writeFile(infoPath(projectPath), `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
  appLog.info(
    `[SelfImprove] Memory index for ${projectPath}: ${written.length} new memory file(s) from ${sessions.length} session(s)`
  );
  return info;
}

/**
 * Build (or rebuild) the project's memory index from its past sessions. Concurrent callers join the
 * build already running rather than starting a second one.
 */
export function buildMemoryIndex(projectPath: string, profileId?: string): Promise<SelfImproveIndexInfo> {
  const key = path.resolve(projectPath);
  const running = inFlight.get(key);
  if (running) return running;

  const build = run(projectPath, profileId).finally(() => inFlight.delete(key));
  inFlight.set(key, build);
  return build;
}
