import { useState, useEffect, useRef, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Play, Square, Loader2, RotateCcw, Archive, GitPullRequest, MoreVertical } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn, formatRelativeTime, sanitizeMarkdownForDisplay } from '../lib/utils';
import {
  TASK_STATUS_LABELS,
  getAllowedTaskMoves,
  JSON_ERROR_PREFIX,
  JSON_ERROR_TITLE_SUFFIX
} from '../../shared/constants';
import { stopTask, checkTaskRunning, isIncompleteHumanReview, archiveTasks, hasRecentActivity, startTaskOrQueue, taskHasErrors, retryTask } from '../stores/task-store';
import type { Task, TaskStatus } from '../../shared/types';
import { GitHubChip } from './github/GitHubChip';

// Stuck detection interval (ms). XState handles normal process exits (PROCESS_EXITED); this
// catches a task left In Progress or AI Review without a run (e.g. the app quit mid-run),
// checked when the card mounts and then every 60 seconds.
const STUCK_CHECK_INTERVAL_MS = 60_000;

// Icon-only buttons, like the settings dialog's (muted icon, nav hover background)
const ICON_BUTTON_CLASS = 'h-8 w-8 rounded-lg p-0 text-muted-foreground hover:bg-nav-hover hover:text-foreground';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange?: (newStatus: TaskStatus) => unknown;
}

