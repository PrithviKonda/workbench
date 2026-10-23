import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { codexEffortFor, codexModelFor, createCodexTranslator, toCodexInvocation, toStrictSchema } from '../codex';
import { parseCodexRateLimits } from '../../claude-profile/codex-accounts';

const MODELS = [
  { slug: 'gpt-6-astra', displayName: 'A', description: 'Frontier intelligence', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-sol', displayName: 'S', description: 'Workhorse model', efforts: ['low', 'medium', 'high'] },
  { slug: 'gpt-6-luna', displayName: 'L', description: 'Fast and affordable model', efforts: ['low', 'medium'] },
];

let home: string;
afterEach(() => home && rmSync(home, { recursive: true, force: true }));

function codexHome(): string {
  home = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
    models: MODELS.map((m, i) => ({
      slug: m.slug, display_name: m.displayName, description: m.description, visibility: 'list', priority: i,
      supported_reasoning_levels: m.efforts.map((effort) => ({ effort })),
    })),
  }));
  return home;
}

describe('Codex models', () => {
  it('maps Claude tiers to Codex models and clamps effort', () => {
    expect(codexModelFor('opus', MODELS)).toBe('gpt-6-astra');
    expect(codexModelFor('fable', MODELS)).toBe('gpt-6-astra');
    expect(codexModelFor('sonnet', MODELS)).toBe('gpt-6-sol');
    expect(codexModelFor('haiku', MODELS)).toBe('gpt-6-luna');
    expect(codexModelFor('gpt-6-sol', MODELS)).toBe('gpt-6-sol');
    expect(codexModelFor('claude-opus-5-5', MODELS)).toBe('gpt-6-astra');
    expect(codexEffortFor('max', 'gpt-6-sol', MODELS)).toBe('high');
    expect(codexEffortFor('medium', 'gpt-6-luna', MODELS)).toBe('medium');
  });
});

describe('toStrictSchema', () => {
  it('closes objects and makes optional properties required but nullable', () => {
    const strict = toStrictSchema({
      type: 'object',
      properties: { name: { type: 'string' }, command: { type: 'string' }, list: { type: 'array', maxItems: 3, items: { type: 'string' } } },
      required: ['name'],
    }) as Record<string, any>;
    expect(strict.required).toEqual(['name', 'command', 'list']);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.properties.command.type).toEqual(['string', 'null']);
    expect(strict.properties.list.maxItems).toBeUndefined();
  });
});

