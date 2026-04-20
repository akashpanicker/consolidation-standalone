"""Consolidation API — serves HP-anchored consolidated views and review actions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel

from ..translation import detect_language

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/consolidation", tags=["consolidation"])

VIEWS_DIR = Path(__file__).resolve().parent.parent.parent / "cache" / "consolidation" / "views"
MERGED_DIR = Path(__file__).resolve().parent.parent.parent / "cache" / "consolidation" / "merged"
METADATA_DIR = Path(__file__).resolve().parent.parent.parent / "cache" / "metadata"

# Fields that the pipeline produces and that user actions never change.
# History snapshots capture everything EXCEPT these — fail-safe default so new
# user-facing fields are automatically version-tracked without registration.
_IMMUTABLE_BLOCK_FIELDS = frozenset({
    "id",
    "type",
    "text",
    "format",
    "section_function",
    "normative_mode",
    "heading_path",
    "context_preamble",
    "source",
    "tier",
    "additive_detail",
    "conflict",
    "ai_confidence",
    "ai_reasoning",
    "dimension_matches",
    "hp_original_text",
    "hp_chunk",
    "kcad_chunk",
    "language",
    # "history" is the record itself — snapshotting it would cause unbounded growth.
    "history",
    # "comments" are conversation, not review state. They have their own
    # author attribution and timestamps; reverting a block's decision should
    # not erase the discussion that led to it.
    "comments",
})

VALID_BLOCK_ACTIONS = {"accepted", "dismissed", "edited", "resolved", "pending", "removed"}

VALID_DOC_STATUSES = {"ai_consolidated", "in_review", "approved", "published"}
VALID_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "ai_consolidated": {"in_review"},
    "in_review": {"approved", "ai_consolidated"},
    "approved": {"published", "in_review"},
    "published": {"in_review"},
}


# ── Helpers ───────────────────────────────────────────────────────────────


def _load_view(slug: str) -> dict | None:
    """Load a consolidated view JSON by its slug (filename stem without .json)."""
    path = VIEWS_DIR / f"{slug}.json"
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _save_view(slug: str, data: dict) -> None:
    """Persist a consolidated view back to disk atomically.

    Writes to a sibling .tmp file and uses os.replace for an atomic swap.
    Guarantees that a concurrent reader sees either the old file or the new file —
    never a partial write. Survives process crashes during serialization.
    """
    path = VIEWS_DIR / f"{slug}.json"
    tmp_path = path.with_suffix(".json.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)


def _require_view(slug: str) -> dict:
    """Load a view or raise 404."""
    data = _load_view(slug)
    if data is None:
        raise HTTPException(404, f"No consolidated view for '{slug}'")
    return data


def _check_not_published(data: dict) -> None:
    """Raise 409 if the document is published (locked from edits)."""
    if data.get("review_status", "ai_consolidated") == "published":
        raise HTTPException(409, "Document is published and locked from edits. Unpublish first.")


def _find_block(data: dict, block_id: str) -> dict:
    """Find a block by ID or raise 404."""
    for b in data.get("blocks", []):
        if b["id"] == block_id:
            return b
    raise HTTPException(404, f"Block '{block_id}' not found")


def _snapshot(block: dict) -> dict:
    """Capture all mutable fields of a block for version history.

    Everything EXCEPT pipeline-produced immutable fields and the history
    record itself is captured. This is fail-safe: new user-facing fields
    added in future steps (comments, appendix assignment, etc.) are
    tracked automatically without needing registration.
    """
    return {k: v for k, v in block.items() if k not in _IMMUTABLE_BLOCK_FIELDS}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── User identity dependency ────────────────────────────────────────────


class User(BaseModel):
    name: str | None = None
    email: str | None = None


def get_user(
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
    x_user_name: str | None = Header(default=None, alias="X-User-Name"),
) -> User:
    """Derive the acting user from request headers.

    The frontend sets X-User-Email and X-User-Name from its authenticated
    MSAL session. Body-supplied identity fields are ignored — this is the
    single source of truth for audit trails.

    When we wire full MSAL token validation later, we'll swap this
    implementation to parse the Authorization header; all call sites stay
    unchanged because they depend on the User model, not the parsing.
    """
    return User(name=x_user_name, email=x_user_email)


def _compute_etag(data: dict) -> str:
    """Compute a canonical SHA-256 hash of view data for optimistic concurrency.

    Uses sort_keys=True so that logically identical dicts produce identical
    hashes regardless of key insertion order. The ETag is wrapped in quotes
    per RFC 7232 (strong validator format).
    """
    canonical = json.dumps(data, sort_keys=True, default=str, ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()[:16]
    return f'"{digest}"'


def _check_if_match(if_match: str | None, current_etag: str, current_data: dict) -> None:
    """Validate the If-Match header against the current view ETag.

    - If header is missing, raise 428 Precondition Required with guidance.
    - If header is "*" (wildcard), allow the write (force-overwrite).
    - If header matches the current ETag, allow the write.
    - Otherwise, raise 412 Precondition Failed with the current state embedded
      in the response so the client can merge/retry without a second round trip.
    """
    if if_match is None:
        raise HTTPException(
            status_code=428,
            detail=(
                "Precondition Required: send 'If-Match' header with the current "
                "ETag to prevent overwriting concurrent edits. Use 'If-Match: *' "
                "to force-overwrite (not recommended in multi-user flows)."
            ),
        )

    # Strip whitespace; support both "abc" and W/"abc" forms defensively.
    normalized = if_match.strip()
    if normalized == "*":
        return

    if normalized != current_etag:
        raise HTTPException(
            status_code=412,
            detail={
                "message": "Document changed since you last read it. Reload and retry.",
                "current_etag": current_etag,
                "current_view": current_data,
            },
        )


def _count_reviewed(blocks: list[dict]) -> int:
    """Count blocks with a review action (accepted, dismissed, edited, resolved)."""
    reviewed_statuses = {"accepted", "dismissed", "edited", "resolved"}
    return sum(1 for b in blocks if b.get("status") in reviewed_statuses)


# ── List HP documents with consolidation stats ──────────────────────────


@router.get("/documents")
def list_consolidated_documents():
    """Return all HP documents that have consolidated views, with summary stats.

    Each entry now also includes `kcad_source_titles` — the natural-language
    titles of each KCAD source document (from `cache/metadata/document_details`).
    The existing `kcad_sources` field (raw filenames) stays for backwards
    compatibility. Titles are resolved per-filename; a missing metadata file
    falls back to the filename stem so nothing silently disappears.
    """
    if not VIEWS_DIR.exists():
        return []

    # Cache title lookups across docs — many HP docs share KCAD sources.
    title_cache: dict[str, str] = {}

    def _kcad_title(filename: str) -> str:
        if filename in title_cache:
            return title_cache[filename]
        details = _load_document_details(filename)
        canonical = (details.get("canonical") or {}) if isinstance(details, dict) else {}
        title = None
        if isinstance(canonical, dict):
            title = canonical.get("title")
        if not title:
            title = Path(filename).stem.replace("_", " ")
        title_cache[filename] = title
        return title

    docs = []
    for fp in sorted(VIEWS_DIR.glob("*.json")):
        try:
            with open(fp, encoding="utf-8") as f:
                data = json.load(f)
            summary = data.get("summary", {})
            kcad_sources = summary.get("kcad_sources", []) or []
            # For each KCAD source, resolve its natural-language title + region
            # (from block-level source metadata). De-duped by filename.
            kcad_region_by_fn: dict[str, str] = {}
            for b in data.get("blocks", []):
                src = b.get("source") or {}
                if str(src.get("origin", "")).upper() != "KCAD":
                    continue
                doc = src.get("document")
                if doc and doc not in kcad_region_by_fn:
                    kcad_region_by_fn[doc] = src.get("region") or ""
            kcad_source_titles = [
                {
                    "filename": fn,
                    "title": _kcad_title(fn),
                    "region": kcad_region_by_fn.get(fn, ""),
                }
                for fn in kcad_sources
            ]

            # HP's own display name — from document_details if available, else
            # derive from filename.
            hp_filename = data.get("hp_filename", fp.stem)
            hp_details = _load_document_details(hp_filename)
            hp_canonical = (hp_details.get("canonical") or {}) if isinstance(hp_details, dict) else {}
            hp_title = None
            if isinstance(hp_canonical, dict):
                hp_title = hp_canonical.get("title")
            if not hp_title:
                hp_title = Path(hp_filename).stem.replace("_", " ")

            docs.append({
                "slug": fp.stem,
                "hp_filename": hp_filename,
                "hp_title": hp_title,
                "review_status": data.get("review_status", "ai_consolidated"),
                "total_additions": summary.get("total_additions", 0),
                "total_conflicts": summary.get("total_conflicts", 0),
                "total_gaps": summary.get("total_gaps", 0),
                "total_hp_blocks": summary.get("total_hp_blocks", 0),
                "low_confidence_count": summary.get("low_confidence_count", 0),
                "kcad_source_count": summary.get("kcad_source_count", 0),
                "kcad_sources": kcad_sources,
                "kcad_source_titles": kcad_source_titles,
                "regions": summary.get("regions", []),
                "built_at": data.get("built_at"),
                "reviewed": _count_reviewed(data.get("blocks", [])),
                "total_reviewable": summary.get("total_additions", 0),
            })
        except Exception as e:
            logger.warning(f"Failed to load {fp.name}: {e}")
            continue

    return docs


# ── Get full consolidated view ──────────────────────────────────────────


@router.get("/documents/{slug}/consolidated")
def get_consolidated_view(slug: str, response: Response):
    """Return the full consolidated view for an HP document.

    Sets the ETag response header so clients can use it with If-Match on
    subsequent mutations for optimistic concurrency.
    """
    data = _require_view(slug)
    # Ensure review_status is always present in the response
    data.setdefault("review_status", "ai_consolidated")
    response.headers["ETag"] = _compute_etag(data)
    return data


# ── Merged (unified-narrative) document ─────────────────────────────────


@router.get("/documents/{slug}/merged")
def get_merged_document(slug: str):
    """Return the narrative-merged consolidated document for client preview.

    Produced by `python -m consolidation merge --doc <slug>`. Returns 404 if
    the merged output hasn't been generated yet — the client then falls back
    to block-level rendering from the /consolidated endpoint.
    """
    path = MERGED_DIR / f"{slug}.json"
    if not path.exists():
        raise HTTPException(404, f"No merged document for '{slug}'. Run `python -m consolidation merge --doc {slug}`.")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── Document context (metadata: document_details + concept_classification) ──


def _slug_for_metadata(filename: str) -> str:
    """Mirror consolidation.config.sanitize_filename so metadata pkls resolve.

    Kept local instead of imported to avoid a router→consolidation package
    dependency. See `consolidation/config.py:sanitize_filename`.
    """
    stem = Path(filename).stem
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", stem) + "_pdf"


def _load_pickle(path: Path) -> dict | None:
    """Best-effort load of a pickled metadata file. Returns None on any failure."""
    if not path.exists():
        return None
    try:
        import pickle
        with open(path, "rb") as f:
            obj = pickle.load(f)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _coerce_dictish(value) -> dict | list | None:
    """Accept either a dict/list or a python-repr string of one. Returns None otherwise.

    Some metadata pkls stringify nested structures. Safer than eval: literal_eval
    only accepts Python literals, no callable execution.
    """
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            import ast
            result = ast.literal_eval(value)
            if isinstance(result, (dict, list)):
                return result
        except (ValueError, SyntaxError):
            pass
    return None


def _load_document_details(filename: str) -> dict:
    """Extract canonical, scope, objective, purpose + all named fields.

    HP docs use canonical fields (document_number, title, revision, effective_date,
    revision_notes) + raw_fields covering Affected Entities, Department, etc.
    KCAD docs use raw_fields that include Scope / Objective / Purpose depending on
    the template. Returns a normalized dict with whichever fields were present.
    """
    slug = _slug_for_metadata(filename)
    data = _load_pickle(METADATA_DIR / "document_details" / f"document_details_v1_{slug}.pkl")
    if data is None:
        return {"filename": filename, "available": False}

    canonical = _coerce_dictish(data.get("canonical")) or {}
    raw = _coerce_dictish(data.get("raw_fields")) or []

    named: dict[str, str] = {}
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name", "")).strip().rstrip(":").strip()
            value = entry.get("value", "")
            if not isinstance(value, str):
                value = str(value) if value is not None else ""
            if name and value and name.lower() not in named:
                named[name.lower()] = value

    return {
        "filename": filename,
        "available": True,
        "canonical": canonical if isinstance(canonical, dict) else {},
        "scope": named.get("scope"),
        "objective": named.get("objective"),
        "purpose": named.get("purpose"),
        "affected_entities": named.get("affected entities") or canonical.get("affected_entities") if isinstance(canonical, dict) else named.get("affected entities"),
        "department": named.get("department"),
        "named_fields": named,
    }


def _load_concept_classification(filename: str) -> dict | None:
    """Return primary + secondary concepts for the document, or None if unavailable."""
    slug = _slug_for_metadata(filename)
    data = _load_pickle(METADATA_DIR / "concept_classification" / f"concept_classification_v1_{slug}.pkl")
    if data is None:
        return None

    classification = _coerce_dictish(data.get("classification")) or {}
    if not isinstance(classification, dict):
        return None

    primary = classification.get("primary") or {}
    if not isinstance(primary, dict):
        primary = {}

    secondary_raw = classification.get("secondary") or []
    if not isinstance(secondary_raw, list):
        secondary_raw = []

    return {
        "filename": filename,
        "primary": {
            "code": primary.get("code"),
            "name": primary.get("name"),
            "tier_name": primary.get("tier_name"),
            "confidence": primary.get("confidence"),
        } if primary else None,
        "secondary": [
            {"code": s.get("code"), "name": s.get("name")}
            for s in secondary_raw
            if isinstance(s, dict) and s.get("code")
        ],
    }


@router.get("/documents/{slug}/context")
def get_document_context(slug: str):
    """Return HP document identity + concept coverage, plus the same for every
    KCAD source document referenced in the view.

    Powers the Unified View's document-identity panel and per-regional-callout
    provenance (KCAD scope / objective / primary concept).
    """
    data = _require_view(slug)
    hp_filename = data.get("hp_filename", "")

    hp_details = _load_document_details(hp_filename)
    hp_concepts = _load_concept_classification(hp_filename)

    # Unique KCAD source documents referenced by any block.
    kcad_filenames: set[str] = set()
    for b in data.get("blocks", []):
        src = b.get("source") or {}
        doc = src.get("document")
        origin = str(src.get("origin") or "").upper()
        if doc and origin == "KCAD":
            kcad_filenames.add(doc)

    kcad_entries = []
    for fn in sorted(kcad_filenames):
        kcad_entries.append({
            "filename": fn,
            "details": _load_document_details(fn),
            "concepts": _load_concept_classification(fn),
        })

    return {
        "hp": {
            "filename": hp_filename,
            "details": hp_details,
            "concepts": hp_concepts,
        },
        "kcad": kcad_entries,
    }


# ── Document status transitions ─────────────────────────────────────────


class StatusUpdate(BaseModel):
    status: str


@router.post("/documents/{slug}/status")
def update_document_status(
    slug: str,
    body: StatusUpdate,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Transition the document review status with validation.

    Requires If-Match header for optimistic concurrency. User identity
    derived server-side from X-User-Email / X-User-Name headers.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)

    current = data["review_status"]

    if body.status not in VALID_DOC_STATUSES:
        raise HTTPException(400, f"Invalid status '{body.status}'. Must be one of: {VALID_DOC_STATUSES}")

    allowed = VALID_STATUS_TRANSITIONS.get(current, set())
    if body.status not in allowed:
        raise HTTPException(
            400,
            f"Cannot transition from '{current}' to '{body.status}'. "
            f"Allowed transitions: {allowed or 'none'}",
        )

    # Record the transition
    history_entry = {
        "from": current,
        "to": body.status,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    }
    data.setdefault("status_history", []).append(history_entry)
    data["review_status"] = body.status
    _save_view(slug, data)

    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "review_status": body.status, "from": current}


# ── Block review actions ────────────────────────────────────────────────


class BlockAction(BaseModel):
    action: str  # "accepted", "dismissed", "edited", "resolved", "pending", "removed"
    note: str | None = None
    edited_text: str | None = None
    resolution: str | None = None  # For conflicts: "keep_hp", "keep_kcad", "combined", "escalated"


@router.post("/documents/{slug}/blocks/{block_id}/action")
def update_block_action(
    slug: str,
    block_id: str,
    body: BlockAction,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Save a review action on a specific block. Creates a version history entry.

    Requires If-Match header for optimistic concurrency. User identity
    derived server-side from X-User-Email / X-User-Name headers.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)
    block = _find_block(data, block_id)

    if body.action not in VALID_BLOCK_ACTIONS:
        raise HTTPException(400, f"Invalid action '{body.action}'. Must be one of: {VALID_BLOCK_ACTIONS}")

    # Capture before-state
    before = _snapshot(block)

    # Apply the action
    block["status"] = body.action
    if body.note is not None:
        block["reviewer_note"] = body.note
    if body.edited_text is not None:
        block["edited_text"] = body.edited_text
    if body.resolution is not None:
        block["resolution"] = body.resolution

    # Reset wipes user decisions. 'pending' means 'no decision yet' — leaving
    # a stale edited_text or resolution behind would silently override the
    # original content in downstream rendering. reviewer_note survives because
    # it's the user's notepad, not a decision.
    if body.action == "pending":
        block.pop("edited_text", None)
        block.pop("resolution", None)

    # Capture after-state and create history entry
    after = _snapshot(block)
    history = block.setdefault("history", [])
    version = len(history) + 1
    history.append({
        "version": version,
        "action": body.action,
        "before": before,
        "after": after,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block_id": block_id, "status": body.action, "version": version}


# ── Block version history ───────────────────────────────────────────────


@router.get("/documents/{slug}/blocks/{block_id}/history")
def get_block_history(slug: str, block_id: str):
    """Return the version history timeline for a block."""
    data = _require_view(slug)
    block = _find_block(data, block_id)
    return {
        "block_id": block_id,
        "current_status": block.get("status"),
        "history": block.get("history", []),
    }


# ── Block revert ────────────────────────────────────────────────────────


class RevertRequest(BaseModel):
    version: int


@router.post("/documents/{slug}/blocks/{block_id}/revert")
def revert_block(
    slug: str,
    block_id: str,
    body: RevertRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Revert a block to a specific version. Creates a new history entry recording the revert.

    Requires If-Match header for optimistic concurrency. User identity
    derived server-side from X-User-Email / X-User-Name headers.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)
    block = _find_block(data, block_id)

    history = block.get("history", [])

    # Find the target version by version number (not index)
    target_entry = None
    for entry in history:
        if entry["version"] == body.version:
            target_entry = entry
            break

    if target_entry is None:
        raise HTTPException(404, f"Version {body.version} not found for block '{block_id}'")

    # Capture current state before reverting
    before = _snapshot(block)

    # Restore the after-state of the target version by replacing ALL mutable fields.
    # Remove current mutable fields first (so fields added after the target version
    # are properly cleared), then copy in the target's state.
    target_state = target_entry["after"]
    for key in list(block.keys()):
        if key not in _IMMUTABLE_BLOCK_FIELDS:
            del block[key]
    for key, value in target_state.items():
        block[key] = value

    # Record the revert as a new history entry
    after = _snapshot(block)
    new_version = len(history) + 1
    history.append({
        "version": new_version,
        "action": f"reverted_to_v{body.version}",
        "before": before,
        "after": after,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block_id": block_id, "reverted_to": body.version, "new_version": new_version}


# ── Block-level comments ───────────────────────────────────────────────

# Matches both @username and @user@domain.com forms. Conservative character class
# to avoid pulling in surrounding punctuation.
_MENTION_RE = re.compile(r"@([\w.-]+(?:@[\w.-]+)?)")


def _parse_mentions(text: str) -> list[str]:
    """Extract @mention handles from comment text.

    Captures both `@username` and `@email@domain.com` forms. Deduplicates
    while preserving first-occurrence order (so UI ordering is predictable).
    """
    seen: set[str] = set()
    result: list[str] = []
    for match in _MENTION_RE.finditer(text or ""):
        handle = match.group(1)
        if handle not in seen:
            seen.add(handle)
            result.append(handle)
    return result


class CommentRequest(BaseModel):
    text: str


@router.post("/documents/{slug}/blocks/{block_id}/comments")
def add_comment(
    slug: str,
    block_id: str,
    body: CommentRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Add a comment to a block.

    Comments are conversation — stored on the block but excluded from the
    block's version history. Reverting a block's review state does NOT
    erase its comments.

    @mentions are parsed server-side from the text; clients cannot lie about
    who was mentioned.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)
    block = _find_block(data, block_id)

    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Comment text cannot be empty")

    comment = {
        "id": uuid.uuid4().hex[:12],
        "text": text,
        "mentions": _parse_mentions(text),
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    }
    block.setdefault("comments", []).append(comment)

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "comment": comment}


@router.delete("/documents/{slug}/blocks/{block_id}/comments/{comment_id}")
def delete_comment(
    slug: str,
    block_id: str,
    comment_id: str,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Delete a comment. Only the author (matched by email) can delete."""
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)
    block = _find_block(data, block_id)

    comments = block.get("comments", [])
    idx = next((i for i, c in enumerate(comments) if c.get("id") == comment_id), None)
    if idx is None:
        raise HTTPException(404, f"Comment '{comment_id}' not found on block '{block_id}'")

    target = comments[idx]
    # Author-only delete — match by email (stable identifier; names can vary).
    if not user.email or target.get("user_email") != user.email:
        raise HTTPException(403, "Only the comment author may delete this comment")

    comments.pop(idx)
    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "deleted": comment_id}


