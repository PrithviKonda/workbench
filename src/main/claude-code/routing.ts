/**
 * Model routing
 * =============
 *
 * Settings > Agents > Model routing sets the engine, model and effort per kind of work (triage,
 * planning, coding, review, git, merges, the Claude page, helpers) and, for a task's steps, per
 * task size from its triage. Unset fields stay automatic (the caller's own choice).
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { readSettingsFileAsync } from '../settings-utils';
import { resolveModelRoute, type ModelRoute, type RouteStep, type TaskScope } from '../../shared/types/claude-code';
import type { AppSettings } from '../../shared/types/settings';

/** Size triage gave a task, from its claude_run.json (undefined before triage) */
async function taskScope(specDir: string | undefined): Promise<TaskScope | undefined> {
  if (!specDir) return undefined;
  try {
    const info = JSON.parse(await readFile(path.join(specDir, 'claude_run.json'), 'utf-8')) as { triage?: { scope?: TaskScope } };
    return info.triage?.scope;
  } catch {
    return undefined;
  }
}

/** The route for a step, read from settings (and the task's size when `specDir` is given) */
export async function routeFor(step: RouteStep, specDir?: string): Promise<ModelRoute> {
  const settings = ((await readSettingsFileAsync()) ?? {}) as Partial<AppSettings>;
  return resolveModelRoute(settings.claudeCodeTasks?.modelRouting, step, await taskScope(specDir));
}