describe('toCodexInvocation', () => {
  it('translates a task phase', () => {
    const inv = toCodexInvocation([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', 'opus', '--effort', 'high', '--permission-prompts', 'none',
      '--append-system-prompt', 'SYSTEM', '--name', 'x', '--dangerously-skip-permissions',
      '--resume', 'thread-1', '--json-schema', JSON.stringify({ type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] }),
      '--mcp-config', JSON.stringify({ mcpServers: { tasks: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer secret' } } } }),
    ], [{ type: 'text', text: 'Do it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }], codexHome());

    expect(inv.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
    expect(inv.args).toContain('--json');
    expect(inv.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(inv.args.join(' ')).toContain('-m gpt-6-astra');
    expect(inv.args).toContain('model_reasoning_effort="high"');
    expect(inv.args).toContain('mcp_servers.tasks.bearer_token_env_var="WORKBENCH_MCP_TASKS_AUTHORIZATION"');
    expect(inv.args.join(' ')).not.toContain('secret');
    expect(inv.env.WORKBENCH_MCP_TASKS_AUTHORIZATION).toBe('secret');
    expect(inv.args[inv.args.length - 1]).toBe('-');
    const schemaFile = inv.args[inv.args.indexOf('--output-schema') + 1];
    expect(JSON.parse(readFileSync(schemaFile, 'utf-8')).additionalProperties).toBe(false);
    expect(inv.args).toContain('-i');
    expect(inv.stdin).toBe('<instructions>\nSYSTEM\n</instructions>\n\nDo it');
    expect(inv.structured).toBe(true);
    inv.cleanup();
  });

  it('keeps read-only uses in a read-only sandbox and writing ones in the workspace', () => {
    const readOnly = toCodexInvocation(['-p', '--permission-mode', 'dontAsk', '--model', 'haiku', '--tools', '', '--no-session-persistence'], 'hi', codexHome());
    expect(readOnly.args).toContain('sandbox_mode="read-only"');
    expect(readOnly.args).toContain('--ephemeral');
    const writes = toCodexInvocation(['-p', '--tools', 'Read,Edit,Write,Bash', '--allowedTools', 'Edit', 'Write', '--model', 'opus'], 'hi', codexHome());
    expect(writes.args).toContain('sandbox_mode="workspace-write"');
    const plan = toCodexInvocation(['-p', '--permission-mode', 'plan'], 'hi', codexHome());
    expect(plan.args).toContain('sandbox_mode="read-only"');
  });
});

describe('createCodexTranslator', () => {
  // Events as `codex exec --json` printed them (codex-cli 0.155)
  const events = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Working on it' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat a.txt', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat a.txt', aggregated_output: 'hi\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/repo/b.txt', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'workbench_tasks', tool: 'TaskCreate', arguments: { subject: 'Step' }, result: { content: [{ type: 'text', text: 'Task #1 created successfully: Step' }] }, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: '{"plan":"Do X"}' } },
    { type: 'turn.completed', usage: { input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 } },
  ];

  it('emits Claude Code messages the runner reads', () => {
    const translator = createCodexTranslator({ model: 'gpt-6-astra', partial: false, structured: true, cwd: '/repo' });
    const messages = events.flatMap((e) => translator.translate(e));
    expect(messages[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'thread-1' });

    const toolUses = messages.flatMap((m: any) => (m.type === 'assistant' ? m.message.content : [])).filter((b: any) => b.type === 'tool_use');
    expect(toolUses.map((b: any) => b.name)).toEqual(['Bash', 'Write', 'TaskCreate']);
    expect(toolUses[1].input.file_path).toBe('/repo/b.txt');
    expect(messages.every((m: any) => m.type !== 'assistant' && m.type !== 'user' || m.parent_tool_use_id === null)).toBe(true);

    const result: any = messages[messages.length - 1];
    expect(result).toMatchObject({ type: 'result', subtype: 'success', is_error: false, session_id: 'thread-1', structured_output: { plan: 'Do X' } });
    // 0.5M uncached input at $10 + 0.5M cached at $1 + 0.1M output at $50
    expect(result.total_cost_usd).toBeCloseTo(5 + 0.5 + 5);
    expect(translator.finish('')).toEqual([]);
  });

  it('reports usage limits with the reset time and errors without a turn', () => {
    const reset = new Date('2030-01-01T00:00:00Z');
    const translator = createCodexTranslator({ partial: false, structured: false, cwd: '/repo', resetAt: () => reset });
    translator.translate({ type: 'thread.started', thread_id: 't' });
    const messages = translator.translate({ type: 'turn.failed', error: { message: "You've hit your usage limit." } });
    expect(messages[0]).toMatchObject({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset.getTime() / 1000 } });
    expect(messages[1]).toMatchObject({ type: 'result', is_error: true, api_error_status: 429 });

    const crashed = createCodexTranslator({ partial: false, structured: false, cwd: '/repo' });
    expect(crashed.finish('Error: not logged in')[0]).toMatchObject({ type: 'result', is_error: true, api_error_status: 401 });
  });

  it('mirrors a Codex plan list as TaskCreate/TaskUpdate and streams partial text for Insights', () => {
    const translator = createCodexTranslator({ partial: true, structured: false, cwd: '/repo' });
    const first = translator.translate({ type: 'item.started', item: { id: 'p', type: 'todo_list', items: [{ text: 'A', completed: false }, { text: 'B', completed: false }] } });
    const names = first.flatMap((m: any) => (m.type === 'assistant' ? m.message.content : [])).map((b: any) => [b.name, b.input.status ?? b.input.subject]);
    expect(names).toEqual([['TaskCreate', 'A'], ['TaskCreate', 'B'], ['TaskUpdate', 'in_progress']]);
    const next = translator.translate({ type: 'item.updated', item: { id: 'p', type: 'todo_list', items: [{ text: 'A', completed: true }, { text: 'B', completed: false }] } });
    expect(next.flatMap((m: any) => (m.type === 'assistant' ? m.message.content : [])).map((b: any) => b.input)).toEqual([
      { taskId: '1', status: 'completed' }, { taskId: '2', status: 'in_progress' },
    ]);
    const text = translator.translate({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Hello' } });
    expect(text.some((m: any) => m.type === 'stream_event' && m.event.delta?.text === 'Hello')).toBe(true);
  });
});

describe('parseCodexRateLimits', () => {
  it('splits session and weekly windows', () => {
    const limits = parseCodexRateLimits({
      primary: { used_percent: 40, window_minutes: 300, resets_at: 1_900_000_000 },
      secondary: { used_percent: 100, window_minutes: 10080, resets_at: 1_900_500_000 },
    });
    expect(limits).toMatchObject({ sessionPercent: 40, weeklyPercent: 100, limitReached: true });
    expect(limits.weeklyResetAt?.getTime()).toBe(1_900_500_000_000);
  });
});
