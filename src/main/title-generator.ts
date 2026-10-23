import { EventEmitter } from 'events';
import { runClaudeText } from './claude-code/run-text';

/**
 * Debug logging - only logs when DEBUG=true or in development mode
 */
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.warn('[TitleGenerator]', ...args);
  }
}

const SYSTEM_PROMPT =
  'You generate short, concise task titles (3-7 words). Output ONLY the title, nothing else. No quotes, no explanation, no preamble.';

/**
 * Service for generating task titles from descriptions using a one-shot Claude Code run (haiku).
 *
 * Emits "sdk-rate-limit" events on 429 errors (same interface as before).
 */
class TitleGenerator extends EventEmitter {
  constructor() {
    super();
    debug('TitleGenerator initialized');
  }

  /**
   * No-op configure() kept for backward compatibility with project-handlers.ts.
   * Python path and source path are no longer needed.
   */
  configure(_pythonPath?: string, _autoBuildSourcePath?: string): void {
    // No-op: TypeScript implementation does not need Python path or source path
  }

  /**
   * Generate a task title from a description using Claude AI
   * @param description - The task description to generate a title from
   * @returns Promise resolving to the generated title or null on failure
   */
  async generateTitle(description: string): Promise<string | null> {
    const prompt = this.createTitlePrompt(description);

    debug('Generating title for description:', description.substring(0, 100) + '...');

    try {
      const result = await runClaudeText({
        step: 'helpers',
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        model: 'haiku',
        timeoutMs: 60_000,
      });

      const raw = result.text.trim();
      if (!raw) {
        debug('AI returned empty response');
        return null;
      }

      const title = this.cleanTitle(raw);
      debug('Generated title:', title);
      return title;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Surface 429 rate-limit errors as sdk-rate-limit events
      if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
        debug('Rate limit detected:', message);
        this.emit('sdk-rate-limit', {
          source: 'title-generator',
          message,
          timestamp: new Date().toISOString(),
        });
        return null;
      }

      // Auth failures
      if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
        debug('Auth failure during title generation');
        return null;
      }

      debug('Title generation failed:', message);
      return null;
    }
  }

  /**
   * Create the prompt for title generation
   */
  private createTitlePrompt(description: string): string {
    return `Generate a short, concise task title (3-7 words) for the following task description. The title should be action-oriented and describe what will be done. Output ONLY the title, nothing else.

Description:
${description}

Title:`;
  }

  /**
   * Clean up the generated title
   */
  private cleanTitle(title: string): string {
    // Remove quotes if present
    let cleaned = title.replace(/^["']|["']$/g, '');

    // Remove any "Title:" or similar prefixes
    cleaned = cleaned.replace(/^(title|task|feature)[:\s]*/i, '');

    // Take first line only
    cleaned = cleaned.split('\n')[0]?.trim() ?? cleaned;

    // Capitalize first letter
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

    // Truncate if too long (max 100 chars)
    if (cleaned.length > 100) {
      cleaned = `${cleaned.substring(0, 97)}...`;
    }

    return cleaned.trim();
  }
}

// Export singleton instance
export const titleGenerator = new TitleGenerator();
