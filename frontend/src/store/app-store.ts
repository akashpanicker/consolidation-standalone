import { create } from "zustand";

export type Tab = "extraction" | "metadata" | "chunks";
export type AppView = "pipeline" | "clustering" | "search" | "taxonomy" | "consolidation";
export type ViewMode = "rendered" | "raw";
export type SourceFilter = "all" | "hp" | "kcad";
export type SortMode = "status" | "alpha" | "recent";
export type ExtractionMethod = "llm" | "docling";
export type ChunkSource = "llm" | "docling";

interface AppState {
  // Top-level view
  appView: AppView;
  setAppView: (view: AppView) => void;
  // Document pipeline
  selectedDoc: string | null;
  selectDoc: (filename: string | null) => void;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  sourceFilter: SourceFilter;
  setSourceFilter: (filter: SourceFilter) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchMatches: Record<string, number> | null;
  setSearchMatches: (matches: Record<string, number> | null) => void;
  // Multi-select for batch
  selectedDocs: Set<string>;
  toggleDocSelection: (filename: string) => void;
  selectAllDocs: (filenames: string[]) => void;
  clearDocSelection: () => void;
  // Favorites
  favorites: Set<string>;
  toggleFavorite: (filename: string) => void;
  showFavoritesOnly: boolean;
  setShowFavoritesOnly: (show: boolean) => void;
  // Sorting
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  // Extraction method
  extractionMethod: ExtractionMethod;
  setExtractionMethod: (method: ExtractionMethod) => void;
  chunkSource: ChunkSource;
  setChunkSource: (source: ChunkSource) => void;
  // Theme
  darkMode: boolean;
  toggleDarkMode: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  appView: "consolidation",
  setAppView: (view) => set({ appView: view }),
  selectedDoc: null,
  selectDoc: (filename) => set({ selectedDoc: filename }),
  activeTab: "extraction",
  setActiveTab: (tab) => set({ activeTab: tab }),
  viewMode: "rendered",
  setViewMode: (mode) => set({ viewMode: mode }),
  sourceFilter: "all",
  setSourceFilter: (filter) => set({ sourceFilter: filter }),
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),
  searchMatches: null,
  setSearchMatches: (matches) => set({ searchMatches: matches }),
  selectedDocs: new Set<string>(),
  toggleDocSelection: (filename) =>
    set((s) => {
      const next = new Set(s.selectedDocs);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return { selectedDocs: next };
    }),
  selectAllDocs: (filenames) => set({ selectedDocs: new Set(filenames) }),
  clearDocSelection: () => set({ selectedDocs: new Set<string>() }),
  favorites: (() => {
    try {
      const raw = localStorage.getItem("favorites");
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  })(),
  toggleFavorite: (filename) =>
    set((s) => {
      const next = new Set(s.favorites);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      localStorage.setItem("favorites", JSON.stringify([...next]));
      return { favorites: next };
    }),
  showFavoritesOnly: false,
  setShowFavoritesOnly: (show) => set({ showFavoritesOnly: show }),
  sortMode: "status",
  setSortMode: (mode) => set({ sortMode: mode }),
  extractionMethod: "docling",
  setExtractionMethod: (method) => set({ extractionMethod: method }),
  chunkSource: "docling" as ChunkSource,
  setChunkSource: (source) => set({ chunkSource: source }),
  darkMode: localStorage.getItem("theme") === "dark",
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      localStorage.setItem("theme", next ? "dark" : "light");
      document.documentElement.classList.toggle("dark", next);
      return { darkMode: next };
    }),
}));
