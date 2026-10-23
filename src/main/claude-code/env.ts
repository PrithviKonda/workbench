/**
 * Environment for Claude Code CLI runs
 * ====================================
 *
 * Every task, triage and utility call runs the locally installed `claude` CLI. Credentials
 * come from the chosen Claude profile's CLAUDE_CONFIG_DIR (the CLI refreshes OAuth tokens
 * itself), or from the active API profile (Anthropic-compatible endpoint) when one is set.
 *
 * When the app runs its tools in WSL (shell-runtime), `command` is the distribution's claude and
 * the environment keeps host values (CLAUDE_CONFIG_DIR as a Windows path); runtime-exec
 * translates paths and forwards variables when it launches the run.
 */

import path from 'path';
import { existsSync } from 'fs';
import { getClaudeCliInvocationAsync } from '../cli-utils';
import { getToolInfoAsync } from '../cli-tool-manager';
import { getBestAvailableProfileEnv, getUsableProfileEnv, isDetectedClaudeCodeProfile } from '../rate-limit-detector';
import { getAPIProfileEnv } from '../services/profile';
import { isWindows } from '../platform';
import { getWslInfo, whenShellRuntimeReady } from '../platform/shell-runtime';
import { withClaudeConfigDir } from '../claude-profile/config-dir-paths';
import { getAugmentedEnvAsync } from '../env-utils';
import { readSettingsFileAsync } from '../settings-utils';
import { getClaudeProfileManager } from '../claude-profile-manager';
import {
  getBestCodexAccount,
  hasSignedInCodexAccount,
  isCodexAccountId,
  markCodexAccountUsed,
} from '../claude-profile/codex-accounts';
import type { AiEngine } from '../../shared/types/settings';

/** Agent CLI of a run */
export type EngineKind = 'claude' | 'codex';

/** Variables that would make Claude Code use an API key instead of the profile's sign-in */
const API_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

export interface ClaudeEnvResult {
  /** Path or command for the `claude` (or `codex`) executable */
  command: string;
  env: Record<string, string>;
  /** Which CLI `command` is (missing: claude); startClaudeProcess translates Claude Code arguments for Codex */
  engine?: EngineKind;
  /** Claude profile the run uses (undefined for API profiles) */
  profileId?: string;
  profileName?: string;
}

export interface ClaudeEnvOptions {
  /** Use this Claude profile (or Codex account) instead of picking the best available one */
  profileId?: string;
  /** Extra variables (applied before credentials, so they cannot override auth) */
  extraEnv?: Record<string, string>;
  /** Run on this engine (model routing); a profile of the other engine is then ignored */
  engine?: EngineKind;
}

/** Git Bash path that Claude Code needs on Windows, derived from git.exe */
function deriveGitBashPath(gitExePath: string): string | null {
  const gitDir = path.dirname(gitExePath);
  const dirName = path.basename(gitDir).toLowerCase();
  let gitRoot = path.dirname(gitDir);
  if (dirName === 'bin') {
    const parentName = path.basename(gitRoot).toLowerCase();
    if (parentName === 'mingw64' || parentName === 'mingw32') gitRoot = path.dirname(gitRoot);
  }
  const bashPath = path.join(gitRoot, 'bin', 'bash.exe');
  return existsSync(bashPath) ? bashPath : null;
}

/**
 * Resolve the `claude` command and the environment to run it with.
 * Picks the best available Claude profile (rate-limit aware) unless one is given.
 */
