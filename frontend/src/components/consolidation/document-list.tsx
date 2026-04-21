import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchConsolidationDocuments } from "@/api/consolidation";
import type { ConsolidationDocSummary } from "./types";

type SortKey = "additions" | "conflicts" | "gaps" | "progress" | "name";

export function DocumentList({ onSelect }: { onSelect: (slug: string) => void }) {
  const { data: docs, isLoading, error } = useQuery({
    queryKey: ["consolidation-documents"],
    queryFn: fetchConsolidationDocuments,
  });

  const [sortKey, setSortKey] = useState<SortKey>("additions");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!docs) return [];
    let list = docs;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.hp_filename.toLowerCase().includes(q) ||
          d.regions.some((r) => r.toLowerCase().includes(q)),
      );
    }
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "additions":
          return b.total_additions - a.total_additions;
        case "conflicts":
          return b.total_conflicts - a.total_conflicts;
        case "gaps":
          return b.total_gaps - a.total_gaps;
        case "progress":
          return progressPct(a) - progressPct(b);
        case "name":
          return a.hp_filename.localeCompare(b.hp_filename);
        default:
          return 0;
      }
    });
  }, [docs, sortKey, search]);

  const totalAdditions = docs?.reduce((s, d) => s + d.total_additions, 0) ?? 0;
  const totalConflicts = docs?.reduce((s, d) => s + d.total_conflicts, 0) ?? 0;
  const totalReviewed = docs?.reduce((s, d) => s + d.reviewed, 0) ?? 0;
  const totalReviewable = docs?.reduce((s, d) => s + d.total_reviewable, 0) ?? 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading consolidated documents...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400">
        Failed to load: {String(error)}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 space-y-4 shrink-0">
        <div>
          <h2 className="text-xl font-semibold">Consolidation Review</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Select an H&P document to review KCAD additions, conflicts, and new content.
          </p>
        </div>

        {/* Aggregate stats */}
        <div className="flex items-center gap-6 text-sm">
          <span>
            <strong>{docs?.length ?? 0}</strong> HP documents
          </span>
          <span>
            <strong>{totalAdditions}</strong> total changes
          </span>
          {totalConflicts > 0 && (
            <span className="text-red-400">
              <strong>{totalConflicts}</strong> conflicts
            </span>
          )}
          <span className="text-muted-foreground">
            {totalReviewed} / {totalReviewable} reviewed
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-border bg-background w-64 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-muted-foreground mr-1">Sort:</span>
            {(["additions", "conflicts", "gaps", "progress", "name"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setSortKey(k)}
                className={`px-2 py-1 text-xs rounded ${
                  sortKey === k
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {k === "additions" ? "Changes" : k.charAt(0).toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Document grid */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((doc) => (
            <DocCard key={doc.slug} doc={doc} onClick={() => onSelect(doc.slug)} />
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="text-center text-muted-foreground py-12">
            {search ? "No documents match your search." : "No consolidated documents available."}
          </div>
        )}
      </div>
    </div>
  );
}

function progressPct(d: ConsolidationDocSummary): number {
  return d.total_reviewable > 0 ? d.reviewed / d.total_reviewable : 1;
}

function DocCard({ doc, onClick }: { doc: ConsolidationDocSummary; onClick: () => void }) {
  const pct = progressPct(doc);
  const displayName =
    doc.hp_title ?? doc.hp_filename.replace(/\.pdf$/i, "").replace(/_/g, " ");
  const kcadList = doc.kcad_source_titles ?? [];

  return (
    <button
      onClick={onClick}
      className="text-left p-4 rounded-lg border border-border bg-card hover:border-primary transition-colors cursor-pointer"
    >
      <div className="font-medium text-sm leading-tight mb-2 line-clamp-2">{displayName}</div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-xs mb-2">
        {doc.total_additions > 0 && (
          <span className="text-amber-500 font-medium">{doc.total_additions} changes</span>
        )}
        {doc.total_conflicts > 0 && (
          <span className="text-red-400 font-medium">{doc.total_conflicts} conflicts</span>
        )}
        {doc.total_gaps > 0 && (
          <span className="text-violet-400 font-medium">{doc.total_gaps} new</span>
        )}
        {doc.total_additions === 0 && (
          <span className="text-muted-foreground">No changes</span>
        )}
      </div>

      {/* KCAD source list — natural-language titles with region tag */}
      {kcadList.length > 0 && (
        <div className="mb-2 rounded border border-border/60 bg-muted/20 p-2 text-xs">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            KCAD sources ({kcadList.length})
          </div>
          <ul className="space-y-0.5">
            {kcadList.map((k) => (
              <li key={k.filename} className="flex items-start gap-1.5">
                {k.region && (
                  <span className="shrink-0 mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
                    {k.region}
                  </span>
                )}
                <span className="flex-1 text-foreground leading-snug">
                  {k.title}
                  <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                    {k.filename.replace(/\.pdf$/i, "")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Regions (derived from KCAD list if titles unavailable) */}
      {kcadList.length === 0 && (doc.kcad_source_count > 0 || doc.regions.length > 0) && (
        <div className="text-xs text-muted-foreground mb-2">
          {doc.kcad_source_count} KCAD source{doc.kcad_source_count !== 1 ? "s" : ""}
          {doc.regions.length > 0 && <> &middot; {doc.regions.slice(0, 3).join(", ")}</>}
          {doc.regions.length > 3 && <> +{doc.regions.length - 3}</>}
        </div>
      )}

      {/* Progress bar */}
      {doc.total_reviewable > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary/60 rounded-full transition-all"
              style={{ width: `${Math.round(pct * 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {doc.reviewed}/{doc.total_reviewable}
          </span>
        </div>
      )}
    </button>
  );
}
