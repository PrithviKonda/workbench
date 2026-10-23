import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { ChevronDown, TerminalSquare } from 'lucide-react';
import { AgentNodeIcon, AgentsIcon, SettingsIcon as Settings, TerminalPromptIcon } from './icons/app-icons';
import { SortableTerminalWrapper } from './SortableTerminalWrapper';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { cn } from '../lib/utils';
import { useTerminalStore, getActiveProjectTerminalCount, isProjectTerminal } from '../stores/terminal-store';
import { useTaskStore } from '../stores/task-store';
import { useLiveAgentStore } from '../stores/live-agent-store';
import { useSettingsStore } from '../stores/settings-store';
import { TERMINAL_DOM_UPDATE_DELAY_MS, PANEL_CLEANUP_GRACE_PERIOD_MS } from '../../shared/constants';
import { computeTerminalGridLayout, computeWeightedTerminalLayout } from '../lib/terminal-grid-layout';

interface TerminalGridProps {
  projectPath?: string;
  onNewTaskClick?: () => void;
}

export function TerminalGrid({ projectPath, onNewTaskClick }: TerminalGridProps) {
  const { t } = useTranslation(['common', 'terminal']);
  const allTerminals = useTerminalStore((state) => state.terminals);

  // Track terminals that are in the grace period before being filtered out
  // Map of terminal ID -> timestamp when it was marked for cleanup
  const [pendingCleanup, setPendingCleanup] = useState<Map<string, number>>(new Map());

  // Ref to track active cleanup timers — avoids including pendingCleanup in effect deps
  const cleanupTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Helper to clear all active cleanup timers
  const clearAllCleanupTimers = useCallback(() => {
    for (const timer of cleanupTimersRef.current.values()) {
      clearTimeout(timer);
    }
    cleanupTimersRef.current.clear();
  }, []);

  // Filter terminals to show only those belonging to the current project
  // Also include legacy terminals without projectPath (created before this change)
  // Keep exited terminals in DOM during grace period to allow react-resizable-panels to reconcile
  const terminals = useMemo(() => {
    const filtered = projectPath
      ? allTerminals.filter(t => isProjectTerminal(t, projectPath))
      : allTerminals;

    // Filter out exited terminals UNLESS they are still in the grace period
    return filtered.filter(t => {
      if (t.status !== 'exited') {
        return true; // Keep all non-exited terminals
      }
      // Check if this exited terminal is in grace period
      const cleanupTime = pendingCleanup.get(t.id);
      if (cleanupTime) {
        const now = Date.now();
        return now < cleanupTime; // Keep if still within grace period
      }
      return false; // Remove if not in grace period
    });
  }, [allTerminals, projectPath, pendingCleanup]);

  // Manage grace period timers for exited terminals
  // When a terminal exits, add it to pendingCleanup and schedule its removal
  // Uses cleanupTimersRef to track scheduled timers, avoiding pendingCleanup in deps
  // No cleanup function here — timers must survive dependency changes
  useEffect(() => {
    const filtered = projectPath
      ? allTerminals.filter(t => t.projectPath === projectPath || !t.projectPath)
      : allTerminals;

    const exitedTerminals = filtered.filter(t => t.status === 'exited');

    for (const terminal of exitedTerminals) {
      // Check ref (not state) to see if a timer is already scheduled
      if (!cleanupTimersRef.current.has(terminal.id)) {
        const cleanupTime = Date.now() + PANEL_CLEANUP_GRACE_PERIOD_MS;
        setPendingCleanup(prev => new Map(prev).set(terminal.id, cleanupTime));

        const timer = setTimeout(() => {
          cleanupTimersRef.current.delete(terminal.id);
          setPendingCleanup(prev => {
            const next = new Map(prev);
            next.delete(terminal.id);
            return next;
          });
        }, PANEL_CLEANUP_GRACE_PERIOD_MS);

        cleanupTimersRef.current.set(terminal.id, timer);
      }
    }
  }, [allTerminals, projectPath]);

  // Clear all cleanup timers on unmount
  useEffect(() => {
    return clearAllCleanupTimers;
  }, [clearAllCleanupTimers]);

  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const canAddTerminal = useTerminalStore((state) => state.canAddTerminal);
  const maxTerminals = useTerminalStore((state) => state.maxTerminals);
  const reorderTerminals = useTerminalStore((state) => state.reorderTerminals);

  // Get tasks from task store for task selection dropdown in terminals
  const tasks = useTaskStore((state) => state.tasks);

  // Expanded terminal state - when set, this terminal takes up the full grid space
  const [expandedTerminalId, setExpandedTerminalId] = useState<string | null>(null);

  // Reset expanded terminal and clear pending cleanup when project changes
  useEffect(() => {
    setExpandedTerminalId(null);
    setPendingCleanup(new Map());
    clearAllCleanupTimers();
  }, [projectPath, clearAllCleanupTimers]);

  // Setup drag sensors for both file and terminal drag operations
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement required before drag starts
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Track dragging terminal for overlay
  const [draggingTerminalId, setDraggingTerminalId] = React.useState<string | null>(null);
  const draggingTerminal = terminals.find(t => t.id === draggingTerminalId);

  const handleCloseTerminal = useCallback((id: string) => {
    window.electronAPI.destroyTerminal(id);
    removeTerminal(id);
    // Clear expanded state if the closed terminal was expanded
    if (expandedTerminalId === id) {
      setExpandedTerminalId(null);
    }
  }, [removeTerminal, expandedTerminalId]);

  const handleAddTerminal = useCallback(() => {
    if (canAddTerminal(projectPath)) {
      addTerminal(projectPath, projectPath);
    }
  }, [addTerminal, canAddTerminal, projectPath]);

  // A terminal that starts an agent CLI as soon as its shell is ready: the one picked from the
  // "New agent" menu, or the Settings > Agents engine
  const defaultEngine = useSettingsStore((state) => state.settings.aiEngine);
  const handleAddAgent = useCallback((engine?: 'claude' | 'codex') => {
    if (canAddTerminal(projectPath)) {
      // On "Automatic" the main process picks (Claude when it can run)
      const chosen = engine ?? (defaultEngine === 'claude' || defaultEngine === 'codex' ? defaultEngine : undefined);
      addTerminal(projectPath, projectPath, { launchCLI: true, engine: chosen });
    }
  }, [addTerminal, canAddTerminal, projectPath, defaultEngine]);

  // The menu offers ChatGPT (Codex) once a Codex account is signed in
  const [codexReady, setCodexReady] = useState(false);
  useEffect(() => {
    void window.electronAPI.listCodexAccounts().then((result) => setCodexReady(!!result.data?.accounts.length));
  }, [projectPath]);

  const newAgentButton = (variant: 'empty' | 'toolbar') => {
    const disabled = !canAddTerminal(projectPath);
    const toolbarClass = 'h-8 text-[0.8125rem] text-muted-foreground hover:bg-nav-hover hover:text-foreground';
    return (
      <div className="flex items-center">
        <Button
          variant={variant === 'empty' ? 'default' : 'ghost'}
          size={variant === 'empty' ? 'default' : 'sm'}
          className={cn('gap-2 rounded-r-none', variant === 'toolbar' && cn(toolbarClass, 'gap-1.5 pr-1.5'))}
          onClick={() => handleAddAgent()}
          disabled={disabled}
        >
          <AgentsIcon className={variant === 'empty' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          {t('terminal:grid.newAgent')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={variant === 'empty' ? 'default' : 'ghost'}
              size={variant === 'empty' ? 'default' : 'sm'}
              className={cn('rounded-l-none px-1.5', variant === 'empty' ? 'border-l border-primary-foreground/20' : toolbarClass)}
              disabled={disabled}
              aria-label={t('terminal:grid.chooseAgent')}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem className="cursor-pointer" onSelect={() => handleAddAgent('claude')}>
              {t('terminal:grid.engines.claude')}
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer flex-col items-start gap-0" disabled={!codexReady} onSelect={() => handleAddAgent('codex')}>
              <span>{t('terminal:grid.engines.codex')}</span>
              {!codexReady && <span className="text-xs text-muted-foreground">{t('terminal:grid.engines.codexSignIn')}</span>}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  // Toggle terminal expand state
  const handleToggleExpand = useCallback((terminalId: string) => {
    setExpandedTerminalId(prev => prev === terminalId ? null : terminalId);
  }, []);


  // Handle drag start - store dragged item data
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { type: string } | undefined;

    if (data?.type === 'terminal-panel') {
      setDraggingTerminalId(event.active.id.toString());
    }
  }, []);

  // Handle drag end - reorder terminals
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const activeData = active.data.current as { type?: string } | undefined;

    // Clear drag state
    setDraggingTerminalId(null);

    if (!over) return;

    // Handle terminal reordering
    if (activeData?.type === 'terminal-panel') {
      const activeId = active.id.toString();
      let overId = over.id.toString();

      // Handle case where over is the file drop zone (terminal-xyz) instead of sortable item (xyz)
      if (overId.startsWith('terminal-')) {
        overId = overId.replace('terminal-', '');
      }

      if (activeId !== overId && terminals.some(t => t.id === overId)) {
        reorderTerminals(activeId, overId);

        // Persist the new order to disk so it survives app restarts
        // Use a microtask to ensure the store has updated before we read the new order
        if (projectPath) {
          queueMicrotask(async () => {
            const updatedTerminals = useTerminalStore.getState().terminals;
            const orders = updatedTerminals
              .filter(t => t.projectPath === projectPath || !t.projectPath)
              .map(t => ({ terminalId: t.id, displayOrder: t.displayOrder ?? 0 }));
            try {
              const result = await window.electronAPI.updateTerminalDisplayOrders(projectPath, orders);
              if (!result.success) {
                console.warn('[TerminalGrid] Failed to persist terminal order:', result.error);
              }
            } catch (error) {
              console.warn('[TerminalGrid] Failed to persist terminal order:', error);
            }
          });
        }

        // Refit terminals after dnd-kit CSS transitions settle
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('terminal-refit-all'));
        }, TERMINAL_DOM_UPDATE_DELAY_MS);
      }
      return;
    }
  }, [reorderTerminals, terminals, projectPath]);

  // Near-square grid without empty cells: the newest row or column is shared by its windows
  const gridLayout = useMemo(() => computeTerminalGridLayout(terminals.length), [terminals.length]);

  // Live agent (the project's setting): agent windows show their graph next to the terminal and take
  // twice the width. Without any, the plain grid above is used as it is
  const liveAgent = useLiveAgentStore((state) => (projectPath ? state.enabled[projectPath] === true : false));
  useEffect(() => {
    if (projectPath) void useLiveAgentStore.getState().load(projectPath);
  }, [projectPath]);
  const weightKey = terminals
    .map((terminal) => (liveAgent && terminal.isCLIMode && (terminal.cwd || projectPath) ? 2 : 1))
    .join(',');
  const weightedBoxes = useMemo(
    () => (weightKey.includes('2') ? computeWeightedTerminalLayout(weightKey.split(',').map(Number)) : null),
    [weightKey]
  );

  // Terminal IDs for SortableContext
  const terminalIds = useMemo(() => terminals.map(t => t.id), [terminals]);
  // What the limit counts: a closing window still draws for its grace period but no longer counts
  const activeCount = useMemo(
    () => getActiveProjectTerminalCount(terminals, projectPath),
    [terminals, projectPath]
  );

  // Empty state
  if (terminals.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 pb-[12vh]">
        <div className="flex max-w-[672px] flex-col items-center text-center">
          <h1 className="flex items-center justify-center gap-3 font-heading text-[2.125rem] font-normal! leading-tight tracking-tight text-foreground">
            <AgentNodeIcon className="h-9 w-9 shrink-0" />
            <span>{t('terminal:grid.emptyTitle')}</span>
          </h1>
          <p className="mt-3 max-w-md text-[0.9375rem] leading-relaxed text-muted-foreground">
            {t('terminal:grid.emptyDescription')}
          </p>
          <div className="mt-8 flex items-center gap-2">
            {newAgentButton('empty')}
            <Button variant="ghost" onClick={handleAddTerminal} className="gap-2 hover:bg-nav-hover">
              <TerminalPromptIcon className="h-4 w-4" />
              {t('terminal:grid.newTerminal')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-1">
            <span className="px-1 text-[0.8125rem] text-muted-foreground">
              {t('terminal:grid.count', { count: activeCount, max: maxTerminals })}
            </span>
            {/* Settings > Agents at the window limit */}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:bg-nav-hover hover:text-foreground transition-colors"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('open-app-settings', { detail: { section: 'agent', focusId: 'maxTerminals' } }));
              }}
              aria-label={t('terminal:grid.settingsAriaLabel')}
              title={t('terminal:grid.settingsAriaLabel')}
            >
              <Settings className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex items-center gap-0.5">
            {newAgentButton('toolbar')}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-[0.8125rem] text-muted-foreground hover:bg-nav-hover hover:text-foreground"
              onClick={handleAddTerminal}
              disabled={!canAddTerminal(projectPath)}
            >
              <TerminalPromptIcon className="h-3.5 w-3.5" />
              {t('terminal:grid.newTerminal')}
            </Button>
          </div>
        </div>

        {/* Main content area with the terminal grid */}
        <div className="flex flex-1 overflow-hidden">
          {/* Terminal grid using resizable panels */}
          <div className="flex-1 overflow-hidden px-2 pb-2">
            {expandedTerminalId ? (
              // Show only the expanded terminal
              (() => {
                const expandedTerminal = terminals.find(t => t.id === expandedTerminalId);
                if (!expandedTerminal) return null;
                return (
                  <div className="h-full p-1">
                    <SortableTerminalWrapper
                      id={expandedTerminal.id}
                      cwd={expandedTerminal.cwd || projectPath}
                      projectPath={projectPath}
                      isActive={expandedTerminal.id === activeTerminalId}
                      onClose={() => handleCloseTerminal(expandedTerminal.id)}
                      onActivate={() => setActiveTerminal(expandedTerminal.id)}
                      tasks={tasks}
                      onNewTaskClick={onNewTaskClick}
                      terminalCount={1}
                      isExpanded={true}
                      onToggleExpand={() => handleToggleExpand(expandedTerminal.id)}
                    />
                  </div>
                );
              })()
            ) : (
              // Flat CSS Grid layout — all terminals are siblings of the same parent.
              // This prevents React from unmounting/remounting terminal components during
              // drag-drop reorder. With the old nested Group/Panel structure from
              // react-resizable-panels, terminals that changed rows got new parents,
              // causing React to unmount → dispose xterm → blank screen.
              // With a flat grid, React just reorders siblings (no unmount needed).
              <SortableContext items={terminalIds} strategy={rectSortingStrategy}>
                {/* With Live agent the same windows are placed as boxes (same elements, so switching
                    never remounts a terminal) */}
                <div
                  className="relative h-full grid"
                  style={weightedBoxes ? undefined : {
                    gridTemplateColumns: `repeat(${gridLayout.columns}, 1fr)`,
                    gridTemplateRows: `repeat(${gridLayout.rows}, 1fr)`,
                  }}
                >
                  {terminals.map((terminal, index) => (
                    <div
                      key={terminal.id}
                      className="p-1 min-h-0 min-w-0"
                      style={weightedBoxes ? {
                        position: 'absolute',
                        left: `${weightedBoxes[index].x * 100}%`,
                        top: `${weightedBoxes[index].y * 100}%`,
                        width: `${weightedBoxes[index].width * 100}%`,
                        height: `${weightedBoxes[index].height * 100}%`,
                      } : {
                        gridRow: `${gridLayout.cells[index].row} / span ${gridLayout.cells[index].rowSpan}`,
                        gridColumn: `${gridLayout.cells[index].column} / span ${gridLayout.cells[index].columnSpan}`,
                      }}
                    >
                      <SortableTerminalWrapper
                        id={terminal.id}
                        cwd={terminal.cwd || projectPath}
                        projectPath={projectPath}
                        isActive={terminal.id === activeTerminalId}
                        onClose={() => handleCloseTerminal(terminal.id)}
                        onActivate={() => setActiveTerminal(terminal.id)}
                        tasks={tasks}
                        onNewTaskClick={onNewTaskClick}
                        terminalCount={terminals.length}
                        isExpanded={false}
                        onToggleExpand={() => handleToggleExpand(terminal.id)}
                      />
                    </div>
                  ))}
                </div>
              </SortableContext>
            )}
          </div>

        </div>

        {/* Drag overlay - shows what's being dragged */}
        <DragOverlay>
          {draggingTerminal && (
            <div className="flex items-center gap-2 bg-card border border-primary rounded-md px-3 py-2 shadow-lg">
              <TerminalSquare className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">{draggingTerminal.title || 'Terminal'}</span>
            </div>
          )}
        </DragOverlay>
      </div>
    </DndContext>
  );
}
