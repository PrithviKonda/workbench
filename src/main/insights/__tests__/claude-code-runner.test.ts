/**
 * Insights through Claude Code, exercised end-to-end against a fake `claude` CLI:
 * a Node script that records its argv/stdin/env and prints scripted stream-json events.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = mkdtempSync(join(tmpdir(), 'insights-cc-test-'));
const fakeCli = join(workDir, 'fake-claude.cjs');
const recordFile = join(workDir, 'record.json');

writeFileSync(
  fakeCli,
  `
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const promptFile = args[args.indexOf('--append-system-prompt-file') + 1];
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args,
    stdin,
    systemPrompt: fs.readFileSync(promptFile, 'utf8'),
    configDir: process.env.CLAUDE_CONFIG_DIR,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    graphifyOut: process.env.GRAPHIFY_OUT ?? null,
    mcpConfig: args.includes('--mcp-config') ? JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) : null,
    mcpToolTimeout: process.env.MCP_TOOL_TIMEOUT ?? null,
    bridgeSource: (() => {
      if (!args.includes('--mcp-config')) return null;
      const server = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.workbench;
      return server && server.type === 'stdio' ? fs.readFileSync(server.args[0], 'utf8') : null;
    })(),
  }));
  for (const event of JSON.parse(process.env.FAKE_EVENTS || '[]')) process.stdout.write(JSON.stringify(event) + '\\n');
  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
  process.exit(Number(process.env.FAKE_EXIT || 0));
});
`,
);

let cliFound = true;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    // Run the fake CLI with the current Node binary (works on every platform)
    spawn: (_command: string, args: string[], options: Record<string, unknown>) =>
      actual.spawn(process.execPath, [fakeCli, ...args], { ...options, shell: false }),
  };
});
vi.mock('../../cli-tool-manager', () => ({
  getToolInfoAsync: async () => (cliFound ? { found: true, path: '/usr/bin/claude' } : { found: false, message: 'Claude CLI not found' }),
}));
vi.mock('../../claude-code/env', () => ({
  resolveClaudeEnv: async () => ({
    command: '/usr/bin/claude',
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, GRAPHIFY_OUT: undefined, CLAUDE_CONFIG_DIR: '/profiles/main' },
    profileId: 'main',
  }),
}));
vi.mock('../../env-utils', () => ({
  getSpawnCommand: (command: string) => command,
  getSpawnOptions: (_command: string, options: Record<string, unknown>) => ({ ...options, shell: false }),
  shouldUseShell: () => false,
}));

/**
 * Claude Code in WSL, as far as the Insights runner decides (task tools, claude lookup). The fake
 * CLI itself still runs natively: spawning stays native (isWslRuntime false)
 */
const wslRef = vi.hoisted(() => ({
  info: null as null | { distro: string; networkingMode: string | null; interop?: boolean; tools: { claude: { path: string | null } } },
  version: 2,
}));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  isWslRuntime: () => false,
  getWslInfo: () => wslRef.info,
  getShellRuntimeStatus: () => ({ wsl: wslRef.info ? { version: wslRef.version } : null }),
  toRuntimePath: (p: string) => (wslRef.info ? `/runtime${p.replace(/\\/g, '/')}` : p),
  toHostPath: (p: string) => p,
}));

import {
  runInsights,
  INSIGHTS_READ_ONLY_TOOLS,
  INSIGHTS_GRAPHIFY_COMMANDS,
  INSIGHTS_TASK_TOOLS_RULE,
  resetTaskToolsBridgeForTests,
  toClaudeModel,
  pageRoute,
  type InsightsStreamEvent,
} from '../claude-code-runner';
import { INSIGHTS_ERROR_CODES, parseInsightsError } from '../../../shared/constants/insights';

const delta = (index: number, d: Record<string, unknown>) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: d } });
const blockStart = (index: number, block: Record<string, unknown>) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } });
const blockStop = (index: number) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } });

