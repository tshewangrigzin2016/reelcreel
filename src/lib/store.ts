import { create } from "zustand";
import type { HealthInfo, JobState, Preset, Settings } from "@shared/types";

interface AppState {
  jobs: Record<string, JobState>;
  presets: Preset[];
  settings: Settings | null;
  health: HealthInfo | null;
  /** Downloaded with the exact format/options currently selected. */
  downloadedIds: Set<string>;
  /**
   * Downloaded in *any* format. Re-evaluation runs over these: a copy stored
   * under another preset is exactly the thing a format change should consider
   * converting rather than ignoring.
   */
  ownedIds: Set<string>;
  connected: boolean;
  /** Rows-as-a-list or rows-as-cards, shared by the selection table and queue. */
  layout: Layout;

  upsertJobs: (deltas: JobState[]) => void;
  setJobs: (jobs: JobState[]) => void;
  removeJobLocal: (id: string) => void;
  setPresets: (p: Preset[]) => void;
  setSettings: (s: Settings) => void;
  setHealth: (h: HealthInfo) => void;
  setDownloadedIds: (ids: string[]) => void;
  setOwnedIds: (ids: string[]) => void;
  setConnected: (c: boolean) => void;
  setLayout: (l: Layout) => void;
}

export type Layout = "list" | "grid";

/**
 * Read once at module load rather than through zustand's `persist` middleware,
 * which would try to serialize `jobs`, `health` and `connected` along with it.
 * Only the one key we care about ever touches storage.
 */
const LAYOUT_KEY = "ytd:layout";
const readLayout = (): Layout => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
};

export const useAppStore = create<AppState>((set) => ({
  jobs: {},
  presets: [],
  settings: null,
  health: null,
  downloadedIds: new Set(),
  ownedIds: new Set(),
  connected: false,
  layout: readLayout(),

  upsertJobs: (deltas) =>
    set((state) => {
      if (deltas.length === 0) return state;
      const jobs = { ...state.jobs };
      for (const d of deltas) jobs[d.id] = d;
      return { jobs };
    }),

  setJobs: (list) =>
    set(() => {
      const jobs: Record<string, JobState> = {};
      for (const j of list) jobs[j.id] = j;
      return { jobs };
    }),

  removeJobLocal: (id) =>
    set((state) => {
      const jobs = { ...state.jobs };
      delete jobs[id];
      return { jobs };
    }),

  setPresets: (presets) => set({ presets }),
  setSettings: (settings) => set({ settings }),
  setHealth: (health) => set({ health }),
  setDownloadedIds: (ids) => set({ downloadedIds: new Set(ids) }),
  setOwnedIds: (ids) => set({ ownedIds: new Set(ids) }),
  setConnected: (connected) => set({ connected }),

  setLayout: (layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* private-mode storage denial is not worth interrupting the toggle for */
    }
    set({ layout });
  },
}));

export const jobList = (s: AppState): JobState[] => Object.values(s.jobs);

export const activeJobCount = (s: AppState): number =>
  Object.values(s.jobs).filter(
    (j) =>
      j.phase === "downloading" ||
      j.phase === "postprocessing" ||
      j.phase === "queued",
  ).length;
