/**
 * Codex (ChatGPT / OpenAI) accounts
 * =================================
 *
 * Each Codex setup is a CODEX_HOME folder with an `auth.json` (`~/.codex`, `$CODEX_HOME` and the
 * `~/.codex-*` folders "Add account" creates). They are listed as `ClaudeProfile`s with
 * `provider: 'codex'`, so the scorer, rate-limit records and usage summaries of Claude accounts
 * apply to them unchanged. They live in their own small store (`config/codex-accounts.json`):
 * the Claude profile store merges and dedupes accounts by email, which would mix a ChatGPT
 * sign-in with a Claude one of the same person.
 *
 * Usage comes from Codex itself: every session file (`sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * carries the account's `rate_limits` (used percent, window, reset time), so no network call.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import os from 'os';
import path from 'path';
import type { ClaudeProfile, ProfileUsageSummary } from '../../shared/types/agent';
import { getBestAvailableProfile as pickBest } from './profile-scorer';
import { recordRateLimitEvent, isProfileRateLimited } from './rate-limit-manager';
import { DEFAULT_AUTO_SWITCH_SETTINGS } from './profile-storage';
import type { ClaudeAutoSwitchSettings } from '../../shared/types/agent';

interface StoredCodexAccount {
  name?: string;
  rateLimitEvents?: ClaudeProfile['rateLimitEvents'];
  lastUsedAt?: string;
}

interface CodexAccountStore {
  accounts: Record<string, StoredCodexAccount>;
}

/** What the newest Codex session says about the account's limits */
export interface CodexRateLimits {
  sessionPercent?: number;
  sessionResetAt?: Date;
  sessionWindowMinutes?: number;
  weeklyPercent?: number;
  weeklyResetAt?: Date;
  weeklyWindowMinutes?: number;
  planType?: string;
  /** Codex reports the limit as reached */
  limitReached: boolean;
}

const CODEX_ID_PREFIX = 'codex:';
let store: CodexAccountStore | null = null;
const usageCache = new Map<string, { at: number; limits: CodexRateLimits | null }>();

function storePath(): string {
  return path.join(app.getPath('userData'), 'config', 'codex-accounts.json');
}

function loadStore(): CodexAccountStore {
  if (store) return store;
  try {
    store = JSON.parse(readFileSync(storePath(), 'utf-8')) as CodexAccountStore;
    if (!store.accounts) store = { accounts: {} };
  } catch {
    store = { accounts: {} };
  }
  return store;
}

function saveStore(): void {
  try {
    mkdirSync(path.dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(loadStore(), null, 2));
  } catch {
    // Unwritable config dir: rate limits are kept in memory for this session
  }
}

/** Default Codex home (`$CODEX_HOME` or `~/.codex`) */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Next free `~/.codex-N` folder for a new sign-in (`~/.codex` first when it has no sign-in) */
export function nextCodexHome(): string {
  const base = defaultCodexHome();
  if (!readCodexAuth(base)) return base;
  for (let n = 2; ; n++) {
    const dir = path.join(os.homedir(), `.codex-${n}`);
    if (!readCodexAuth(dir)) return dir;
  }
}

interface CodexAuthInfo {
  mode: 'chatgpt' | 'apikey';
  email?: string;
  plan?: string;
}

/** Sign-in of a Codex home, or null when it has none */
export function readCodexAuth(home: string): CodexAuthInfo | null {
  try {
    const auth = JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf-8')) as {
      OPENAI_API_KEY?: string | null;
      tokens?: { id_token?: string; access_token?: string; refresh_token?: string } | null;
    };
    if (auth.tokens?.refresh_token || auth.tokens?.access_token) {
      const claims = decodeJwt(auth.tokens.id_token);
      const openai = claims?.['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined;
      return { mode: 'chatgpt', email: typeof claims?.email === 'string' ? claims.email : undefined, plan: openai?.chatgpt_plan_type };
    }
    if (auth.OPENAI_API_KEY) return { mode: 'apikey' };
  } catch {
    // No auth.json or not readable
  }
  return null;
}