// Custom comparator for React.memo - only re-render when relevant task data changes
function taskCardPropsAreEqual(prevProps: TaskCardProps, nextProps: TaskCardProps): boolean {
  const prevTask = prevProps.task;
  const nextTask = nextProps.task;

  // Fast path: same reference
  if (
    prevTask === nextTask &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.onStatusChange === nextProps.onStatusChange
  ) {
    return true;
  }

  // Compare only the fields that affect rendering
  const isEqual = (
    prevTask.id === nextTask.id &&
    prevTask.status === nextTask.status &&
    prevTask.title === nextTask.title &&
    prevTask.description === nextTask.description &&
    prevTask.updatedAt === nextTask.updatedAt &&
    prevTask.reviewReason === nextTask.reviewReason &&
    prevTask.executionProgress?.phase === nextTask.executionProgress?.phase &&
    prevTask.metadata?.archivedAt === nextTask.metadata?.archivedAt &&
    prevTask.metadata?.prUrl === nextTask.metadata?.prUrl
  );

  // Only log when actually re-rendering (reduces noise significantly)
  if (window.DEBUG && !isEqual) {
    const changes: string[] = [];
    if (prevTask.status !== nextTask.status) changes.push(`status: ${prevTask.status} -> ${nextTask.status}`);
    if (prevTask.executionProgress?.phase !== nextTask.executionProgress?.phase) {
      changes.push(`phase: ${prevTask.executionProgress?.phase} -> ${nextTask.executionProgress?.phase}`);
    }
    if (prevTask.subtasks.length !== nextTask.subtasks.length) {
      changes.push(`subtasks: ${prevTask.subtasks.length} -> ${nextTask.subtasks.length}`);
    }
    console.log(`[TaskCard] Re-render: ${prevTask.id} | ${changes.join(', ') || 'other fields'}`);
  }

  return isEqual;
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  onStatusChange
}: TaskCardProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const [isStuck, setIsStuck] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  // Why starting or retrying from the card failed, shown under the description
  const [actionError, setActionError] = useState<string | null>(null);
  const stuckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const isRunning = task.status === 'in_progress';
  // Validation (AI Review) also runs Claude Code, so it can be left stuck too (e.g. by an app quit)
  const isActive = isRunning || task.status === 'ai_review';

  // Check if task is in human_review but has no completed subtasks (crashed/incomplete)
  const isIncomplete = isIncompleteHumanReview(task);

  // Memoize expensive computations to avoid running on every render
  // Truncate description for card display - full description shown in modal
  // Handle JSON error tasks with i18n
  const sanitizedDescription = useMemo(() => {
    if (!task.description) return null;
    // Check for JSON error marker and use i18n
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      const translatedDesc = t('errors:task.jsonError.description', { error: errorMessage });
      return sanitizeMarkdownForDisplay(translatedDesc, 120);
    }
    return sanitizeMarkdownForDisplay(task.description, 120);
  }, [task.description, t]);

  // Memoize title with JSON error suffix handling
  const displayTitle = useMemo(() => {
    if (task.title.endsWith(JSON_ERROR_TITLE_SUFFIX)) {
      const baseName = task.title.slice(0, -JSON_ERROR_TITLE_SUFFIX.length);
      return `${baseName} ${t('errors:task.jsonError.titleSuffix')}`;
    }
    return task.title;
  }, [task.title, t]);

  // Memoize relative time (recalculates only when updatedAt changes)
  const relativeTime = useMemo(
    () => formatRelativeTime(task.updatedAt),
    [task.updatedAt]
  );

  // Memoize status menu items to avoid recreating on every render.
  // Lists only the columns the task may move to (same rule as drag and drop).
  const statusMenuItems = useMemo(() => {
    if (!onStatusChange) return null;
    const allowedMoves = getAllowedTaskMoves(task.status);
    if (allowedMoves.length === 0) return null;
    return allowedMoves.map((status) => (
      <DropdownMenuItem
        key={status}
        onClick={() => onStatusChange(status)}
      >
        {t(TASK_STATUS_LABELS[status])}
      </DropdownMenuItem>
    ));
  }, [task.status, onStatusChange, t]);

  // Catastrophic stuck detection — last-resort safety net.
  // XState handles all normal transitions via PROCESS_EXITED events.
  // This only fires if XState somehow fails to transition after 60s with no activity.
  useEffect(() => {
    if (!isActive) {
      setIsStuck(false);
      if (stuckIntervalRef.current) {
        clearInterval(stuckIntervalRef.current);
        stuckIntervalRef.current = null;
      }
      return;
    }

    const checkStuck = () => {
      // If any activity (status, progress, logs) was recorded recently, task is alive
      if (hasRecentActivity(task.id)) {
        setIsStuck(false);
        return;
      }

      // No recent activity: verify the process is actually gone
      checkTaskRunning(task.id).then((actuallyRunning) => {
        // Re-check activity in case something arrived while the IPC was in flight
        if (hasRecentActivity(task.id)) {
          setIsStuck(false);
        } else {
          setIsStuck(!actuallyRunning);
        }
      });
    };
    // Check right away (a run stopped by quitting the app is stuck as soon as the app starts)
    checkStuck();
    stuckIntervalRef.current = setInterval(checkStuck, STUCK_CHECK_INTERVAL_MS);

    return () => {
      if (stuckIntervalRef.current) {
        clearInterval(stuckIntervalRef.current);
      }
    };
  }, [task.id, isActive]);

  const handleStartStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      // Allow stopping both running and stuck tasks
      // User should be able to force-stop a stuck task
      stopTask(task.id);
    } else {
      // A queued task moves to the Queue column, so only a failure needs telling
      const result = await startTaskOrQueue(task.id);
      setActionError(result.success ? null : result.error || t('tasks:wizard.errors.startFailed'));
    }
  };

  // A stuck task (marked running without a run) starts over like Retry on a failed task:
  // continuing its broken session could pick up where it went wrong
  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRetrying(true);
    const result = await retryTask(task.id);
    setIsRetrying(false);
    if (result.success) {
      setIsStuck(false);
      setActionError(null);
    } else {
      setActionError(result.error || t('wizard.errors.startFailed'));
    }
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await archiveTasks(task.projectId, [task.id]);
    if (!result.success) {
      console.error('[TaskCard] Failed to archive task:', task.id, result.error);
    }
  };

  const handleViewPR = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.metadata?.prUrl && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(task.metadata.prUrl);
    }
  };

  const isArchived = !!task.metadata?.archivedAt;
  // Failed tasks show the usage badge's "sign in again" alert icon next to the title; stuck
  // tasks show it in the color of their "Stuck" label
  const hasErrors = taskHasErrors(task);
  const alertClass = hasErrors ? 'text-red-500' : isStuck ? 'text-warning' : null;

  return (
    <Card
      className={cn(
        'card-surface task-card-enhanced cursor-pointer',
        isArchived && 'opacity-60 hover:opacity-80'
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div>
          <div>
            {/* Title, with an alert icon at the right when the task failed */}
            <div className="flex items-start gap-2">
              <h3
                className="min-w-0 flex-1 font-bold text-sm text-foreground line-clamp-2 leading-snug wrap-anywhere"
                title={displayTitle}
              >
                {displayTitle}
              </h3>
              {alertClass && (
                <AlertCircle
                  className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', alertClass)}
                  aria-label={hasErrors ? t('reviewReason.hasErrors') : t('detailHeader.stuck')}
                />
              )}
            </div>

        {/* Description - sanitized to handle markdown content (memoized); long paths and URLs
            wrap instead of widening the card past its column */}
        {sanitizedDescription && (
          <p className="mt-1.5 text-sm text-(--nav-label-color) line-clamp-2 wrap-anywhere">
            {sanitizedDescription}
          </p>
        )}
        {actionError && (
          <p role="alert" className="mt-1.5 text-xs text-destructive line-clamp-2 wrap-anywhere">
            {actionError}
          </p>
        )}

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-sm text-(--nav-label-color)">{relativeTime}</span>
            <GitHubChip task={task} />
          </span>

          <div className="flex items-center gap-1.5">
            {/* Action buttons: icon buttons like the settings dialog's (label in the tooltip) */}
            {isStuck ? (
              <Button
                variant="ghost"
                size="sm"
                className={ICON_BUTTON_CLASS}
                onClick={handleRetry}
                disabled={isRetrying}
                title={t('actions.retry')}
                aria-label={t('actions.retry')}
              >
                {isRetrying
                  ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                  : <RotateCcw className="h-4 w-4" strokeWidth={1.75} />}
              </Button>
            ) : isIncomplete ? (
              <Button
                variant="ghost"
                size="sm"
                className={ICON_BUTTON_CLASS}
                onClick={handleStartStop}
                title={t('actions.resume')}
                aria-label={t('actions.resume')}
              >
                <Play className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            ) : task.status === 'done' ? (
              <div className="flex gap-1">
                {task.metadata?.prUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON_CLASS}
                    onClick={handleViewPR}
                    title={t('tooltips.viewPR')}
                    aria-label={t('tooltips.viewPR')}
                  >
                    <GitPullRequest className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                )}
                {!isArchived && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON_CLASS}
                    onClick={handleArchive}
                    title={t('tooltips.archiveTask')}
                    aria-label={t('tooltips.archiveTask')}
                  >
                    <Archive className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                )}
              </div>
            ) : isRunning && (
              /* Tasks start from the task dialog; a running task can be stopped from its card */
              <Button
                variant="ghost"
                size="sm"
                className={ICON_BUTTON_CLASS}
                onClick={handleStartStop}
                title={t('actions.stop')}
                aria-label={t('actions.stop')}
              >
                <Square className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            )}

            {/* Move to menu for keyboard accessibility */}
            {statusMenuItems && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON_CLASS}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('actions.taskActions')}
                  >
                    <MoreVertical className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuLabel>{t('actions.moveTo')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {statusMenuItems}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {/* Close content wrapper for selectable mode */}
        </div>
        {/* Close flex container for selectable mode */}
        </div>
      </CardContent>
    </Card>
  );
}, taskCardPropsAreEqual);
