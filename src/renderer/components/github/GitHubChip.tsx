import { useTranslation } from 'react-i18next';
import { CircleDot, GitPullRequest } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useGitHubStore } from '../../stores/github-store';
import type { Task } from '../../../shared/types';

/** The GitHub issue or pull request a task came from, with its current state (open, closed, merged) */
export function GitHubChip({ task }: { task: Task }) {
  const { t } = useTranslation('tasks');
  const pr = task.metadata?.githubPrNumber;
  const issue = task.metadata?.githubIssueNumber;
  const states = useGitHubStore((s) => s.states[task.projectId]);
  if (!pr && !issue) return null;
  const number = (pr ?? issue)!;
  const state = pr ? states?.prs[pr] : states?.issues[number];
  const Icon = pr ? GitPullRequest : CircleDot;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs',
        state === 'open' ? 'bg-segment-track text-foreground' : 'bg-segment-track text-(--nav-label-color)'
      )}
      title={state ? t(`github.state.${state}`) : undefined}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      #{number}
      {state && state !== 'open' && <span>{t(`github.state.${state}`)}</span>}
    </span>
  );
}