function decodeJwt(token: string | undefined): Record<string, unknown> | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Codex homes on this machine: the default one and every `~/.codex-*` folder */
function codexHomes(): string[] {
  const homes = new Set<string>([defaultCodexHome()]);
  try {
    for (const entry of readdirSync(os.homedir())) {
      if (/^\.codex-[\w-]+$/.test(entry)) homes.add(path.join(os.homedir(), entry));
    }
  } catch {
    // Home not listable
  }
  return [...homes];
}

function accountId(home: string): string {
  return `${CODEX_ID_PREFIX}${path.basename(home)}`;
}

export function isCodexAccountId(id: string | undefined): boolean {
  return !!id?.startsWith(CODEX_ID_PREFIX);
}

/** Every signed-in Codex account (fresh from disk each call; it's a few small files) */
export function listCodexAccounts(): ClaudeProfile[] {
  const saved = loadStore().accounts;
  const accounts: ClaudeProfile[] = [];
  for (const home of codexHomes()) {
    const auth = readCodexAuth(home);
    if (!auth) continue;
    const id = accountId(home);
    const stored = saved[id] ?? {};
    const limits = readCodexRateLimits(home);
    accounts.push({
      id,
      provider: 'codex',
      name: stored.name || auth.email || (auth.mode === 'apikey' ? 'OpenAI API key' : 'ChatGPT'),
      email: auth.email,
      configDir: home,
      isDefault: home === defaultCodexHome(),
      createdAt: new Date(0),
      lastUsedAt: stored.lastUsedAt ? new Date(stored.lastUsedAt) : undefined,
      subscriptionType: auth.plan,
      rateLimitEvents: stored.rateLimitEvents,
      isAuthenticated: true,
      usage: limits ? {
        sessionUsagePercent: limits.sessionPercent ?? 0,
        sessionResetTime: limits.sessionResetAt?.toISOString() ?? '',
        weeklyUsagePercent: limits.weeklyPercent ?? 0,
        weeklyResetTime: limits.weeklyResetAt?.toISOString() ?? '',
        lastUpdated: new Date(),
      } : undefined,
    });
  }
  return accounts;
}

export function getCodexAccount(id: string): ClaudeProfile | undefined {
  return listCodexAccounts().find((account) => account.id === id);
}

export function hasSignedInCodexAccount(): boolean {
  return codexHomes().some((home) => !!readCodexAuth(home));
}

/**
 * Best Codex account for a run: the pinned one while it's signed in, otherwise the available one
 * with the most room (same rules as Claude accounts), skipping `excludeId`
 */
export function getBestCodexAccount(options: { pinnedId?: string; excludeId?: string; autoSwitch?: ClaudeAutoSwitchSettings } = {}): ClaudeProfile | null {
  const accounts = listCodexAccounts();
  if (options.pinnedId) {
    const pinned = accounts.find((a) => a.id === options.pinnedId);
    if (pinned) return pinned;
  }
  return pickBest(accounts, options.autoSwitch ?? DEFAULT_AUTO_SWITCH_SETTINGS, options.excludeId);
}

/** Remember that an account hit its limit until `resetAt` */
export function recordCodexRateLimit(id: string, resetAt: Date): void {
  const accounts = loadStore().accounts;
  const entry = (accounts[id] ??= {});
  const profile = { rateLimitEvents: entry.rateLimitEvents } as ClaudeProfile;
  if (recordRateLimitEvent(profile, '', { resetAt })) {
    entry.rateLimitEvents = profile.rateLimitEvents;
    saveStore();
  }
}

export function markCodexAccountUsed(id: string): void {
  const entry = (loadStore().accounts[id] ??= {});
  entry.lastUsedAt = new Date().toISOString();
  saveStore();
}

export function renameCodexAccount(id: string, name: string): void {
  const entry = (loadStore().accounts[id] ??= {});
  entry.name = name.trim() || undefined;
  saveStore();
}

/** Usage rows for the usage indicator and Settings > Accounts */
export function codexUsageSummaries(activeId?: string): ProfileUsageSummary[] {
  return listCodexAccounts().map((account) => {
    const limited = isProfileRateLimited(account);
    const session = account.usage?.sessionUsagePercent ?? 0;
    const weekly = account.usage?.weeklyUsagePercent ?? 0;
    return {
      profileId: account.id,
      profileName: account.name,
      profileEmail: account.email,
      sessionPercent: session,
      weeklyPercent: weekly,
      sessionResetTimestamp: account.usage?.sessionResetTime || undefined,
      weeklyResetTimestamp: account.usage?.weeklyResetTime || undefined,
      isAuthenticated: true,
      isRateLimited: limited.limited,
      rateLimitType: limited.type,
      availabilityScore: limited.limited ? 0 : 100 - Math.max(session, weekly),
      isActive: account.id === activeId,
      lastFetchedAt: new Date().toISOString(),
      provider: 'codex',
    };
  });
}

