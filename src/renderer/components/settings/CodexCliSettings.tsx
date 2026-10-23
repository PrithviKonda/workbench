import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';

// Delay before re-checking after the install terminal opens
const RECHECK_DELAY_MS = 8000;

/** Codex CLI (the ChatGPT engine): whether it's installed, and install/update in a terminal */
export function CodexCliSettings() {
  const { t } = useTranslation('settings');
  const [info, setInfo] = useState<{ found: boolean; version?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.electronAPI.getCodexCliInfo();
      if (result.success && result.data) setInfo(result.data);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      const result = await window.electronAPI.installCodexCli();
      if (result.success) setTimeout(() => void refresh(), RECHECK_DELAY_MS);
      else setError(result.error || t('codexCli.installFailed'));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <SettingsSection title={t('codexCli.title')} description={t('codexCli.description')}>
      <SettingsRows>
        <SettingsRow
          label={t('codexCli.status')}
          description={info?.found ? t('codexCli.installed', { version: info.version ?? '' }).trim() : info ? t('codexCli.notInstalled') : undefined}
        >
          {info && (
            <Button size="sm" variant={info.found ? 'outline' : 'default'} className="gap-1.5" onClick={() => void install()} disabled={installing}>
              {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {info.found ? t('codexCli.update') : t('codexCli.install')}
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()} disabled={checking}>
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
            {t('codexCli.refresh')}
          </Button>
        </SettingsRow>
      </SettingsRows>
      {error && <div className="mt-3 rounded-xl bg-segment-track px-4 py-3 text-sm text-foreground">{error}</div>}
    </SettingsSection>
  );
}
