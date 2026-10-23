/** GitHub issues and pull requests shown on the Kanban board */

export type GitHubItemKind = 'issue' | 'pr';

export interface GitHubItem {
  kind: GitHubItemKind;
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  labels: string[];
  author?: string;
  updatedAt?: string;
  /** Pull requests: the head branch */
  branch?: string;
  draft?: boolean;
}

/** Current state by number, and the open ones (for the board's summary line) */
export interface GitHubItemStates {
  issues: Record<number, GitHubItem['state']>;
  prs: Record<number, GitHubItem['state']>;
  openIssues: number[];
  openPrs: number[];
}
