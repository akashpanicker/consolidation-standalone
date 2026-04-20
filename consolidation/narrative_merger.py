"""Narrative merger — unified-prose integration of HP + KCAD content.

Reads a consolidated view JSON (Stage 6 output) and produces a merged
document where HP sections are rewritten to integrate KCAD additions
seamlessly, translating foreign-language content in-place and flagging
conflicts. One LLM call per HP section with KCAD additions.

Output: cache/consolidation/merged/{slug}.json

Entry points:
  - `run_merge(hp_docs, model)` — CLI runner (sync wrapper)
  - `merge_document_async(view, ...)` — programmatic use
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .config import CONSOLIDATION_VIEWS_DIR, sanitize_filename

logger = logging.getLogger(__name__)


# ── Paths ──────────────────────────────────────────────────────────────────

_CONSOLIDATION_DIR = Path(__file__).resolve().parent.parent / "cache" / "consolidation"
MERGED_DIR = _CONSOLIDATION_DIR / "merged"
_PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "narrative_merge.txt"


# ── Strict JSON schema for structured output ──────────────────────────────

_MERGE_OUTPUT_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "merged_text": {"type": "string"},
        "preserved_kcad_facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "fact": {"type": "string"},
                    "source": {"type": "string"},
                    "evidence_in_merged": {"type": "string"},
                    # Verbatim source-language quote from the KCAD input
                    # that grounds this fact. Empty string when the source
                    # was already English (kcad_source_text_for_citation
                    # was not provided). Populated for non-English KCAD so
                    # reviewer sign-off can see the original wording
                    # alongside the English paraphrase in merged_text.
                    "kcad_source_quote": {"type": "string"},
                    "kcad_source_language": {"type": "string"},
                },
                "required": [
                    "fact",
                    "source",
                    "evidence_in_merged",
                    "kcad_source_quote",
                    "kcad_source_language",
                ],
                "additionalProperties": False,
            },
        },
        "omitted_kcad_content": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"},
                    "summary": {"type": "string"},
                    "reason": {
                        "enum": [
                            "duplicate_of_hp",
                            "governance_boilerplate",
                            "out_of_scope",
                            "t2_redundant",
                            "other",
                        ]
                    },
                },
                "required": ["source", "summary", "reason"],
                "additionalProperties": False,
            },
        },
        "conflicts_flagged": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "description": {"type": "string"},
                    "severity": {"enum": ["critical", "material", "minor"]},
                    "sources": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["description", "severity", "sources"],
                "additionalProperties": False,
            },
        },
        "merge_confidence": {"enum": ["high", "medium", "low"]},
        "merge_notes": {"type": "string"},
    },
    "required": [
        "merged_text",
        "preserved_kcad_facts",
        "omitted_kcad_content",
        "conflicts_flagged",
        "merge_confidence",
        "merge_notes",
    ],
    "additionalProperties": False,
}


# ── Region label mapping — raw KCAD filenames to demo-friendly phrases ────

_REGION_LABELS = {
    "KS": "Saudi Arabia operations",
    "OM": "Oman operations",
    "EU": "European land drilling operations",
    "AZ": "Azerbaijan operations",
    "DZ": "Algerian operations",
    "PK": "Pakistan operations",
    "LD": "Land drilling operations",
}


def _friendly_kcad_label(source_document: str, fallback_region: str = "") -> str:
    """Convert raw KCAD filename to a demo-friendly region label.

    Example: ``K-KS-HS-PR-005.pdf`` -> ``"Saudi Arabia operations"``.
    Falls back to the pipeline-detected ``fallback_region`` when the prefix
    is unrecognized, and to the stem as a last resort.
    """
    stem = Path(source_document).stem
    parts = stem.split("-")
    if len(parts) >= 2 and parts[0].upper() == "K":
        code = parts[1].upper()
        label = _REGION_LABELS.get(code)
        if label:
            return label
    if fallback_region:
        return f"{fallback_region} operations"
    return stem


# ── Data models ────────────────────────────────────────────────────────────


@dataclass
class KcadAddition:
    """One KCAD addition to merge into an HP section.

    Translation contract: ``text`` is the source-language original
    (exactly as extracted — preserved through chunking and reconstruction).
    ``text_en`` is the canonical English translation produced at chunking
    time by :func:`api.translation.translate_chunks_inplace`; it is
    ``None`` for docs that were already English. The merger prompt uses
    ``text_en`` as the English surface (falling back to ``text`` when the
    source is already English) and keeps ``text`` available as the
    source-language-for-citation field — so the merger never re-translates
    and reviewer sign-off can cite verbatim source wording.
    """

    block_id: str
    kcad_source: str  # friendly label (e.g., "Saudi Arabia operations")
    source_document: str  # raw filename (e.g., "K-KS-HS-PR-005.pdf")
    source_language: str  # ISO 639-1
    heading_path: str  # KCAD chunk's heading_path (for UI provenance display)
    region_raw: str  # raw region string from source metadata
    relationship: str
    tier: int | None
    additive_detail: str | None
    conflict: dict | None
    text: str  # source-language original (verbatim from extraction)
    block_type: str
    text_en: str | None = None  # canonical English translation (None if already English)


@dataclass
class SectionInput:
    """A single HP section plus its KCAD additions."""

    heading_path: str
    hp_text: str
    hp_block_ids: list[str]
    kcad_additions: list[KcadAddition] = field(default_factory=list)
    kcad_block_ids: list[str] = field(default_factory=list)


# ── Section grouping ──────────────────────────────────────────────────────


def _group_blocks_into_sections(blocks: list[dict]) -> list[SectionInput]:
    """Group view blocks into sections by heading_path continuity.

    An HP block starts or continues a section (blocks with the same
    heading_path merge into one section). KCAD additions / conflicts that
    follow an HP block are attached to that HP section. Dismissed and
    removed blocks are excluded.

    Gap and gap_header blocks do not join any HP section — they represent
    content with no HP anchor and are handled separately by callers.
    """
    sections: list[SectionInput] = []
    current: SectionInput | None = None

    def _flush() -> None:
        nonlocal current
        if current is not None and current.hp_text.strip():
            sections.append(current)
        current = None

    for block in blocks:
        if block.get("status") in {"dismissed", "removed"}:
            continue

        btype = block.get("type", "")
        heading = block.get("heading_path", "") or ""
        source = block.get("source") or {}
        region = source.get("region") or ""

        if btype == "hp_original":
            if current is None or heading != current.heading_path:
                _flush()
                current = SectionInput(
                    heading_path=heading,
                    hp_text=block.get("text", ""),
                    hp_block_ids=[block.get("id", "")],
                )
            else:
                current.hp_text = current.hp_text.rstrip() + "\n\n" + block.get("text", "")
                current.hp_block_ids.append(block.get("id", ""))
        elif btype in {"kcad_addition", "conflict"}:
            if current is None:
                # Orphan KCAD before any HP block — skip (should not happen).
                continue
            ka = KcadAddition(
                block_id=block.get("id", ""),
                kcad_source=_friendly_kcad_label(source.get("document", ""), region),
                source_document=source.get("document", ""),
                source_language=block.get("language") or "en",
                heading_path=block.get("heading_path", "") or "",
                region_raw=region,
                relationship=block.get("relationship") or ("Conflict" if btype == "conflict" else "Variant"),
                tier=block.get("tier"),
                additive_detail=block.get("additive_detail"),
                conflict=block.get("conflict"),
                text=block.get("text", ""),
                text_en=block.get("text_en"),
                block_type=btype,
            )
            current.kcad_additions.append(ka)
            current.kcad_block_ids.append(block.get("id", ""))
        elif btype in {"gap_header", "gap"}:
            # Gaps end the current section — do not absorb them into any HP section.
            _flush()
        # user_added: leave in current section as HP-style content
        elif btype == "user_added":
            if current is not None:
                current.hp_text = current.hp_text.rstrip() + "\n\n" + block.get("text", "")
                current.hp_block_ids.append(block.get("id", ""))

    _flush()
    return sections


# ── Prompt construction ────────────────────────────────────────────────────


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _compute_prompt_hash() -> str:
    return hashlib.sha256(_PROMPT_PATH.read_bytes()).hexdigest()[:12]


def _build_user_prompt(
    section: SectionInput, *, strict_retry: bool = False, user_prompt: str | None = None,
) -> str:
    parts: list[str] = []
    parts.append("## HP Section")
    parts.append(f"heading_path: {section.heading_path}")
    parts.append("\n### HP Canonical Text\n")
    parts.append(section.hp_text.strip())
    parts.append(f"\n## KCAD Additions ({len(section.kcad_additions)})\n")

    for i, ka in enumerate(section.kcad_additions, 1):
        parts.append(f"\n### Addition {i}")
        parts.append(f"kcad_source: {ka.kcad_source}")
        parts.append(f"source_document: {ka.source_document}")
        parts.append(f"source_language: {ka.source_language}")
        parts.append(f"relationship: {ka.relationship}")
        if ka.tier is not None:
            parts.append(f"tier: {ka.tier}")
        if ka.additive_detail:
            parts.append(f"additive_detail: {ka.additive_detail}")
        if ka.conflict and isinstance(ka.conflict, dict) and ka.conflict.get("detected"):
            parts.append(f"conflict: {json.dumps(ka.conflict)}")
        # Translation contract (see prompt rule 3): kcad_text is the
        # English surface the merger should integrate. For already-English
        # KCAD docs, text_en is None and we feed ka.text directly — the
        # merger cannot tell the difference. For non-English KCAD, text_en
        # is the chunk-layer canonical translation produced at chunking
        # time; the merger uses it as-is (no in-prompt re-translation).
        # The source-language original is provided as
        # kcad_source_text_for_citation so the merger can cite verbatim
        # wording in the source language when a fact or conflict depends
        # on the literal phrasing.
        english_text = (ka.text_en or "").strip() or ka.text.strip()
        parts.append(f"\nkcad_text:\n{english_text}")
        if ka.text_en and ka.source_language and ka.source_language != "en":
            parts.append(
                f"\nkcad_source_text_for_citation ({ka.source_language}, "
                f"quote verbatim only if referenced in merged_text):\n"
                f"{ka.text.strip()}"
            )

    parts.append("\n\n---\n")
    if strict_retry:
        parts.append(
            "IMPORTANT (retry): your previous attempt lost specific KCAD values "
            "not present in HP. This time, LIST every numeric specific (ppm, "
            "minutes, percentages, thresholds, exposure limits) from each KCAD "
            "addition in preserved_kcad_facts AND ensure each such value appears "
            "verbatim somewhere in merged_text. Do not summarize numbers into "
            "ranges unless the input itself uses a range.\n"
        )
    if user_prompt and user_prompt.strip():
        parts.append(
            "\n## Reviewer refinement request\n"
            "The reviewer has provided an additional instruction for this merge. "
            "Honor it alongside the standard rules — but the hard rules (preserve "
            "specifics, no invention, no HP weakening, surface conflicts) still "
            "take precedence over any reviewer wording preference.\n\n"
            f"Reviewer instruction:\n{user_prompt.strip()}\n"
        )
    parts.append("Produce the merged JSON per the schema.")
    return "\n".join(parts)


# ── LLM call ───────────────────────────────────────────────────────────────


def _estimate_output_budget(hp_text: str, kcad_additions: list[KcadAddition]) -> int:
    """Estimate tokens needed for merged output.

    The output must hold:
      - merged_text (potentially 1.5x HP length when KCAD is heavily integrated)
      - preserved_kcad_facts list (several short strings per addition)
      - conflicts/omissions (small)
      - reasoning overhead (medium reasoning_effort reserves ~4-8K internal)
    """
    hp_tokens = max(1, len(hp_text) // 4)
    kcad_tokens = sum(len(ka.text) for ka in kcad_additions) // 4
    merged_est = int(hp_tokens * 1.7 + kcad_tokens * 0.5)
    structured_overhead = 1500 + 200 * max(1, len(kcad_additions))
    reasoning_reserve = 8000  # medium reasoning floor
    total = merged_est + structured_overhead + reasoning_reserve
    return max(8000, min(48000, total))


async def _call_merger_api(
    section: SectionInput,
    *,
    model: str,
    strict_retry: bool,
    user_prompt: str | None = None,
) -> dict:
    """Single LLM call. Raises on HTTP / schema / parse failures."""
    base_url = os.getenv("GPT54_BASE_URL")
    api_key = os.getenv("GPT54_API_KEY")
    if not base_url or not api_key:
        raise ValueError("GPT54_BASE_URL / GPT54_API_KEY not set in environment")

    system_prompt = _load_prompt()
    user_text = _build_user_prompt(section, strict_retry=strict_retry, user_prompt=user_prompt)
    max_output = _estimate_output_budget(section.hp_text, section.kcad_additions)

    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "max_output_tokens": max_output,
        "reasoning": {"effort": "medium"},
        "text": {
            "format": {
                "type": "json_schema",
                "name": "narrative_merge_output",
                "strict": True,
                "schema": _MERGE_OUTPUT_SCHEMA,
            }
        },
    }

    http_errors = 0
    while True:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.post(
                base_url,
                headers={"Content-Type": "application/json", "api-key": api_key},
                json=payload,
            )

        if resp.status_code in {429, 500, 502, 503, 504}:
            http_errors += 1
            if http_errors >= 3:
                raise ValueError(f"Merger API {resp.status_code} after 3 tries: {resp.text[:200]}")
            wait = 5 * http_errors
            logger.warning("Merger HTTP %d, retrying in %ds", resp.status_code, wait)
            await asyncio.sleep(wait)
            continue

        if resp.status_code >= 400:
            raise ValueError(f"Merger API {resp.status_code}: {resp.text[:500]}")

        body = resp.json()

        if body.get("status") == "incomplete":
            reason = body.get("incomplete_details", {}).get("reason", "unknown")
            if reason == "max_output_tokens" and payload["max_output_tokens"] < 65000:
                payload["max_output_tokens"] = min(65000, int(payload["max_output_tokens"] * 1.5))
                logger.warning(
                    "Merger truncated, retrying with max_output=%d", payload["max_output_tokens"]
                )
                continue
            raise ValueError(f"Merger incomplete: {reason}")

        # Extract output text
        output_text = ""
        for item in body.get("output", []):
            if item.get("type") != "message":
                continue
            for ci in item.get("content", []):
                if isinstance(ci, dict) and ci.get("text"):
                    output_text = str(ci["text"])
                    break
            if output_text:
                break

        if not output_text:
            raise ValueError("Merger returned no output text")

        try:
            parsed = json.loads(output_text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Merger returned invalid JSON: {exc}") from exc

        # Usage metadata for logging
        usage = body.get("usage", {}) or {}
        parsed["_usage"] = {
            "input_tokens": int(usage.get("input_tokens", 0) or 0),
            "output_tokens": int(usage.get("output_tokens", 0) or 0),
        }
        return parsed


# ── Numeric preservation validation ────────────────────────────────────────

_NUMERIC_PATTERN = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*"
    r"(ppm|psi|mg/m3|mg/m³|bar|kpa|mpa|°c|°f|°|%|minutes?|mins?|seconds?|secs?|"
    r"hours?|hrs?|knots?|mph|m/s|kg|lbs?|ft|meters?|metres?|m\b|feet|inches?|"
    r"in\b|decibels?|db|ampoules?)\b",
    re.IGNORECASE,
)


def _extract_numerics(text: str) -> set[str]:
    """Extract `value + unit` specifics. Returns lowercased, deduped strings."""
    hits: set[str] = set()
    for m in _NUMERIC_PATTERN.finditer(text or ""):
        value = m.group(1).replace(",", "").strip()
        unit = m.group(2).lower().strip()
        hits.add(f"{value} {unit}")
    return hits


def _validate_preservation(section: SectionInput, result: dict) -> tuple[bool, str]:
    """Check that KCAD-new numeric specifics were preserved in merged_text
    (or explicitly omitted in omitted_kcad_content).

    Returns (ok, reason). A missed numeric is a critical merge failure.
    """
    merged_text = result.get("merged_text", "") or ""
    omitted = result.get("omitted_kcad_content", []) or []

    hp_nums = _extract_numerics(section.hp_text)
    kcad_text_all = "\n".join(ka.text for ka in section.kcad_additions)
    kcad_nums = _extract_numerics(kcad_text_all)
    merged_nums = _extract_numerics(merged_text)

    # Only check values KCAD introduced that aren't already in HP.
    kcad_new = kcad_nums - hp_nums
    if not kcad_new:
        return True, ""

    omitted_blob = " ".join(
        (o.get("summary", "") + " " + o.get("reason", "")).lower() for o in omitted
    )

    missing: list[str] = []
    for spec in kcad_new:
        if spec in merged_nums:
            continue
        # Loose match: check if the numeric value alone appears verbatim in merged text.
        num_only = spec.split(" ", 1)[0]
        if num_only and num_only in merged_text:
            continue
        if spec in omitted_blob:
            continue
        missing.append(spec)

    if missing:
        return False, f"Lost KCAD-new specifics: {sorted(missing)[:6]}"
    return True, ""


# ── Per-section merge with retry + fallback ───────────────────────────────


async def _merge_one_section(
    section: SectionInput,
    *,
    model: str,
    semaphore: asyncio.Semaphore,
    user_prompt: str | None = None,
) -> dict:
    """Merge one section. One validation retry, then fallback.

    `user_prompt` — optional free-text refinement instruction from the reviewer
    (e.g. "make this more concise", "emphasize the H2S respirator requirements
    for offshore rigs"). Appended to the user message so the LLM honors it
    alongside the standard merge rules.
    """
    async with semaphore:
        last_error: str | None = None
        attempts = 0

        for strict_retry in (False, True):
            attempts += 1
            try:
                result = await _call_merger_api(section, model=model, strict_retry=strict_retry, user_prompt=user_prompt)
                ok, reason = _validate_preservation(section, result)
                if ok:
                    result["_fallback_to_block_level"] = False
                    result["_attempts"] = attempts
                    result["_validation_ok"] = True
                    return result
                last_error = reason
                logger.warning(
                    "Merge validation failed (attempt %d) for '%s': %s",
                    attempts,
                    section.heading_path,
                    reason,
                )
            except Exception as exc:
                last_error = str(exc)
                logger.warning(
                    "Merge attempt %d raised for '%s': %s",
                    attempts,
                    section.heading_path,
                    exc,
                )

        # Both attempts failed: fall back to block-level rendering.
        # Append raw KCAD prose below HP so the content is still visible (no
        # silent loss). The frontend styles fallback sections with a muted
        # note so viewers know this isn't the fully integrated rewrite.
        fallback_text_parts = [section.hp_text.strip()]
        for ka in section.kcad_additions:
            fallback_text_parts.append("")
            fallback_text_parts.append(f"> **Additional content from {ka.kcad_source}:**")
            fallback_text_parts.append("")
            fallback_text_parts.append(ka.text.strip())
        fallback_text = "\n\n".join(fallback_text_parts)

        return {
            "merged_text": fallback_text,
            "preserved_kcad_facts": [],
            "omitted_kcad_content": [
                {
                    "source": ka.kcad_source,
                    "summary": "rendered un-merged below HP (fallback)",
                    "reason": "other",
                }
                for ka in section.kcad_additions
            ],
            "conflicts_flagged": [],
            "merge_confidence": "low",
            "merge_notes": f"Automated narrative integration failed after {attempts} attempts (likely content-filter on graphic safety content). Raw KCAD content appended below HP so no detail is lost.",
            "_fallback_to_block_level": True,
            "_attempts": attempts,
            "_validation_ok": False,
            "_error": last_error,
        }


# ── Document-level orchestration ──────────────────────────────────────────


async def polish_section_async(
    blocks: list[dict],
    heading_path: str,
    *,
    model: str = "gpt-5.4",
    include_pending: bool = True,
    user_prompt: str | None = None,
) -> dict:
    """Run the narrative merger on a SINGLE section, honoring live reviewer state.

    Differs from the batch `merge_document_async` in three material ways:

    1. Reads `edited_text` with precedence over `text` — so reviewer edits
       drive the polish. The batch merger was designed to work on raw
       judge output; this one reflects the current reviewer intent.
    2. Includes pending/unreviewed KCAD blocks by default. Explicit
       `dismissed`/`removed` blocks are excluded; everything else is fair
       game for merging. A reviewer who has not yet decided about a block
       still wants it represented in the merged prose — they can dismiss
       it afterward and re-polish if needed.
    3. Skips appendix-assigned blocks — those live in the appendix, not in
       the section's canonical prose.

    Conflict handling honors `status` + `resolution`:
      - resolved/keep_hp:  drop the KCAD conflict block (HP wins)
      - resolved/keep_kcad: drop HP's version in favor of KCAD content
      - resolved/combined: feed the combined edited_text as the authoritative text
      - escalated or pending: include the conflict flag for the prompt to surface
    """
    target_blocks: list[dict] = []
    for b in blocks:
        if b.get("heading_path") != heading_path:
            continue
        if b.get("status") in {"dismissed", "removed"}:
            continue
        if b.get("appendix_id"):
            continue
        if (
            b.get("type") in {"kcad_addition", "conflict"}
            and b.get("status") == "pending"
            and not include_pending
        ):
            continue
        target_blocks.append(b)

    if not target_blocks:
        raise ValueError(
            f"No active blocks in section '{heading_path}' — nothing to polish"
        )

    hp_parts: list[str] = []
    hp_ids: list[str] = []
    kcad_additions: list[KcadAddition] = []

    for b in target_blocks:
        btype = b.get("type", "")
        text = (b.get("edited_text") or b.get("text") or "").strip()
        if not text:
            continue

        if btype in {"hp_original", "user_added"}:
            hp_parts.append(text)
            hp_ids.append(b.get("id", ""))
        elif btype in {"kcad_addition", "conflict"}:
            # Resolution-aware routing for conflict blocks.
            resolution = b.get("resolution")
            if btype == "conflict" and b.get("status") == "resolved":
                if resolution == "keep_hp":
                    continue  # HP side already included; drop the KCAD conflict block
                # keep_kcad / combined: include the KCAD text (with edited_text overriding)
            source = b.get("source") or {}
            kcad_additions.append(KcadAddition(
                block_id=b.get("id", ""),
                kcad_source=_friendly_kcad_label(
                    source.get("document", ""), source.get("region", "") or ""
                ),
                source_document=source.get("document", ""),
                source_language=b.get("language") or "en",
                heading_path=b.get("source_heading_path") or b.get("heading_path", "") or "",
                region_raw=source.get("region", "") or "",
                relationship=b.get("relationship") or ("Conflict" if btype == "conflict" else "Variant"),
                tier=b.get("tier"),
                additive_detail=b.get("additive_detail"),
                conflict=b.get("conflict"),
                text=text,
                text_en=b.get("text_en"),
                block_type=btype,
            ))

    if not hp_parts:
        raise ValueError(
            f"Section '{heading_path}' has no HP anchor text after filtering"
        )

    section = SectionInput(
        heading_path=heading_path,
        hp_text="\n\n".join(hp_parts),
        hp_block_ids=hp_ids,
        kcad_additions=kcad_additions,
        kcad_block_ids=[ka.block_id for ka in kcad_additions],
    )

    semaphore = asyncio.Semaphore(1)
    result = await _merge_one_section(
        section, model=model, semaphore=semaphore, user_prompt=user_prompt,
    )
    return result


async def merge_document_async(
    view: dict,
    *,
    model: str = "gpt-5.4",
    max_concurrency: int = 5,
    progress: bool = True,
) -> dict:
    """Merge all sections of a consolidated view concurrently.

    Returns a merged-document dict ready to write as JSON.
    """
    blocks = view.get("blocks", [])
    sections = _group_blocks_into_sections(blocks)

    sections_to_merge = [s for s in sections if s.kcad_additions]
    sections_hp_only = [s for s in sections if not s.kcad_additions]

    if progress:
        print(f"    Sections: {len(sections_to_merge)} need merging, "
              f"{len(sections_hp_only)} HP-only")

    # Collect gap blocks for a separate "potential additions" appendix section.
    gap_blocks = [b for b in blocks if b.get("type") == "gap" and b.get("status") not in {"dismissed", "removed"}]

    semaphore = asyncio.Semaphore(max_concurrency)

    async def _with_idx(idx: int, section: SectionInput) -> tuple[int, dict]:
        result = await _merge_one_section(section, model=model, semaphore=semaphore)
        return idx, result

    # Launch all merges concurrently; collect with progress reporting.
    tasks = [
        _with_idx(i, section) for i, section in enumerate(sections_to_merge)
    ]

    results: list[dict | None] = [None] * len(sections_to_merge)
    completed = 0
    for task_future in asyncio.as_completed(tasks):
        idx, result = await task_future
        results[idx] = result
        completed += 1
        if progress:
            section = sections_to_merge[idx]
            if result.get("_fallback_to_block_level"):
                status = "FALLBACK"
            else:
                status = result.get("merge_confidence", "?")
            heading_short = section.heading_path.split(" > ")[-1] if " > " in section.heading_path else section.heading_path
            heading_short = heading_short[:60]
            print(f"    [{completed}/{len(sections_to_merge)}] {heading_short} — {status}")

    # Build output sections
    merged_sections: list[dict] = []

    def _first_block_idx(block_ids: list[str]) -> int:
        if not block_ids:
            return 10_000
        try:
            return int(block_ids[0].replace("block_", "")) if block_ids[0].startswith("block_") else 10_000
        except ValueError:
            return 10_000

    for section, result in zip(sections_to_merge, results):
        merge_result = dict(result) if result else {}
        # Strip internal-only metadata before persistence.
        fallback = merge_result.pop("_fallback_to_block_level", False)
        attempts = merge_result.pop("_attempts", None)
        validation_ok = merge_result.pop("_validation_ok", None)
        error = merge_result.pop("_error", None)
        usage = merge_result.pop("_usage", None)

        merged_sections.append({
            "heading_path": section.heading_path,
            "hp_block_ids": section.hp_block_ids,
            "kcad_block_ids": section.kcad_block_ids,
            "hp_original_text": section.hp_text,
            "kcad_addition_count": len(section.kcad_additions),
            "kcad_sources": sorted({ka.kcad_source for ka in section.kcad_additions}),
            "kcad_contributions": [
                {
                    "block_id": ka.block_id,
                    "source_document": ka.source_document,
                    "region": ka.kcad_source,
                    "heading_path": ka.heading_path,
                    "language": ka.source_language,
                }
                for ka in section.kcad_additions
            ],
            "merge_result": {
                "merged_text": merge_result.get("merged_text", section.hp_text),
                "preserved_kcad_facts": merge_result.get("preserved_kcad_facts", []),
                "omitted_kcad_content": merge_result.get("omitted_kcad_content", []),
                "conflicts_flagged": merge_result.get("conflicts_flagged", []),
                "merge_confidence": merge_result.get("merge_confidence", "low"),
                "merge_notes": merge_result.get("merge_notes", ""),
                "fallback_to_block_level": fallback,
                "validation_ok": validation_ok,
                "attempts": attempts,
                "error": error,
            },
        })

    for section in sections_hp_only:
        merged_sections.append({
            "heading_path": section.heading_path,
            "hp_block_ids": section.hp_block_ids,
            "kcad_block_ids": [],
            "hp_original_text": section.hp_text,
            "kcad_addition_count": 0,
            "kcad_sources": [],
            "kcad_contributions": [],
            "merge_result": {
                "merged_text": section.hp_text,
                "preserved_kcad_facts": [],
                "omitted_kcad_content": [],
                "conflicts_flagged": [],
                "merge_confidence": "high",
                "merge_notes": "",
                "fallback_to_block_level": False,
                "validation_ok": True,
                "attempts": 0,
                "error": None,
            },
        })

    # Sort by first HP block order (preserves document flow)
    merged_sections.sort(key=lambda s: _first_block_idx(s["hp_block_ids"]))

    # Aggregate summary
    total_preserved = sum(len(s["merge_result"]["preserved_kcad_facts"]) for s in merged_sections)
    total_omitted = sum(len(s["merge_result"]["omitted_kcad_content"]) for s in merged_sections)
    total_conflicts = sum(len(s["merge_result"]["conflicts_flagged"]) for s in merged_sections)
    total_kcad = sum(s["kcad_addition_count"] for s in merged_sections)
    fallback_count = sum(
        1 for s in merged_sections if s["merge_result"]["fallback_to_block_level"]
    )
    confidence_counts = {"high": 0, "medium": 0, "low": 0}
    for s in merged_sections:
        c = s["merge_result"]["merge_confidence"]
        if c in confidence_counts:
            confidence_counts[c] += 1

    if fallback_count == 0 and confidence_counts["low"] == 0:
        overall_confidence = "high"
    elif fallback_count <= 1 and confidence_counts["low"] <= 1:
        overall_confidence = "medium"
    else:
        overall_confidence = "low"

    return {
        "hp_filename": view.get("hp_filename"),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": model,
        "prompt_hash": _compute_prompt_hash(),
        "sections": merged_sections,
        "gap_blocks": [
            {
                "block_id": gb.get("id"),
                "heading_path": gb.get("heading_path"),
                "text": gb.get("text"),
                "source": gb.get("source"),
                "language": gb.get("language", "en"),
            }
            for gb in gap_blocks
        ],
        "summary": {
            "total_sections": len(merged_sections),
            "sections_with_kcad": len([s for s in merged_sections if s["kcad_addition_count"] > 0]),
            "sections_fallback": fallback_count,
            "total_kcad_additions": total_kcad,
            "total_preserved_facts": total_preserved,
            "total_omitted": total_omitted,
            "total_conflicts_flagged": total_conflicts,
            "total_gap_blocks": len(gap_blocks),
            "confidence_counts": confidence_counts,
            "overall_confidence": overall_confidence,
        },
    }


# ── CLI runner ─────────────────────────────────────────────────────────────


def _match_view_files(hp_docs: list[str] | None) -> list[Path]:
    """Resolve --doc filters against the views directory."""
    if not hp_docs:
        return sorted(CONSOLIDATION_VIEWS_DIR.glob("*.json"))
    matched: list[Path] = []
    seen: set[Path] = set()
    for name in hp_docs:
        name_norm = name.lower().replace(".pdf", "").replace(" ", "_").replace("-", "_")
        for fp in sorted(CONSOLIDATION_VIEWS_DIR.glob("*.json")):
            stem = fp.stem.lower().replace("-", "_")
            if name_norm in stem and fp not in seen:
                matched.append(fp)
                seen.add(fp)
    return matched


def run_merge(hp_docs: list[str] | None = None, model: str = "gpt-5.4") -> None:
    """Run the narrative merger for one or more consolidated view files.

    Loads the view from cache/consolidation/views/{slug}.json, runs the
    section merger, and writes to cache/consolidation/merged/{slug}.json.
    """
    MERGED_DIR.mkdir(parents=True, exist_ok=True)

    # Load env — merger uses GPT54 keys.
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        from dotenv import load_dotenv

        load_dotenv(env_path)

    view_files = _match_view_files(hp_docs)
    if not view_files:
        print("Merge: no matching view files found.")
        return

    print(f"Narrative merge: {len(view_files)} HP document(s)")

    for i, view_path in enumerate(view_files):
        with open(view_path, "r", encoding="utf-8") as f:
            view = json.load(f)

        hp_fn = view.get("hp_filename", view_path.stem)
        print(f"\n  [{i + 1}/{len(view_files)}] {hp_fn}")

        start = time.monotonic()
        try:
            merged = asyncio.run(merge_document_async(view, model=model, progress=True))
        except Exception:
            logger.exception("Merge failed for %s", hp_fn)
            print(f"    FAILED — see log")
            continue

        out_path = MERGED_DIR / view_path.name
        tmp_path = out_path.with_suffix(".json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False, default=str)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, out_path)

        elapsed = time.monotonic() - start
        s = merged["summary"]
        print(
            f"    Done in {elapsed:.1f}s · {s['sections_with_kcad']} sections merged · "
            f"{s['total_preserved_facts']} facts preserved · "
            f"{s['total_omitted']} omitted · "
            f"{s['total_conflicts_flagged']} conflicts · "
            f"{s['overall_confidence']} confidence "
            f"({s['sections_fallback']} fallback)"
        )

    print("\nNarrative merge complete.")