const conversation = [
  { type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read'] },
  blockStart(0, { type: 'text', text: '' }),
  delta(0, { type: 'text_delta', text: 'Let me look.' }),
  blockStop(0),
  blockStart(1, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
  delta(1, { type: 'input_json_delta', partial_json: '{"file_path": "src/au' }),
  delta(1, { type: 'input_json_delta', partial_json: 'th.ts"}' }),
  blockStop(1),
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const auth = 1' }] } },
  blockStart(0, { type: 'text', text: '' }),
  delta(0, { type: 'text_delta', text: 'Auth uses JWT.' }),
  blockStop(0),
  { type: 'result', subtype: 'success', is_error: false, result: 'Auth uses JWT.' },
];

function setRun(events: unknown[], exitCode = 0, stderr = '') {
  process.env.FAKE_EVENTS = JSON.stringify(events);
  process.env.FAKE_EXIT = String(exitCode);
  process.env.FAKE_STDERR = stderr;
  process.env.FAKE_RECORD = recordFile;
}

const record = () => JSON.parse(readFileSync(recordFile, 'utf8'));

async function run(overrides: Record<string, unknown> = {}) {
  const events: InsightsStreamEvent[] = [];
  const promise = runInsights(
    { projectDir: workDir, message: 'How does auth work?', model: 'claude-sonnet-4-6', thinkingLevel: 'high', ...overrides },
    (e) => events.push(e),
  );
  return { promise, events };
}

beforeEach(() => {
  vi.clearAllMocks();
  cliFound = true;
  wslRef.info = null;
  wslRef.version = 2;
  resetTaskToolsBridgeForTests();
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('runInsights', () => {
  it('streams text and tool activity and returns the answer', async () => {
    setRun(conversation);
    const { promise, events } = await run();
    const result = await promise;

    expect(result.text).toBe('Let me look.\n\nAuth uses JWT.');
    expect(result.toolCalls).toEqual([{ name: 'Read', input: 'src/auth.ts' }]);
    expect(events).toEqual([
      { type: 'text-delta', text: 'Let me look.' },
      { type: 'tool-start', name: 'Read', input: 'src/auth.ts' },
      { type: 'tool-end', name: 'Read' },
      { type: 'text-delta', text: '\n\n' },
      { type: 'text-delta', text: 'Auth uses JWT.' },
    ]);
  });

  it('runs the CLI read-only, headless and with the profile credentials', async () => {
    setRun(conversation);
    await (await run()).promise;
    const { args, configDir, apiKey, systemPrompt } = record();

    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']));
    expect(args[args.indexOf('--tools') + 1]).toBe(INSIGHTS_READ_ONLY_TOOLS.join(','));
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    expect(systemPrompt).toContain('helping developers understand');
    expect(configDir).toBe('/profiles/main');
    expect(apiKey).toBeNull();
  });

  it('lets the CLI search the project memory graph with graphify commands only', async () => {
    setRun(conversation);
    await (await run({
      graphify: {
        prompt: 'CodebaseGraph tool section',
        commandPrompt: 'graphify commands section',
        cli: '/home/me/.local/bin/graphify',
        graph: '/project/.workbench/knowledge/graphify-out/graph.json',
      },
    })).promise;
    const { args, systemPrompt, graphifyOut } = record();

    expect(args[args.indexOf('--tools') + 1]).toBe([...INSIGHTS_READ_ONLY_TOOLS, 'Bash'].join(','));
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 1 + INSIGHTS_GRAPHIFY_COMMANDS.length);
    expect(allowed).toEqual([...INSIGHTS_GRAPHIFY_COMMANDS]);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(systemPrompt).toContain('graphify commands section');
    expect(systemPrompt).not.toContain('CodebaseGraph tool section');
    expect(graphifyOut).toBe('/project/.workbench/knowledge/graphify-out');
  });

  it('shows the command of a Bash graph search', async () => {
    setRun([
      blockStart(0, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"command": "graphify explain AgentManager", ' }),
      delta(0, { type: 'input_json_delta', partial_json: '"description": "Explain AgentManager"}' }),
      blockStop(0),
      ...conversation,
    ]);
    const { promise, events } = await run();
    const result = await promise;
    expect(result.toolCalls[0]).toEqual({ name: 'Bash', input: 'graphify explain AgentManager' });
    expect(events[0]).toEqual({ type: 'tool-start', name: 'Bash', input: 'graphify explain AgentManager' });
  });

  it("gives the CLI Workbench's task tools as its only MCP server", async () => {
    setRun(conversation);
    const mcpServer = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer secret' } };
    await (await run({ taskTools: mcpServer })).promise;
    const { args, mcpConfig, mcpToolTimeout, systemPrompt } = record();

    expect(mcpConfig).toEqual({ mcpServers: { 'workbench': mcpServer } });
    // The token stays in the config file, out of the process arguments
    expect(args.join(' ')).not.toContain('secret');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toContain(INSIGHTS_TASK_TOOLS_RULE);
    expect(args[args.indexOf('--tools') + 1]).toBe(INSIGHTS_READ_ONLY_TOOLS.join(','));
    expect(Number(mcpToolTimeout)).toBeGreaterThan(10 * 60 * 1000);
    expect(systemPrompt).toContain('mcp__workbench__');
    expect(systemPrompt).toContain('__TASK_SUGGESTION__');
  });

  it('keeps Bash out without a memory graph', async () => {
    setRun(conversation);
    await (await run()).promise;
    const { args, graphifyOut } = record();
    expect(args).not.toContain('--allowedTools');
    expect(args[args.indexOf('--tools') + 1]).not.toContain('Bash');
    expect(graphifyOut).toBeNull();
  });

  it('sends history, the question and attachments as one stream-json user message', async () => {
    setRun(conversation);
    await (await run({
      history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      attachments: [
        { id: '1', filename: 'shot.png', mimeType: 'image/png', size: 4, data: 'iVBORw==' },
        { id: '2', filename: 'notes.md', mimeType: 'text/markdown', size: 5, data: Buffer.from('# Hi').toString('base64') },
      ],
    })).promise;

    const message = JSON.parse(record().stdin);
    expect(message.type).toBe('user');
    expect(message.message.content[0].text).toContain('Previous conversation:');
    expect(message.message.content[0].text).toContain('Current question: How does auth work?');
    expect(message.message.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } });
    expect(message.message.content[2].text).toContain('<attached_file name="notes.md">');
  });

  it('rejects with the CLI error result (e.g. usage limit) and reports it', async () => {
    setRun([{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' }]);
    const { promise, events } = await run();
    await expect(promise).rejects.toThrow('Claude AI usage limit reached');
    expect(events).toContainEqual({ type: 'error', error: 'Claude AI usage limit reached' });
  });

  it('rejects with stderr when the CLI exits without a result', async () => {
    setRun([], 1, 'Invalid API key · Please run /login');
    await expect((await run()).promise).rejects.toThrow('Invalid API key · Please run /login');
  });

  it('rejects when the CLI produced no answer', async () => {
    setRun([{ type: 'result', subtype: 'success', is_error: false, result: '' }]);
    await expect((await run()).promise).rejects.toThrow(/empty response/i);
  });

  it('reports a missing Claude Code CLI with an error code', async () => {
    cliFound = false;
    const { promise } = await run();
    const error = await promise.catch((e: Error) => e);
    expect(parseInsightsError((error as Error).message).code).toBe(INSIGHTS_ERROR_CODES.claudeCodeMissing);
  });

  describe('with Claude Code in WSL', () => {
    const mcpServer = { type: 'http' as const, url: 'http://127.0.0.1:4567/mcp', headers: { Authorization: 'Bearer secret' } };

    it("reaches the task tools through the stdio bridge under NAT networking, where the app's 127.0.0.1 is out of reach", async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      const { args, mcpConfig, systemPrompt, bridgeSource } = record();
      const server = mcpConfig.mcpServers.workbench;
      // Workbench's own executable by its Linux path, the script by its Windows path
      expect(server).toEqual({
        type: 'stdio',
        command: `/runtime${process.execPath.replace(/\\/g, '/')}`,
        args: [expect.stringMatching(/task-tools-bridge.cjs$/)],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          WORKBENCH_TASK_TOOLS_URL: 'http://127.0.0.1:4567/mcp',
          WORKBENCH_TASK_TOOLS_TOKEN: 'secret',
          WSLENV: 'ELECTRON_RUN_AS_NODE:WORKBENCH_TASK_TOOLS_URL:WORKBENCH_TASK_TOOLS_TOKEN',
        },
      });
      expect(server.args[0].startsWith('/runtime')).toBe(false);
      // The script exists while the turn runs
      expect(bridgeSource).toContain('WORKBENCH_TASK_TOOLS_TOKEN');
      expect(JSON.stringify(args)).not.toContain('secret');
      expect(args).toContain(INSIGHTS_TASK_TOOLS_RULE);
      expect(systemPrompt).toContain('mcp__workbench__');
    });

    it('turns the task tools off after the bridge failed to start', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun([{ type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'workbench', status: 'failed' }] }, ...conversation.slice(1)]);
      await (await run({ taskTools: mcpServer })).promise;
      expect(record().mcpConfig.mcpServers.workbench.type).toBe('stdio');

      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      const { args, mcpConfig, systemPrompt } = record();
      expect(mcpConfig).toBeNull();
      expect(args).not.toContain(INSIGHTS_TASK_TOOLS_RULE);
      expect(systemPrompt).not.toContain('mcp__workbench__');
    });

    it('offers no task tools from the first turn when the distribution has WSL interop off', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', interop: false, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      const { args, mcpConfig } = record();
      expect(mcpConfig).toBeNull();
      expect(args).not.toContain(INSIGHTS_TASK_TOOLS_RULE);
    });

    it('keeps the direct HTTP entry in WSL1, which shares the host network', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: null, tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      wslRef.version = 1;
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      expect(record().mcpConfig).toEqual({ mcpServers: { 'workbench': mcpServer } });
    });

    it('keeps the task tools with mirrored networking', async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'mirrored', tools: { claude: { path: '/home/me/.local/bin/claude' } } };
      setRun(conversation);
      await (await run({ taskTools: mcpServer })).promise;
      expect(record().mcpConfig).toEqual({ mcpServers: { 'workbench': mcpServer } });
    });

    it("reports a missing Claude Code CLI when the distribution has none", async () => {
      wslRef.info = { distro: 'Ubuntu', networkingMode: 'nat', tools: { claude: { path: null } } };
      const { promise } = await run();
      const error = await promise.catch((e: Error) => e);
      expect(parseInsightsError((error as Error).message).code).toBe(INSIGHTS_ERROR_CODES.claudeCodeMissing);
    });
  });
});

