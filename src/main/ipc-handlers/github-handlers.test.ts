import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, runTool } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  runTool: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
}));
vi.mock('../platform/runtime-exec', () => ({ runTool }));
vi.mock('../project-store', () => ({
  projectStore: { getProject: (id: string) => (id === 'p1' ? { id, path: '/repo' } : undefined) },
}));

import { registerGitHubHandlers } from './github-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

const reply = (data: unknown) => ({ stdout: JSON.stringify(data) });

describe('GitHub handlers', () => {
  beforeEach(() => {
    handlers.clear();
    runTool.mockReset();
    registerGitHubHandlers();
  });

  it('lists closed pull requests including merged ones, mapped for the dialog', async () => {
    runTool.mockResolvedValueOnce(reply([
      { number: 7, title: 'Add login', body: 'Body', url: 'u7', state: 'MERGED', labels: [{ name: 'feature' }], author: { login: 'pat' }, headRefName: 'login', isDraft: false },
      { number: 8, title: 'WIP', url: 'u8', state: 'OPEN', headRefName: 'wip' },
      { number: 9, title: 'Old', url: 'u9', state: 'CLOSED' },
    ]));
    const result = await handlers.get(IPC_CHANNELS.GITHUB_ITEMS_LIST)!({}, 'p1', 'pr', 'closed') as { success: boolean; data: Array<Record<string, unknown>> };
    expect(runTool.mock.calls[0][1].slice(0, 4)).toEqual(['pr', 'list', '--state', 'all']);
    expect(result.data.map((item) => [item.number, item.state])).toEqual([[7, 'merged'], [9, 'closed']]);
    expect(result.data[0]).toMatchObject({ kind: 'pr', labels: ['feature'], author: 'pat', branch: 'login', body: 'Body' });
  });

  it('reports open items and states for the board', async () => {
    runTool
      .mockResolvedValueOnce(reply([{ number: 1, state: 'OPEN' }, { number: 2, state: 'CLOSED' }]))
      .mockResolvedValueOnce(reply([{ number: 5, state: 'MERGED' }, { number: 6, state: 'OPEN' }]));
    const result = await handlers.get(IPC_CHANNELS.GITHUB_ITEM_STATES)!({}, 'p1') as { data: Record<string, unknown> };
    expect(result.data).toEqual({ issues: { 1: 'open', 2: 'closed' }, prs: { 5: 'merged', 6: 'open' }, openIssues: [1], openPrs: [6] });
  });

  it('explains gh failures', async () => {
    runTool.mockRejectedValueOnce(Object.assign(new Error('x'), { stderr: 'To get started with GitHub CLI, please run: gh auth login' }));
    const result = await handlers.get(IPC_CHANNELS.GITHUB_ITEMS_LIST)!({}, 'p1', 'issue', 'open');
    expect(result).toEqual({ success: false, error: 'GitHub CLI is not signed in. Run gh auth login in a terminal' });
  });
});