# ── Appendix management ────────────────────────────────────────────────


_SCOPE_DIMENSIONS = ("region", "rig", "customer", "environment")


class AppendixScope(BaseModel):
    region: str | None = None
    rig: str | None = None
    customer: str | None = None
    environment: str | None = None


class AppendixCreateRequest(BaseModel):
    name: str
    scope: AppendixScope


class AppendixAssignRequest(BaseModel):
    appendix_id: str
    block_ids: list[str]


class AppendixMatchRequest(BaseModel):
    scope: AppendixScope


def _scope_to_dict(scope: AppendixScope) -> dict[str, str | None]:
    """Materialize a scope model as a plain dict with all four dimensions."""
    return {dim: getattr(scope, dim) for dim in _SCOPE_DIMENSIONS}


def _scope_match_score(block_scope: dict, appendix_scope: dict) -> int | None:
    """Score how well an appendix's scope fits a block's scope.

    An appendix is a candidate only if every non-None dimension it declares
    is satisfied by the block's scope. A None appendix dimension is a
    wildcard (no constraint). Returns the count of satisfied dimensions
    (how specifically the appendix applies) or None if any declared
    dimension fails.

    Example:
      block_scope = {region: "Oman", rig: None}
      appendix A = {region: "Oman"}              -> score 1 (candidate)
      appendix B = {region: "Oman", rig: "T-9X"} -> None (over-scoped; block has no rig)
      appendix C = {region: "Europe"}            -> None (contradicts)
    """
    score = 0
    for dim in _SCOPE_DIMENSIONS:
        appendix_val = appendix_scope.get(dim)
        if appendix_val is None:
            # Wildcard: no constraint imposed by the appendix.
            continue
        block_val = block_scope.get(dim)
        if block_val != appendix_val:
            # Appendix demands a value the block does not have
            # (either a direct contradiction or over-scoping).
            return None
        score += 1
    return score


