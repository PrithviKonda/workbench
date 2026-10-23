import { describe, it, expect, vi, beforeEach } from 'vitest';

const runClaudeText = vi.fn();
vi.mock('../run-text', () => ({
  READ_ONLY_TOOLS: ['Read', 'Glob', 'Grep'],
  runClaudeText: (...args: unknown[]) => runClaudeText(...args),
}));

import { MAX_SECOND_OPINIONS, secondOpinionTools } from '../second-opinion';

describe('secondOpinionTools', () => {
  beforeEach(() => {
    runClaudeText.mockReset();
    runClaudeText.mockResolvedValue({ text: 'Use a map.', costUsd: 0.02 });
  });

  it('asks the other engine read-only in the worktree and reports the cost', async () => {
    const onCost = vi.fn();
    const { tools, call } = secondOpinionTools('codex', '/wt', onCost);
    expect(tools.map((t) => t.name)).toEqual(['ask_codex']);
    expect(tools[0].mutates).toBeFalsy();

    expect(await call('ask_codex', { question: 'Map or list?', context: 'Hot path' })).toBe('Use a map.');
    const options = runClaudeText.mock.calls[0][0];
    expect(options).toMatchObject({ engine: 'codex', cwd: '/wt', tools: ['Read', 'Glob', 'Grep'], step: 'helpers' });
    expect(options.prompt).toContain('Map or list?');
    expect(options.prompt).toContain('Hot path');
    expect(onCost).toHaveBeenCalledWith(0.02);
  });

  it('stops after the cap per phase', async () => {
    const { call } = secondOpinionTools('claude', '/wt', vi.fn());
    for (let i = 0; i < MAX_SECOND_OPINIONS; i++) await call('ask_claude', { question: `q${i}` });
    expect(await call('ask_claude', { question: 'one more' })).toMatch(/limit/);
    expect(runClaudeText).toHaveBeenCalledTimes(MAX_SECOND_OPINIONS);
  });

  it('turns a timeout into a message', async () => {
    runClaudeText.mockRejectedValue(new Error('Claude Code run timed out'));
    const { call } = secondOpinionTools('codex', '/wt', vi.fn());
    expect(await call('ask_codex', { question: 'q' })).toMatch(/didn't answer within 5 minutes/);
  });
});
