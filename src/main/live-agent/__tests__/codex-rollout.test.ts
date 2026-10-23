/**
 * Codex rollouts in the Live agent graph: rollout lines become the Claude transcript lines the
 * parser reads, and the relay shows a Codex session run in a window's directory
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexRolloutLineToTranscript, codexRolloutThreadId, isCodexRollout } from '../relay/lib/codex-rollout';
import { createRelay, type Relay } from '../relay/relay';

const THREAD_ID = '01a16a16-fbcf-75d2-b8ff-9c1f3e5b709f';

/** A rollout line, as Codex writes it */
const event = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-10-23T18:47:41Z', type: 'event_msg', payload });
const completed = (item: Record<string, unknown>) => event({ type: 'item_completed', thread_id: THREAD_ID, turn_id: 't1', item });

const translate = (line: string) => codexRolloutLineToTranscript(line).map((out) => JSON.parse(out));
const blocks = (line: string) => translate(line).flatMap((entry) => entry.message?.content ?? []);

describe('codexRolloutLineToTranscript', () => {
  it('turns a command into a Bash call and its result', () => {
    const lines = translate(completed({ type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'ls'], status: 'completed', exit_code: 0 }));
    expect(lines).toEqual([
      expect.objectContaining({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'exec-1', name: 'Bash' }] } }),
      expect.objectContaining({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'exec-1' }] } }),
    ]);
  });

  it('marks a failed call as an error', () => {
    expect(blocks(completed({ type: 'CommandExecution', id: 'exec-2', status: 'failed', exit_code: 1 }))[1])
      .toEqual({ type: 'tool_result', tool_use_id: 'exec-2', is_error: true });
  });

  it('names MCP calls like Claude Code does', () => {
    expect(blocks(completed({ type: 'McpToolCall', id: 'm1', server: 'workbench_tasks', tool: 'TaskCreate', status: 'completed' }))[0])
      .toEqual({ type: 'tool_use', id: 'm1', name: 'mcp__workbench_tasks__TaskCreate' });
  });

  it('turns a file change into a Write or an Edit per file', () => {
    const uses = blocks(completed({
      type: 'FileChange', id: 'f1', status: 'completed',
      changes: { '/repo/new.js': { type: 'add' }, '/repo/math.js': { type: 'update', unified_diff: '' } },
    })).filter((block) => block.type === 'tool_use');
    expect(uses).toEqual([
      { type: 'tool_use', id: 'f1:0', name: 'Write' },
      { type: 'tool_use', id: 'f1:1', name: 'Edit' },
    ]);
  });

  it('turns a web search into WebSearch, and drops other extensions', () => {
    expect(blocks(completed({ type: 'Extension', kind: 'web.search', id: 'w1', query: 'x' }))[0])
      .toEqual({ type: 'tool_use', id: 'w1', name: 'WebSearch' });
    expect(translate(completed({ type: 'Extension', kind: 'image_gen.generation', id: 'g1' }))).toEqual([]);
  });

  it('writes only the tool_use when an item starts', () => {
    expect(translate(event({ type: 'item_started', item: { type: 'CommandExecution', id: 'exec-3' } }))).toHaveLength(1);
  });

  it('turns an agent message into assistant text', () => {
    expect(translate(completed({ type: 'AgentMessage', id: 'msg_1', content: [{ type: 'Text', text: 'Looking' }] })))
      .toEqual([{ type: 'assistant', uuid: 'msg_1', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking' }] } }]);
  });

  it('opens and closes the turn', () => {
    expect(translate(event({ type: 'task_started', turn_id: 't1' }))[0]).toMatchObject({ type: 'user', message: { content: '' } });
    expect(translate(event({ type: 'task_complete', turn_id: 't1' }))).toEqual([{ type: 'system', subtype: 'turn_duration' }]);
  });

  it('drops everything else', () => {
    expect(translate(JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } }))).toEqual([]);
    expect(translate(event({ type: 'token_count' }))).toEqual([]);
    expect(translate(completed({ type: 'Reasoning', id: 'rs_1' }))).toEqual([]);
    expect(translate('not json')).toEqual([]);
  });

  it('knows a rollout file and its thread id', () => {
    const file = `rollout-2026-10-23T13-47-33-${THREAD_ID}.jsonl`;
    expect(isCodexRollout(path.join('/x', file))).toBe(true);
    expect(isCodexRollout(`/x/${THREAD_ID}.jsonl`)).toBe(false);
    expect(codexRolloutThreadId(file)).toBe(THREAD_ID);
  });
});

describe('relay with Codex rollouts', () => {
  let root: string;
  let workspace: string;
  let flowDir: string;
  let rollout: string;
  let relay: Relay;
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  const events = () => sent
    .filter((message) => message.type === 'agent-event')
    .map((message) => message.event as { type: string; payload: Record<string, unknown> });

  beforeEach(async () => {
    sent.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-codex-')));
    workspace = path.join(root, 'project');
    flowDir = path.join(workspace, '.workbench', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    const codexHome = path.join(root, 'codex');
    const now = new Date();
    const dayDir = path.join(codexHome, 'sessions', String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    fs.mkdirSync(dayDir, { recursive: true });
    rollout = path.join(dayDir, `rollout-2026-10-23T13-47-33-${THREAD_ID}.jsonl`);
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID, cwd: workspace } }),
      event({ type: 'task_started', turn_id: 't1' }),
    ].join('\n') + '\n');

    relay = await createRelay({
      claudeDirs: [path.join(root, 'claude-config')],
      codexHomes: [codexHome],
      send: (_clientIds, data) => sent.push(JSON.parse(data)),
    });
  });

  afterEach(() => {
    relay.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows a Codex session run in the window directory, with its tool calls', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    expect(sent.find((message) => message.type === 'session-started')).toMatchObject({ session: { id: THREAD_ID } });

    fs.appendFileSync(rollout, [
      completed({ type: 'CommandExecution', id: 'exec-1', status: 'completed' }),
      completed({ type: 'McpToolCall', id: 'm1', server: 's', tool: 't', status: 'failed' }),
      event({ type: 'task_complete', turn_id: 't1' }),
    ].join('\n') + '\n');

    await vi.waitFor(
      () => expect(events().some((e) => e.type === 'agent_complete' && e.payload.name === 'orchestrator' && !e.payload.endsSession)).toBe(true),
      { timeout: 5000 }
    );
    const toolEvents = events().filter((e) => e.type.startsWith('tool_call_')).map((e) => [e.type, e.payload.tool, e.payload.isError]);
    expect(toolEvents).toEqual([
      ['tool_call_start', 'Bash', undefined],
      ['tool_call_end', 'Bash', undefined],
      ['tool_call_start', 'mcp__s__t', undefined],
      ['tool_call_end', 'mcp__s__t', true],
    ]);
  });
});