def _count_blocks_in_appendix(blocks: list[dict], appendix_id: str) -> int:
    return sum(1 for b in blocks if b.get("appendix_id") == appendix_id)


def _enrich_appendix(appendix: dict, blocks: list[dict]) -> dict:
    """Return an appendix dict with a live block_count."""
    return {
        **appendix,
        "block_count": _count_blocks_in_appendix(blocks, appendix["id"]),
    }


@router.post("/documents/{slug}/appendices")
def create_appendix(
    slug: str,
    body: AppendixCreateRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Create a named appendix with a scope (region/rig/customer/environment).

    Scopes declare which content belongs in the appendix. Any scope dimension
    left as None is a wildcard — the appendix applies regardless of that
    dimension on candidate blocks.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    appendix = {
        "id": uuid.uuid4().hex[:12],
        "name": body.name,
        "scope": _scope_to_dict(body.scope),
        "created_by": user.email,
        "created_at": _now_iso(),
    }
    data.setdefault("appendices", []).append(appendix)

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "appendix": _enrich_appendix(appendix, data.get("blocks", []))}


@router.get("/documents/{slug}/appendices")
def list_appendices(slug: str):
    """List all appendices for a document with live block counts."""
    data = _require_view(slug)
    blocks = data.get("blocks", [])
    items = [_enrich_appendix(a, blocks) for a in data.get("appendices", [])]
    return {"appendices": items}


