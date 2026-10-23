/**
 * GitHub dialog (Kanban board): the project's open or closed issues and pull requests. Open ones
 * become Backlog tasks ("Add to board"); the task keeps the number, so its card shows the live state.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { ExternalLink } from '../ui/external-link';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { SegmentedControl } from '../settings/SettingsRow';
import { cn, formatRelativeTime } from '../../lib/utils';
import { useTaskStore } from '../../stores/task-store';
import { useGitHubStore } from '../../stores/github-store';
import type { GitHubItem, GitHubItemKind, Task, TaskMetadata } from '../../../shared/types';

interface GitHubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  tasks: Task[];
}

/** The task that tracks a GitHub item, if any */
function taskFor(tasks: Task[], item: GitHubItem): Task | undefined {
  return tasks.find((task) =>
    item.kind === 'pr' ? task.metadata?.githubPrNumber === item.number : task.metadata?.githubIssueNumber === item.number);
}

/** What the agent is asked to do for an issue or a pull request */
function taskFromItem(item: GitHubItem): { title: string; description: string; metadata: TaskMetadata } {
  const body = item.body.trim();
  const description = item.kind === 'pr'
    ? `Finish pull request #${item.number}${item.branch ? ` (branch \`${item.branch}\`)` : ''}: review it, address open feedback and make sure the checks pass. Get its changes with \`git fetch origin pull/${item.number}/head && git merge FETCH_HEAD\`.\n\n${body}\n\n${item.url}`
    : `${body || item.title}\n\nGitHub issue #${item.number}: ${item.url}`;
  return {
    title: `#${item.number} ${item.title}`,
    description,
    metadata: {
      sourceType: 'github',
      userDescription: body || item.title,
      githubUrl: item.url,
      ...(item.kind === 'pr' ? { githubPrNumber: item.number } : { githubIssueNumber: item.number }),
    },
  };
}

export function GitHubDialog({ open, onOpenChange, projectId, tasks }: GitHubDialogProps) {
  const { t } = useTranslation('tasks');
  const [kind, setKind] = useState<GitHubItemKind>('issue');
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [items, setItems] = useState<GitHubItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.listGitHubItems(projectId, kind, state);
      if (result.success) setItems(result.data ?? []);
      else {
        setItems(null);
        setError(result.error ?? t('github.loadFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, kind, state, t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const notOnBoard = useMemo(() => (items ?? []).filter((item) => item.state === 'open' && !taskFor(tasks, item)), [items, tasks]);

  const add = async (list: GitHubItem[]) => {
    setAdding(new Set(list.map((item) => item.number)));
    setError(null);
    try {
      for (const item of list) {
        const { title, description, metadata } = taskFromItem(item);
        const result = await window.electronAPI.createTask(projectId, title, description, metadata);
        if (result.success && result.data) useTaskStore.getState().addTask(result.data);
        else setError(result.error ?? t('github.addFailed'));
      }
      void useGitHubStore.getState().load(projectId, true);
    } finally {
      setAdding(new Set());
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('github.title')}</DialogTitle>
          <DialogDescription>{t('github.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<GitHubItemKind>
            value={kind}
            onValueChange={setKind}
            ariaLabel={t('github.kind')}
            options={[
              { value: 'issue', label: t('github.issues') },
              { value: 'pr', label: t('github.pullRequests') },
            ]}
          />
          <SegmentedControl<'open' | 'closed'>
            value={state}
            onValueChange={setState}
            ariaLabel={t('github.stateFilter')}
            options={[
              { value: 'open', label: t('github.open') },
              { value: 'closed', label: t('github.closed') },
            ]}
          />
          <div className="ml-auto flex items-center gap-2">
            {state === 'open' && notOnBoard.length > 1 && (
              <Button size="sm" className="gap-1.5" onClick={() => void add(notOnBoard)} disabled={adding.size > 0}>
                <Plus className="h-3.5 w-3.5" />
                {t('github.addAll', { count: notOnBoard.length })}
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              {t('github.refresh')}
            </Button>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="max-h-[55vh] overflow-y-auto">
          {loading && !items ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('github.loading')}</p>
          ) : items && items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {state === 'open' ? t('github.emptyOpen') : t('github.emptyClosed')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(items ?? []).map((item) => {
                const onBoard = taskFor(tasks, item);
                return (
                  <li key={item.number} className="flex items-start gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 text-sm text-muted-foreground">#{item.number}</span>
                        <span className="min-w-0 truncate text-sm text-foreground" title={item.title}>{item.title}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{t(`github.state.${item.state}`)}{item.draft ? ` · ${t('github.draft')}` : ''}</span>
                        {item.author && <span>{item.author}</span>}
                        {item.updatedAt && <span>{formatRelativeTime(new Date(item.updatedAt))}</span>}
                        {item.labels.slice(0, 3).map((label) => (
                          <span key={label} className="rounded-full bg-segment-track px-1.5">{label}</span>
                        ))}
                      </div>
                    </div>
                    <ExternalLink href={item.url} aria-label={t('github.openOnGitHub')} className="shrink-0 text-xs text-muted-foreground">
                      {t('github.view')}
                    </ExternalLink>
                    {onBoard ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{t('github.onBoard')}</span>
                    ) : item.state === 'open' ? (
                      <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1" onClick={() => void add([item])} disabled={adding.size > 0}>
                        {adding.has(item.number) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        {t('github.add')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
