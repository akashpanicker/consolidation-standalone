import type {
  Appendix,
  AppendixScope,
  BlockComment,
  ConsolidationDocSummary,
  ConsolidatedView,
  DocumentContext,
  HistoryEntry,
  MergedDocument,
  ReviewStatus,
} from "@/components/consolidation/types";

const BASE = "/api/v1/consolidation";

// ── Typed wrappers for ETag-aware fetch/mutate ──────────────────────────

/** A view paired with the ETag that identifies this exact revision on the server. */
export interface ViewWithEtag {
  view: ConsolidatedView;
  etag: string;
}

/** A successful mutation result + the new ETag returned by the server. */
export interface MutationResult<T> {
  result: T;
  etag: string;
}

/** The user performing a mutation. Threaded through as an identity header,
 *  never as request body — so the server is the single source of truth. */
export interface Actor {
  name: string;
  email: string;
}

/** Thrown when the server rejects a mutation because the view changed
 *  since the client last read it (HTTP 412). Carries the current server
 *  state so the UI can merge/retry without a second round trip.
 */
export class ConcurrencyError extends Error {
  readonly currentView: ConsolidatedView;
  readonly currentEtag: string;
  constructor(currentView: ConsolidatedView, currentEtag: string) {
    super("Document changed since you last read it. Reload and retry.");
    this.name = "ConcurrencyError";
    this.currentView = currentView;
    this.currentEtag = currentEtag;
  }
}

// ── Document list & view ────────────────────────────────────────────────

export async function fetchConsolidationDocuments(): Promise<ConsolidationDocSummary[]> {
  const res = await fetch(`${BASE}/documents`);
  if (!res.ok) throw new Error(`Failed to fetch consolidation documents: ${res.status}`);
  return res.json();
}

/** Fetch a view with its ETag for optimistic concurrency on later mutations. */
export async function fetchConsolidatedView(slug: string): Promise<ViewWithEtag> {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(slug)}/consolidated`);
  if (!res.ok) throw new Error(`Failed to fetch consolidated view: ${res.status}`);
  const etag = res.headers.get("ETag") ?? "";
  const view = (await res.json()) as ConsolidatedView;
  return { view, etag };
}

/** Fetch the narrative-merged (unified-prose) consolidated document.
 *  Returns null if the merged output hasn't been generated yet — the caller
 *  should fall back to block-level rendering from fetchConsolidatedView. */
export async function fetchMergedDocument(slug: string): Promise<MergedDocument | null> {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(slug)}/merged`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch merged document: ${res.status}`);
  return (await res.json()) as MergedDocument;
}

/** Fetch HP document identity + concept coverage, plus the same for every
 *  KCAD source document referenced in the view. Powers the Unified View's
 *  document-identity panel and regional-callout provenance. */
export async function fetchDocumentContext(slug: string): Promise<DocumentContext> {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(slug)}/context`);
  if (!res.ok) throw new Error(`Failed to fetch document context: ${res.status}`);
  return (await res.json()) as DocumentContext;
}

/** Single-section LLM polish — wraps the section's current reviewer state
 *  (accepted/edited blocks, conflict resolutions, appendix routing) into a
 *  unified prose rewrite. Stored as `unified_overrides[heading_path]` on
 *  the view. Returns the polished text + generation metadata. */
export interface SectionPolishResult {
  text: string;
  preserved_facts: Array<{ fact: string; source: string; evidence_in_merged: string }>;
  conflicts_flagged: Array<{ description: string; severity: "critical" | "material" | "minor"; sources: string[] }>;
  merge_confidence: "high" | "medium" | "low" | null;
  merge_notes: string;
  omitted_kcad_content: Array<{ source: string; summary: string; reason: string }>;
  generated_at: string;
  generated_by: string;
  validation_ok: boolean;
  fallback_to_block_level: boolean;
  block_ids: string[];
}

export async function polishSection(
  slug: string,
  etag: string,
  actor: Actor,
  heading_path: string,
  opts?: { includePending?: boolean; userPrompt?: string },
): Promise<MutationResult<{ ok: boolean; heading_path: string; override: SectionPolishResult }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/sections/polish`,
    etag,
    actor,
    {
      heading_path,
      // Default: include pending (unreviewed) KCAD/conflict blocks in the
      // merge. Reviewers who want accept-only merging pass includePending=false
      // explicitly. Matches the backend default flipped in polish_section_async.
      include_pending: opts?.includePending ?? true,
      user_prompt: opts?.userPrompt ?? null,
    },
  );
}

/** Drag-and-drop move to arbitrary position. Single API call regardless of
 *  how far the block is dragged, unlike the iterative /move endpoint. */
export async function moveBlockTo(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  targetPosition: number,
): Promise<MutationResult<{ ok: boolean; block_id: string; from: number; to: number; no_op?: boolean }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/move_to`,
    etag,
    actor,
    { target_position: targetPosition },
  );
}