@router.post("/documents/{slug}/appendices/match")
def match_appendix(
    slug: str,
    body: AppendixMatchRequest,
):
    """Find the best existing appendix for a given scope.

    Returns the appendix whose scope has the most matching dimensions
    without contradicting the query. Returns `null` when no appendix
    matches (caller should prompt the user to create one).
    """
    data = _require_view(slug)
    query_scope = _scope_to_dict(body.scope)
    appendices = data.get("appendices", [])

    best: tuple[int, int, dict] | None = None  # (match_score, specificity, appendix)
    for ap in appendices:
        ap_scope = ap.get("scope", {})
        score = _scope_match_score(query_scope, ap_scope)
        if score is None:
            continue
        specificity = sum(1 for dim in _SCOPE_DIMENSIONS if ap_scope.get(dim) is not None)
        candidate = (score, specificity, ap)
        if best is None or candidate > best:
            best = candidate

    if best is None:
        return {"appendix": None}
    return {"appendix": _enrich_appendix(best[2], data.get("blocks", []))}


@router.post("/documents/{slug}/appendices/assign")
def assign_blocks_to_appendix(
    slug: str,
    body: AppendixAssignRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Assign one or more blocks to an appendix.

    Each assignment creates a block history entry (unlike comments —
    appendix routing is a review decision, not conversation).
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    appendix = next((a for a in data.get("appendices", []) if a["id"] == body.appendix_id), None)
    if appendix is None:
        raise HTTPException(404, f"Appendix '{body.appendix_id}' not found")

    # Resolve ALL block_ids BEFORE mutating any — otherwise a bad ID partway
    # through the list would leave earlier blocks reassigned while failing 404.
    targets: list[dict] = [_find_block(data, bid) for bid in body.block_ids]

    updated: list[str] = []
    for block in targets:
        before = _snapshot(block)
        block["appendix_id"] = appendix["id"]
        block["appendix_name"] = appendix["name"]
        after = _snapshot(block)

        history = block.setdefault("history", [])
        history.append({
            "version": len(history) + 1,
            "action": "assigned_to_appendix",
            "before": before,
            "after": after,
            "user_name": user.name,
            "user_email": user.email,
            "at": _now_iso(),
        })
        updated.append(block["id"])

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "assigned": updated, "appendix_id": appendix["id"]}