// =============================================================================
// Rate limits from Codex session files
// =============================================================================

/** Newest session file under `<home>/sessions/YYYY/MM/DD/` */
function newestRollout(home: string): string | null {
  const descend = (dir: string, depth: number): string | null => {
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse();
    } catch {
      return null;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (depth === 3) {
        if (name.startsWith('rollout-') && name.endsWith('.jsonl')) return full;
        continue;
      }
      const found = descend(full, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return descend(path.join(home, 'sessions'), 0);
}

/** Session file of one Codex thread (resume on another account copies it there) */
export function findCodexRollout(home: string, threadId: string): string | null {
  const walk = (dir: string): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.endsWith(`${threadId}.jsonl`)) return full;
      if (!name.includes('.') && statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(path.join(home, 'sessions'));
}

/** A thread's token totals so far, from its session file (null when it can't be read) */
export function readCodexThreadUsage(home: string, threadId: string): { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } | null {
  const file = findCodexRollout(home, threadId);
  if (!file) return null;
  try {
    const lines = readTail(file).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"total_token_usage"')) continue;
      try {
        const record = JSON.parse(lines[i]) as { payload?: { info?: { total_token_usage?: Record<string, number> } | null } };
        const total = record.payload?.info?.total_token_usage;
        if (total) return total;
      } catch {
        // Partial first line of the tail
      }
    }
  } catch {
    // Unreadable session file
  }
  return null;
}

/** Last part of a file (session files grow large; the newest limits are at the end) */
function readTail(file: string, bytes = 256 * 1024): string {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf-8');
}

interface CodexLimitWindow { used_percent?: number; window_minutes?: number; resets_at?: number }

/** Turn Codex's `rate_limits` object into session / weekly figures */
export function parseCodexRateLimits(raw: {
  primary?: CodexLimitWindow | null;
  secondary?: CodexLimitWindow | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
}): CodexRateLimits {
  const limits: CodexRateLimits = { limitReached: !!raw.rate_limit_reached_type, planType: raw.plan_type ?? undefined };
  for (const window of [raw.primary, raw.secondary]) {
    if (!window || typeof window.used_percent !== 'number') continue;
    const resetAt = typeof window.resets_at === 'number' ? new Date(window.resets_at * 1000) : undefined;
    // Up to a day is the short (session) window; longer is the weekly one
    if ((window.window_minutes ?? 0) <= 24 * 60) {
      limits.sessionPercent = window.used_percent;
      limits.sessionResetAt = resetAt;
      limits.sessionWindowMinutes = window.window_minutes;
    } else {
      limits.weeklyPercent = window.used_percent;
      limits.weeklyResetAt = resetAt;
      limits.weeklyWindowMinutes = window.window_minutes;
    }
    if (window.used_percent >= 100) limits.limitReached = true;
  }
  return limits;
}

/** The account's limits as its newest Codex session recorded them (cached for 30 seconds) */
export function readCodexRateLimits(home: string): CodexRateLimits | null {
  const cached = usageCache.get(home);
  if (cached && Date.now() - cached.at < 30_000) return cached.limits;
  let limits: CodexRateLimits | null = null;
  const file = existsSync(home) ? newestRollout(home) : null;
  if (file) {
    try {
      const lines = readTail(file).split('\n');
      for (let i = lines.length - 1; i >= 0 && !limits; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try {
          const record = JSON.parse(lines[i]) as { payload?: { rate_limits?: Parameters<typeof parseCodexRateLimits>[0] | null } };
          if (record.payload?.rate_limits) limits = parseCodexRateLimits(record.payload.rate_limits);
        } catch {
          // Partial first line of the tail
        }
      }
    } catch {
      // Unreadable session file
    }
  }
  usageCache.set(home, { at: Date.now(), limits });
  return limits;
}