/** Document-level undo — pops the most recent action across block history
 *  and polish history (whichever has the latest timestamp), and reverses it.
 *  Handles: block actions (accept/dismiss/edit/move/reclassify/appendix
 *  assign), drag moves, polish, and polish-clear — all chronologically
 *  ordered. Returns metadata about what was undone so the UI can message
 *  the reviewer ("Undid accept on section 4.1" or "Undid polish on §2"). */
export interface UndoLastResult {
  ok: boolean;
  undone:
    | null
    | {
        kind: "block";
        block_id: string;
        version: number;
        action: string;
        at: string;
      }
    | {
        kind: "polish";
        action: "polish" | "clear";
        heading_path: string;
        at: string;
      };
  reason?: string;
}

export async function undoLast(
  slug: string,
  etag: string,
  actor: Actor,
): Promise<MutationResult<UndoLastResult>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/undo/last`,
    etag,
    actor,
    {},
  );
}

export async function clearSectionPolish(
  slug: string,
  etag: string,
  heading_path: string,
): Promise<MutationResult<{ ok: boolean; cleared: boolean; heading_path: string }>> {
  const res = await fetch(
    `${BASE}/documents/${encodeURIComponent(slug)}/sections/polish?heading_path=${encodeURIComponent(heading_path)}`,
    {
      method: "DELETE",
      headers: { "If-Match": etag },
    },
  );
  if (res.status === 412) {
    const detail = (await res.json()).detail as {
      message: string;
      current_etag: string;
      current_view: ConsolidatedView;
    };
    throw new ConcurrencyError(detail.current_view, detail.current_etag);
  }
  if (!res.ok) throw new Error(`Clear polish failed: ${res.status}`);
  const newEtag = res.headers.get("ETag") ?? "";
  const result = await res.json();
  return { result, etag: newEtag };
}

// ── Shared mutation plumbing ────────────────────────────────────────────

async function mutate<T>(
  url: string,
  etag: string,
  actor: Actor,
  body: unknown,
  method: "POST" | "PUT" | "DELETE" = "POST",
): Promise<MutationResult<T>> {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "If-Match": etag,
      "X-User-Name": actor.name,
      "X-User-Email": actor.email,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 412) {
    // The view changed. Detail payload carries the current view + etag.
    const detail = (await res.json()).detail as {
      message: string;
      current_etag: string;
      current_view: ConsolidatedView;
    };
    throw new ConcurrencyError(detail.current_view, detail.current_etag);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed: ${res.status} ${text}`);
  }

  const newEtag = res.headers.get("ETag") ?? "";
  const result = (await res.json()) as T;
  return { result, etag: newEtag };
}

// ── Document status transitions ─────────────────────────────────────────

export async function updateDocumentStatus(
  slug: string,
  etag: string,
  actor: Actor,
  status: ReviewStatus,
): Promise<MutationResult<{ ok: boolean; review_status: string; from: string }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/status`,
    etag,
    actor,
    { status },
  );
}

// ── Block actions ───────────────────────────────────────────────────────

export async function submitBlockAction(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  action: string,
  opts?: {
    note?: string;
    edited_text?: string;
    resolution?: string;
  },
): Promise<MutationResult<{ ok: boolean; block_id: string; status: string; version: number }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/action`,
    etag,
    actor,
    { action, ...opts },
  );
}

// ── Block version history ───────────────────────────────────────────────

export async function fetchBlockHistory(
  slug: string,
  blockId: string,
): Promise<{ block_id: string; current_status: string; history: HistoryEntry[] }> {
  const res = await fetch(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/history`,
  );
  if (!res.ok) throw new Error(`Failed to fetch block history: ${res.status}`);
  return res.json();
}

// ── Block revert ────────────────────────────────────────────────────────

export async function revertBlock(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  version: number,
): Promise<MutationResult<{ ok: boolean; block_id: string; reverted_to: number; new_version: number }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/revert`,
    etag,
    actor,
    { version },
  );
}

// ── Comments ───────────────────────────────────────────────────────────

export async function addComment(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  text: string,
): Promise<MutationResult<{ ok: boolean; comment: BlockComment }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/comments`,
    etag,
    actor,
    { text },
  );
}

export async function deleteComment(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  commentId: string,
): Promise<MutationResult<{ ok: boolean; deleted: string }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/comments/${encodeURIComponent(commentId)}`,
    etag,
    actor,
    undefined,
    "DELETE",
  );
}