@router.delete("/documents/{slug}/appendices/{appendix_id}")
def delete_appendix(
    slug: str,
    appendix_id: str,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Delete an appendix. Any blocks assigned to it are unassigned.

    Block-level history entries record the unassignment so users can see
    that a prior appendix decision was reverted by the deletion.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    appendices = data.get("appendices", [])
    idx = next((i for i, a in enumerate(appendices) if a["id"] == appendix_id), None)
    if idx is None:
        raise HTTPException(404, f"Appendix '{appendix_id}' not found")

    appendix = appendices.pop(idx)

    # Unassign blocks that were in this appendix.
    for block in data.get("blocks", []):
        if block.get("appendix_id") != appendix_id:
            continue
        before = _snapshot(block)
        block.pop("appendix_id", None)
        block.pop("appendix_name", None)
        after = _snapshot(block)

        history = block.setdefault("history", [])
        history.append({
            "version": len(history) + 1,
            "action": "unassigned_from_appendix_deleted",
            "before": before,
            "after": after,
            "user_name": user.name,
            "user_email": user.email,
            "at": _now_iso(),
        })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "deleted": appendix_id, "name": appendix.get("name")}


# ── Block manipulation (add / move / restore) ──────────────────────────


_VALID_SECTION_FUNCTIONS = {
    "objective", "applicability", "context", "terms", "roles",
    "safeguards", "authorization", "equipment", "method", "verification",
    "competency", "criteria",
}
_VALID_NORMATIVE_MODES = {"policy", "standard", "procedure", "guideline", "informational"}
_VALID_FORMATS = {"prose", "form", "table", "image"}


class AddBlockRequest(BaseModel):
    text: str
    position: int
    section_function: str
    normative_mode: str
    format: str = "prose"
    heading_path: str | None = None


class MoveBlockRequest(BaseModel):
    direction: str  # "up" | "down"


class MoveBlockToRequest(BaseModel):
    """Arbitrary-position move — the drag-and-drop target."""

    target_position: int  # 0-based index in the document's block array


