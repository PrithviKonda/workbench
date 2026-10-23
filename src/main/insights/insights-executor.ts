import { EventEmitter } from 'events';
import type {
  InsightsChatMessage,
  InsightsChatStatus,
  InsightsStreamChunk,
  InsightsToolUsage,
  InsightsModelConfig,
  ImageAttachment
} from '../../shared/types';
import { detectRateLimit, createSDKRateLimitInfo } from '../rate-limit-detector';
import { runInsights } from './claude-code-runner';
import { getGraphifyPromptContext, isGraphifyEnabled } from '../graphify';
import { projectStore } from '../project-store';
import { openTaskToolsSession } from './task-tools-server';

/**
 * Message processor result
 */
interface ProcessorResult {
  fullResponse: string;
  suggestedTasks?: InsightsChatMessage['suggestedTasks'];
  toolsUsed: InsightsToolUsage[];
}

/**
 * Executor for insights: runs each chat turn through Claude Code
 */
export class InsightsExecutor extends EventEmitter {
  private abortControllers: Map<string, AbortController> = new Map();

  constructor() {
    super();
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(projectId: string): boolean {
    return this.abortControllers.has(projectId);
  }

  /**
   * Cancel an active session
   */
  cancelSession(projectId: string): boolean {
    const controller = this.abortControllers.get(projectId);
    if (!controller) return false;

    controller.abort();
    this.abortControllers.delete(projectId);
    return true;
  }

  /**
   * Execute an insights query through Claude Code
   */
  async execute(
    projectId: string,
    projectPath: string,
    message: string,
    conversationHistory: Array<{ role: string; content: string }>,
    modelConfig?: InsightsModelConfig,
    images?: ImageAttachment[]
  ): Promise<ProcessorResult> {
    // Cancel any existing session
    this.cancelSession(projectId);

    // Emit thinking status
    this.emit('status', projectId, {
      phase: 'thinking',
      message: 'Processing your message...'
    } as InsightsChatStatus);

    const controller = new AbortController();
    this.abortControllers.set(projectId, controller);

    const fullResponse = '';
    const suggestedTasks: InsightsChatMessage['suggestedTasks'] = [];
    const toolsUsed: InsightsToolUsage[] = [];
    let accumulatedText = '';
    let allOutput = '';

    const model = modelConfig?.model || 'sonnet';
    const thinkingLevel = modelConfig?.thinkingLevel ?? 'medium';

    // Map history to InsightsMessage format
    const history = conversationHistory
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // With the Kanban button on, Claude can manage the project's tasks; the board reloads when a
    // tool changes them
    const taskTools = modelConfig?.kanbanTools
      ? await openTaskToolsSession({
        projectId,
        onTasksChanged: () => this.emit('tasks-changed', projectId),
      }).catch(() => undefined)
      : undefined;

    try {
      const projectSettings = projectStore.getProject(projectId)?.settings;
      // The project's memory graph, searchable from the chat when the project uses Graphify
      const graphify = (await isGraphifyEnabled(projectPath))
        ? (await getGraphifyPromptContext(projectPath)) ?? undefined
        : undefined;
      const result = await runInsights(
        {
          projectDir: projectPath,
          message,
          history,
          model,
          thinkingLevel,
          abortSignal: controller.signal,
          attachments: images,
          graphify,
          profileId: projectSettings?.claudeProfileId,
          taskTools: taskTools?.mcpServer,
          engine: modelConfig?.engine,
        },
        (event) => {
          switch (event.type) {
            case 'text-delta': {
              accumulatedText += event.text;
              allOutput = (allOutput + event.text).slice(-10000);
              this.emit('stream-chunk', projectId, {
                type: 'text',
                content: event.text,
              } as InsightsStreamChunk);
              break;
            }
            case 'tool-start': {
              toolsUsed.push({
                name: event.name,
                input: event.input,
                timestamp: new Date(),
              });
              this.emit('stream-chunk', projectId, {
                type: 'tool_start',
                tool: { name: event.name, input: event.input },
              } as InsightsStreamChunk);
              break;
            }
            case 'tool-end': {
              this.emit('stream-chunk', projectId, {
                type: 'tool_end',
                tool: { name: event.name },
              } as InsightsStreamChunk);
              break;
            }
            case 'error': {
              allOutput = (allOutput + event.error).slice(-10000);
              this.emit('stream-chunk', projectId, {
                type: 'error',
                error: event.error,
              } as InsightsStreamChunk);
              break;
            }
          }
        },
      );

      this.abortControllers.delete(projectId);

      // Extract task suggestion from the full result
      if (result.taskSuggestion) {
        const task = {
          title: result.taskSuggestion.title,
          description: result.taskSuggestion.description,
        };
        suggestedTasks.push(task);
        this.emit('stream-chunk', projectId, {
          type: 'task_suggestion',
          suggestedTasks: [task],
        } as InsightsStreamChunk);
      }

      this.emit('stream-chunk', projectId, {
        type: 'done',
      } as InsightsStreamChunk);

      this.emit('status', projectId, {
        phase: 'complete',
      } as InsightsChatStatus);

      return {
        fullResponse: result.text.trim() || accumulatedText.trim() || fullResponse,
        suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
        toolsUsed,
      };
    } catch (error) {
      this.abortControllers.delete(projectId);

      // Check for rate limit in accumulated output
      this.handleRateLimit(projectId, allOutput);

      const errorMsg = error instanceof Error ? error.message : String(error);

      // Don't emit error if aborted (user cancelled)
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          fullResponse: accumulatedText.trim(),
          suggestedTasks: suggestedTasks.length > 0 ? suggestedTasks : undefined,
          toolsUsed,
        };
      }

      this.emit('stream-chunk', projectId, {
        type: 'error',
        error: errorMsg,
      } as InsightsStreamChunk);

      this.emit('error', projectId, errorMsg);
      throw error;
    } finally {
      taskTools?.close();
    }
  }

  /**
   * Handle rate limit detection
   */
  private handleRateLimit(projectId: string, output: string): void {
    const rateLimitDetection = detectRateLimit(output);
    if (rateLimitDetection.isRateLimited) {
      const rateLimitInfo = createSDKRateLimitInfo('other', rateLimitDetection, {
        projectId,
      });
      this.emit('sdk-rate-limit', rateLimitInfo);
    }
  }
}
