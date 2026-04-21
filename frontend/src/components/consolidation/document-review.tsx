import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { ArrowRight, ArrowLeft, ArrowUp, ArrowDown, Check, Lock, X, Eye, EyeOff, Pencil } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type Actor,
  ConcurrencyError,
  addComment,
  assignBlocksToAppendix,
  createAppendix,
  deleteAppendix,
  deleteComment,
  detectViewLanguages,
  fetchConsolidatedView,
  fetchDocumentContext,
  listAppendices,
  matchAppendix,
  moveBlock,
  moveBlockTo,
  polishSection,
  reclassifyBlock,
  restoreBlock,
  revertBlock,
  submitBlockAction,
  undoLast,
  updateDocumentStatus,
} from "@/api/consolidation";
import { useAuth } from "@/hooks/useAuth";
import {
  type Appendix,
  type AppendixScope,
  type ConsolidatedBlock,
  type ConsolidatedView,
  type ReviewStatus,
  isActionable,
  isReviewed,
  relationshipLabel,
} from "./types";
import { DetailPanel } from "./detail-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  LanguageBadge,
  TranslateToggle,
  TranslationError,
  useChunkTranslation,
} from "./translation-toggle";
import { FormatBadge, NormativeModeBadge } from "./classification-badges";

/** Strip leading markdown headings (and blank separators) from chunk text.
 *  Chunks frequently arrive with their own doc-title or section heading at
 *  the top (e.g. `# Hydrogen Sulfide Policy`, `## 2.0 Introduction`, or a
 *  KCAD source title like `## Policy Statement on Stop Work Authority`) —
 *  these duplicate the section heading rendered above the chunk and create
 *  visual noise. Strip them before passing to ReactMarkdown. Headings
 *  further down in the chunk body are preserved. */
function stripLeadingMarkdownHeadings(text: string | undefined | null): string {
  if (!text) return text ?? "";
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "") {
      i++;
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n");
}

// ── Section grouping ────────────────────────────────────────────────────

interface Section {
  heading: string;
  depth: number;
  blocks: ConsolidatedBlock[];
  anchorId: string;
}