// ── Appendices ─────────────────────────────────────────────────────────

export async function createAppendix(
  slug: string,
  etag: string,
  actor: Actor,
  name: string,
  scope: Partial<AppendixScope>,
): Promise<MutationResult<{ ok: boolean; appendix: Appendix }>> {
  const fullScope: AppendixScope = {
    region: scope.region ?? null,
    rig: scope.rig ?? null,
    customer: scope.customer ?? null,
    environment: scope.environment ?? null,
  };
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/appendices`,
    etag,
    actor,
    { name, scope: fullScope },
  );
}

export async function listAppendices(slug: string): Promise<{ appendices: Appendix[] }> {
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(slug)}/appendices`);
  if (!res.ok) throw new Error(`Failed to list appendices: ${res.status}`);
  return res.json();
}

export async function matchAppendix(
  slug: string,
  scope: Partial<AppendixScope>,
): Promise<{ appendix: Appendix | null }> {
  const fullScope: AppendixScope = {
    region: scope.region ?? null,
    rig: scope.rig ?? null,
    customer: scope.customer ?? null,
    environment: scope.environment ?? null,
  };
  const res = await fetch(`${BASE}/documents/${encodeURIComponent(slug)}/appendices/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: fullScope }),
  });
  if (!res.ok) throw new Error(`Failed to match appendix: ${res.status}`);
  return res.json();
}

export async function assignBlocksToAppendix(
  slug: string,
  etag: string,
  actor: Actor,
  appendixId: string,
  blockIds: string[],
): Promise<MutationResult<{ ok: boolean; assigned: string[]; appendix_id: string }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/appendices/assign`,
    etag,
    actor,
    { appendix_id: appendixId, block_ids: blockIds },
  );
}

export async function deleteAppendix(
  slug: string,
  etag: string,
  actor: Actor,
  appendixId: string,
): Promise<MutationResult<{ ok: boolean; deleted: string; name: string | null }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/appendices/${encodeURIComponent(appendixId)}`,
    etag,
    actor,
    undefined,
    "DELETE",
  );
}

// ── Block manipulation (add / move / restore) ──────────────────────────

export interface AddBlockPayload {
  text: string;
  position: number;
  section_function: string;
  normative_mode: string;
  format?: "prose" | "form" | "table" | "image";
  heading_path?: string;
}

export async function addBlock(
  slug: string,
  etag: string,
  actor: Actor,
  payload: AddBlockPayload,
): Promise<MutationResult<{ ok: boolean; block: import("@/components/consolidation/types").ConsolidatedBlock; position: number }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/add`,
    etag,
    actor,
    payload,
  );
}

export async function moveBlock(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  direction: "up" | "down",
): Promise<MutationResult<{ ok: boolean; block_id: string; from: number; to: number }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/move`,
    etag,
    actor,
    { direction },
  );
}

export async function restoreBlock(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
): Promise<MutationResult<{ ok: boolean; block_id: string; status: string }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/restore`,
    etag,
    actor,
    {},
  );
}

// ── Manual reclassification ─────────────────────────────────────────────

/** Override the AI-assigned relationship on a block. Backend validates the
 *  new value against {Equivalent, Variant, Complementary, Related} and
 *  appends a "reclassified" entry to block history. */
export async function reclassifyBlock(
  slug: string,
  etag: string,
  actor: Actor,
  blockId: string,
  relationship: "Equivalent" | "Variant" | "Complementary" | "Related",
): Promise<MutationResult<{ ok: boolean; block_id: string; relationship: string }>> {
  return mutate(
    `${BASE}/documents/${encodeURIComponent(slug)}/blocks/${encodeURIComponent(blockId)}/reclassify`,
    etag,
    actor,
    { relationship },
  );
}

// ── Translation ─────────────────────────────────────────────────────────
// The single-text translate endpoint moved to the shared translation router
// (POST /api/v1/translate). fetchTranslation + TranslationResult now live in
// @/api/translation; re-exported here so existing consolidation imports keep
// working.
export { fetchTranslation, type TranslationResult } from "./translation";

/** Run language detection on every KCAD block in a view that's missing `language`.
 *  Persists results into the view JSON. Idempotent — repeat calls do no extra work. */
export async function detectViewLanguages(
  slug: string,
): Promise<{ ok: boolean; updated: number; already_tagged?: boolean; unique_detected?: number }> {
  const res = await fetch(
    `${BASE}/documents/${encodeURIComponent(slug)}/detect-languages`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Language detection failed: ${res.status}`);
  return res.json();
}
