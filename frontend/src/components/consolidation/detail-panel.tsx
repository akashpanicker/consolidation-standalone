import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type BlockComment,
  type ConsolidatedBlock,
  type HistoryEntry,
  relationshipLabel,
} from "./types";
import {
  LanguageBadge,
  TranslateToggle,
  TranslationError,
  useChunkTranslation,
} from "./translation-toggle";
import { ClassificationBadges } from "./classification-badges";

const PROSE_CLASSES =
  "prose prose-sm dark:prose-invert max-w-none [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/50";

export function DetailPanel({
  block,
  onClose,
  onAction,
  onAssignToAppendix,
  onRevert,
  onAddComment,
  onDeleteComment,
  currentUserEmail,
  readOnly,
  onReclassify,
  onUpdateUnified,
  unifiedUpdating,
  unifiedPolished,
  unifiedStale,
}: {
  block: ConsolidatedBlock;
  onClose: () => void;
  onAction: (blockId: string, action: string, opts?: { note?: string; edited_text?: string; resolution?: string }) => Promise<void>;
  /** Trigger the LLM merge for THIS block's section — re-runs polish for the
   *  heading_path this block belongs to, reflecting the current accept/edit
   *  state of all blocks in that section. */
  onUpdateUnified?: (headingPath: string) => void | Promise<void>;
  /** The section containing this block currently has a polish request in flight. */
  unifiedUpdating?: boolean;
  /** A polish already exists for this block's section. */
  unifiedPolished?: boolean;
  /** The existing polish is stale (newer block changes). */
  unifiedStale?: boolean;
  /** Optional: invoked when the user clicks "Add to Appendix" on a Variant block.
   *  Parent owns the full flow (match → create → assign) to keep API+ETag logic
   *  centralized. Step 3 calls window.prompt; Step 8 replaces with a dialog. */
  onAssignToAppendix?: (blockId: string) => Promise<void>;
  /** Optional: invoked from the Version History entries' "Revert" buttons.
   *  Parent calls revertBlock + invalidates the view so the refetch picks up
   *  the new state. Omit to disable per-version revert in the panel. */
  onRevert?: (blockId: string, version: number) => Promise<void>;
  /** Comment handlers. When omitted, the CommentsSection doesn't render. */
  onAddComment?: (blockId: string, text: string) => Promise<void>;
  onDeleteComment?: (blockId: string, commentId: string) => Promise<void>;
  /** Used to decide which comments show a Delete button (owners only).
   *  null when auth is still resolving — delete buttons stay hidden. */
  currentUserEmail?: string | null;
  /** When true, the document is published and all mutations are disabled.
   *  Backend enforces via _check_not_published; this mirrors the lock into
   *  the UI so users see disabled controls + a banner rather than 409s. */
  readOnly?: boolean;
  /** Manually override the AI's relationship classification. Only surfaced
   *  on kcad_addition blocks — Gap/Conflict are driven by block.type, not
   *  relationship, so flipping those would confuse the dispatch. */
  onReclassify?: (blockId: string, relationship: "Equivalent" | "Variant" | "Complementary" | "Related") => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // `editDraft` seeds from the current edited_text, falling back to the raw
  // block text. Re-seed when the selected block changes so edits don't bleed
  // across blocks when the user clicks around.
  const [editDraft, setEditDraft] = useState(
    block.edited_text ?? block.text ?? "",
  );
  useEffect(() => {
    setEditDraft(block.edited_text ?? block.text ?? "");
    setEditMode(false);
  }, [block.id, block.edited_text, block.text]);

  const handleAction = async (action: string, resolution?: string) => {
    setBusy(true);
    try {
      await onAction(block.id, action, {
        note: note || undefined,
        resolution,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async () => {
    setBusy(true);
    try {
      await onAction(block.id, "edited", {
        edited_text: editDraft,
        note: note || undefined,
      });
      setEditMode(false);
    } finally {
      setBusy(false);
    }
  };

  const handleAssignAppendix = async () => {
    if (!onAssignToAppendix) return;
    setBusy(true);
    try {
      await onAssignToAppendix(block.id);
    } finally {
      setBusy(false);
    }
  };

  const isGap = block.type === "gap";
  const locked = !!readOnly;

  return (
    <aside className="w-[420px] border-l border-border flex flex-col shrink-0 bg-background overflow-hidden">
      {/* Panel header */}
      <div className="px-4 py-3 border-b border-border shrink-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <RelationshipBadge block={block} />
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            &times;
          </button>
        </div>
        <ClassificationBadges block={block} />
        <ConfidenceIndicator confidence={block.ai_confidence} />
        <div className="text-xs text-muted-foreground truncate">
          {block.source.document?.replace(/\.pdf$/i, "")}
          {block.source.region && <> &middot; {block.source.region}</>}
          {block.source.rig && <> &middot; {block.source.rig}</>}
        </div>
      </div>

      {locked && (
        <div className="px-4 py-2 text-xs border-b border-green-500/30 bg-green-500/10 text-green-400 flex items-center gap-2 shrink-0">
          <span>🔒</span>
          <span>Document is published. Unpublish to edit.</span>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto">
        <div className="px-4 py-4 space-y-4">
          {/* HP Original intentionally omitted from the DetailPanel.
              The reviewer can see HP's original text inline in the main
              document flow (where it always lives); showing it again in the
              candidate details adds noise without informing the decision. */}

          {/* What's different */}
          <DifferenceSummary block={block} />

          {/* KCAD chunk — translatable. Prefer the pipeline-set block.language
               (GPT-5.4 detection) over block.kcad_chunk.language (stale
               langdetect value carried from enrichment).
               In edit mode, this area becomes a Markdown textarea the reviewer
               uses to rewrite the block before accepting. */}
          {editMode ? (
            <EditDraftEditor
              value={editDraft}
              onChange={setEditDraft}
              onSave={handleSaveEdit}
              onCancel={() => {
                setEditMode(false);
                setEditDraft(block.edited_text ?? block.text ?? "");
              }}
              busy={busy}
              hasExistingEdit={!!block.edited_text}
            />
          ) : (
            <ChunkView
              label={block.edited_text ? "KCAD Content · Edited" : "KCAD Content"}
              accentColor="amber"
              chunk={block.kcad_chunk}
              fallbackText={block.edited_text ?? block.text}
              language={block.language ?? block.kcad_chunk?.language}
              translatable
              onEdit={locked ? undefined : () => setEditMode(true)}
              hasEdit={!!block.edited_text}
            />
          )}

          {/* Provenance — where this block's content came from upstream.
              Compact summary of source documents + chunk IDs; useful for
              engineers tracing a specific statement back to its origin
              PDFs during review. */}
          <ProvenanceCard block={block} />

          {/* AI explanation (collapsible) */}
          {block.ai_reasoning && (
            <div className="border border-border rounded-md">
              <button
                onClick={() => setAiExpanded(!aiExpanded)}
                className="w-full text-left px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {aiExpanded ? "▾" : "▸"} AI details
              </button>
              {aiExpanded && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-xs text-foreground/80 leading-relaxed">{block.ai_reasoning}</p>
                  {block.dimension_matches && <DimensionDots dims={block.dimension_matches} />}
                </div>
              )}
            </div>
          )}

          {/* Note input. Gap dismissals require a justification (enforced by
              the action panel); for other blocks the note is optional metadata.
              Hidden entirely when locked — no action to annotate. */}
          {!locked && (
            <div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={notePlaceholder(block)}
                rows={2}
                className="w-full text-xs p-2 rounded border border-border bg-muted/20 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}

          {/* Version history timeline. Reads block.history directly (already
              served with the view JSON — no extra fetch). Revert bumps ETag
              and refetches the view, so any pending local edit draft must be
              re-opened; that's acceptable since revert is a rare action.
              In locked mode the timeline stays visible (audit value) but
              the Revert buttons disappear — see VersionHistorySection.canRevert. */}
          {(block.history?.length ?? 0) > 0 && (
            <VersionHistorySection
              history={block.history ?? []}
              busy={busy}
              canRevert={!locked && !!onRevert}
              onRevert={async (version) => {
                if (!onRevert) return;
                setBusy(true);
                try {
                  await onRevert(block.id, version);
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}

          {/* Comments — conversation separate from block version history.
              Reviewers coordinate here ("@Alice can you confirm the H2S
              threshold?"). Delete button is ownership-gated by email.
              When locked, the list stays visible (audit value) but posting
              and deleting are disabled — CommentsSection.readOnly. */}
          {onAddComment && onDeleteComment && (
            <CommentsSection
              comments={block.comments ?? []}
              currentUserEmail={currentUserEmail ?? null}
              busy={busy}
              readOnly={locked}
              onAdd={async (text) => {
                setBusy(true);
                try {
                  await onAddComment(block.id, text);
                } finally {
                  setBusy(false);
                }
              }}
              onDelete={async (commentId) => {
                setBusy(true);
                try {
                  await onDeleteComment(block.id, commentId);
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </div>
      </div>

      {/* Action bar (sticky bottom). Hidden entirely when locked — no
          decision to be made on a published block. The banner at the top
          explains why. */}
      {!locked && (
        <div className="px-4 py-3 border-t border-border shrink-0 space-y-2">
          {block.relationship === "Variant" && <VariantContextCard block={block} />}
          {onReclassify && block.type === "kcad_addition" && (
            <ReclassifyDropdown
              current={block.relationship}
              disabled={busy}
              onSelect={(newRel) => {
                if (newRel === block.relationship) return;
                setBusy(true);
                onReclassify(block.id, newRel).finally(() => setBusy(false));
              }}
            />
          )}
          <ActionBar
            block={block}
            busy={busy}
            note={note}
            onAction={handleAction}
            onAssignAppendix={onAssignToAppendix ? handleAssignAppendix : undefined}
          />
          {onUpdateUnified && block.heading_path && (
            <UpdateUnifiedButton
              headingPath={block.heading_path}
              disabled={busy || !!unifiedUpdating || block.status === "pending"}
              isUpdating={!!unifiedUpdating}
              isPolished={!!unifiedPolished}
              isStale={!!unifiedStale}
              onUpdate={onUpdateUnified}
            />
          )}
        </div>
      )}
    </aside>
  );
}

/** Per-block CTA that triggers a section polish reflecting this block's
 *  current review state. Rendered in the detail panel so the reviewer can
 *  "approve and apply" without jumping to the Unified pane. */
function UpdateUnifiedButton({
  headingPath,
  disabled,
  isUpdating,
  isPolished,
  isStale,
  onUpdate,
}: {
  headingPath: string;
  disabled: boolean;
  isUpdating: boolean;
  isPolished: boolean;
  isStale: boolean;
  onUpdate: (headingPath: string) => void | Promise<void>;
}) {
  const label = isUpdating
    ? "Updating…"
    : isPolished && isStale
    ? "Update Consolidated Version (stale)"
    : isPolished
    ? "Re-update Consolidated Version"
    : "Update Consolidated Version";
  const title = isPolished && isStale
    ? "Blocks changed since last polish — re-merge to apply."
    : isPolished
    ? "Re-run the LLM merge for this section using current reviewer state."
    : "Merge this section's accepted content into unified prose via LLM.";
  return (
    <button
      type="button"
      onClick={() => onUpdate(headingPath)}
      disabled={disabled}
      title={title}
      className="w-full px-3 py-1.5 text-xs rounded border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {label}
    </button>
  );
}

/** Pick a note-field placeholder tailored to the current block's review path. */
function notePlaceholder(block: ConsolidatedBlock): string {
  if (block.type === "conflict") return "Resolution note (recommended for conflicts)...";
  if (block.type === "gap") return "Justification — required before dismissing a gap...";
  return "Add a note (optional)...";
}

// ── Version history ─────────────────────────────────────────────────────

/** Collapsible timeline of every action taken on this block. Reads
 *  block.history directly (already attached to the block by the view
 *  endpoint). Each entry is a frozen snapshot-pair the revert endpoint
 *  knows how to restore from.
 *
 *  We intentionally summarise each entry rather than render a full
 *  before-vs-after diff — the compact form is legible at a glance, and the
 *  snapshots are still on the entry if a richer diff view is bolted on
 *  later (plan Step 6 explicitly lists side-by-side diff as future work). */
function VersionHistorySection({
  history,
  busy,
  onRevert,
  canRevert,
}: {
  history: HistoryEntry[];
  busy: boolean;
  onRevert: (version: number) => void;
  /** When false, the Revert buttons are hidden. Timeline still renders
   *  because the audit trail is useful even on locked documents. */
  canRevert: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Newest-first feels right for an audit trail — reviewers want to see
  // "what just changed" before "what was done weeks ago."
  const ordered = [...history].sort((a, b) => b.version - a.version);
  const currentVersion = ordered[0]?.version ?? 0;

  return (
    <div className="rounded border border-border">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <span>
          {expanded ? "▾" : "▸"} Version history · {history.length} entr
          {history.length === 1 ? "y" : "ies"}
        </span>
        {!expanded && currentVersion > 0 && (
          <span className="text-[10px] text-muted-foreground">v{currentVersion} current</span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border">
          {ordered.map((entry) => (
            <HistoryEntryRow
              key={entry.version}
              entry={entry}
              isCurrent={entry.version === currentVersion}
              busy={busy}
              canRevert={canRevert}
              onRevert={() => onRevert(entry.version)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryEntryRow({
  entry,
  isCurrent,
  busy,
  canRevert,
  onRevert,
}: {
  entry: HistoryEntry;
  isCurrent: boolean;
  busy: boolean;
  canRevert: boolean;
  onRevert: () => void;
}) {
  const when = formatRelativeTime(entry.at);
  const summary = summariseEntry(entry);
  const who = entry.user_name ?? entry.user_email ?? "Unknown";

  return (
    <div className="px-3 py-2 border-b border-border last:border-b-0 space-y-1">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-mono text-muted-foreground">v{entry.version}</span>
        <span className="font-medium text-foreground">{humanAction(entry.action)}</span>
        <span className="flex-1" />
        {!isCurrent && canRevert && (
          <button
            disabled={busy}
            onClick={onRevert}
            title={`Restore block to the state after v${entry.version}`}
            className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            Revert
          </button>
        )}
        {isCurrent && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-green-500/30 bg-green-500/10 text-green-400">
            current
          </span>
        )}
      </div>
      {summary && <p className="text-[11px] text-muted-foreground">{summary}</p>}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>{who}</span>
        <span>·</span>
        <time dateTime={entry.at} title={entry.at}>
          {when}
        </time>
      </div>
    </div>
  );
}

/** Compact before→after summary for a history entry. Returns null when the
 *  action name alone is self-explanatory (user_added, reverted_to_vN). */
function summariseEntry(entry: HistoryEntry): string | null {
  const before = entry.before as Record<string, unknown>;
  const after = entry.after as Record<string, unknown>;
  const parts: string[] = [];

  // Status transitions are the headline for most entries.
  if (before.status !== after.status) {
    const from = (before.status as string | undefined) ?? "—";
    const to = (after.status as string | undefined) ?? "—";
    parts.push(`${from} → ${to}`);
  }

  // Edit — flag text change without rendering the full diff.
  if ((before.edited_text ?? "") !== (after.edited_text ?? "")) {
    if (after.edited_text) parts.push("Text edited");
    else if (before.edited_text) parts.push("Edit cleared");
  }

  // Resolution on conflicts / complementaries.
  if ((before.resolution ?? null) !== (after.resolution ?? null)) {
    if (after.resolution) parts.push(`Resolution: ${after.resolution}`);
  }

  // Appendix routing.
  if ((before.appendix_id ?? null) !== (after.appendix_id ?? null)) {
    if (after.appendix_id) parts.push(`Appendix: ${after.appendix_name ?? "routed"}`);
    else parts.push("Appendix unassigned");
  }

  // Note — snippet.
  if ((before.reviewer_note ?? "") !== (after.reviewer_note ?? "")) {
    const note = (after.reviewer_note as string | undefined) ?? "";
    if (note) {
      parts.push(`Note: “${note.slice(0, 60)}${note.length > 60 ? "…" : ""}”`);
    }
  }

  return parts.length ? parts.join(" · ") : null;
}

const HUMAN_ACTIONS: Record<string, string> = {
  accepted: "Accepted",
  dismissed: "Dismissed",
  edited: "Edited",
  resolved: "Resolved",
  pending: "Reset",
  removed: "Removed",
  restored: "Restored",
  user_added: "Created",
  moved_up: "Moved up",
  moved_down: "Moved down",
  assigned_to_appendix: "Routed to appendix",
};

function humanAction(action: string): string {
  if (action.startsWith("reverted_to_v")) return action.replace("reverted_to_v", "Reverted to v");
  return HUMAN_ACTIONS[action] ?? action;
}

/** Lightweight relative-time formatter. Intentionally approximate — this is
 *  a timeline, not a precision clock, and adding a date library just for
 *  this would be overkill. The ISO string sits behind `title` for hover. */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Comments ────────────────────────────────────────────────────────────

/** Matches the same @mention pattern the backend extracts server-side:
 *  a bare `@handle` or a full `@name@domain`. Used client-side only for
 *  visual highlighting — the backend is the authoritative parser. */
const MENTION_REGEX = /@[\w.-]+(?:@[\w.-]+)?/g;

/** Conversation panel for reviewer-to-reviewer coordination on a block.
 *  Separate from block version history — comments don't affect block state,
 *  they just capture discussion. Server enforces delete ownership; the
 *  client hides the delete button for non-owners as UX courtesy. */
function CommentsSection({
  comments,
  currentUserEmail,
  busy,
  readOnly,
  onAdd,
  onDelete,
}: {
  comments: BlockComment[];
  currentUserEmail: string | null;
  busy: boolean;
  /** When true, hide the post/delete affordances — existing comments still
   *  render for audit value. */
  readOnly: boolean;
  onAdd: (text: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    await onAdd(text);
    setDraft("");
  };

  // Enter submits, Shift+Enter keeps the default (newline). Standard chat
  // convention — reviewers can still author multi-line comments by holding
  // Shift. Also submit via the button below.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="rounded border border-border">
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
        Comments · {comments.length}
      </div>
      {comments.length > 0 && (
        <div className="divide-y divide-border">
          {comments.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              canDelete={!readOnly && !!currentUserEmail && c.user_email === currentUserEmail}
              busy={busy}
              onDelete={() => onDelete(c.id)}
            />
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="p-2 border-t border-border space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Add a comment — @mention teammates. Enter to send, Shift+Enter for newline."
            rows={2}
            className="w-full text-xs p-2 rounded border border-border bg-muted/20 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex items-center justify-end">
            <button
              onClick={submit}
              disabled={busy || draft.trim().length === 0}
              className="text-xs px-3 py-1 rounded border border-border hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentRow({
  comment,
  canDelete,
  busy,
  onDelete,
}: {
  comment: BlockComment;
  canDelete: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const who = comment.user_name ?? comment.user_email ?? "Unknown";

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="text-foreground font-medium">{who}</span>
        <span>·</span>
        <time dateTime={comment.at} title={comment.at}>
          {formatRelativeTime(comment.at)}
        </time>
        <span className="flex-1" />
        {canDelete && (
          <button
            onClick={onDelete}
            disabled={busy}
            title="Delete your comment"
            className="text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50"
          >
            ✕
          </button>
        )}
      </div>
      <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
        <MentionHighlighted text={comment.text} />
      </p>
    </div>
  );
}

/** Splits a comment by @mention tokens and wraps each mention in a styled
 *  span. Uses the same regex as the backend's extraction so nothing drifts
 *  between what's visually highlighted and what the server counts as a
 *  mention. The non-mention segments render plain. */
function MentionHighlighted({ text }: { text: string }) {
  // String.split with a capturing regex keeps the matched tokens in the
  // resulting array (on odd indices), which lets us reconstruct with one pass.
  const parts = text.split(new RegExp(`(${MENTION_REGEX.source})`, "g"));
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          return (
            <span
              key={i}
              className="text-blue-400 font-medium"
              title="Mentioned user"
            >
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function RelationshipBadge({ block }: { block: ConsolidatedBlock }) {
  const colorMap: Record<string, string> = {
    conflict: "bg-red-500/15 text-red-400",
    gap: "bg-violet-500/15 text-violet-400",
    kcad_addition: "bg-amber-500/15 text-amber-500",
  };

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${colorMap[block.type] ?? colorMap.kcad_addition}`}>
      {block.type === "conflict" ? "Conflict" : block.type === "gap" ? "New Content" : relationshipLabel(block).split(" — ")[0]}
    </span>
  );
}

function ConfidenceIndicator({ confidence }: { confidence: string | null }) {
  if (!confidence) return null;
  const levels: Record<string, { dots: number; color: string; label: string }> = {
    high: { dots: 3, color: "text-green-400", label: "High confidence" },
    medium: { dots: 2, color: "text-yellow-400", label: "Medium confidence" },
    low: { dots: 1, color: "text-red-400", label: "Low — verify carefully" },
  };
  const l = levels[confidence] ?? levels.high;

  return (
    <div className={`flex items-center gap-1 text-[10px] ${l.color}`}>
      {Array.from({ length: 3 }, (_, i) => (
        <span key={i} className={i < l.dots ? "" : "opacity-20"}>&#9679;</span>
      ))}
      <span className="ml-0.5">{l.label}</span>
    </div>
  );
}

function ChunkView({
  label,
  accentColor,
  chunk,
  fallbackText,
  language,
  translatable = false,
  onEdit,
  hasEdit = false,
}: {
  label: string;
  accentColor: "blue" | "amber";
  chunk: ConsolidatedBlock["hp_chunk"] | null;
  fallbackText: string | null;
  language?: string;
  translatable?: boolean;
  /** Optional edit entry point. Rendered as a small header button. */
  onEdit?: () => void;
  hasEdit?: boolean;
}) {
  const text = chunk?.text ?? fallbackText ?? "";
  const translation = useChunkTranslation(text, language);

  if (!text) return null;

  const borderColor = accentColor === "blue" ? "border-blue-500/50" : "border-amber-500/50";
  const labelColor = accentColor === "blue" ? "text-blue-400" : "text-amber-400";

  const displayText = translatable ? translation.displayText : text;
  const dir = translatable ? translation.dir : "ltr";

  return (
    <div className={`border-l-2 ${borderColor} pl-3`}>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={`text-xs font-semibold ${labelColor}`}>{label}</span>
        {hasEdit && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-blue-400">
            Edited
          </span>
        )}
        {chunk?.document && (
          <span className="text-[10px] text-muted-foreground">{chunk.document.replace(/\.pdf$/i, "")}</span>
        )}
        {translatable && <LanguageBadge language={language} />}
        <span className="flex-1" />
        {translatable && translation.canTranslate && (
          <TranslateToggle
            mode={translation.mode}
            isLoading={translation.isLoading}
            onClick={translation.toggle}
            size="xs"
          />
        )}
        {onEdit && (
          <button
            onClick={onEdit}
            className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            title={hasEdit ? "Edit this block's text again" : "Edit before accepting"}
          >
            ✎ Edit
          </button>
        )}
      </div>
      {chunk?.heading_path && (
        <div className="text-[10px] text-muted-foreground mb-1 truncate">{chunk.heading_path}</div>
      )}
      {chunk?.context_preamble && (
        <p className="text-[10px] text-muted-foreground italic mb-1 leading-relaxed">
          {chunk.context_preamble}
        </p>
      )}
      <div className={`${PROSE_CLASSES} max-h-60 overflow-auto`} dir={dir}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
      </div>
      {translatable && translation.error && <TranslationError message={translation.error} />}
    </div>
  );
}

/** In-place editor for the reviewer to rewrite a block's text before
 *  accepting. Writes to `edited_text` via a standard block action so the
 *  change participates in version history / concurrency / publish locks. */
function EditDraftEditor({
  value,
  onChange,
  onSave,
  onCancel,
  busy,
  hasExistingEdit,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  hasExistingEdit: boolean;
}) {
  return (
    <div className="border-l-2 border-blue-500/50 pl-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold text-blue-400">Editing block</span>
        <span className="text-[10px] text-muted-foreground">Markdown supported</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className="w-full text-xs p-2 font-mono rounded border border-border bg-muted/20 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
        autoFocus
      />
      <div className="flex gap-2">
        <button
          disabled={busy || value.trim().length === 0}
          onClick={onSave}
          className="flex-1 text-xs py-1.5 rounded border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {hasExistingEdit ? "Save changes" : "Save edit"}
        </button>
        <button
          disabled={busy}
          onClick={onCancel}
          className="flex-1 text-xs py-1.5 rounded border border-border text-muted-foreground hover:bg-muted/50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Compact provenance card: HP source (document + heading_path) and KCAD
 *  source (document + chunk_id) when each is available. Nothing renders if
 *  the block has neither (pure user_added). */
function ProvenanceCard({ block }: { block: ConsolidatedBlock }) {
  const hp = block.hp_chunk ?? null;
  const kcad = block.kcad_chunk ?? null;
  const hasHp = hp || block.hp_original_text;
  const hasKcad = kcad || (block.type === "kcad_addition" || block.type === "gap" || block.type === "conflict");
  if (!hasHp && !hasKcad && block.source.origin !== "user") return null;

  return (
    <div className="rounded border border-border bg-muted/20 p-2 text-[11px] space-y-1">
      <div className="text-[11px] font-semibold text-muted-foreground">
        Provenance
      </div>
      {hasHp && (
        <div>
          <span className="text-blue-400 font-medium">HP · </span>
          <span className="text-muted-foreground">
            {hp?.document?.replace(/\.pdf$/i, "") ?? block.source.document?.replace(/\.pdf$/i, "") ?? "—"}
          </span>
          {hp?.heading_path && (
            <span className="text-muted-foreground/70"> · {hp.heading_path}</span>
          )}
        </div>
      )}
      {hasKcad && (
        <>
          <div>
            <span className="text-amber-400 font-medium">KCAD · </span>
            <span className="text-muted-foreground">
              {kcad?.document?.replace(/\.pdf$/i, "") ??
                block.source.document?.replace(/\.pdf$/i, "") ??
                "—"}
            </span>
            {block.source.chunk_id && (
              <span className="text-muted-foreground/70 font-mono"> · {block.source.chunk_id}</span>
            )}
          </div>
          {/* Region surfaces here (and only here) — the reviewer clicks into
              the block to learn "which region does this apply to?". Inline
              block cards + Unified View callouts stay region-free. */}
          {(block.source.region || block.source.rig) && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground/90">
              {block.source.region && (
                <span>
                  <span className="font-medium">Region:</span> {block.source.region}
                </span>
              )}
              {block.source.rig && (
                <span>
                  <span className="font-medium">Rig:</span> {block.source.rig}
                </span>
              )}
            </div>
          )}
        </>
      )}
      {block.source.origin === "user" && (
        <div>
          <span className="text-emerald-400 font-medium">User-added · </span>
          <span className="text-muted-foreground">Created in reviewer UI</span>
        </div>
      )}
    </div>
  );
}

function DifferenceSummary({ block }: { block: ConsolidatedBlock }) {
  if (block.type === "conflict" && block.conflict?.description) {
    return (
      <div className="p-2.5 rounded border border-red-500/30 bg-red-500/5">
        <div className="text-xs font-medium text-red-400 mb-0.5">Conflict</div>
        <p className="text-xs text-foreground/80">{block.conflict.description}</p>
      </div>
    );
  }

  if (block.additive_detail) {
    return (
      <div className="p-2.5 rounded border border-amber-500/30 bg-amber-500/5">
        <div className="text-xs font-medium text-amber-500 mb-0.5">What&apos;s different</div>
        <p className="text-xs text-foreground/80">{block.additive_detail}</p>
      </div>
    );
  }

  if (block.type === "gap") {
    return (
      <div className="p-2.5 rounded border border-violet-500/30 bg-violet-500/5">
        <div className="text-xs font-medium text-violet-400 mb-0.5">New content</div>
        <p className="text-xs text-foreground/80">
          No matching section found in this H&P document.
          {block.ai_reasoning && ` ${block.ai_reasoning}`}
        </p>
      </div>
    );
  }

  return null;
}

function DimensionDots({ dims }: { dims: Record<string, boolean> }) {
  const labels: Record<string, string> = {
    document_function: "Function",
    operational_object: "Object",
    intent_type: "Intent",
    applicability_context: "Context",
    decision_evidence_logic: "Logic",
  };

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {Object.entries(labels).map(([key, label]) => {
        const match = dims[key];
        return (
          <span key={key} className="text-[10px] flex items-center gap-0.5">
            <span className={match ? "text-green-400" : "text-red-400"}>{match ? "✓" : "✗"}</span>
            <span className="text-muted-foreground">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Action bar dispatcher ───────────────────────────────────────────────

/** Routes to a relationship-specific action set. Conflict and Gap are
 *  type-special; everything else switches on `block.relationship`. Unknown
 *  relationships (e.g. "Related", not yet emitted by the pipeline) fall
 *  back to the generic Accept/Dismiss/Reset set so new data doesn't break
 *  the UI — review is still possible, just without the tailored prompts. */
function ActionBar({
  block,
  busy,
  note,
  onAction,
  onAssignAppendix,
}: {
  block: ConsolidatedBlock;
  busy: boolean;
  note: string;
  onAction: (action: string, resolution?: string) => void;
  onAssignAppendix?: () => void;
}) {
  if (block.type === "conflict") {
    return <ConflictActions busy={busy} status={block.status} onAction={onAction} />;
  }
  if (block.type === "gap") {
    return <GapActions busy={busy} status={block.status} note={note} onAction={onAction} />;
  }
  switch (block.relationship) {
    case "Equivalent":
      return <EquivalentActions busy={busy} status={block.status} onAction={onAction} />;
    case "Variant":
      return (
        <VariantActions
          busy={busy}
          status={block.status}
          onAction={onAction}
          onAssignAppendix={onAssignAppendix}
          hasAppendixAssignment={!!block.appendix_id}
          appendixName={block.appendix_name ?? null}
        />
      );
    case "Complementary":
      return <ComplementaryActions busy={busy} status={block.status} onAction={onAction} />;
    default:
      return <StandardActions busy={busy} status={block.status} onAction={onAction} />;
  }
}

// ── Reclassify dropdown ────────────────────────────────────────────────

const RECLASSIFY_OPTIONS: {
  value: "Equivalent" | "Variant" | "Complementary" | "Related";
  label: string;
}[] = [
  { value: "Equivalent", label: "Equivalent — already covered" },
  { value: "Variant", label: "Variant — regional adaptation" },
  { value: "Complementary", label: "Complementary — supporting content" },
  { value: "Related", label: "Related — loosely relevant" },
];

/** Small native-select dropdown for manually overriding the AI's
 *  relationship label on a block. Native <select> is deliberate — this is
 *  an infrequent corrective action, not a primary review flow, so
 *  accessibility and familiarity outweigh design polish. On change, the
 *  ActionBar automatically switches its rendered action set because it
 *  dispatches on block.relationship. */
function ReclassifyDropdown({
  current,
  disabled,
  onSelect,
}: {
  current: string | null;
  disabled: boolean;
  onSelect: (next: "Equivalent" | "Variant" | "Complementary" | "Related") => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <label className="text-muted-foreground font-semibold">Reclassify</label>
      <select
        value={current ?? ""}
        disabled={disabled}
        onChange={(e) =>
          onSelect(e.target.value as "Equivalent" | "Variant" | "Complementary" | "Related")
        }
        className="flex-1 px-2 py-1 text-[11px] rounded border border-border bg-muted/20 text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
      >
        {current && !RECLASSIFY_OPTIONS.find((o) => o.value === current) && (
          <option value={current}>{current} (current)</option>
        )}
        {RECLASSIFY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Shared action-button styles ─────────────────────────────────────────

const BTN_BASE =
  "text-xs py-1.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

const BTN_ACCEPT_SELECTED = "bg-green-500/15 text-green-400 border-green-500/30";
const BTN_ACCEPT_IDLE =
  "border-border hover:bg-green-500/10 hover:text-green-400 hover:border-green-500/30";
const BTN_DISMISS_SELECTED = "bg-muted text-muted-foreground border-border";
const BTN_DISMISS_IDLE = "border-border hover:bg-muted/50 hover:text-muted-foreground";
const BTN_NEUTRAL = "border-border hover:bg-muted/50";

// ── Variant context card ────────────────────────────────────────────────

/** Shows which operational dimensions the Variant block is scoped to.
 *  Only rendered when block.relationship === "Variant" — Gaps don't yet
 *  carry scope metadata, so the caller guards the render site. */
function VariantContextCard({ block }: { block: ConsolidatedBlock }) {
  const chips: { label: string; value: string }[] = [];
  if (block.source.region) chips.push({ label: "Region", value: block.source.region });
  if (block.source.rig) chips.push({ label: "Rig", value: block.source.rig });
  if (chips.length === 0) return null;

  return (
    <div className="rounded border border-border bg-muted/20 px-2 py-1.5 flex flex-wrap gap-1.5 text-[10px]">
      <span className="text-muted-foreground">Scope:</span>
      {chips.map((c) => (
        <span key={c.label} className="px-1.5 py-0.5 rounded bg-background border border-border">
          <span className="text-muted-foreground">{c.label}</span>
          <span className="mx-1">·</span>
          <span className="text-foreground">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

// ── Action components ───────────────────────────────────────────────────

function EquivalentActions({
  busy,
  status,
  onAction,
}: {
  busy: boolean;
  status: string;
  onAction: (action: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-muted-foreground">
        Already Covered — Confirm or Dismiss
      </div>
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={() => onAction("accepted")}
          className={`${BTN_BASE} flex-1 ${status === "accepted" ? BTN_ACCEPT_SELECTED : BTN_ACCEPT_IDLE}`}
        >
          Approve
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("dismissed")}
          className={`${BTN_BASE} flex-1 ${status === "dismissed" ? BTN_DISMISS_SELECTED : BTN_DISMISS_IDLE}`}
        >
          Dismiss
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("pending")}
          className={`${BTN_BASE} px-3 ${BTN_NEUTRAL}`}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function VariantActions({
  busy,
  status,
  onAction,
  onAssignAppendix,
  hasAppendixAssignment,
  appendixName,
}: {
  busy: boolean;
  status: string;
  onAction: (action: string) => void;
  onAssignAppendix?: () => void;
  hasAppendixAssignment: boolean;
  appendixName: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-muted-foreground">
        Regional Variant — Approve, Dismiss, or Route to an Appendix
      </div>
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={() => onAction("accepted")}
          className={`${BTN_BASE} flex-1 ${status === "accepted" ? BTN_ACCEPT_SELECTED : BTN_ACCEPT_IDLE}`}
        >
          Approve
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("dismissed")}
          className={`${BTN_BASE} flex-1 ${status === "dismissed" ? BTN_DISMISS_SELECTED : BTN_DISMISS_IDLE}`}
        >
          Dismiss
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("pending")}
          className={`${BTN_BASE} px-3 ${BTN_NEUTRAL}`}
        >
          Reset
        </button>
      </div>
      {/* "Add to Appendix" is listed last per spec — the primary path is
          approve/dismiss; appendix routing is the escape hatch. */}
      <button
        disabled={busy || !onAssignAppendix}
        onClick={onAssignAppendix}
        className={`${BTN_BASE} w-full ${
          hasAppendixAssignment
            ? "bg-indigo-500/15 text-indigo-400 border-indigo-500/30"
            : "border-dashed border-indigo-500/40 hover:bg-indigo-500/10 hover:text-indigo-400"
        }`}
      >
        {hasAppendixAssignment
          ? `✓ In appendix: ${appendixName ?? "(unnamed)"}`
          : "+ Add to Appendix"}
      </button>
    </div>
  );
}

function ComplementaryActions({
  busy,
  status,
  onAction,
}: {
  busy: boolean;
  status: string;
  onAction: (action: string, resolution?: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-muted-foreground">
        Supporting Content — AI Suggests Placing Here
      </div>
      <button
        disabled={busy}
        onClick={() => onAction("accepted", "place_here")}
        className={`${BTN_BASE} w-full ${status === "accepted" ? BTN_ACCEPT_SELECTED : BTN_ACCEPT_IDLE}`}
      >
        Accept · Place Here
      </button>
      <div className="grid grid-cols-3 gap-1.5">
        {/* "Edit Before Accepting" lives in Step 5 — stubbed but wired to
            the same edited-text action so Step 3 isn't blocked on the editor. */}
        <button
          disabled
          title="Inline editor ships in Step 5"
          className={`${BTN_BASE} ${BTN_NEUTRAL}`}
        >
          Edit first
        </button>
        <button
          disabled
          title="Adjacent-merge ships in M2"
          className={`${BTN_BASE} ${BTN_NEUTRAL}`}
        >
          Merge
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("dismissed")}
          className={`${BTN_BASE} ${status === "dismissed" ? BTN_DISMISS_SELECTED : BTN_DISMISS_IDLE}`}
        >
          Dismiss
        </button>
      </div>
      <button
        disabled={busy}
        onClick={() => onAction("pending")}
        className={`${BTN_BASE} w-full ${BTN_NEUTRAL}`}
      >
        Reset
      </button>
    </div>
  );
}

function GapActions({
  busy,
  status,
  note,
  onAction,
}: {
  busy: boolean;
  status: string;
  note: string;
  onAction: (action: string, resolution?: string) => void;
}) {
  const hasJustification = note.trim().length > 0;

  return (
    <div className="space-y-1.5 rounded border border-violet-500/30 bg-violet-500/5 p-2">
      <div className="text-[11px] font-semibold text-violet-400">
        New Content · Not in this H&P Doc
      </div>
      <button
        disabled={busy}
        onClick={() => onAction("accepted", "create_section")}
        className={`${BTN_BASE} w-full ${
          status === "accepted"
            ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
            : "border-violet-500/40 hover:bg-violet-500/15 text-violet-400"
        }`}
      >
        Accept · Create Section
      </button>
      <div className="flex gap-2">
        <button
          disabled={busy || !hasJustification}
          onClick={() => onAction("dismissed")}
          title={hasJustification ? "" : "Justification required — type a reason above"}
          className={`${BTN_BASE} flex-1 ${status === "dismissed" ? BTN_DISMISS_SELECTED : BTN_DISMISS_IDLE}`}
        >
          Dismiss (need note)
        </button>
        <button
          disabled
          title="Cross-document relocation ships later"
          className={`${BTN_BASE} flex-1 ${BTN_NEUTRAL}`}
        >
          Separate topic
        </button>
      </div>
      <button
        disabled={busy}
        onClick={() => onAction("pending")}
        className={`${BTN_BASE} w-full ${BTN_NEUTRAL}`}
      >
        Reset
      </button>
    </div>
  );
}

function StandardActions({
  busy,
  onAction,
  status,
}: {
  busy: boolean;
  onAction: (action: string) => void;
  status: string;
}) {
  return (
    <div className="flex gap-2">
      <button
        disabled={busy}
        onClick={() => onAction("accepted")}
        className={`${BTN_BASE} flex-1 ${status === "accepted" ? BTN_ACCEPT_SELECTED : BTN_ACCEPT_IDLE}`}
      >
        Accept
      </button>
      <button
        disabled={busy}
        onClick={() => onAction("dismissed")}
        className={`${BTN_BASE} flex-1 ${status === "dismissed" ? BTN_DISMISS_SELECTED : BTN_DISMISS_IDLE}`}
      >
        Dismiss
      </button>
      <button
        disabled={busy}
        onClick={() => onAction("pending")}
        className={`${BTN_BASE} px-3 ${BTN_NEUTRAL}`}
      >
        Reset
      </button>
    </div>
  );
}

function ConflictActions({
  busy,
  status,
  onAction,
}: {
  busy: boolean;
  status: string;
  onAction: (action: string, resolution?: string) => void;
}) {
  const isResolved = status === "resolved";
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-muted-foreground">
        Resolution {isResolved && <span className="text-green-400">· Resolved</span>}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          disabled={busy}
          onClick={() => onAction("resolved", "keep_hp")}
          className={`${BTN_BASE} border-border hover:bg-blue-500/10 hover:text-blue-400 hover:border-blue-500/30`}
        >
          Keep H&P
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("resolved", "keep_kcad")}
          className={`${BTN_BASE} border-border hover:bg-amber-500/10 hover:text-amber-500 hover:border-amber-500/30`}
        >
          Use KCAD
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("resolved", "combined")}
          className={`${BTN_BASE} ${BTN_NEUTRAL}`}
        >
          Combine
        </button>
        <button
          disabled={busy}
          onClick={() => onAction("resolved", "escalated")}
          className={`${BTN_BASE} ${BTN_NEUTRAL}`}
        >
          Escalate
        </button>
      </div>
      {isResolved && (
        <button
          disabled={busy}
          onClick={() => onAction("pending")}
          className={`${BTN_BASE} w-full ${BTN_NEUTRAL}`}
        >
          Reset
        </button>
      )}
    </div>
  );
}
