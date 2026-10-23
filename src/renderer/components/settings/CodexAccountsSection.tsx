/**
 * ChatGPT (Codex) accounts (Accounts page): each Codex setup with a sign-in (`~/.codex` and the
 * `~/.codex-*` folders added here). Tasks on the Codex engine use the account with the most room
 * and move to the next one when it hits a limit, like Claude accounts. Adding an account runs
 * Codex's own sign-in (`codex login`) in the user's terminal, then the accounts are listed again
 * until the sign-in shows up; an OpenAI API key can sign in instead.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut, MoreHorizontal, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { SettingsRow } from './SettingsRow';
import type { CodexAccountsInfo, ClaudeProfile } from '../../../shared/types';

const LOGIN_WATCH_INTERVAL_MS = 3000;
const LOGIN_WATCH_MAX_TRIES = 200;

export function CodexAccountsSection() {
  const { t } = useTranslation('settings');
  const [info, setInfo] = useState<CodexAccountsInfo>({ accounts: [], usage: [], cliFound: true });
  const [watching, setWatching] = useState<{ known: Set<string>; accountId?: string } | null>(null);
  const [status, setStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const reload = useCallback(async () => {
    const result = await window.electronAPI.listCodexAccounts();
    if (result.success && result.data) setInfo(result.data);
    return result.success ? result.data : undefined;
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startLogin = async (account?: ClaudeProfile) => {
    setStatus(null);
    setRowError(null);
    const known = new Set(info.accounts.map((a) => a.id));
    const result = await window.electronAPI.loginCodexAccount(account?.id);
    if (!result.success) {
      const message = result.error ?? t('codexAccounts.login.failedToStart');
      if (account) setRowError({ id: account.id, message });
      else setStatus({ message, error: true });
      return;
    }
    if (!account) setStatus({ message: t('codexAccounts.login.waiting') });
    setWatching({ known, accountId: account?.id });
  };

  // While Codex's sign-in runs in the terminal, list the accounts again until a new one shows up
  useEffect(() => {
    if (!watching) return;
    let tries = 0;
    let stopped = false;
    const timer = setInterval(async () => {
      tries++;
      const data = await reload();
      if (stopped) return;
      const signedIn = watching.accountId
        ? data?.accounts.find((a) => a.id === watching.accountId)
        : data?.accounts.find((a) => !watching.known.has(a.id));
      // Signing in again keeps the same account: watch only until the timeout
      if (!(signedIn && !watching.accountId) && tries < LOGIN_WATCH_MAX_TRIES) return;
      clearInterval(timer);
      setWatching(null);
      if (!watching.accountId) {
        setStatus(signedIn
          ? { message: signedIn.email ? t('codexAccounts.login.signedInAs', { email: signedIn.email }) : t('codexAccounts.login.signedIn') }
          : { message: t('codexAccounts.login.notSignedIn') });
      }
    }, LOGIN_WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watching, reload, t]);

  const saveApiKey = async () => {
    setApiKeyStatus(null);
    const result = await window.electronAPI.loginCodexWithApiKey(apiKey);
    if (result.success) {
      setApiKey('');
      setApiKeyStatus({ message: t('codexAccounts.apiKeySaved') });
      await reload();
    } else {
      setApiKeyStatus({ message: result.error ?? '', error: true });
    }
  };

  const signOut = async (account: ClaudeProfile) => {
    const result = await window.electronAPI.signOutCodexAccount(account.id);
    if (!result.success) setRowError({ id: account.id, message: result.error ?? '' });
    await reload();
  };

  const saveName = async () => {
    if (!renaming) return;
    await window.electronAPI.renameCodexAccount(renaming.id, renaming.name);
    setRenaming(null);
    await reload();
  };

  const describe = (account: ClaudeProfile): string => {
    const summary = info.usage.find((u) => u.profileId === account.id);
    const parts: string[] = [];
    parts.push(account.email || (account.subscriptionType ? `ChatGPT ${account.subscriptionType}` : t('codexAccounts.apiKeyAccount')));
    if (summary?.isRateLimited) parts.push(t('codexAccounts.rateLimited'));
    if (account.usage) {
      parts.push(account.usage.sessionResetTime
        ? t('codexAccounts.usage', { session: Math.round(account.usage.sessionUsagePercent), weekly: Math.round(account.usage.weeklyUsagePercent) })
        : t('codexAccounts.weeklyUsage', { weekly: Math.round(account.usage.weeklyUsagePercent) }));
    }
    return parts.join(' · ');
  };

  const statusLine = (value: { message: string; error?: boolean } | null) =>
    value ? (
      <span role={value.error ? 'alert' : undefined} className={value.error ? 'text-destructive' : undefined}>
        {value.message}
      </span>
    ) : undefined;

  const activeId = info.usage.find((u) => u.isActive)?.profileId;

  return (
    <>
      {info.accounts.map((account) => (
        <SettingsRow
          key={account.id}
          label={
            renaming?.id === account.id ? (
              <Input
                autoFocus
                className="h-8"
                value={renaming.name}
                onChange={(e) => setRenaming({ id: account.id, name: e.target.value })}
                onBlur={() => void saveName()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveName();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{account.name}</span>
                {account.id === activeId && <span className="shrink-0 text-(--nav-label-color)">{t('codexAccounts.inUse')}</span>}
              </span>
            )
          }
          description={
            rowError?.id === account.id ? <span role="alert" className="text-destructive">{rowError.message}</span> : describe(account)
          }
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label={t('codexAccounts.menu', { name: account.name })}>
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem className="cursor-pointer" onSelect={() => void startLogin(account)}>
                <RefreshCw className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                {t('codexAccounts.signInAgain')}
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onSelect={() => setRenaming({ id: account.id, name: account.name })}>
                <Pencil className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                {t('codexAccounts.rename')}
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onSelect={() => void signOut(account)}>
                <LogOut className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                {t('codexAccounts.signOut')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsRow>
      ))}
      <SettingsRow
        label={t('codexAccounts.add')}
        description={statusLine(status) ?? (info.cliFound ? t('codexAccounts.addDescription') : t('codexAccounts.cliMissing'))}
      >
        <Button variant="outline" size="sm" className="gap-1.5" disabled={!info.cliFound} onClick={() => void startLogin()}>
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t('codexAccounts.addButton')}
        </Button>
      </SettingsRow>
      <SettingsRow label={t('codexAccounts.apiKey')} description={statusLine(apiKeyStatus) ?? t('codexAccounts.apiKeyDescription')} htmlFor="codex-api-key">
        <div className="flex items-center gap-2">
          <Input
            id="codex-api-key"
            type="password"
            autoComplete="off"
            className="h-8 w-44"
            placeholder={t('codexAccounts.apiKeyPlaceholder')}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && apiKey.trim()) void saveApiKey();
            }}
          />
          <Button variant="outline" size="sm" disabled={!apiKey.trim() || !info.cliFound} onClick={() => void saveApiKey()}>
            {t('codexAccounts.apiKeySave')}
          </Button>
        </div>
      </SettingsRow>
    </>
  );
}