describe('toClaudeModel', () => {
  it('keeps aliases and full Claude IDs, maps legacy IDs to their family, defaults to sonnet', () => {
    expect(toClaudeModel('opus')).toBe('opus');
    expect(toClaudeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(toClaudeModel('us.anthropic.haiku-x')).toBe('haiku');
    expect(toClaudeModel('gpt-5')).toBe('sonnet');
    expect(toClaudeModel(undefined)).toBe('sonnet');
  });
});

describe('pageRoute', () => {
  it('lets routing decide without a page engine', () => {
    expect(pageRoute({ engine: 'codex', model: 'gpt-5', effort: 'high' }, undefined))
      .toEqual({ route: { engine: 'codex', model: 'gpt-5', effort: 'high' }, engine: 'codex' });
  });

  it('keeps the page engine and drops model and effort routed to the other engine', () => {
    expect(pageRoute({ engine: 'claude', model: 'opus', effort: 'max' }, 'codex')).toEqual({ route: {}, engine: 'codex' });
    expect(pageRoute({ model: 'opus' }, 'codex')).toEqual({ route: {}, engine: 'codex' });
  });

  it('keeps model and effort routed to the page engine', () => {
    expect(pageRoute({ engine: 'codex', model: 'gpt-5', effort: 'low' }, 'codex'))
      .toEqual({ route: { engine: 'codex', model: 'gpt-5', effort: 'low' }, engine: 'codex' });
  });
});