export async function resolveClaudeEnv(options: ClaudeEnvOptions = {}): Promise<ClaudeEnvResult> {
  // Runs spawned right after startup must know whether Claude Code runs in WSL
  await whenShellRuntimeReady();
  const engine = options.engine ?? (await pickEngine(options.profileId));
  // A pinned account of the other engine can't run here: pick the best one of this engine instead
  if (options.profileId && isCodexAccountId(options.profileId) !== (engine === 'codex')) {
    options = { ...options, profileId: undefined };
  }
  if (engine === 'codex') return resolveCodexEnv(options);
  const wsl = getWslInfo();

  // In WSL: the distribution's own claude, and the app's environment as it is (PATH and other
  // Windows-only variables stay on the Windows side; runtime-exec sends what the run adds)
  const { command, env: baseEnv } = wsl
    ? { command: wsl.tools.claude.path ?? 'claude', env: { ...process.env } as Record<string, string> }
    : await getClaudeCliInvocationAsync();
  const env: Record<string, string> = { ...baseEnv, ...(options.extraEnv ?? {}) };

  if (wsl) {
    // Git Bash is a Windows-only setting of Claude Code
    delete env.CLAUDE_CODE_GIT_BASH_PATH;
  } else if (isWindows() && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitInfo = await getToolInfoAsync('git');
    const bashPath = gitInfo.found && gitInfo.path ? deriveGitBashPath(gitInfo.path) : null;
    if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
  }

  // An active API profile (custom Anthropic-compatible endpoint) wins over subscription sign-ins
  const apiProfileEnv = await getAPIProfileEnv();
  if (Object.keys(apiProfileEnv).length > 0) {
    for (const name of API_AUTH_VARS) delete env[name];
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return { command, env: { ...env, ...apiProfileEnv }, engine: 'claude' };
  }

  let profileEnv: Record<string, string>;
  let profileId: string | undefined;
  let profileName: string | undefined;
  // A requested profile is used while it exists and is signed in; otherwise (removed, or never
  // signed in) the best available profile runs instead of a run that can only fail
  const pinnedEnv = options.profileId ? getUsableProfileEnv(options.profileId) : null;
  if (options.profileId && pinnedEnv) {
    profileEnv = pinnedEnv;
    profileId = options.profileId;
  } else {
    const best = getBestAvailableProfileEnv();
    profileEnv = best.env;
    profileId = best.profileId;
    profileName = best.profileName;
  }

  // Subscription sign-in: never let a shell API key take over billing. A detected Claude Code
  // setup keeps the variables it may be configured with (a cloud provider, a key, a gateway)
  if (!profileId || !isDetectedClaudeCodeProfile(profileId)) {
    for (const name of API_AUTH_VARS) delete env[name];
  }
  const merged = { ...env, ...profileEnv };
  if (profileEnv.CLAUDE_CONFIG_DIR) {
    // The CLI reads (and refreshes) tokens from the config dir itself
    delete merged.CLAUDE_CODE_OAUTH_TOKEN;
  }
  // Claude Code's default ~/.claude runs without CLAUDE_CONFIG_DIR
  return { command, env: withClaudeConfigDir(merged), profileId, profileName, engine: 'claude' };
}

/** Whether Claude Code has something to run with: a signed-in account or an API profile */
async function claudeCanRun(): Promise<boolean> {
  try {
    if (getClaudeProfileManager().getSettings().profiles.some((p) => p.isAuthenticated)) return true;
  } catch {
    // Profile manager not ready
  }
  try {
    return Object.keys(await getAPIProfileEnv()).length > 0;
  } catch {
    return false;
  }
}

/**
 * Engine for a run: a pinned account decides (a session stays with the CLI it started in), then
 * Settings > Agents. "Auto" runs Claude Code when it can sign in, otherwise Codex when a
 * ChatGPT/OpenAI account is signed in, so either kind of account just works.
 */
export async function pickEngine(profileId?: string): Promise<EngineKind> {
  if (profileId) return isCodexAccountId(profileId) ? 'codex' : 'claude';
  const setting = ((await readSettingsFileAsync())?.aiEngine as AiEngine | undefined) ?? 'auto';
  if (setting !== 'auto') return setting;
  if (await claudeCanRun()) return 'claude';
  return hasSignedInCodexAccount() ? 'codex' : 'claude';
}

/** The `codex` command and the environment of the best available Codex account */
async function resolveCodexEnv(options: ClaudeEnvOptions): Promise<ClaudeEnvResult> {
  const wsl = getWslInfo();
  const info = await getToolInfoAsync('codex', { refreshIfMissing: true });
  const command = wsl ? wsl.tools.codex.path ?? 'codex' : info.path ?? 'codex';
  const env: Record<string, string> = { ...(wsl ? process.env as Record<string, string> : await getAugmentedEnvAsync()), ...(options.extraEnv ?? {}) };
  // ponytail: in WSL, Codex uses the distribution's own ~/.codex (accounts are found on the host only)
  if (wsl) return { command, env, engine: 'codex' };

  let autoSwitch;
  try {
    autoSwitch = getClaudeProfileManager().getAutoSwitchSettings();
  } catch {
    autoSwitch = undefined;
  }
  const account = getBestCodexAccount({ pinnedId: options.profileId, autoSwitch });
  if (!account?.configDir) return { command, env, engine: 'codex' };
  markCodexAccountUsed(account.id);
  return { command, env: { ...env, CODEX_HOME: account.configDir }, profileId: account.id, profileName: account.name, engine: 'codex' };
}
