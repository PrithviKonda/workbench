import { describe, it, expect } from 'vitest';
import { buildMcpConfig } from '../mcp-config';
import { resolveClaudeCodeTaskSettings } from '../settings';
import { applyPlanningPolicy, fixedTriage } from '../triage';
import { isClaudeRunFinished } from '../task-runner';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS, resolveModelRoute, type ModelRouting } from '../../../shared/types/claude-code';

describe('buildMcpConfig', () => {
  it('maps built-in and tested custom connectors to --mcp-config servers', () => {
    const config = buildMcpConfig(['context7', 'my server', 'untested'], {
      customServers: [
        { id: 'my server', name: 'My Server', type: 'http', url: 'https://example.com/mcp', verified: true },
        { id: 'untested', name: 'Untested', type: 'command', command: 'npx', verified: false },
      ],
    } as never);
    expect(Object.keys(config.mcpServers)).toEqual(['context7', 'My_Server']);
    expect(config.mcpServers.My_Server).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: undefined });
  });

  it('uses the Connectors defaults when the task has no choice', () => {
    expect(Object.keys(buildMcpConfig(undefined, undefined).mcpServers)).toEqual(['context7']);
    expect(buildMcpConfig([], undefined).mcpServers).toEqual({});
  });
});

describe('resolveClaudeCodeTaskSettings', () => {
  it('fills defaults and drops invalid values', () => {
    expect(resolveClaudeCodeTaskSettings(undefined)).toEqual(DEFAULT_CLAUDE_CODE_TASK_SETTINGS);
    const resolved = resolveClaudeCodeTaskSettings({ fixedModel: 'gpt' as never, planning: 'sometimes' as never, validation: false });
    expect(resolved.fixedModel).toBe('sonnet');
    expect(resolved.planning).toBe('auto');
    expect(resolved.validation).toBe(false);
  });
});

describe('planning policy', () => {
  it('overrides the triage decision', () => {
    const base = fixedTriage(DEFAULT_CLAUDE_CODE_TASK_SETTINGS, 'T', 'fixed', '');
    expect(applyPlanningPolicy(base, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'always' }).needsPlan).toBe(true);
    expect(applyPlanningPolicy({ ...base, needsPlan: true }, { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, planning: 'never' }).needsPlan).toBe(false);
  });
});

describe('isClaudeRunFinished', () => {
  const run = (phases: Array<Record<string, unknown>>) => ({ version: 1 as const, phases, subagents: [], totalCostUsd: 0, updatedAt: '' }) as never;
  const done = { startedAt: 'a', endedAt: 'b' };

  it('is finished after a successful validation, or implementation when validation is off', () => {
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }, { name: 'validate', ...done }]), true)).toBe(true);
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }]), true)).toBe(false);
    expect(isClaudeRunFinished(run([{ name: 'implement', ...done }]), false)).toBe(true);
  });

  it('is not finished when the last step failed or is still running', () => {
    expect(isClaudeRunFinished(run([{ name: 'validate', ...done, isError: true }]), true)).toBe(false);
    expect(isClaudeRunFinished(run([{ name: 'validate', startedAt: 'a' }]), true)).toBe(false);
    expect(isClaudeRunFinished(null, true)).toBe(false);
  });
});

describe('resolveModelRoute', () => {
  const routing: ModelRouting = {
    plan: { all: { engine: 'claude', model: 'opus', effort: 'high' } },
    implement: { all: { model: 'gpt-6.1-sol' }, large: { effort: 'xhigh' } },
    validate: { all: { model: 'opus', effort: 'xhigh' }, small: { model: 'sonnet', effort: 'low' } },
    git: { all: { engine: 'claude', model: 'haiku' } },
    merge: { all: { model: 'gpt-6-sol' }, medium: { engine: 'claude' } },
    triage: { all: { model: 'haiku' }, large: { model: 'opus' } },
  };

  it('applies a size over all sizes, field by field', () => {
    expect(resolveModelRoute(routing, 'plan', 'medium')).toEqual({ engine: 'claude', model: 'opus', effort: 'high' });
    expect(resolveModelRoute(routing, 'validate', 'trivial')).toEqual({ model: 'sonnet', effort: 'low' });
    expect(resolveModelRoute(routing, 'validate', 'large')).toEqual({ model: 'opus', effort: 'xhigh' });
    expect(resolveModelRoute(routing, 'git', undefined)).toEqual({ engine: 'claude', model: 'haiku' });
    expect(resolveModelRoute(routing, 'insights', 'large')).toEqual({});
  });

  it('runs Codex models on Codex and never on Claude', () => {
    expect(resolveModelRoute(routing, 'implement', 'large')).toEqual({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(resolveModelRoute(routing, 'merge', 'medium')).toEqual({ engine: 'claude' });
  });

  it('ignores sizes for steps that have none', () => {
    expect(resolveModelRoute(routing, 'triage', 'large')).toEqual({ model: 'haiku' });
  });
});