@router.post("/documents/{slug}/blocks/{block_id}/move_to")
def move_block_to(
    slug: str,
    block_id: str,
    body: MoveBlockToRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Move a block to an arbitrary target position (drag-and-drop).

    Unlike `/move` (single-step up/down), this supports multi-position moves
    in one mutation. The semantics mirror a `list.pop(src).insert(target)` —
    so `target_position` is the position AFTER the move in the block array.
    Target is clamped into [0, len(blocks)-1]."""
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    blocks = data.get("blocks", [])
    idx = next((i for i, b in enumerate(blocks) if b["id"] == block_id), None)
    if idx is None:
        raise HTTPException(404, f"Block '{block_id}' not found")

    target = max(0, min(body.target_position, len(blocks) - 1))
    if target == idx:
        response.headers["ETag"] = _compute_etag(data)
        return {"ok": True, "block_id": block_id, "from": idx, "to": idx, "no_op": True}

    # pop-and-insert preserves every block's identity, only changes array order.
    before = _snapshot(blocks[idx])
    moved = blocks.pop(idx)
    blocks.insert(target, moved)

    block = moved
    after = _snapshot(block)
    history = block.setdefault("history", [])
    history.append({
        "version": len(history) + 1,
        "action": "moved_to",
        "before": before,
        "after": after,
        "from_position": idx,
        "to_position": target,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block_id": block_id, "from": idx, "to": target}


class PolishSectionRequest(BaseModel):
    heading_path: str
    include_pending: bool = False
    user_prompt: str | None = None  # optional reviewer refinement instruction


@router.post("/documents/{slug}/sections/polish")
def polish_section(
    slug: str,
    body: PolishSectionRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Run the narrative merger on a single section using live reviewer state.

    Unlike the batch merger (which is a one-shot CLI pass over raw judge
    output), this endpoint:
      - honors `edited_text` (reviewer edits),
      - skips dismissed / removed / appendix-assigned blocks,
      - skips unreviewed pending KCAD unless `include_pending=true`,
      - stores the polished prose under `unified_overrides[heading_path]`.

    The Unified View renders the override text when present, falling back to
    the deterministic block-level render when a section hasn't been polished
    yet. Each override carries a `generated_at` timestamp so the frontend
    can flag "stale" sections (block changed since last polish).
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    # The narrative_merger module makes LLM calls — ensure the .env keys
    # are loaded before invocation.
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    if env_path.exists():
        try:
            from dotenv import load_dotenv
            load_dotenv(env_path)
        except ImportError:
            pass

    # Import is deliberately deferred so that the consolidation package is
    # only imported when this endpoint fires — keeps cold-start light.
    from consolidation.narrative_merger import polish_section_async
    import asyncio

    try:
        result = asyncio.run(polish_section_async(
            blocks=data.get("blocks", []),
            heading_path=body.heading_path,
            include_pending=body.include_pending,
            user_prompt=body.user_prompt,
        ))
    except ValueError as e:
        raise HTTPException(400, f"Polish rejected: {e}")
    except Exception as e:
        logger.exception("Polish failed for %s in %s", body.heading_path, slug)
        raise HTTPException(500, f"Polish failed: {e}")

    # Store the polished text under unified_overrides. Keyed by heading_path
    # so the Unified View can look it up in O(1) when rendering sections.
    overrides = data.setdefault("unified_overrides", {})
    block_ids_in_section = [
        b["id"]
        for b in data.get("blocks", [])
        if b.get("heading_path") == body.heading_path
        and b.get("status") not in {"dismissed", "removed"}
        and not b.get("appendix_id")
    ]
    # Capture the existing override BEFORE we overwrite it, so the undo stack
    # can restore it. If no override existed, previous is None (undo = clear).
    previous_override = overrides.get(body.heading_path)

    overrides[body.heading_path] = {
        "text": result.get("merged_text", ""),
        "preserved_facts": result.get("preserved_kcad_facts", []),
        "conflicts_flagged": result.get("conflicts_flagged", []),
        "merge_confidence": result.get("merge_confidence"),
        "merge_notes": result.get("merge_notes", ""),
        "omitted_kcad_content": result.get("omitted_kcad_content", []),
        "generated_at": _now_iso(),
        "generated_by": user.email or user.name or "anonymous",
        "validation_ok": bool(result.get("_validation_ok", True)),
        "fallback_to_block_level": bool(result.get("_fallback_to_block_level", False)),
        # Block-id snapshot so the frontend can detect "some block changed
        # since this polish" (block appeared/disappeared/was edited).
        "block_ids": block_ids_in_section,
        # Reviewer's refinement instruction (if any) — persisted so the UI
        # can show what prompt produced this polish.
        "user_prompt": body.user_prompt,
    }

    # Append to polish_history so document-level undo can reverse this.
    polish_history = data.setdefault("polish_history", [])
    polish_history.append({
        "action": "polish",
        "heading_path": body.heading_path,
        "at": _now_iso(),
        "user_name": user.name,
        "user_email": user.email,
        "user_prompt": body.user_prompt,
        "previous_override": previous_override,
        "new_override": overrides[body.heading_path],
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {
        "ok": True,
        "heading_path": body.heading_path,
        "override": overrides[body.heading_path],
    }


@router.delete("/documents/{slug}/sections/polish")
def clear_section_override(
    slug: str,
    heading_path: str,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Clear a section's LLM polish — revert to deterministic render.

    Useful after a bad polish or when the reviewer wants to re-do from
    scratch. Writes a polish_history entry so the document-level undo can
    restore the cleared override."""
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    overrides = data.get("unified_overrides", {})
    existed = heading_path in overrides
    if existed:
        previous_override = overrides[heading_path]
        del overrides[heading_path]
        polish_history = data.setdefault("polish_history", [])
        polish_history.append({
            "action": "clear",
            "heading_path": heading_path,
            "at": _now_iso(),
            "user_name": user.name,
            "user_email": user.email,
            "previous_override": previous_override,
            "new_override": None,
        })
        _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "cleared": existed, "heading_path": heading_path}


# ── Unified document-level undo ─────────────────────────────────────────