/** Group blocks into sections by heading_path changes. */
function groupIntoSections(blocks: ConsolidatedBlock[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const block of blocks) {
    const heading = block.heading_path || "(Untitled)";
    // Start a new section when the heading changes
    if (!current || current.heading !== heading) {
      current = {
        heading,
        depth: (heading.match(/>/g) || []).length,
        blocks: [],
        anchorId: `section-${sections.length}`,
      };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  return sections;
}

// ── View filter ─────────────────────────────────────────────────────────

type ViewFilter = "all" | "changes" | "conflicts" | "unreviewed";

const RELATIONSHIP_CHIPS = ["Equivalent", "Variant", "Complementary", "Gap", "Conflict"] as const;
type RelationshipChip = (typeof RELATIONSHIP_CHIPS)[number];

const NORMATIVE_CHIPS = ["policy", "standard", "procedure", "guideline", "informational"] as const;

/** Map a block to its relationship-chip identity. Conflict and Gap are
 *  driven by `type` (the pipeline doesn't set relationship on those); the
 *  other three live on `relationship`. Returns null for hp_original /
 *  gap_header / user-authored blocks that aren't subject to the chip filter. */
function relationshipChip(b: ConsolidatedBlock): RelationshipChip | null {
  if (b.type === "conflict") return "Conflict";
  if (b.type === "gap") return "Gap";
  if (b.relationship === "Equivalent") return "Equivalent";
  if (b.relationship === "Variant") return "Variant";
  if (b.relationship === "Complementary") return "Complementary";
  return null;
}

function filterByView(blocks: ConsolidatedBlock[], filter: ViewFilter): Set<string> {
  const visible = new Set<string>();
  for (const b of blocks) {
    switch (filter) {
      case "all":
        visible.add(b.id);
        break;
      case "changes":
        if (isActionable(b) || b.status === "has_additions") visible.add(b.id);
        break;
      case "conflicts":
        if (b.type === "conflict") visible.add(b.id);
        break;
      case "unreviewed":
        if (isActionable(b) && !isReviewed(b)) visible.add(b.id);
        break;
    }
  }
  return visible;
}

/** Intersect the view filter with the multi-select chip filters.
 *  An empty chip set = that filter is off (no intersection). An active
 *  chip set = keep only blocks matching ≥1 chip value (OR within group,
 *  AND across groups). hp_original and gap_header blocks are kept
 *  unconditionally for layout integrity — chips filter actionable blocks. */
function applyAllFilters(
  blocks: ConsolidatedBlock[],
  viewFilter: ViewFilter,
  normative: Set<string>,
  relationships: Set<string>,
): Set<string> {
  const base = filterByView(blocks, viewFilter);
  const hasNormative = normative.size > 0;
  const hasRelationship = relationships.size > 0;
  if (!hasNormative && !hasRelationship) return base;

  const visible = new Set<string>();
  for (const b of blocks) {
    if (!base.has(b.id)) continue;
    // Structural blocks (HP originals, gap headers) are filter-exempt so
    // the document still reads in order when chips are active. Note: this
    // load-bearing only for viewFilter="all"; other view filters already
    // exclude HP blocks from `base`, so chip narrowing then can't reintroduce
    // them. Intentional — users picking "Conflicts" + chips want just the
    // matching conflicts, not the surrounding HP prose.
    if (b.type === "hp_original" || b.type === "gap_header") {
      visible.add(b.id);
      continue;
    }
    if (hasNormative && !normative.has(b.normative_mode ?? "")) continue;
    if (hasRelationship) {
      const chip = relationshipChip(b);
      if (!chip || !relationships.has(chip)) continue;
    }
    visible.add(b.id);
  }
  return visible;
}

// ── URL-backed flag state ───────────────────────────────────────────────

/** Boolean flag persisted to a URL search param (presence = true). Same
 *  back/forward behaviour as useUrlSetParam — paired so review state stays
 *  shareable across both set and scalar switches. */
function useUrlFlag(key: string): [boolean, (next: boolean) => void] {
  const readFromUrl = useCallback((): boolean => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has(key);
  }, [key]);

  const [value, setValue] = useState<boolean>(readFromUrl);

  useEffect(() => {
    const onPop = () => setValue(readFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [readFromUrl]);

  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      const params = new URLSearchParams(window.location.search);
      if (next) params.set(key, "1");
      else params.delete(key);
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", url);
    },
    [key],
  );

  return [value, update];
}

// ── URL-backed Set state ────────────────────────────────────────────────

/** Two-way binding between a Set<string> and a comma-separated URL search
 *  param. Syncs on set() via history.replaceState so we don't spam the
 *  back-stack, and re-reads on popstate so browser back/forward restores
 *  the filter. Small + standalone — no need to pull in react-router. */
function useUrlSetParam(key: string): [Set<string>, (next: Set<string>) => void] {
  const readFromUrl = useCallback((): Set<string> => {
    if (typeof window === "undefined") return new Set();
    const raw = new URLSearchParams(window.location.search).get(key);
    if (!raw) return new Set();
    return new Set(raw.split(",").filter(Boolean));
  }, [key]);

  const [value, setValue] = useState<Set<string>>(readFromUrl);

  useEffect(() => {
    const onPop = () => setValue(readFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [readFromUrl]);

  const update = useCallback(
    (next: Set<string>) => {
      setValue(next);
      const params = new URLSearchParams(window.location.search);
      if (next.size === 0) {
        params.delete(key);
      } else {
        params.set(key, [...next].join(","));
      }
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(window.history.state, "", url);
    },
    [key],
  );

  return [value, update];
}

/** Hook for localStorage boolean flag so it persists across reloads */
function useLocalStorageFlag(key: string, defaultValue: boolean): [boolean, (val: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultValue;
    const stored = window.localStorage.getItem(key);
    return stored !== null ? stored === "true" : defaultValue;
  });

  const updateValue = useCallback((next: boolean) => {
    setValue(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, String(next));
    }
  }, [key]);

  return [value, updateValue];
}

// ── Appendix assign dialog state ───────────────────────────────────────

/** In-flight state while the user picks / creates an appendix for a block.
 *  `existingMatch` is populated when matchAppendix() returned a compatible
 *  appendix; the dialog surfaces it as the default route target. */
interface AppendixDialogState {
  blockId: string;
  scope: AppendixScope;
  existingMatch: Appendix | null;
  defaultName: string;
}

// ── Main component ──────────────────────────────────────────────────────

export function DocumentReview({
  slug,
  onBack,
  embedded = false,
}: {
  slug: string;
  onBack: () => void;
  /** When true, suppress this component's own top bar (ReviewHeader).
   *  The parent (ConsolidationPage in split mode) owns chrome. */
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const authUser = useAuth();
  const actor: Actor = {
    name: authUser?.name ?? "",
    email: authUser?.email ?? "",
  };
  const { data: viewWithEtag, isLoading, error } = useQuery({
    queryKey: ["consolidated-view", slug],
    queryFn: () => fetchConsolidatedView(slug),
  });
  const data = viewWithEtag?.view;
  const etag = viewWithEtag?.etag ?? "";

  // Appendix list refetches after any assign/create/delete by invalidating
  // this queryKey alongside the view key. Kept as a separate query so the
  // list stays fresh independent of block-level mutations.
  const { data: appendicesData } = useQuery({
    queryKey: ["appendix-list", slug],
    queryFn: () => listAppendices(slug),
  });

  // Document context (HP + KCAD source metadata: document_details +
  // concept_classification). Used to pre-fill ALL 4 appendix-scope variants
  // (Region, Rig, Customer, Environment) rather than just Region + Rig.
  // Environment and Customer live on the source doc's metadata, not on
  // individual blocks — they must be looked up from the context payload.
  const { data: docContext } = useQuery({
    queryKey: ["consolidation-context", slug],
    queryFn: () => fetchDocumentContext(slug),
  });
  const appendices = appendicesData?.appendices ?? [];

  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [viewFilter, setViewFilter] = useState<ViewFilter>("all");
  const [normativeFilter, setNormativeFilter] = useUrlSetParam("nm");
  const [relationshipFilter, setRelationshipFilter] = useUrlSetParam("rel");
  const [showSources, setShowSources] = useUrlFlag("sources");
  const [showChunks, setShowChunks] = useLocalStorageFlag("showChunks", true);

  // If showChunks becomes disabled, clear out any selected chunk since it's hidden now
  useEffect(() => {
    if (!showChunks) {
      setSelectedBlockId(null);
    }
  }, [showChunks]);

  /** State for the Add-to-Appendix dialog. null = closed; populated object
   *  = dialog is open with the given block + scope + any matching existing
   *  appendix surfaced from matchAppendix(). */
  const [appendixDialog, setAppendixDialog] = useState<AppendixDialogState | null>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

  // One-shot migration: if any KCAD block lacks a `language` field (legacy views
  // built before language detection was part of reconstruction), hit the batch
  // detect endpoint then refetch. Backend is idempotent — safe if it's a no-op.
  const needsLanguageDetection = useMemo(() => {
    if (!data) return false;
    return data.blocks.some(
      (b) =>
        (b.type === "kcad_addition" || b.type === "conflict" || b.type === "gap") &&
        !b.language,
    );
  }, [data]);

  useEffect(() => {
    if (!needsLanguageDetection) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await detectViewLanguages(slug);
        if (cancelled) return;
        if (result.updated > 0) {
          queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
        }
      } catch (e) {
        // Silent: detection is a progressive enhancement. Users can still translate
        // individual blocks — backend detects on the fly for that path.
        console.warn("View language detection failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, needsLanguageDetection, queryClient]);

  // Document-wide read-only flag. Backend's _check_not_published guards
  // every mutation at the router level; this mirrors the state into the UI
  // so reviewers see disabled controls and a banner rather than toast-
  // storm-of-409s when they click published-locked buttons.
  const isLocked = data?.review_status === "published";

  const sections = useMemo(() => (data ? groupIntoSections(data.blocks) : []), [data]);
  const visibleIds = useMemo(
    () =>
      data
        ? applyAllFilters(data.blocks, viewFilter, normativeFilter, relationshipFilter)
        : new Set<string>(),
    [data, viewFilter, normativeFilter, relationshipFilter],
  );
  const filtersActive =
    viewFilter !== "all" || normativeFilter.size > 0 || relationshipFilter.size > 0;

  const selectedBlock = useMemo(
    () => data?.blocks.find((b) => b.id === selectedBlockId) ?? null,
    [data, selectedBlockId],
  );

  // Progress stats
  const actionableBlocks = useMemo(() => data?.blocks.filter(isActionable) ?? [], [data]);
  const reviewedCount = useMemo(() => actionableBlocks.filter(isReviewed).length, [actionableBlocks]);

  /** Is there any action to undo? Combines block histories + polish_history —
   *  matches what the backend /undo/last scans. We don't need to compute the
   *  exact target here; the backend picks the most-recent one authoritatively.
   *  This is just the "Undo button enabled?" gate. */
  const canUndoAnything = useMemo(() => {
    if (!data) return false;
    for (const b of data.blocks) {
      if (b.history && b.history.length > 0) return true;
    }
    const polishHistory = (data as unknown as { polish_history?: unknown[] }).polish_history;
    if (Array.isArray(polishHistory) && polishHistory.length > 0) return true;
    return false;
  }, [data]);

  // Jump to next unreviewed
  const jumpToNext = useCallback(() => {
    if (!data) return;
    const next = data.blocks.find((b) => isActionable(b) && !isReviewed(b));
    if (next) {
      setSelectedBlockId(next.id);
      // Scroll block into view
      const el = document.getElementById(`block-${next.id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [data]);

  // Handle block action (accept, dismiss, etc.)
  const handleAction = useCallback(
    async (blockId: string, action: string, opts?: { note?: string; edited_text?: string; resolution?: string }) => {
      if (!etag) {
        console.warn("Cannot submit action: no ETag for current view");
        return;
      }
      if (isLocked) return; // backend enforces; UI disable prevents click path, this is defense-in-depth
      try {
        const { etag: newEtag } = await submitBlockAction(slug, etag, actor, blockId, action, opts);
        // Optimistic update: patch the local query cache with new block state AND new etag.
        // Reset ("pending") wipes edited_text + resolution to match the backend — otherwise
        // the UI flashes the stale edit for one frame until the next refetch.
        const resetting = action === "pending";
        queryClient.setQueryData<{ view: ConsolidatedView; etag: string }>(
          ["consolidated-view", slug],
          (old) => {
            if (!old) return old;
            return {
              etag: newEtag,
              view: {
                ...old.view,
                blocks: old.view.blocks.map((b) => {
                  if (b.id !== blockId) return b;
                  const next: ConsolidatedBlock = {
                    ...b,
                    status: action as ConsolidatedBlock["status"],
                    reviewer_note: opts?.note ?? b.reviewer_note,
                    edited_text: opts?.edited_text ?? b.edited_text,
                    resolution: opts?.resolution ?? b.resolution,
                  };
                  if (resetting) {
                    next.edited_text = undefined;
                    next.resolution = undefined;
                  }
                  return next;
                }),
              },
            };
          },
        );
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          // Someone else changed the doc. Update the cache with their state and
          // let the user retry. A future step will show a conflict-resolution UI.
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
          console.warn("Concurrent edit detected; view refreshed to latest server state");
        } else {
          throw err;
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Move a block one step up or down. Boundary errors (already first/last) are
   *  silent no-ops — the UI's arrow button disables itself at extremes, but we
   *  keep the backend as the source of truth. Refetches the view to reflect the
   *  new ordering; the visual cost of that full re-render is negligible at
   *  document size (~100s of blocks) and far simpler than an optimistic swap. */
  const handleMoveBlock = useCallback(
    async (blockId: string, direction: "up" | "down") => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        await moveBlock(slug, currentEtag, actor, blockId, direction);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          // Boundary violations come back as 400s — log and swallow.
          console.warn("Move failed:", err);
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Drag-and-drop reorder. Takes source + target block IDs and resolves
   *  their current array positions, then issues a single `move_to` call —
   *  replaces what would otherwise be N iterative up/down calls for a
   *  long drop. */
  const handleDropBlock = useCallback(
    async (sourceBlockId: string, targetBlockId: string) => {
      if (isLocked) return;
      if (sourceBlockId === targetBlockId) return;
      const cached = queryClient.getQueryData<{ view: ConsolidatedView; etag: string }>(
        ["consolidated-view", slug],
      );
      if (!cached) return;
      const blocks = cached.view.blocks;
      const targetIdx = blocks.findIndex((b) => b.id === targetBlockId);
      if (targetIdx < 0) return;
      try {
        await moveBlockTo(slug, cached.etag, actor, sourceBlockId, targetIdx);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.warn("Drop move failed:", err);
        }
      }
    },
    [slug, actor, queryClient, isLocked],
  );

  /** Per-section polish — triggered from the Detail Panel's "Update
   *  Consolidated Version" CTA. Runs the LLM merge for the given
   *  heading_path using the current reviewer state (accepted/edited blocks,
   *  conflict resolutions, appendix assignments). Result lands on
   *  `view.unified_overrides[heading_path]`; the Unified pane re-renders via
   *  React Query invalidation. In-flight state is tracked per heading_path so
   *  the button can show "Updating…" without blocking other sections. */
  const [polishingSections, setPolishingSections] = useState<Set<string>>(new Set());
  const handleUpdateUnified = useCallback(
    async (headingPath: string) => {
      if (isLocked) return;
      const current = queryClient.getQueryData<{ view: ConsolidatedView; etag: string }>(
        ["consolidated-view", slug],
      );
      const currentEtag = current?.etag ?? "";
      if (!currentEtag) return;
      setPolishingSections((p) => new Set(p).add(headingPath));
      try {
        await polishSection(slug, currentEtag, actor, headingPath);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Update Consolidated failed:", err);
          window.alert(`Update Consolidated Version failed: ${(err as Error).message}`);
        }
      } finally {
        setPolishingSections((p) => {
          const next = new Set(p);
          next.delete(headingPath);
          return next;
        });
      }
    },
    [slug, actor, queryClient, isLocked],
  );

  /** Revert a block to the state after a specific history version. The server
   *  restores the snapshotted `after` of that version and writes a new
   *  history entry recording the revert. Invalidation keeps the UI in sync
   *  rather than trying to optimistically apply the snapshot locally. */
  const handleRevert = useCallback(
    async (blockId: string, version: number) => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        await revertBlock(slug, currentEtag, actor, blockId, version);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Revert failed:", err);
          window.alert("Could not revert. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Restore a previously removed block back to 'pending'. Same invalidation
   *  pattern as move — the block's re-ordering relative to the document is
   *  server-authoritative. */
  const handleRestoreBlock = useCallback(
    async (blockId: string) => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        await restoreBlock(slug, currentEtag, actor, blockId);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Restore failed:", err);
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Advance or revert the document-level review status. Backend's
   *  VALID_STATUS_TRANSITIONS enforces which transitions are allowed from
   *  each state; the UI only surfaces buttons for legal moves, but the
   *  server is the source of truth. Invalidate to refetch the bumped etag
   *  and any server-side side effects. */
  const handleChangeStatus = useCallback(
    async (target: ReviewStatus) => {
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        await updateDocumentStatus(slug, currentEtag, actor, target);
        await queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] });
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Status change failed:", err);
          window.alert("Could not change status. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Add a comment to a block. Returns the new comment + bumped ETag; we
   *  append optimistically so the reviewer sees their comment instantly —
   *  on ConcurrencyError we fall back to refetching (rare: another user
   *  just edited the same view). block.comments may be undefined on a
   *  never-commented block, so default to [] before spreading. */
  const handleAddComment = useCallback(
    async (blockId: string, text: string) => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag || !text.trim()) return;
      try {
        const { result, etag: newEtag } = await addComment(
          slug,
          currentEtag,
          actor,
          blockId,
          text.trim(),
        );
        queryClient.setQueryData<{ view: ConsolidatedView; etag: string }>(
          ["consolidated-view", slug],
          (old) => {
            if (!old) return old;
            return {
              etag: newEtag,
              view: {
                ...old.view,
                blocks: old.view.blocks.map((b) =>
                  b.id === blockId
                    ? { ...b, comments: [...(b.comments ?? []), result.comment] }
                    : b,
                ),
              },
            };
          },
        );
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Add comment failed:", err);
          window.alert("Could not post comment. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Delete a comment. Server enforces ownership; client hides the delete
   *  button for non-owners as a UX guard. Optimistic filter-by-id — the
   *  ?? [] guard isn't strictly necessary here (you can't delete from a
   *  block with no comments) but it keeps the types honest. */
  const handleDeleteComment = useCallback(
    async (blockId: string, commentId: string) => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        const { etag: newEtag } = await deleteComment(
          slug,
          currentEtag,
          actor,
          blockId,
          commentId,
        );
        queryClient.setQueryData<{ view: ConsolidatedView; etag: string }>(
          ["consolidated-view", slug],
          (old) => {
            if (!old) return old;
            return {
              etag: newEtag,
              view: {
                ...old.view,
                blocks: old.view.blocks.map((b) =>
                  b.id === blockId
                    ? { ...b, comments: (b.comments ?? []).filter((c) => c.id !== commentId) }
                    : b,
                ),
              },
            };
          },
        );
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Delete comment failed:", err);
          window.alert("Could not delete comment. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient],
  );

  /** Manually override the AI's relationship classification on a block.
   *  Bumps etag + invalidates so the new relationship takes effect in the
   *  ActionBar (which dispatches on block.relationship) without any extra
   *  coordination. Optimistic update patches block.relationship so the
   *  action-panel switch feels instant. */
  const handleReclassify = useCallback(
    async (blockId: string, relationship: "Equivalent" | "Variant" | "Complementary" | "Related") => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        const { etag: newEtag } = await reclassifyBlock(slug, currentEtag, actor, blockId, relationship);
        queryClient.setQueryData<{ view: ConsolidatedView; etag: string }>(
          ["consolidated-view", slug],
          (old) => {
            if (!old) return old;
            return {
              etag: newEtag,
              view: {
                ...old.view,
                blocks: old.view.blocks.map((b) =>
                  b.id === blockId ? { ...b, relationship } : b,
                ),
              },
            };
          },
        );
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Reclassify failed:", err);
          window.alert("Could not reclassify. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient, isLocked],
  );

  /** Document-wide Undo: reverts the most recent action anywhere in the doc.
   *  - If the block's most recent history entry is version >= 2, revert to
   *    version-1 (restores the state after the second-most-recent action).
   *  - If it's version 1 (first action on this block), there's no prior
   *    version to restore — fall back to action="pending", which wipes
   *    edited_text + resolution on the server and effectively undoes the
   *    first user decision. The reset itself becomes version 2 in history. */
  /** Unified undo — sends a single POST to /undo/last. The backend scans
   *  both block history and polish_history and reverses whichever entry has
   *  the latest timestamp. Replaces the older per-block-only undo path so a
   *  reviewer who just polished a section can undo the polish in one click
   *  (and a reviewer who just accepted a block can undo the accept). */
  const handleUndoLast = useCallback(async () => {
    if (isLocked) return;
    const cached = queryClient.getQueryData<{ view: ConsolidatedView; etag: string }>(
      ["consolidated-view", slug],
    );
    const currentEtag = cached?.etag ?? etag;
    if (!currentEtag) return;
    try {
      await undoLast(slug, currentEtag, actor);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] }),
        queryClient.invalidateQueries({ queryKey: ["appendix-list", slug] }),
      ]);
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        queryClient.setQueryData(["consolidated-view", slug], {
          view: err.currentView,
          etag: err.currentEtag,
        });
      } else {
        console.error("Undo failed:", err);
      }
    }
  }, [slug, etag, actor, queryClient, isLocked]);

  /** Route a Variant block to an appendix. Opens AppendixAssignDialog with
   *  the block's scope + any existing-scoped-appendix surfaced by
   *  matchAppendix(). The dialog owns the name input + confirm UX; this
   *  handler's job is setup + matching + error paths.
   *
   *  Scope derivation — all 4 variants supported:
   *  - Region, Rig: from block.source.* (block-level, set by the pipeline)
   *  - Customer, Environment: from the KCAD source doc's document_details
   *    metadata (docContext.kcad[].details.named_fields). When the source doc
   *    is a regional doc (K-*-*) whose details name a customer or environment,
   *    we pre-fill. The dialog allows the user to override / clear. */
  const handleAssignToAppendix = useCallback(
    async (blockId: string) => {
      if (isLocked) return;
      if (!etag) return;
      const block = data?.blocks.find((b) => b.id === blockId);
      if (!block) return;

      // Derive customer + environment from the KCAD source doc's metadata.
      const sourceDoc = block.source.document || "";
      const kcadEntry = docContext?.kcad?.find((k) => k.filename === sourceDoc);
      const named = kcadEntry?.details?.named_fields ?? {};
      const customerFromMeta =
        named["customer"] ||
        named["operator"] ||
        named["client"] ||
        null;
      const environmentFromMeta =
        named["environment"] ||
        named["operating environment"] ||
        // Inference from rig label: offshore rig types → "Offshore"; land → "Onshore".
        // Only set when unambiguous — don't guess on "All Rigs" or blank.
        (block.source.rig && /offshore/i.test(block.source.rig)
          ? "Offshore"
          : block.source.rig && /land|onshore/i.test(block.source.rig)
            ? "Onshore"
            : null);

      const scope: AppendixScope = {
        region: block.source.region ?? null,
        rig: block.source.rig ?? null,
        customer: customerFromMeta ?? null,
        environment: environmentFromMeta ?? null,
      };
      try {
        const existing = await matchAppendix(slug, scope);
        // Name proposal: lead with region + environment, then rig + customer.
        // Falls back to "Appendix" if nothing is set — the dialog requires the
        // user to enter a name before creating.
        const defaultName =
          [scope.region, scope.environment, scope.rig, scope.customer]
            .filter(Boolean)
            .slice(0, 2) // cap at 2 parts so the name stays legible
            .join(" — ") || "Appendix";
        setAppendixDialog({
          blockId,
          scope,
          existingMatch: existing.appendix ?? null,
          defaultName,
        });
      } catch (err) {
        console.error("matchAppendix failed:", err);
        window.alert("Could not look up matching appendix. See console for details.");
      }
    },
    [slug, etag, isLocked, data, docContext],
  );

  /** Perform the actual assign operation after the dialog confirms. When
   *  existingId is set, route to that appendix; otherwise create a new one
   *  using the provided name + scope, then assign the block to it.
   *  Refetch to surface appendix_id/appendix_name on the block. */
  const confirmAppendixAssign = useCallback(
    async (choice: { existingId: string | null; name: string; scope: AppendixScope; blockId: string }) => {
      if (isLocked) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;

      try {
        let appendixId = choice.existingId;
        let nextEtag = currentEtag;
        if (!appendixId) {
          const created = await createAppendix(slug, currentEtag, actor, choice.name, choice.scope);
          appendixId = created.result.appendix.id;
          nextEtag = created.etag;
        }
        await assignBlocksToAppendix(slug, nextEtag, actor, appendixId, [choice.blockId]);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] }),
          queryClient.invalidateQueries({ queryKey: ["appendix-list", slug] }),
        ]);
        setAppendixDialog(null);
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
          console.warn("Concurrent edit during appendix assign; view refreshed");
        } else {
          console.error("Appendix assign failed:", err);
          window.alert("Could not assign to appendix. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient, isLocked],
  );

  /** Delete an appendix. Backend unassigns all blocks that were routed to
   *  it as a side effect (writes block-level history entries per
   *  unassignment). Per-block unassign isn't an endpoint yet — users who
   *  need finer control revert via block history. */
  const handleDeleteAppendix = useCallback(
    async (appendixId: string, name: string) => {
      if (isLocked) return;
      const ok = window.confirm(
        `Delete appendix "${name}"? All routed blocks will be unassigned.`,
      );
      if (!ok) return;
      const currentEtag =
        queryClient.getQueryData<{ etag: string }>(["consolidated-view", slug])?.etag ?? etag;
      if (!currentEtag) return;
      try {
        await deleteAppendix(slug, currentEtag, actor, appendixId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["consolidated-view", slug] }),
          queryClient.invalidateQueries({ queryKey: ["appendix-list", slug] }),
        ]);
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          queryClient.setQueryData(["consolidated-view", slug], {
            view: err.currentView,
            etag: err.currentEtag,
          });
        } else {
          console.error("Delete appendix failed:", err);
          window.alert("Could not delete appendix. See console for details.");
        }
      }
    },
    [slug, etag, actor, queryClient, isLocked],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading document...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-full text-red-400">
        {error ? String(error) : "No data"}
      </div>
    );
  }

  const displayName = data.hp_filename.replace(/\.pdf$/i, "").replace(/_/g, " ");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Header ── */}
      {!embedded && (
        <ReviewHeader
          displayName={displayName}
          summary={data.summary}
          viewFilter={viewFilter}
          onFilterChange={setViewFilter}
          onBack={onBack}
        />
      )}

      {/* ── Approval workflow pipeline — always visible; load-bearing publish controls ── */}
      <ApprovalWorkflowBar
        status={data.review_status}
        onChange={handleChangeStatus}
      />

      {/* ── Classification filter chip bar ── */}
      <FilterChipBar
        normativeFilter={normativeFilter}
        relationshipFilter={relationshipFilter}
        onNormativeChange={setNormativeFilter}
        onRelationshipChange={setRelationshipFilter}
        matchingCount={visibleIds.size}
        totalCount={data.blocks.length}
        showSources={showSources}
        onToggleSources={setShowSources}
        showChunks={showChunks}
        onToggleChunks={setShowChunks}
      />

      {/* ── Three-panel layout ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Section outline + appendix list */}
        <SectionOutline
          sections={sections}
          blocks={data.blocks}
          appendices={appendices}
          onScrollTo={(anchorId) => {
            sectionRefs.current.get(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          onDeleteAppendix={handleDeleteAppendix}
          canMutateAppendices={!isLocked}
        />

        {/* Center: Document body */}
        <div className="flex-1 overflow-auto bg-muted/30">
          <div className="max-w-4xl mx-auto px-4 py-6">
          <div className="bg-card rounded-xl shadow-sm px-6 py-6">

            {/* Sections */}
            {sections.map((section) => {
              const sectionVisible = section.blocks.some((b) => visibleIds.has(b.id));
              if (!sectionVisible && filtersActive) return null;

              return (
                <div
                  key={section.anchorId}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(section.anchorId, el);
                  }}
                  className="mb-8"
                >
                  {/* Section Heading rendered directly above the section's blocks */}
                  {(function () {
                    const label = section.heading.split(">").pop()?.trim() || "(Untitled)";
                    const level = Math.min(4, Math.max(2, section.depth + 1));
                    if (level === 2) return <h2 className="mt-10 mb-3 text-2xl font-semibold text-foreground">{label}</h2>;
                    if (level === 3) return <h3 className="mt-8 mb-2 text-xl font-semibold text-foreground">{label}</h3>;
                    return <h4 className="mt-6 mb-2 text-lg font-semibold text-foreground">{label}</h4>;
                  })()}

                  {section.blocks.map((block) => {
                    if (!visibleIds.has(block.id) && filtersActive) return null;
                    // Removed blocks live in the Excluded Content drawer at
                    // the bottom — keep them out of the main document flow so
                    // reviewers aren't distracted by content they've set aside.
                    if (block.status === "removed") return null;
                    // Appendix-assigned blocks move to the dedicated appendix
                    // section at the bottom — no longer appear inline.
                    if (block.appendix_id) return null;

                    const isChunk = block.type === "kcad_addition" || block.type === "conflict" || block.type === "gap";
                    if (!showChunks && isChunk) return null;

                    const isSelected = block.id === selectedBlockId;

                    return (
                      <DraggableBlock
                        key={block.id}
                        blockId={block.id}
                        onDrop={handleDropBlock}
                        readOnly={isLocked}
                      >
                        <ContentBlock
                          block={block}
                          isSelected={isSelected}
                          onClick={() => {
                            if (isActionable(block)) {
                              setSelectedBlockId(isSelected ? null : block.id);
                            }
                          }}
                          onMove={(dir) => handleMoveBlock(block.id, dir)}
                          onRemove={() => handleAction(block.id, "removed")}
                          onAction={(action, opts) => handleAction(block.id, action, opts)}
                          readOnly={isLocked}
                          showSources={showSources}
                        />
                      </DraggableBlock>
                    );
                  })}
                </div>
              );
            })}

            {/* Appendix sections — one section per appendix, rendered below
                the main document. Each block assigned to an appendix has been
                filtered out of the inline flow above; here's where they land. */}
            {showChunks && (
              <AppendixSectionsBlock
                blocks={data.blocks}
                appendices={appendices}
                selectedBlockId={selectedBlockId}
                onSelectBlock={setSelectedBlockId}
                onMove={handleMoveBlock}
                onRemove={(bid) => handleAction(bid, "removed")}
                readOnly={isLocked}
                showSources={showSources}
                sectionRefs={sectionRefs}
              />
            )}

            {/* Excluded content drawer — collapsed list of soft-deleted blocks
                with a Restore button that returns each to 'pending' status.
                Clicking an entry opens the DetailPanel so reviewers can audit
                why a block was excluded + restore with full context. */}
            {showChunks && (
              <ExcludedContent
                blocks={data.blocks}
                onRestore={handleRestoreBlock}
                selectedBlockId={selectedBlockId}
                onSelectBlock={setSelectedBlockId}
              />
            )}
          </div>
          </div>
        </div>

        {/* Right: Detail panel (persistent when showChunks is on) */}
        {showChunks && (() => {
          const overrides = data.unified_overrides ?? {};
          const sectionHeading = selectedBlock?.heading_path || "";
          const override = overrides[sectionHeading];
          let stale = false;
          if (selectedBlock && override) {
            const cutoff = override.generated_at || "";
            for (const b of data.blocks) {
              if (b.heading_path !== sectionHeading) continue;
              const hist = b.history;
              if (hist && hist.length > 0 && hist[hist.length - 1].at > cutoff) {
                stale = true;
                break;
              }
            }
          }
          return (
            <DetailPanel
              block={selectedBlock}
              onAction={handleAction}
              onAssignToAppendix={handleAssignToAppendix}
              onRevert={handleRevert}
              onAddComment={handleAddComment}
              onDeleteComment={handleDeleteComment}
              onReclassify={handleReclassify}
              currentUserEmail={authUser?.email ?? null}
              readOnly={isLocked}
              onUpdateUnified={handleUpdateUnified}
              unifiedUpdating={selectedBlock ? polishingSections.has(sectionHeading) : false}
              unifiedPolished={!!override}
              unifiedStale={stale}
            />
          );
        })()}
      </div>

      {/* ── Progress bar ── */}
      <ProgressBar
        reviewed={reviewedCount}
        total={actionableBlocks.length}
        onJumpToNext={jumpToNext}
        canUndo={canUndoAnything}
        onUndo={handleUndoLast}
      />

      {/* ── Appendix assign dialog ── */}
      {appendixDialog && (
        <AppendixAssignDialog
          state={appendixDialog}
          onClose={() => setAppendixDialog(null)}
          onConfirm={confirmAppendixAssign}
        />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function ReviewHeader({
  displayName,
  summary,
  viewFilter,
  onFilterChange,
  onBack,
}: {
  displayName: string;
  summary: ConsolidatedView["summary"];
  viewFilter: ViewFilter;
  onFilterChange: (f: ViewFilter) => void;
  onBack: () => void;
}) {
  return (
    <div className="px-4 py-2.5 border-b border-border flex items-center gap-4 shrink-0 bg-background">
      <button
        onClick={onBack}
        className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold truncate ml-4">{displayName}</h2>
      </div>

      {/* Stats badges */}
      <div className="flex items-center gap-3 text-xs shrink-0">
        {summary.total_additions > 0 && (
          <span className="text-amber-500">{summary.total_additions} changes</span>
        )}
        {summary.total_conflicts > 0 && (
          <span className="text-red-400">{summary.total_conflicts} conflicts</span>
        )}
        {summary.total_gaps > 0 && (
          <span className="text-violet-400">{summary.total_gaps} new</span>
        )}
      </div>

      {/* View filter */}
      <div className="flex items-center gap-0.5 bg-muted/50 rounded-md p-0.5 shrink-0">
        {(["all", "changes", "conflicts", "unreviewed"] as const).map((f) => (
          <button
            key={f}
            onClick={() => onFilterChange(f)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${viewFilter === f
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Visual approval pipeline + transition buttons. The backend's
 *  VALID_STATUS_TRANSITIONS dict defines which moves are legal; we encode
 *  the forward/back labels here so the UI stays descriptive even as the
 *  state graph evolves. Clicking a stage dot is not allowed — skipping
 *  states would 400 server-side and invites foot-guns; only the explicit
 *  Advance / Revert buttons call handleChangeStatus. */
const REVIEW_STAGES: readonly { key: ReviewStatus; label: string; hint: string }[] = [
  { key: "ai_consolidated", label: "AI Draft", hint: "Generated by the pipeline" },
  { key: "in_review", label: "In Review", hint: "Reviewer is working through the doc" },
  { key: "approved", label: "Approved", hint: "Sign-off complete; ready to publish" },
  { key: "published", label: "Published", hint: "Locked from edits" },
];

type Transition = { target: ReviewStatus; label: string };

function transitionsFrom(status: ReviewStatus): { forward: Transition | null; back: Transition | null } {
  switch (status) {
    case "ai_consolidated":
      return {
        forward: { target: "in_review", label: "Start Review" },
        back: null,
      };
    case "in_review":
      return {
        forward: { target: "approved", label: "Approve" },
        back: { target: "ai_consolidated", label: "Back to AI Draft" },
      };
    case "approved":
      return {
        forward: { target: "published", label: "Publish" },
        back: { target: "in_review", label: "Back to Review" },
      };
    case "published":
      return {
        forward: null,
        back: { target: "in_review", label: "Unpublish" },
      };
  }
}

function ApprovalWorkflowBar({
  status,
  onChange,
}: {
  status: ReviewStatus;
  onChange: (target: ReviewStatus) => void;
}) {
  const currentIdx = REVIEW_STAGES.findIndex((s) => s.key === status);
  const { forward, back } = transitionsFrom(status);
  const isPublished = status === "published";

  return (
    <div
      className={`px-4 py-2 border-b border-border shrink-0 flex items-center gap-4 ${isPublished ? "bg-success/5" : "bg-background"
        }`}
    >
      <div className="flex items-center gap-1 flex-wrap">
        {REVIEW_STAGES.map((stage, i) => {
          const reached = i <= currentIdx;
          const current = i === currentIdx;
          return (
            <div key={stage.key} className="flex items-center gap-1">
              <div
                title={stage.hint}
                className={`flex items-center gap-1.5 text-[12px] px-2 py-0.5 rounded ${current
                  ? "bg-primary/20 text-foreground font-medium"
                  : reached
                    ? "text-foreground"
                    : "text-muted-foreground"
                  }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${current
                    ? "bg-primary"
                    : reached
                      ? "bg-foreground/60"
                      : "bg-muted-foreground/40"
                    }`}
                />
                {stage.label}
              </div>
              {i < REVIEW_STAGES.length - 1 && (
                <span className={`flex items-center text-[10px] ${reached && i + 1 <= currentIdx ? "text-foreground/60" : "text-muted-foreground/40"}`}>
                  <ArrowRight className="w-3 h-3" />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <span className="flex-1" />
      {back && (
        <button
          onClick={() => onChange(back.target)}
          className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex items-center gap-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {back.label}
        </button>
      )}
      {forward && (
        <button
          onClick={() => onChange(forward.target)}
          className={`text-xs px-3 py-1 rounded border transition-colors flex items-center gap-1.5 ${forward.target === "published"
            ? "bg-success text-white border-success hover:bg-success/90"
            : "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
            }`}
        >
          {forward.label}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      )}
      {isPublished && (
        <span className="text-xs text-success font-medium px-2 py-1 rounded border border-success/30 bg-success/10 flex items-center gap-1.5">
          <Lock className="w-3 h-3" /> Published
        </span>
      )}
    </div>
  );
}

/** Toggle-chip filter bar. OR within a group, AND across groups. Empty
 *  group = no filter. Changes persist to the URL so reloads/bookmarks keep
 *  the same view. The "n of m matching" readout is a sanity check for
 *  reviewers — easy to notice when a filter combination accidentally hides
 *  all actionable blocks. */
function FilterChipBar({
  normativeFilter,
  relationshipFilter,
  onNormativeChange,
  onRelationshipChange,
  matchingCount,
  totalCount,
  showSources,
  onToggleSources,
  showChunks,
  onToggleChunks,
}: {
  normativeFilter: Set<string>;
  relationshipFilter: Set<string>;
  onNormativeChange: (next: Set<string>) => void;
  onRelationshipChange: (next: Set<string>) => void;
  matchingCount: number;
  totalCount: number;
  showSources: boolean;
  onToggleSources: (next: boolean) => void;
  showChunks: boolean;
  onToggleChunks: (next: boolean) => void;
}) {
  const anyActive = normativeFilter.size > 0 || relationshipFilter.size > 0;

  const toggle = (
    set: Set<string>,
    value: string,
    setter: (next: Set<string>) => void,
  ) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  };

  return (
    <div className="px-4 py-2 border-b border-border bg-muted/20 shrink-0 flex items-center gap-3 flex-wrap text-[12px]">
      <ChipGroup
        label="Type"
        values={RELATIONSHIP_CHIPS as readonly string[]}
        active={relationshipFilter}
        onToggle={(v) => toggle(relationshipFilter, v, onRelationshipChange)}
        colorFor={relationshipChipColor}
        checkboxMode
      />
      <div className="h-4 w-px bg-border" />
      <ChipGroup
        label="Mode"
        values={["none", ...NORMATIVE_CHIPS] as readonly string[]}
        active={normativeFilter.size === 0 ? new Set(["none"]) : normativeFilter}
        onToggle={(v) => {
          if (v === "none") {
            onNormativeChange(new Set());
          } else {
            onNormativeChange(new Set([v]));
          }
        }}
        colorFor={(v) => v === "none" ? { selected: "bg-muted text-foreground border-border", idle: "hover:bg-muted/50" } : normativeChipColor(v)}
        radioMode
      />
      <span className="flex-1" />
      <span className="text-muted-foreground">
        {anyActive ? `${matchingCount} of ${totalCount} match` : `${totalCount} blocks`}
      </span>
      {anyActive && (
        <button
          onClick={() => {
            onNormativeChange(new Set());
            onRelationshipChange(new Set());
          }}
          className="text-muted-foreground hover:text-foreground underline"
        >
          Clear
        </button>
      )}
      <div className="h-4 w-px bg-border" />
      <button
        onClick={() => onToggleSources(!showSources)}
        title="Color-code block text by provenance (HP / KCAD / Edited)"
        className={`px-2 py-0.5 rounded border text-[12px] transition-colors flex items-center gap-1.5 ${showSources
          ? "bg-primary/10 text-primary border-primary/40"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
      >
        {showSources ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        {showSources ? "Clean View" : "Show Sources"}
      </button>
      <button
        onClick={() => onToggleChunks(!showChunks)}
        title={showChunks ? "Hide individual chunk cards" : "Show individual chunk cards"}
        className={`px-2 py-0.5 rounded border text-[12px] transition-colors flex items-center gap-1.5 ${showChunks
          ? "bg-primary/10 text-primary border-primary/40"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50"
          }`}
      >
        {showChunks ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        {showChunks ? "Hide Chunks" : "Show Chunks"}
      </button>
    </div>
  );
}

function ChipGroup({
  label,
  values,
  active,
  onToggle,
  colorFor,
  radioMode,
  checkboxMode,
}: {
  label: string;
  values: readonly string[];
  active: Set<string>;
  onToggle: (v: string) => void;
  colorFor: (v: string) => { selected: string; idle: string };
  radioMode?: boolean;
  checkboxMode?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {values.map((v) => {
        const { selected, idle } = colorFor(v);
        const on = active.has(v);
        return (
          <button
            key={v}
            onClick={() => onToggle(v)}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[12px] capitalize transition-colors ${on ? selected : `border-border text-muted-foreground hover:text-foreground ${idle}`
              }`}
          >
            {radioMode && (
              <div
                className={`w-3 h-3 rounded-full border flex items-center justify-center shrink-0 ${on ? "border-current" : "border-muted-foreground"
                  }`}
              >
                {on && <div className="w-1.5 h-1.5 rounded-full bg-current" />}
              </div>
            )}
            {checkboxMode && (
              <div
                className={`w-3 h-3 rounded-[2px] border flex items-center justify-center shrink-0 ${on ? "border-current bg-current" : "border-muted-foreground"
                  }`}
              >
                {on && (
                  <svg className="w-2 h-2 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2.5 6 5 8.5 9.5 3.5" />
                  </svg>
                )}
              </div>
            )}
            {v}
          </button>
        );
      })}
    </div>
  );
}

/** Color mapping aligns with the card border colors (amber Variant, blue
 *  Complementary, zinc Equivalent, red Conflict, violet Gap) so toggling a
 *  chip reinforces the visual language of the document body. */
function relationshipChipColor(v: string): { selected: string; idle: string } {
  switch (v) {
    case "Variant":
      return {
        selected: "bg-warning/15 text-warning border-warning/40",
        idle: "hover:bg-warning/10",
      };
    case "Complementary":
      return {
        selected: "bg-info/15 text-info border-info/40",
        idle: "hover:bg-info/10",
      };
    case "Equivalent":
      return {
        selected: "bg-zinc-400/20 text-zinc-400 border-zinc-400/40",
        idle: "hover:bg-zinc-400/10",
      };
    case "Gap":
      return {
        selected: "bg-violet-500/15 text-violet-400 border-violet-500/40",
        idle: "hover:bg-violet-500/10",
      };
    case "Conflict":
      return {
        selected: "bg-error/15 text-error border-error/40",
        idle: "hover:bg-error/10",
      };
    default:
      return {
        selected: "bg-muted text-foreground border-border",
        idle: "hover:bg-muted/50",
      };
  }
}

function normativeChipColor(v: string): { selected: string; idle: string } {
  switch (v) {
    case "policy":
      return {
        selected: "bg-purple-500/15 text-purple-400 border-purple-500/40",
        idle: "hover:bg-purple-500/10",
      };
    case "standard":
      return {
        selected: "bg-error/15 text-error border-error/40",
        idle: "hover:bg-error/10",
      };
    case "procedure":
      return {
        selected: "bg-info/15 text-info border-info/40",
        idle: "hover:bg-info/10",
      };
    case "guideline":
      return {
        selected: "bg-success/15 text-success border-success/40",
        idle: "hover:bg-success/10",
      };
    case "informational":
      return {
        selected: "bg-zinc-500/20 text-zinc-400 border-zinc-500/40",
        idle: "hover:bg-zinc-500/10",
      };
    default:
      return {
        selected: "bg-muted text-foreground border-border",
        idle: "hover:bg-muted/50",
      };
  }
}

function SectionOutline({
  sections,
  blocks,
  onScrollTo,
  appendices,
  onDeleteAppendix,
  canMutateAppendices,
}: {
  sections: Section[];
  blocks: ConsolidatedBlock[];
  onScrollTo: (anchorId: string) => void;
  appendices: Appendix[];
  onDeleteAppendix: (id: string, name: string) => void;
  canMutateAppendices: boolean;
}) {
  // Deduplicate sections by heading for the outline
  const outlineEntries = useMemo(() => {
    const seen = new Set<string>();
    return sections
      .filter((s) => {
        if (seen.has(s.heading)) return false;
        seen.add(s.heading);
        return true;
      })
      .map((s) => {
        const sectionBlocks = blocks.filter((b) => b.heading_path === s.heading);
        const additions = sectionBlocks.filter((b) => b.type === "kcad_addition");
        const conflicts = sectionBlocks.filter((b) => b.type === "conflict");
        const gaps = sectionBlocks.filter((b) => b.type === "gap");
        const allReviewed =
          sectionBlocks.filter(isActionable).length > 0 &&
          sectionBlocks.filter(isActionable).every(isReviewed);
        return { ...s, additions: additions.length, conflicts: conflicts.length, gaps: gaps.length, allReviewed };
      });
  }, [sections, blocks]);

  return (
    <aside className="w-52 border-r border-border overflow-auto shrink-0 py-3 px-2 bg-muted/10">
      <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-2">Outline</div>
      {outlineEntries.map((entry) => {
        // Show the leaf heading (last segment after >)
        const parts = entry.heading.split(">");
        const label = parts[parts.length - 1].trim();

        return (
          <button
            key={entry.anchorId}
            onClick={() => onScrollTo(entry.anchorId)}
            className="w-full text-left px-2 py-1 text-xs rounded hover:bg-muted/60 transition-colors flex items-center gap-1.5"
            style={{ paddingLeft: `${8 + entry.depth * 10}px` }}
          >
            <span className="truncate flex-1">{label}</span>
            {entry.allReviewed && <Check className="w-3 h-3 text-green-500 shrink-0" />}
            {entry.additions > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
            )}
            {entry.conflicts > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
            )}
            {entry.gaps > 0 && (
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
            )}
          </button>
        );
      })}

      {/* Appendix list — regional variants routed out of the main document.
          Hidden entirely when there are no appendices (zero-state UI). */}
      {appendices.length > 0 && (
        <AppendicesPanel
          appendices={appendices}
          canDelete={canMutateAppendices}
          onDelete={onDeleteAppendix}
        />
      )}
    </aside>
  );
}

function AppendicesPanel({
  appendices,
  canDelete,
  onDelete,
}: {
  appendices: Appendix[];
  canDelete: boolean;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <div className="mt-4 pt-3 border-t border-border">
      <div className="text-xs font-semibold text-muted-foreground uppercase px-2 mb-2 flex items-center gap-1.5">
        <span>Supporting Content</span>
        <span className="text-[10px] text-muted-foreground/60">· {appendices.length}</span>
      </div>
      <div className="space-y-1.5 px-1">
        {appendices.map((a) => {
          const scopeChips = [a.scope.region, a.scope.rig, a.scope.customer, a.scope.environment].filter(
            Boolean,
          ) as string[];
          return (
            <div
              key={a.id}
              className="rounded border border-indigo-500/20 bg-indigo-500/5 p-2 text-[11px] space-y-1"
            >
              <div className="flex items-start gap-1">
                <span className="flex-1 font-medium text-foreground truncate" title={a.name}>
                  {a.name}
                </span>
                {canDelete && (
                  <button
                    onClick={() => onDelete(a.id, a.name)}
                    title="Delete appendix (unassigns all blocks)"
                    className="text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="text-muted-foreground">
                {a.block_count} block{a.block_count === 1 ? "" : "s"}
              </div>
              {scopeChips.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {scopeChips.map((chip, i) => (
                    <span
                      key={i}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-background border border-border text-muted-foreground"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DocumentBanner({ summary }: { summary: ConsolidatedView["summary"] }) {
  if (summary.total_additions === 0) {
    return (
      <div className="mb-6 p-4 rounded-lg border border-border bg-muted/20 text-sm text-muted-foreground">
        No KCAD additions found for this document.
      </div>
    );
  }

  return (
    <div className="mb-6 p-4 rounded-lg border border-border bg-muted/20 text-sm space-y-1">
      <div>
        <strong>{summary.total_additions}</strong> suggested change{summary.total_additions !== 1 ? "s" : ""} from{" "}
        <strong>{summary.kcad_source_count}</strong> KCAD source{summary.kcad_source_count !== 1 ? "s" : ""}
      </div>
      {summary.regions.length > 0 && (
        <div className="text-muted-foreground">Regions: {summary.regions.join(", ")}</div>
      )}
      {summary.total_conflicts > 0 && (
        <div className="text-red-400">
          {summary.total_conflicts} conflict{summary.total_conflicts !== 1 ? "s" : ""} require resolution
        </div>
      )}
    </div>
  );
}

// ── Block rendering ─────────────────────────────────────────────────────

function ContentBlock({
  block,
  isSelected,
  onClick,
  onMove,
  onRemove,
  onAction,
  readOnly,
  showSources,
}: {
  block: ConsolidatedBlock;
  isSelected: boolean;
  onClick: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onAction?: (action: string, opts?: { edited_text?: string }) => Promise<void>;
  readOnly: boolean;
  showSources: boolean;
}) {
  switch (block.type) {
    case "hp_original":
      return <HpBlock block={block} showSources={showSources} onAction={readOnly ? undefined : onAction} readOnly={readOnly} />;
    case "kcad_addition":
      return (
        <KcadAdditionCard
          block={block}
          isSelected={isSelected}
          onClick={onClick}
          onMove={onMove}
          onRemove={onRemove}
          onAction={readOnly ? undefined : onAction}
          readOnly={readOnly}
          showSources={showSources}
        />
      );
    case "conflict":
      return (
        <ConflictCard
          block={block}
          isSelected={isSelected}
          onClick={onClick}
          onMove={onMove}
          onRemove={onRemove}
          readOnly={readOnly}
          showSources={showSources}
        />
      );
    case "gap":
      return (
        <GapCard
          block={block}
          isSelected={isSelected}
          onClick={onClick}
          onMove={onMove}
          onRemove={onRemove}
          readOnly={readOnly}
          showSources={showSources}
        />
      );
    case "gap_header":
      return <GapHeaderBlock block={block} />;
    default:
      return null;
  }
}

/** Prose text color keyed by provenance. Only applied when "Show Sources"
 *  is on — in Clean View mode all text renders with the default foreground
 *  color so documents read like finished prose. Edited text takes priority
 *  over block type so a KCAD block that's been rewritten reads as edited. */
function sourceTextColor(
  block: ConsolidatedBlock,
  showSources: boolean,
): string {
  if (!showSources) return "";
  if (block.edited_text) return "text-zinc-500 dark:text-zinc-400";
  if (block.type === "hp_original") return "text-foreground";
  if (block.type === "kcad_addition" || block.type === "gap" || block.type === "conflict")
    return "text-blue-600 dark:text-blue-400";
  if (block.type === "user_added") return "text-emerald-600 dark:text-emerald-400";
  return "";
}

// ── Appendix assign dialog ──────────────────────────────────────────────

/** Modal replacing the old window.prompt/confirm flow for routing a block
 *  to an appendix. Two modes inside one dialog:
 *  - "Route to existing" when matchAppendix() returned a scope-compatible
 *    appendix. User confirms or switches to create mode.
 *  - "Create new" when there's no match (or user explicitly switched).
 *    Input for name; scope is read-only (derived from the block). */
function AppendixAssignDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: AppendixDialogState;
  onClose: () => void;
  onConfirm: (choice: {
    existingId: string | null;
    name: string;
    scope: AppendixScope;
    blockId: string;
  }) => Promise<void>;
}) {
  const { blockId, scope: initialScope, existingMatch, defaultName } = state;
  const [mode, setMode] = useState<"existing" | "create">(
    existingMatch ? "existing" : "create",
  );
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  // Editable scope — all 4 variants (Region, Rig, Customer, Environment).
  // Pre-filled from block source + source-doc metadata; the user can override
  // or clear any field. Empty strings normalize to null (= wildcard).
  const [scope, setScope] = useState<AppendixScope>(initialScope);

  const setField = (key: keyof AppendixScope, v: string) => {
    setScope((s) => ({ ...s, [key]: v.trim() === "" ? null : v }));
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      if (mode === "existing" && existingMatch) {
        await onConfirm({ existingId: existingMatch.id, name: existingMatch.name, scope, blockId });
      } else {
        const cleaned = name.trim();
        if (!cleaned) return;
        await onConfirm({ existingId: null, name: cleaned, scope, blockId });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Appendix</DialogTitle>
          <DialogDescription>
            Route this regional variant into a scoped appendix — HP stays clean,
            the nuance stays discoverable.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          <div>
            <div className="text-muted-foreground mb-1.5">
              Appendix scope — defines which content this appendix covers
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ScopeField
                label="Region"
                value={scope.region ?? ""}
                placeholder="Oman, Europe, …"
                onChange={(v) => setField("region", v)}
              />
              <ScopeField
                label="Environment"
                value={scope.environment ?? ""}
                placeholder="Offshore / Onshore"
                onChange={(v) => setField("environment", v)}
              />
              <ScopeField
                label="Rig"
                value={scope.rig ?? ""}
                placeholder="T-9X, land drilling rig, …"
                onChange={(v) => setField("rig", v)}
              />
              <ScopeField
                label="Customer"
                value={scope.customer ?? ""}
                placeholder="PDO, Saudi Aramco, …"
                onChange={(v) => setField("customer", v)}
              />
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              Blank = wildcard (applies to any value of that variant).
            </div>
          </div>
          <div className="border-t border-border pt-3" />


          {existingMatch && (
            <label className="flex items-start gap-2 p-2 rounded border border-border cursor-pointer hover:bg-muted/30">
              <input
                type="radio"
                name="appendix-mode"
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div className="font-medium">Route to existing</div>
                <div className="text-muted-foreground">
                  {existingMatch.name} · {existingMatch.block_count} block
                  {existingMatch.block_count === 1 ? "" : "s"} already assigned
                </div>
              </div>
            </label>
          )}

          <label className="flex items-start gap-2 p-2 rounded border border-border cursor-pointer hover:bg-muted/30">
            <input
              type="radio"
              name="appendix-mode"
              checked={mode === "create"}
              onChange={() => setMode("create")}
              className="mt-0.5"
            />
            <div className="flex-1 space-y-1.5">
              <div className="font-medium">Create new appendix</div>
              {mode === "create" && (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Appendix name…"
                  className="w-full text-xs p-1.5 rounded border border-border bg-muted/20 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              )}
            </div>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={busy || (mode === "create" && name.trim().length === 0)}
          >
            {mode === "existing" ? "Route here" : "Create & assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renders every appendix as a labeled section at the bottom of the
 *  Reviewer View. Blocks assigned via appendix_id are surfaced here in the
 *  order they appear in the view's block array. Each section has:
 *    - letter-prefixed title ("Appendix A — Oman operations")
 *    - 4-variant scope chips (Region · Environment · Rig · Customer)
 *    - member blocks rendered with the same ContentBlock component used
 *      inline, so accept/edit/move actions work identically.
 *  Empty when no appendices have assigned blocks (zero-state). */
function AppendixSectionsBlock({
  blocks,
  appendices,
  selectedBlockId,
  onSelectBlock,
  onMove,
  onRemove,
  readOnly,
  showSources,
  sectionRefs,
}: {
  blocks: ConsolidatedBlock[];
  appendices: Appendix[];
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onRemove: (id: string) => void;
  readOnly: boolean;
  showSources: boolean;
  sectionRefs: React.MutableRefObject<Map<string, HTMLElement>>;
}) {
  // Group blocks by appendix_id, preserving view array order.
  const byAppendix = new Map<string, ConsolidatedBlock[]>();
  for (const b of blocks) {
    if (b.appendix_id && b.status !== "removed") {
      if (!byAppendix.has(b.appendix_id)) byAppendix.set(b.appendix_id, []);
      byAppendix.get(b.appendix_id)!.push(b);
    }
  }
  if (byAppendix.size === 0) return null;

  // Stable letter assignment: sorted by appendix creation time. A, B, C …
  const orderedAppendices = [...appendices].sort(
    (a, b) => (a.created_at || "").localeCompare(b.created_at || ""),
  );

  return (
    <div className="mt-10 border-t-2 border-border pt-6">
      <div className="mb-3 text-[10px] uppercase tracking-wide text-muted-foreground">
        Appendices — regional supplements moved out of canonical flow
      </div>
      {orderedAppendices.map((app, idx) => {
        const members = byAppendix.get(app.id) ?? [];
        if (members.length === 0) {
          // Empty appendix — surfaced so reviewers can see it exists even before
          // any block is routed.  Collapses into a one-line placeholder.
          const letter = String.fromCharCode("A".charCodeAt(0) + idx);
          return (
            <div
              key={app.id}
              className="mb-3 rounded border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            >
              Appendix {letter} — {app.name} (no blocks assigned yet)
            </div>
          );
        }
        return (
          <AppendixSection
            key={app.id}
            appendix={app}
            letter={String.fromCharCode("A".charCodeAt(0) + idx)}
            blocks={members}
            selectedBlockId={selectedBlockId}
            onSelectBlock={onSelectBlock}
            onMove={onMove}
            onRemove={onRemove}
            readOnly={readOnly}
            showSources={showSources}
            sectionRefs={sectionRefs}
          />
        );
      })}
      {/* Orphan case: block has appendix_id but the appendix was deleted.
          Surface these so nothing disappears. */}
      {[...byAppendix.entries()]
        .filter(([id]) => !orderedAppendices.find((a) => a.id === id))
        .map(([orphanId, orphanBlocks]) => (
          <div
            key={orphanId}
            className="mb-6 rounded border border-dashed border-amber-400 bg-amber-50/30 p-3 dark:border-amber-700 dark:bg-amber-950/10"
          >
            <div className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
              Orphan Appendix (appendix deleted but {orphanBlocks.length} block
              {orphanBlocks.length === 1 ? "" : "s"} still assigned)
            </div>
            {orphanBlocks.map((b) => (
              <ContentBlock
                key={b.id}
                block={b}
                isSelected={b.id === selectedBlockId}
                onClick={() => onSelectBlock(b.id === selectedBlockId ? null : b.id)}
                onMove={(dir) => onMove(b.id, dir)}
                onRemove={() => onRemove(b.id)}
                readOnly={readOnly}
                showSources={showSources}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

function AppendixSection({
  appendix,
  letter,
  blocks,
  selectedBlockId,
  onSelectBlock,
  onMove,
  onRemove,
  readOnly,
  showSources,
  sectionRefs,
}: {
  appendix: Appendix;
  letter: string;
  blocks: ConsolidatedBlock[];
  selectedBlockId: string | null;
  onSelectBlock: (id: string | null) => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onRemove: (id: string) => void;
  readOnly: boolean;
  showSources: boolean;
  sectionRefs: React.MutableRefObject<Map<string, HTMLElement>>;
}) {
  const anchorId = `appendix-${appendix.id}`;
  const scope = appendix.scope || { region: null, rig: null, customer: null, environment: null };
  const chips: Array<[string, string]> = [];
  if (scope.region) chips.push(["Region", scope.region]);
  if (scope.environment) chips.push(["Environment", scope.environment]);
  if (scope.rig) chips.push(["Rig", scope.rig]);
  if (scope.customer) chips.push(["Customer", scope.customer]);

  return (
    <section
      ref={(el) => {
        if (el) sectionRefs.current.set(anchorId, el);
      }}
      className="mb-8"
    >
      <h2 className="mb-2 text-lg font-semibold text-foreground">
        Appendix {letter} — {appendix.name}
      </h2>
      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Scope:</span>
          {chips.map(([label, value]) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded bg-muted/50 px-2 py-0.5 text-foreground"
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              <span>·</span>
              <span>{value}</span>
            </span>
          ))}
        </div>
      )}
      {blocks.map((b) => (
        <ContentBlock
          key={b.id}
          block={b}
          isSelected={b.id === selectedBlockId}
          onClick={() => onSelectBlock(b.id === selectedBlockId ? null : b.id)}
          onMove={(dir) => onMove(b.id, dir)}
          onRemove={() => onRemove(b.id)}
          readOnly={readOnly}
          showSources={showSources}
        />
      ))}
    </section>
  );
}

/** Collapsible list of soft-deleted blocks at the document bottom. Hidden
 *  entirely when nothing has been removed — this is a zero-state UI. Each
 *  removed block previews its first ~120 chars and offers a Restore button
 *  that sends it back to 'pending' status. */
function ExcludedContent({
  blocks,
  onRestore,
  selectedBlockId,
  onSelectBlock,
}: {
  blocks: ConsolidatedBlock[];
  onRestore: (blockId: string) => void;
  /** When set, clicking a row opens the DetailPanel so the reviewer can see
   *  the excluded block's full text, source, reasoning — same view they'd see
   *  for any in-flow block. */
  selectedBlockId?: string | null;
  onSelectBlock?: (id: string | null) => void;
}) {
  const removed = blocks.filter((b) => b.status === "removed");
  if (removed.length === 0) return null;

  return (
    <details className="mt-10 border-t border-border pt-4">
      <summary className="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground select-none">
        Excluded Content · {removed.length} block{removed.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-3 space-y-2">
        {removed.map((b) => {
          const preview = (b.edited_text ?? b.text ?? "").slice(0, 140).trim();
          const truncated = (b.edited_text ?? b.text ?? "").length > 140;
          const isSelected = b.id === selectedBlockId;
          const clickable = !!onSelectBlock;
          return (
            <div
              key={b.id}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={() => {
                if (!onSelectBlock) return;
                onSelectBlock(isSelected ? null : b.id);
              }}
              onKeyDown={(e) => {
                if (!onSelectBlock) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectBlock(isSelected ? null : b.id);
                }
              }}
              className={`rounded border px-3 py-2 text-xs transition-colors ${isSelected
                ? "border-primary/60 bg-primary/10"
                : clickable
                  ? "border-border bg-muted/20 hover:border-border/60 hover:bg-muted/40 cursor-pointer"
                  : "border-border bg-muted/20"
                }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-muted-foreground">
                  {b.source.document?.replace(/\.pdf$/i, "") ?? "—"}
                </span>
                {b.heading_path && (
                  <span className="text-muted-foreground truncate">
                    · {b.heading_path}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestore(b.id);
                  }}
                  className="px-2 py-0.5 rounded border border-border hover:bg-muted hover:text-foreground text-muted-foreground transition-colors"
                >
                  Restore
                </button>
              </div>
              <p className="text-foreground/60 line-clamp-2">
                {preview}
                {truncated && "…"}
              </p>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Hover-revealed toolbar on each actionable card. Buttons stopPropagation
 *  so they don't accidentally open the detail panel. Move up/down propagate
 *  to the parent's move handler (which calls the backend and invalidates).
 *  Remove issues an `action=removed` soft-delete via the standard action
 *  pipeline — that preserves history and respects publish-lock / ETag. */
function BlockToolbar({
  onMove,
  onRemove,
  readOnly,
}: {
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  readOnly: boolean;
}) {
  // Move up/down removed — overlapped the Edit button in the chunk header.
  // X (remove) is rendered outside the card by each chunk card's wrapper.
  void onMove; void onRemove; void readOnly;
  return null;
}

/** HP original content — the base document. Dimmed when no additions. */
function HpBlock({
  block,
  showSources,
  onAction,
  readOnly,
}: {
  block: ConsolidatedBlock;
  showSources: boolean;
  onAction?: (action: string, opts?: { edited_text?: string }) => Promise<void>;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);
  const dimmed = block.status === "unchanged";
  const colorCls = sourceTextColor(block, showSources);
  const originalDisplay = stripLeadingMarkdownHeadings(block.text);
  // Strip leading headings from edited_text too (prevents prose rendering them as h2/h3).
  // Fall back to originalDisplay if stripping the edit leaves nothing — prevents invisible blocks.
  const displayText = block.edited_text
    ? (stripLeadingMarkdownHeadings(block.edited_text) || originalDisplay)
    : originalDisplay;

  useEffect(() => {
    if (editing && editRef.current) {
      // Seed contenteditable with the displayed (heading-stripped) text so the user
      // edits exactly what they see, and subsequent saves stay heading-free.
      editRef.current.innerText = displayText;
      editRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const handleSave = async () => {
    if (!editRef.current || !onAction) return;
    setBusy(true);
    try {
      await onAction("edited", { edited_text: editRef.current.innerText });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id={`block-${block.id}`}
      className={`group/hpblock relative py-1 transition-opacity ${dimmed ? "opacity-50" : "opacity-100"}`}
    >
      {showSources && (
        <span className="inline-block text-[9px] font-semibold tracking-wide px-1 rounded border border-border bg-background text-muted-foreground mb-1">
          HP
        </span>
      )}
      <div className="flex items-start gap-1">
        <div className={`flex-1 prose prose-sm dark:prose-invert max-w-none [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/50 ${colorCls}`}>
          {editing ? (
            <div
              ref={editRef}
              contentEditable
              suppressContentEditableWarning
              className="outline-none whitespace-pre-wrap border-b border-primary/40 pb-1 not-prose text-sm text-foreground"
            />
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
          )}
        </div>
        {!readOnly && !editing && onAction && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            className="opacity-0 group-hover/hpblock:opacity-100 transition-opacity shrink-0 mt-0.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50"
            title="Edit paragraph"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
      {block.edited_text && !editing && (
        <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] border border-info/30 bg-info/10 text-info">
          Edited
        </span>
      )}
      {editing && (
        <div className="mt-2 flex items-center gap-3">
          <button
            disabled={busy}
            onClick={handleSave}
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Save
          </button>
          <button
            disabled={busy}
            onClick={() => setEditing(false)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

/** Visual styling driven by `block.relationship`. A Variant is a regional
 *  adaptation worth inspecting (amber, full-strength). Complementary is
 *  supporting context (blue, slightly softer). Equivalent duplicates existing
 *  HP content (gray, greatly softened). Unknown or missing relationship falls
 *  back to the amber default so new relationship values still render. */
function relationshipStyles(block: ConsolidatedBlock): {
  border: string;
  ring: string;
  resting: string;
  hover: string;
  labelColor: string;
  softenIdle: boolean;
} {
  switch (block.relationship) {
    case "Complementary":
      return {
        border: "border-info",
        ring: "ring-info/40 bg-info/10",
        resting: "bg-info/5",
        hover: "hover:bg-info/15",
        labelColor: "text-info",
        softenIdle: false,
      };
    case "Equivalent":
      return {
        border: "border-zinc-400",
        ring: "ring-zinc-400/40 bg-zinc-50/60 dark:bg-zinc-900/50",
        resting: "bg-zinc-50/30 dark:bg-zinc-900/25",
        hover: "hover:bg-zinc-50/50 dark:hover:bg-zinc-900/40",
        labelColor: "text-zinc-600 dark:text-zinc-400",
        softenIdle: true,
      };
    case "Variant":
    default:
      return {
        border: "border-warning",
        ring: "ring-warning/40 bg-warning/10",
        resting: "bg-warning/5",
        hover: "hover:bg-warning/15",
        labelColor: "text-warning",
        softenIdle: false,
      };
  }
}

/** KCAD addition — styled by relationship, clickable for detail panel. */
function KcadAdditionCard({
  block,
  isSelected,
  onClick,
  onMove,
  onRemove,
  onAction,
  readOnly,
  showSources,
}: {
  block: ConsolidatedBlock;
  isSelected: boolean;
  onClick: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  onAction?: (action: string, opts?: { edited_text?: string }) => Promise<void>;
  readOnly: boolean;
  showSources: boolean;
}) {
  const [inlineEditing, setInlineEditing] = useState(false);
  const [inlineBusy, setInlineBusy] = useState(false);
  const inlineEditRef = useRef<HTMLDivElement>(null);
  const reviewed = isReviewed(block);
  const translation = useChunkTranslation(block.text, block.language);
  const styles = relationshipStyles(block);
  const statusColors: Record<string, string> = {
    accepted: "bg-success/15 text-success border-success/30",
    dismissed: "bg-muted/50 text-muted-foreground border-border",
    edited: "bg-info/15 text-info border-info/30",
    pending: "bg-muted/30 text-muted-foreground border-border",
  };

  const dimmed =
    (reviewed && block.status === "dismissed") || (styles.softenIdle && !isSelected);

  useEffect(() => {
    if (inlineEditing && inlineEditRef.current) {
      inlineEditRef.current.innerText = block.edited_text ?? block.text;
      inlineEditRef.current.focus();
    }
  }, [inlineEditing]);

  const handleInlineSave = async () => {
    if (!inlineEditRef.current || !onAction) return;
    setInlineBusy(true);
    try {
      await onAction("edited", { edited_text: inlineEditRef.current.innerText });
      setInlineEditing(false);
    } finally {
      setInlineBusy(false);
    }
  };

  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

  return (
    <div className="group/chunk-outer relative my-2 pr-8">
      {!readOnly && (
        <button
          onClick={stop(onRemove)}
          title="Remove (sends to Excluded Content)"
          className="absolute right-0 top-2 w-6 h-6 flex items-center justify-center rounded border border-border bg-background/80 text-muted-foreground hover:text-red-400 hover:border-red-500/30 opacity-0 group-hover/chunk-outer:opacity-100 transition-all backdrop-blur-sm z-10"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    <div
      id={`block-${block.id}`}
      onClick={inlineEditing ? undefined : onClick}
      className={`group relative rounded-lg border-l-4 ${styles.border} cursor-pointer transition-all ${isSelected ? `ring-2 ${styles.ring}` : `${styles.resting} ${styles.hover}`
        } ${dimmed ? "opacity-60" : ""}`}
    >
      <BlockToolbar onMove={onMove} onRemove={onRemove} readOnly={readOnly} />
      {/* Header — region shows up in DetailPanel only (keeps card header compact) */}
      <div className="px-3 pt-2 pb-1 flex items-center gap-2 text-xs">
        <LanguageBadge language={block.language} className="shrink-0" />
        <NormativeModeBadge mode={block.normative_mode} />
        <FormatBadge format={block.format} />
        {showSources && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] border shrink-0 ${block.edited_text
              ? "border-zinc-500/30 bg-zinc-500/10 text-zinc-400"
              : "border-info/30 bg-info/10 text-info"
              }`}
            title={block.edited_text ? "Reviewer-edited content" : "Content sourced from KCAD"}
          >
            {block.edited_text ? "Edited" : "KCAD"}
          </span>
        )}
        {block.edited_text && !showSources && (
          <span className="px-1.5 py-0.5 rounded text-[10px] border border-info/30 bg-info/10 text-info shrink-0">
            Edited
          </span>
        )}
        {block.appendix_id && (
          <span className="px-1.5 py-0.5 rounded text-[10px] border border-indigo-500/30 bg-indigo-500/10 text-indigo-400 shrink-0">
            App: {block.appendix_name ?? "…"}
          </span>
        )}
        <span className="flex-1" />
        {translation.canTranslate && (
          <TranslateToggle
            mode={translation.mode}
            isLoading={translation.isLoading}
            onClick={translation.toggle}
            size="xs"
          />
        )}
        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${statusColors[block.status] ?? statusColors.pending}`}>
          {block.status}
        </span>
        {!readOnly && onAction && !inlineEditing && (
          <button
            onClick={(e) => { e.stopPropagation(); setInlineEditing(true); }}
            className="px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title={block.edited_text ? "Edit this block's text again" : "Edit before accepting"}
          >
            ✎ Edit
          </button>
        )}
      </div>
      {/* Content. When the reviewer has edited this block, render their
          edited text directly (translation doesn't apply — they wrote it in
          whatever language they wanted). Otherwise show the original text
          with the translation toggle. */}
      <div className="px-3 pb-3">
        {inlineEditing ? (
          <>
            <div
              ref={inlineEditRef}
              contentEditable
              suppressContentEditableWarning
              onClick={(e) => e.stopPropagation()}
              className="outline-none whitespace-pre-wrap border border-primary/40 rounded p-2 text-sm text-foreground min-h-[4em]"
            />
            <div className="mt-2 flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
              <button
                disabled={inlineBusy}
                onClick={handleInlineSave}
                className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                Save
              </button>
              <button
                disabled={inlineBusy}
                onClick={() => setInlineEditing(false)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Discard
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              dir={block.edited_text ? "ltr" : translation.dir}
              className={`prose prose-sm dark:prose-invert max-w-none text-sm [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/50 ${sourceTextColor(block, showSources)}`}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {stripLeadingMarkdownHeadings(block.edited_text ?? translation.displayText)}
              </ReactMarkdown>
            </div>
            {!block.edited_text && translation.error && <TranslationError message={translation.error} />}
          </>
        )}
      </div>
    </div>
    </div>
  );
}

/** Conflict — red border, shows both statements inline. */
function ConflictCard({
  block,
  isSelected,
  onClick,
  onMove,
  onRemove,
  readOnly,
  showSources: _showSources, // Ignore unused
}: {
  block: ConsolidatedBlock;
  isSelected: boolean;
  onClick: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  readOnly: boolean;
  showSources: boolean;
}) {
  const translation = useChunkTranslation(block.text, block.language);
  const kcadText = translation.displayText;
  const kcadSnippet = kcadText.slice(0, 200) + (kcadText.length > 200 ? "..." : "");

  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

  return (
    <div className="group/chunk-outer relative my-2 pr-8">
      {!readOnly && (
        <button
          onClick={stop(onRemove)}
          title="Remove (sends to Excluded Content)"
          className="absolute right-0 top-2 w-6 h-6 flex items-center justify-center rounded border border-border bg-background/80 text-muted-foreground hover:text-red-400 hover:border-red-500/30 opacity-0 group-hover/chunk-outer:opacity-100 transition-all backdrop-blur-sm z-10"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    <div
      id={`block-${block.id}`}
      onClick={onClick}
      className={`group relative rounded-lg border-l-4 border-error cursor-pointer transition-all ${isSelected ? "ring-2 ring-error/40 bg-error/10" : "bg-error/5 hover:bg-error/15"
        }`}
    >
      <BlockToolbar onMove={onMove} onRemove={onRemove} readOnly={readOnly} />
      <div className="px-3 pt-2 pb-1 flex items-center gap-2 text-xs">
        <span className="font-medium text-error">&#9888; Conflict</span>
        {block.conflict?.severity && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] border ${block.conflict.severity === "critical"
              ? "bg-error/15 text-error border-error/30"
              : block.conflict.severity === "material"
                ? "bg-warning/15 text-warning border-warning/30"
                : "bg-warning/15 text-warning border-warning/30"
              }`}
          >
            {block.conflict.severity}
          </span>
        )}
        <LanguageBadge language={block.language} className="shrink-0" />
        <span className="flex-1" />
        {translation.canTranslate && (
          <TranslateToggle
            mode={translation.mode}
            isLoading={translation.isLoading}
            onClick={translation.toggle}
            size="xs"
          />
        )}
        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${block.status === "resolved"
          ? "bg-success/15 text-success border-success/30"
          : "bg-muted/30 text-muted-foreground border-border"
          }`}>
          {block.status === "resolved" ? "resolved" : "open"}
        </span>
      </div>

      {block.conflict?.description && (
        <div className="px-3 pb-1 text-xs text-error">{block.conflict.description}</div>
      )}

      {/* Show both statements when possible */}
      <div className="px-3 pb-3 space-y-1.5 text-sm">
        {block.hp_original_text && (
          <div className="text-xs">
            <span className="font-medium text-info">H&P: </span>
            <span className="text-foreground/70">{block.hp_original_text.slice(0, 200)}{block.hp_original_text.length > 200 ? "..." : ""}</span>
          </div>
        )}
        <div className="text-xs" dir={translation.dir}>
          <span className="font-medium text-warning">KCAD: </span>
          <span className="text-foreground/70">{kcadSnippet}</span>
        </div>
        {translation.error && <TranslationError message={translation.error} />}
      </div>
    </div>
    </div>
  );
}

/** Gap — violet border, KCAD content with no HP home. */
function GapCard({
  block,
  isSelected,
  onClick,
  onMove,
  onRemove,
  readOnly,
  showSources,
}: {
  block: ConsolidatedBlock;
  isSelected: boolean;
  onClick: () => void;
  onMove: (direction: "up" | "down") => void;
  onRemove: () => void;
  readOnly: boolean;
  showSources: boolean;
}) {
  const reviewed = isReviewed(block);
  const translation = useChunkTranslation(block.text, block.language);
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

  return (
    <div className="group/chunk-outer relative my-2 pr-8">
      {!readOnly && (
        <button
          onClick={stop(onRemove)}
          title="Remove (sends to Excluded Content)"
          className="absolute right-0 top-2 w-6 h-6 flex items-center justify-center rounded border border-border bg-background/80 text-muted-foreground hover:text-red-400 hover:border-red-500/30 opacity-0 group-hover/chunk-outer:opacity-100 transition-all backdrop-blur-sm z-10"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    <div
      id={`block-${block.id}`}
      onClick={onClick}
      className={`group relative rounded-lg border-l-4 border-violet-500 cursor-pointer transition-all ${isSelected ? "ring-2 ring-violet-500/40 bg-violet-50/60 dark:bg-violet-950/30" : "bg-violet-50/30 dark:bg-violet-950/15 hover:bg-violet-50/50 dark:hover:bg-violet-950/25"
        } ${reviewed && block.status === "dismissed" ? "opacity-50" : ""}`}
    >
      <BlockToolbar onMove={onMove} onRemove={onRemove} readOnly={readOnly} />
      <div className="px-3 pt-2 pb-1 flex items-center gap-2 text-xs">
        <span className="font-medium text-violet-500">New content</span>
        <LanguageBadge language={block.language} className="shrink-0" />
        <span className="flex-1" />
        {translation.canTranslate && (
          <TranslateToggle
            mode={translation.mode}
            isLoading={translation.isLoading}
            onClick={translation.toggle}
            size="xs"
          />
        )}
        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${reviewed ? "bg-success/15 text-success border-success/30" : "bg-muted/30 text-muted-foreground border-border"
          }`}>
          {block.status}
        </span>
      </div>
      <div className="px-3 pb-3">
        <div
          dir={translation.dir}
          className={`prose prose-sm dark:prose-invert max-w-none text-sm [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/50 ${sourceTextColor(block, showSources)}`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripLeadingMarkdownHeadings(translation.displayText)}</ReactMarkdown>
        </div>
        {translation.error && <TranslationError message={translation.error} />}
      </div>
    </div>
    </div>
  );
}

/** Gap header separator block. */
function GapHeaderBlock({ block }: { block: ConsolidatedBlock }) {
  return (
    <div id={`block-${block.id}`} className="mt-8 mb-4 pt-6 border-t-2 border-violet-500/30">
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripLeadingMarkdownHeadings(block.text)}</ReactMarkdown>
      </div>
    </div>
  );
}

// ── Progress bar ────────────────────────────────────────────────────────

function ProgressBar({
  reviewed,
  total,
  onJumpToNext,
  canUndo,
  onUndo,
}: {
  reviewed: number;
  total: number;
  onJumpToNext: () => void;
  canUndo: boolean;
  onUndo: () => void;
}) {
  if (total === 0) return null;
  const pct = Math.round((reviewed / total) * 100);
  const remaining = total - reviewed;

  return (
    <div className="px-4 py-2 border-t border-border flex items-center gap-4 shrink-0 bg-background">
      <span className="text-xs text-muted-foreground">
        &#x2713; {reviewed} of {total} reviewed
      </span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-xs">
        <div
          className="h-full bg-primary/60 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title={canUndo ? "Undo the most recent action on any block" : "Nothing to undo"}
        className="text-xs px-2.5 py-1 rounded border border-border hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ↶ Undo
      </button>
      {remaining > 0 && (
        <button
          onClick={onJumpToNext}
          className="text-xs px-2.5 py-1 rounded border border-border hover:bg-muted/50 transition-colors"
        >
          Next &rarr;
        </button>
      )}
    </div>
  );
}

// ── Scope field helper for the AppendixAssignDialog ─────────────────────

/** Single labelled input for one scope variant (Region / Rig / Customer /
 *  Environment). Pre-filled from source metadata; blank = wildcard. Kept
 *  local because this is the only consumer and it reuses the dialog's
 *  tight vertical rhythm. */
function ScopeField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs px-2 py-1 rounded border border-border bg-muted/20 focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

// ── DraggableBlock — native HTML5 drag-and-drop wrapper ─────────────────

/** Wraps a block render with HTML5 drag-source + drop-target handlers.
 *  Emits a single `onDrop(sourceId, targetId)` call on drop — parent is
 *  responsible for resolving the target position and issuing the mutation.
 *  Visual: slight opacity while dragging; dashed outline when a valid
 *  drop target is hovering. Respects `readOnly` (e.g., published docs). */
function DraggableBlock({
  blockId,
  onDrop,
  readOnly,
  children,
}: {
  blockId: string;
  onDrop: (sourceId: string, targetId: string) => void;
  readOnly: boolean;
  children: React.ReactNode;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);

  if (readOnly) {
    return <>{children}</>;
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-consolidation-block-id", blockId);
        e.dataTransfer.effectAllowed = "move";
        setIsDragging(true);
      }}
      onDragEnd={() => setIsDragging(false)}
      onDragOver={(e) => {
        // preventDefault is REQUIRED to enable dropping.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const sourceId = e.dataTransfer.getData("text/x-consolidation-block-id");
        if (sourceId && sourceId !== blockId) {
          onDrop(sourceId, blockId);
        }
      }}
      className={
        (isDragging ? "opacity-50 " : "") +
        (isOver ? "ring-2 ring-primary/50 rounded-md " : "") +
        "transition-opacity"
      }
      title="Drag to reorder"
    >
      {children}
    </div>
  );
}
