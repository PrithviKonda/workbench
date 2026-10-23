/**
 * GitHub issues and pull requests for the Kanban board (via the gh CLI in the project folder):
 * the GitHub dialog lists them to add as tasks, and task cards show the state of the ones they came from
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { GitHubItem, GitHubItemKind, GitHubItemStates } from '../../shared/types/github';
import { projectStore } from '../project-store';
import { runTool } from '../platform/runtime-exec';

const LIST_LIMIT = '100';
const ISSUE_FIELDS = 'number,title,body,url,state,labels,author,updatedAt';
const PR_FIELDS = 'number,title,body,url,state,labels,author,updatedAt,headRefName,isDraft';

/** gh's error, without its usage text */
function ghError(error: unknown): string {
  const stderr = String((error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : error)).trim();
  if (/not logged|auth login/i.test(stderr)) return 'GitHub CLI is not signed in. Run gh auth login in a terminal';
  if (/ENOENT|not found: gh|command not found/i.test(stderr)) return 'GitHub CLI (gh) is not installed';
  if (/no git remotes|not a git repository|could not determine/i.test(stderr)) return 'This project has no GitHub remote';
  return stderr.split('\n')[0] || 'GitHub request failed';
}

async function gh(projectPath: string, args: string[]): Promise<unknown> {
  const { stdout } = await runTool('gh', args, { cwd: projectPath, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(String(stdout) || '[]');
}

interface RawItem {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: string;
  labels?: Array<{ name: string }>;
  author?: { login?: string };
  updatedAt?: string;
  headRefName?: string;
  isDraft?: boolean;
}

function toItem(kind: GitHubItemKind, raw: RawItem): GitHubItem {
  return {
    kind,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    state: raw.state.toLowerCase() as GitHubItem['state'],
    labels: (raw.labels ?? []).map((label) => label.name),
    author: raw.author?.login,
    updatedAt: raw.updatedAt,
    branch: raw.headRefName,
    draft: raw.isDraft,
  };
}

export function registerGitHubHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.GITHUB_ITEMS_LIST,
    async (_event, projectId: string, kind: GitHubItemKind, state: 'open' | 'closed'): Promise<IPCResult<GitHubItem[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        // Closed pull requests include merged ones
        const ghState = kind === 'pr' && state === 'closed' ? 'all' : state;
        const raw = await gh(project.path, [kind === 'pr' ? 'pr' : 'issue', 'list', '--state', ghState, '--limit', LIST_LIMIT, '--json', kind === 'pr' ? PR_FIELDS : ISSUE_FIELDS]) as RawItem[];
        const items = raw.map((item) => toItem(kind, item));
        return { success: true, data: state === 'closed' ? items.filter((item) => item.state !== 'open') : items };
      } catch (error) {
        return { success: false, error: ghError(error) };
      }
    }
  );

  // State of every recent issue and pull request, for the GitHub chip on task cards
  ipcMain.handle(IPC_CHANNELS.GITHUB_ITEM_STATES, async (_event, projectId: string): Promise<IPCResult<GitHubItemStates>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      const [issues, prs] = await Promise.all([
        gh(project.path, ['issue', 'list', '--state', 'all', '--limit', '500', '--json', 'number,state']) as Promise<RawItem[]>,
        gh(project.path, ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,state']) as Promise<RawItem[]>,
      ]);
      const toMap = (items: RawItem[]) => Object.fromEntries(items.map((item) => [item.number, item.state.toLowerCase()])) as GitHubItemStates['issues'];
      const openIssues = issues.filter((item) => item.state === 'OPEN').map((item) => item.number);
      const openPrs = prs.filter((item) => item.state === 'OPEN').map((item) => item.number);
      return { success: true, data: { issues: toMap(issues), prs: toMap(prs), openIssues, openPrs } };
    } catch (error) {
      return { success: false, error: ghError(error) };
    }
  });
}