@router.post("/documents/{slug}/undo/last")
def undo_last(
    slug: str,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Undo the single most recent mutation across block history + polish history.

    Scans both sources, picks the entry with the latest `at` timestamp, and
    reverses it:
      - Block history entry → revert block to the snapshot before the entry.
      - Polish entry (action=polish) → restore previous_override (or delete
        if there was none before).
      - Polish entry (action=clear) → restore previous_override under the
        same heading_path.

    Idempotent within a single stack-pop sense — calling again undoes the
    next-most-recent action. Returns 204 when there's nothing to undo."""
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    # Find most recent block-history entry across all blocks.
    best_block: tuple[str, int, str] | None = None  # (block_id, version, at)
    for b in data.get("blocks", []):
        hist = b.get("history") or []
        if not hist:
            continue
        top = hist[-1]
        at = top.get("at", "")
        if best_block is None or at > best_block[2]:
            best_block = (b["id"], int(top.get("version", len(hist))), at)

    # Find most recent polish-history entry.
    polish_history = data.get("polish_history") or []
    best_polish_idx: int | None = None
    best_polish_at: str = ""
    for i in range(len(polish_history) - 1, -1, -1):
        at = polish_history[i].get("at", "")
        if at >= best_polish_at:
            best_polish_at = at
            best_polish_idx = i
            # Keep scanning — list may have duplicate timestamps; the
            # latest-inserted wins. Since we iterate reverse, first hit is
            # fine but we continue until tied to get the latest by index.

    if best_block is None and best_polish_idx is None:
        response.headers["ETag"] = _compute_etag(data)
        return {"ok": True, "undone": None, "reason": "no history"}

    # Pick the more recent of the two.
    use_polish = False
    if best_block is None:
        use_polish = True
    elif best_polish_idx is not None and best_polish_at > best_block[2]:
        use_polish = True

    if use_polish and best_polish_idx is not None:
        entry = polish_history.pop(best_polish_idx)
        overrides = data.setdefault("unified_overrides", {})
        heading_path = entry["heading_path"]
        prev = entry.get("previous_override")
        if prev is None:
            overrides.pop(heading_path, None)
        else:
            overrides[heading_path] = prev
        _save_view(slug, data)
        response.headers["ETag"] = _compute_etag(data)
        return {
            "ok": True,
            "undone": {
                "kind": "polish",
                "action": entry.get("action"),
                "heading_path": heading_path,
                "at": entry.get("at"),
            },
        }

    # Undo a block-level action using the existing revert pathway.
    assert best_block is not None
    block_id, version, _at = best_block
    block = _find_block(data, block_id)
    history = block.get("history") or []
    # Find the target entry (the one we're undoing).
    target = next((h for h in history if h.get("version") == version), None)
    if target is None:
        raise HTTPException(404, f"History version {version} not found on block {block_id}")
    # Restore `before` snapshot from the target entry.
    before_snapshot = target.get("before") or {}
    for k in _snapshot(block).keys():
        # Remove existing mutable fields so restored state is clean.
        block.pop(k, None)
    for k, v in before_snapshot.items():
        block[k] = v
    # Pop the reverted history entry so subsequent undos climb the stack.
    history.pop(-1)

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {
        "ok": True,
        "undone": {
            "kind": "block",
            "block_id": block_id,
            "version": version,
            "action": target.get("action"),
            "at": target.get("at"),
        },
    }


@router.post("/documents/{slug}/blocks/add")
def add_block(
    slug: str,
    body: AddBlockRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Insert a user-authored block at the given position (0-indexed).

    Requires explicit section_function and normative_mode — no hardcoded
    defaults, so user-added content doesn't pollute downstream consumers
    that depend on these fields being meaningful.

    If heading_path is omitted, the new block inherits the heading_path of
    the block immediately before the insertion point (or the block at the
    insertion point if position is 0 or greater than the last index).
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    # Validate classification against the HSE-051 vocabulary
    if body.section_function not in _VALID_SECTION_FUNCTIONS:
        raise HTTPException(
            422,
            f"Invalid section_function '{body.section_function}'. Must be one of: {sorted(_VALID_SECTION_FUNCTIONS)}",
        )
    if body.normative_mode not in _VALID_NORMATIVE_MODES:
        raise HTTPException(
            422,
            f"Invalid normative_mode '{body.normative_mode}'. Must be one of: {sorted(_VALID_NORMATIVE_MODES)}",
        )
    if body.format not in _VALID_FORMATS:
        raise HTTPException(
            422,
            f"Invalid format '{body.format}'. Must be one of: {sorted(_VALID_FORMATS)}",
        )

    blocks = data.setdefault("blocks", [])
    position = max(0, min(body.position, len(blocks)))

    # Inherit heading_path from a neighbor if not supplied.
    heading_path = body.heading_path
    if heading_path is None:
        neighbor_idx = position - 1 if position > 0 else position
        if 0 <= neighbor_idx < len(blocks):
            heading_path = blocks[neighbor_idx].get("heading_path", "")
        else:
            heading_path = ""

    new_block: dict = {
        "id": uuid.uuid4().hex[:12],
        "type": "user_added",
        "text": body.text,
        "format": body.format,
        "section_function": body.section_function,
        "normative_mode": body.normative_mode,
        "heading_path": heading_path,
        "source": {
            "document": "USER",
            "origin": "user",
            "region": None,
            "rig": None,
            "chunk_id": None,
        },
        "relationship": None,
        "tier": None,
        "additive_detail": None,
        "conflict": None,
        "ai_confidence": None,
        "ai_reasoning": None,
        "dimension_matches": None,
        "hp_original_text": None,
        "hp_chunk": None,
        "kcad_chunk": None,
        "status": "pending",
    }
    # Snapshot AFTER the block is fully built, so a revert to v1 restores the
    # full initial state (text, classification, source, etc.), not just status.
    new_block["history"] = [{
        "version": 1,
        "action": "user_added",
        "before": {},
        "after": _snapshot(new_block),
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    }]
    blocks.insert(position, new_block)

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block": new_block, "position": position}


@router.post("/documents/{slug}/blocks/{block_id}/move")
def move_block(
    slug: str,
    block_id: str,
    body: MoveBlockRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Move a block one position up or down. Rejects moves past document boundaries."""
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)

    blocks = data.get("blocks", [])
    idx = next((i for i, b in enumerate(blocks) if b["id"] == block_id), None)
    if idx is None:
        raise HTTPException(404, f"Block '{block_id}' not found")

    if body.direction not in {"up", "down"}:
        raise HTTPException(400, f"Invalid direction '{body.direction}'. Must be 'up' or 'down'.")

    if body.direction == "up":
        if idx == 0:
            raise HTTPException(400, "Cannot move block past document boundary (already first)")
        new_idx = idx - 1
    else:
        if idx == len(blocks) - 1:
            raise HTTPException(400, "Cannot move block past document boundary (already last)")
        new_idx = idx + 1

    # Capture the full block state BEFORE swap. Position isn't a block field,
    # so before/after must be full snapshots — otherwise revert-to-this-version
    # would wipe unrelated fields (status, edited_text, appendix_id, etc.).
    before = _snapshot(blocks[idx])

    # Swap
    blocks[idx], blocks[new_idx] = blocks[new_idx], blocks[idx]

    # Record the move on the moved block's history
    block = blocks[new_idx]
    after = _snapshot(block)
    history = block.setdefault("history", [])
    history.append({
        "version": len(history) + 1,
        "action": f"moved_{body.direction}",
        "before": before,
        "after": after,
        "from_position": idx,
        "to_position": new_idx,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block_id": block_id, "from": idx, "to": new_idx}


@router.post("/documents/{slug}/blocks/{block_id}/restore")
def restore_block(
    slug: str,
    block_id: str,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Restore a removed block back to pending.

    Only applies to blocks with status='removed'. Other statuses should use
    the regular action endpoint for transitions.
    """
    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)
    block = _find_block(data, block_id)

    if block.get("status") != "removed":
        raise HTTPException(
            400,
            f"Block is not removed (current status: '{block.get('status')}'). "
            "Use the /action endpoint to change status from other states.",
        )

    before = _snapshot(block)
    block["status"] = "pending"
    after = _snapshot(block)

    history = block.setdefault("history", [])
    history.append({
        "version": len(history) + 1,
        "action": "restored",
        "before": before,
        "after": after,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block_id": block_id, "status": "pending"}


# ── Manual reclassification ──────────────────────────────────────────────

_VALID_RELATIONSHIPS = frozenset(
    {"Equivalent", "Variant", "Complementary", "Related"}
)


class ReclassifyRequest(BaseModel):
    relationship: str


@router.post("/documents/{slug}/blocks/{block_id}/reclassify")
def reclassify_block(
    slug: str,
    block_id: str,
    body: ReclassifyRequest,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match"),
    user: User = Depends(get_user),
):
    """Change a block's AI-assigned relationship label.

    Intended for cases where a reviewer disagrees with the pipeline's
    classification (e.g. "this isn't Complementary, it's a Variant").
    The change participates in version history just like any other action.

    We restrict the valid values to the four user-facing review categories.
    Gap and Conflict are block *types*, not relationships — flipping those
    would change block semantics in ways this endpoint isn't designed for;
    use the /action endpoint plus delete/recreate for that.
    """
    if body.relationship not in _VALID_RELATIONSHIPS:
        raise HTTPException(
            422,
            f"Invalid relationship '{body.relationship}'. "
            f"Must be one of: {sorted(_VALID_RELATIONSHIPS)}",
        )

    data = _require_view(slug)
    data.setdefault("review_status", "ai_consolidated")
    _check_if_match(if_match, _compute_etag(data), data)
    _check_not_published(data)
    block = _find_block(data, block_id)

    before = _snapshot(block)
    block["relationship"] = body.relationship
    after = _snapshot(block)

    history = block.setdefault("history", [])
    history.append({
        "version": len(history) + 1,
        "action": "reclassified",
        "before": before,
        "after": after,
        "user_name": user.name,
        "user_email": user.email,
        "at": _now_iso(),
    })

    _save_view(slug, data)
    response.headers["ETag"] = _compute_etag(data)
    return {"ok": True, "block_id": block_id, "relationship": body.relationship}


# ── Batch language detection for existing views ─────────────────────────
# The single-text /translate + /detect-language handlers live in the shared
# translation router (api/routers/translation.py). Only view-level batch
# detection stays here since it operates on a consolidation view slug.


_KCAD_BLOCK_TYPES = {"kcad_addition", "conflict", "gap"}


@router.post("/documents/{slug}/detect-languages")
async def detect_languages_for_view(slug: str):
    """Detect language for every KCAD-sourced block that doesn't have one.

    One-shot migration for views built before language detection was added to
    the reconstruction pipeline. Idempotent — blocks that already have a
    `language` field are skipped. Results persisted into the view JSON.
    """
    data = _require_view(slug)
    blocks = data.get("blocks", [])

    # Identify blocks needing detection and deduplicate by text.
    texts_to_detect: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        if block.get("type") not in _KCAD_BLOCK_TYPES:
            continue
        if block.get("language"):
            continue
        text = block.get("text") or ""
        if not text.strip() or text in seen:
            continue
        seen.add(text)
        texts_to_detect.append(text)

    if not texts_to_detect:
        return {"ok": True, "updated": 0, "already_tagged": True}

    # Concurrent detection with a cap; each call is cached so repeat runs cost nothing.
    semaphore = asyncio.Semaphore(8)

    async def _one(t: str) -> tuple[str, str]:
        async with semaphore:
            try:
                result = await detect_language(t)
                return t, str(result.get("language") or "en").lower()
            except Exception:
                return t, "en"

    pairs = await asyncio.gather(*[_one(t) for t in texts_to_detect])
    language_by_text = {t: lang for t, lang in pairs}

    updated = 0
    for block in blocks:
        if block.get("type") not in _KCAD_BLOCK_TYPES:
            continue
        if block.get("language"):
            continue
        text = block.get("text") or ""
        lang = language_by_text.get(text, "en")
        block["language"] = lang
        updated += 1

    _save_view(slug, data)
    return {"ok": True, "updated": updated, "unique_detected": len(texts_to_detect)}
