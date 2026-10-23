import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { findCodexProjectSessions, readCodexRolloutSpending } from '../codex-accounts';
import { dayOf } from '../../claude-code/session-spending';

const meta = (cwd: string) => ({ timestamp: '2026-10-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'x', cwd } });
const turn = (timestamp: string, model: string) => ({ timestamp, type: 'turn_context', payload: { model } });
const tokens = (timestamp: string, input: number, cached: number, output: number) => ({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  },
});
const jsonl = (lines: object[]) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

describe('Codex rollouts', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('books each token delta on its day at the model then in effect', async () => {
    const file = path.join(root, 'rollout-2026-10-01T12-00-00-01a16a45-8539-7c33-a765-4f3a64d9c341.jsonl');
    const day1 = '2026-10-01T12:00:00.000Z';
    const day2 = '2026-10-03T12:00:00.000Z';
    writeFileSync(
      file,
      jsonl([
        meta(root),
        turn(day1, 'gpt-5.4'),
        // 1M fresh input + 1M output on gpt-5.4: 2.5 + 15
        tokens(day1, 1_000_000, 0, 1_000_000),
        { timestamp: day1, type: 'event_msg', payload: { type: 'token_count', info: null } },
        turn(day2, 'gpt-5'),
        // +2M input of which 1M cached, +0 output on gpt-5: 1.25 + 0.125
        tokens(day2, 3_000_000, 1_000_000, 1_000_000),
      ])
    );

    const spending = await readCodexRolloutSpending(file);

    expect(spending.totalCostUsd).toBeCloseTo(17.5 + 1.375);
    expect([...spending.byDay.keys()]).toEqual([dayOf(day1), dayOf(day2)]);
    expect(spending.byDay.get(dayOf(day1)!)).toBeCloseTo(17.5);
    expect(spending.byDay.get(dayOf(day2)!)).toBeCloseTo(1.375);
  });

  it('finds the project threads in every home and skips worktree and other-project threads', async () => {
    const project = path.join(root, 'project');
    const homeA = path.join(root, 'codex-a');
    const homeB = path.join(root, 'codex-b');
    const write = (home: string, id: string, cwd: string) => {
      const dir = path.join(home, 'sessions', '2026', '10', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rollout-2026-10-01T12-00-00-${id}.jsonl`);
      writeFileSync(file, jsonl([meta(cwd), turn('2026-10-01T12:00:00.000Z', 'gpt-5')]));
      return file;
    };
    const window = write(homeA, '00000000-0000-0000-0000-000000000001', project);
    const nested = write(homeB, '00000000-0000-0000-0000-000000000002', path.join(project, 'src'));
    write(homeA, '00000000-0000-0000-0000-000000000003', path.join(project, '.workbench', 'worktrees', 'task'));
    write(homeB, '00000000-0000-0000-0000-000000000004', path.join(root, 'elsewhere'));
    write(homeB, '00000000-0000-0000-0000-000000000005', project);

    const found = await findCodexProjectSessions(project, {
      homes: [homeA, homeB],
      skip: new Set(['00000000-0000-0000-0000-000000000005']),
      skipUnder: [path.join(project, '.workbench', 'worktrees')],
    });

    expect(found.map((session) => [session.sessionId, session.configDir, session.file]).sort()).toEqual([
      ['00000000-0000-0000-0000-000000000001', homeA, window],
      ['00000000-0000-0000-0000-000000000002', homeB, nested],
    ]);
  });
});
