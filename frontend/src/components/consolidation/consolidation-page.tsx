import { useCallback, useEffect, useState } from "react";
import { ConsolidatedFinalView } from "./consolidated-final-view";
import { DocumentList } from "./document-list";
import { DocumentReview } from "./document-review";

/** View modes per document.
 *  - "review":  full Reviewer View, own chrome
 *  - "unified": Unified Document preview, own chrome
 *  - "split":   Reviewer on the left, Unified on the right — reviewer edits
 *               propagate to the Unified preview instantly because both panes
 *               share the ["consolidated-view", slug] React Query cache key.
 *               Parent owns chrome; inner components render embedded.
 *  URL-backed so a page reload preserves the selected mode and so demo links
 *  are shareable. */
type ViewMode = "unified" | "review" | "split";

function readModeFromUrl(): ViewMode {
  if (typeof window === "undefined") return "split";
  const raw = new URLSearchParams(window.location.search).get("mode");
  if (raw === "review") return "review";
  if (raw === "unified") return "unified";
  return "split";
}

function writeModeToUrl(mode: ViewMode) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  // Default = split, so elide it from the URL for cleanliness.
  if (mode === "split") {
    params.delete("mode");
  } else {
    params.set("mode", mode);
  }
  const qs = params.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(window.history.state, "", url);
}

/**
 * Top-level consolidation page.
 * - No slug selected → show document list
 * - Slug selected: render the selected view mode, owning the back + mode-toggle chrome
 *   when in split mode (so the inner components can render without their own top bars).
 */
export function ConsolidationPage() {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>(readModeFromUrl);

  // Keep mode in sync with browser back/forward navigation.
  useEffect(() => {
    const onPop = () => setMode(readModeFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const updateMode = useCallback((next: ViewMode) => {
    setMode(next);
    writeModeToUrl(next);
  }, []);

  if (!selectedSlug) {
    return <DocumentList onSelect={setSelectedSlug} />;
  }

  const backToList = () => setSelectedSlug(null);

  if (mode === "review") {
    return (
      <DocumentReview
        slug={selectedSlug}
        onBack={backToList}
        onSwitchMode={() => updateMode("split")}
      />
    );
  }

  if (mode === "unified") {
    return (
      <ConsolidatedFinalView
        slug={selectedSlug}
        onBackToList={backToList}
        onSwitchMode={() => updateMode("split")}
      />
    );
  }

  // Split mode — parent owns chrome; inner components render embedded.
  return (
    <div className="flex h-full flex-col">
      <SplitChrome
        slug={selectedSlug}
        mode={mode}
        onBack={backToList}
        onModeChange={updateMode}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Reviewer. Mutations here invalidate the view query key,
            which the right pane is also subscribed to — instant propagation. */}
        <div className="flex-1 min-w-0 border-r border-zinc-200 dark:border-zinc-800">
          <DocumentReview
            slug={selectedSlug}
            onBack={backToList}
            embedded
          />
        </div>
        {/* Right: Unified preview. Deterministic render from the live view JSON. */}
        <div className="flex-1 min-w-0">
          <ConsolidatedFinalView
            slug={selectedSlug}
            onBackToList={backToList}
            onSwitchMode={() => updateMode("unified")}
            embedded
          />
        </div>
      </div>
    </div>
  );
}

function SplitChrome({
  slug,
  mode,
  onBack,
  onModeChange,
}: {
  slug: string;
  mode: ViewMode;
  onBack: () => void;
  onModeChange: (m: ViewMode) => void;
}) {
  const displayName = slug.replace(/_pdf$/, "").replace(/_/g, " ");
  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50/80 px-4 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/80">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onBack}
          className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 shrink-0"
        >
          ← Documents
        </button>
        <span className="truncate font-medium text-zinc-800 dark:text-zinc-100">
          {displayName}
        </span>
      </div>
      <div className="inline-flex items-center rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700 shrink-0">
        {(["review", "split", "unified"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className={
              mode === m
                ? "rounded bg-zinc-900 px-2.5 py-0.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "px-2.5 py-0.5 text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }
            title={
              m === "review"
                ? "Full Reviewer View — accept, dismiss, edit, appendix assign"
                : m === "split"
                ? "Split — Reviewer on the left, Unified preview on the right. Edits propagate instantly."
                : "Unified Document — preview only, shows the signable output"
            }
          >
            {m === "review" ? "Review" : m === "split" ? "Split ⇄" : "Unified"}
          </button>
        ))}
      </div>
    </div>
  );
}
