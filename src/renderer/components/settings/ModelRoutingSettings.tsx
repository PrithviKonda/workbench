/**
 * Model routing (Agents page): the engine, model and effort for each kind of work. A task's steps
 * (planning, coding, review, git, merges) can differ by the size triage gives the task; the size
 * tabs override "All sizes" field by field. Anything left on Automatic keeps the app's own choice.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select';
import { SettingsSection } from './SettingsSection';
import { SegmentedControl, SettingsRow, SettingsRows } from './SettingsRow';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  SIZED_ROUTE_STEPS,
  UNSIZED_ROUTE_STEPS,
  isClaudeModel,
  type ClaudeCodeTaskSettings,
  type ClaudeEffort,
  type ModelRoute,
  type ModelRouting,
  type RouteSize,
  type RouteStep,
} from '../../../shared/types/claude-code';
import type { AppSettings } from '../../../shared/types';

interface ModelRoutingSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

type SizeTab = 'all' | RouteSize;
const AUTO = 'auto';

export function ModelRoutingSettings({ settings, onSettingsChange }: ModelRoutingSettingsProps) {
  const { t } = useTranslation('settings');
  const [size, setSize] = useState<SizeTab>('all');
  const [codexModels, setCodexModels] = useState<Array<{ slug: string; displayName: string }>>([]);
  const routing: ModelRouting = settings.claudeCodeTasks?.modelRouting ?? {};

  useEffect(() => {
    void window.electronAPI.getCodexModels().then((result) => {
      if (result.success && result.data) setCodexModels(result.data.models);
    });
  }, []);

  const update = (step: RouteStep, tab: SizeTab, patch: Partial<ModelRoute>) => {
    const route: ModelRoute = { ...(routing[step]?.[tab] ?? {}), ...patch };
    for (const key of Object.keys(route) as Array<keyof ModelRoute>) if (!route[key]) delete route[key];
    const stored: Partial<ClaudeCodeTaskSettings> = settings.claudeCodeTasks ?? {};
    onSettingsChange({
      ...settings,
      claudeCodeTasks: { ...stored, modelRouting: { ...routing, [step]: { ...(routing[step] ?? {}), [tab]: route } } },
    });
  };

  const row = (step: RouteStep, tab: SizeTab) => {
    const route = routing[step]?.[tab] ?? {};
    // On a size tab, an unset field falls back to "All sizes"
    const autoLabel = tab === 'all' ? t('modelRouting.automatic') : t('modelRouting.sameAsAll');
    const engine = route.engine ?? AUTO;
    const id = `route-${step}-${tab}`;
    const select = (key: string, value: string, onChange: (v: string) => void, items: React.ReactNode) => (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={`${id}-${key}`} className="h-8 w-44" aria-label={t(`modelRouting.${key}`)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{items}</SelectContent>
      </Select>
    );
    const claudeItems = CLAUDE_MODEL_ALIASES.map((m) => (
      <SelectItem key={m} value={m}>{t(`claudeCode.models.${m}`)}</SelectItem>
    ));
    const codexItems = codexModels.map((m) => <SelectItem key={m.slug} value={m.slug}>{m.displayName}</SelectItem>);

    return (
      <SettingsRow key={id} label={t(`modelRouting.steps.${step}`)} description={t(`modelRouting.stepDescriptions.${step}`)} stacked>
        <div className="flex flex-wrap gap-2">
          {select('engine', engine, (v) => {
            const next = v === AUTO ? undefined : (v as ModelRoute['engine']);
            // A model of the other engine doesn't carry over (Claude tiers do: Codex maps them)
            const keepModel = !route.model || next !== 'claude' || isClaudeModel(route.model);
            update(step, tab, { engine: next, ...(keepModel ? {} : { model: undefined }) });
          }, (
            <>
              <SelectItem value={AUTO}>{autoLabel}</SelectItem>
              <SelectItem value="claude">{t('claudeCode.engine.options.claude')}</SelectItem>
              <SelectItem value="codex">{t('claudeCode.engine.options.codex')}</SelectItem>
            </>
          ))}
          {select('model', route.model ?? AUTO, (v) => {
            const model = v === AUTO ? undefined : v;
            // Picking a Codex model runs the step on Codex
            update(step, tab, { model, ...(model && !isClaudeModel(model) ? { engine: 'codex' } : {}) });
          }, (
            <>
              <SelectItem value={AUTO}>{autoLabel}</SelectItem>
              {engine === 'claude' ? claudeItems : engine === 'codex' ? (
                <>
                  {codexItems}
                  <SelectGroup>
                    <SelectLabel>{t('modelRouting.tiers')}</SelectLabel>
                    {claudeItems}
                  </SelectGroup>
                </>
              ) : (
                <>
                  <SelectGroup>
                    <SelectLabel>{t('claudeCode.engine.options.claude')}</SelectLabel>
                    {claudeItems}
                  </SelectGroup>
                  {codexItems.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('claudeCode.engine.options.codex')}</SelectLabel>
                      {codexItems}
                    </SelectGroup>
                  )}
                </>
              )}
            </>
          ))}
          {select('effort', route.effort ?? AUTO, (v) => update(step, tab, { effort: v === AUTO ? undefined : (v as ClaudeEffort) }), (
            <>
              <SelectItem value={AUTO}>{autoLabel}</SelectItem>
              {CLAUDE_EFFORTS.map((e) => <SelectItem key={e} value={e}>{t(`claudeCode.efforts.${e}`)}</SelectItem>)}
            </>
          ))}
        </div>
      </SettingsRow>
    );
  };

  return (
    <>
      <SettingsSection title={t('modelRouting.title')} description={t('modelRouting.description')}>
        <SettingsRows>
          <SettingsRow label={t('modelRouting.size')} description={t('modelRouting.sizeDescription')}>
            <SegmentedControl<SizeTab>
              value={size}
              onValueChange={setSize}
              ariaLabel={t('modelRouting.size')}
              options={(['all', 'small', 'medium', 'large'] as const).map((value) => ({ value, label: t(`modelRouting.sizes.${value}`) }))}
            />
          </SettingsRow>
          {SIZED_ROUTE_STEPS.map((step) => row(step, size))}
        </SettingsRows>
      </SettingsSection>
      <SettingsSection title={t('modelRouting.otherTitle')}>
        <SettingsRows>{UNSIZED_ROUTE_STEPS.map((step) => row(step, 'all'))}</SettingsRows>
      </SettingsSection>
    </>
  );
}
