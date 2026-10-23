/**
 * GitHub issue and pull request states per project, for the GitHub chips on task cards and the
 * board's summary line. Fetched once per project (and again when the board is refreshed).
 */
import { create } from 'zustand';
import type { GitHubItemStates } from '../../shared/types';

interface GitHubStore {
  states: Record<string, GitHubItemStates | undefined>;
  errors: Record<string, string | undefined>;
  load: (projectId: string, force?: boolean) => Promise<void>;
}

const inFlight = new Set<string>();

export const useGitHubStore = create<GitHubStore>((set, get) => ({
  states: {},
  errors: {},
  load: async (projectId, force = false) => {
    if (inFlight.has(projectId) || (!force && (get().states[projectId] || get().errors[projectId]))) return;
    inFlight.add(projectId);
    try {
      const result = await window.electronAPI.getGitHubItemStates(projectId);
      set((s) => ({
        states: { ...s.states, [projectId]: result.success ? result.data : s.states[projectId] },
        errors: { ...s.errors, [projectId]: result.success ? undefined : result.error },
      }));
    } finally {
      inFlight.delete(projectId);
    }
  },
}));
