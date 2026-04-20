"""Language detection and translation for KCAD chunk content.

Used by the Consolidation page to let reviewers translate non-English KCAD
chunks to English on-demand, and by :func:`translate_chunks_inplace` to
populate the dual-field ``text_en`` / ``heading_path_en`` sidecars at
chunking time.

Design notes:
  - Context-aware detection (GPT-5.4) rather than `langdetect`. Short or
    mixed-language industrial text fools statistical n-gram detectors.
  - Translation prompt explicitly preserves regulatory codes, equipment
    names, organization references, and markdown structure.
  - Content-hash cache via CacheManager ("translations" subdir). Same text
    across documents translates once. The cache key embeds a prompt hash
    so prompt edits invalidate stale entries.

Re-run invariant (do not break):
  Translation is a **chunk-time** concern. Extraction emits source-language
  markdown and MUST NOT translate inline. Any change to the translation
  prompt, model, or strategy triggers
      re-chunk + re-run ``translate_chunks_inplace`` on cached chunks
  and NEVER requires re-extracting PDFs. The dual-field contract
  (``text`` = source-language verbatim, ``text_en`` = canonical English)
  is preserved through reconstruction, the narrative merger, and the
  judge input builder so downstream layers never re-translate either —
  they consume the ``text_en`` the chunk carries. If you add a new
  persistence layer on the chunk path, carry both fields; dropping one
  silently reintroduces the "must re-run upstream to adopt a translation
  change" failure mode this invariant exists to prevent.

Public API:
  - detect_language(text, *, model="gpt-5.4") -> {"language": "de", "confidence": "high"}
  - translate_to_english(text, *, source_language, model="gpt-5.4")
      -> {"translated_text": "...", "source_language": "de"}
  - translate_chunks_inplace(chunks, ...) — populates text_en sidecars.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from typing import Any

from .cache import CacheManager
from .llm import (
    calculate_cost,
    extract_output_text,
    get_http_client,
    parse_llm_json,
)

logger = logging.getLogger(__name__)

# ── Cache ───────────────────────────────────────────────────────────────

_TRANSLATION_SUBDIR = "translations"
_DETECTION_SUBDIR = "language_detections"

_cache: CacheManager | None = None


def _get_cache() -> CacheManager:
    global _cache
    if _cache is None:
        _cache = CacheManager()
    return _cache


_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_for_hash(text: str) -> str:
    """Collapse whitespace for cache-key stability across trivial formatting."""
    return _WHITESPACE_RE.sub(" ", text.strip())


def _prompt_hash(prompt: str) -> str:
    """Short fingerprint of a system prompt for cache-key versioning.

    Including this in the cache key ensures that edits to the
    preservation-rules section (e.g., "preserve API RP numbers") or the
    detection-confidence rubric invalidate stale cached outputs instead
    of silently serving the previous behavior. 8 hex chars = 32 bits;
    collision probability is negligible for prompt-revision history.
    """
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8]


def _detection_key(text: str, model: str) -> str:
    norm = _normalize_for_hash(text)
    prompt_h = _prompt_hash(_DETECTION_SYSTEM_PROMPT)
    h = hashlib.sha256(
        f"{model}|{prompt_h}|{norm}".encode("utf-8")
    ).hexdigest()[:24]
    return f"lang_{h}"


def _translation_key(text: str, source_language: str, model: str) -> str:
    norm = _normalize_for_hash(text)
    # Uses the TEMPLATE hash (pre-format), not the formatted per-language
    # system prompt. The {source_language_*} substitutions are already
    # present in the separate source_language key field, so hashing the
    # template avoids cache fragmentation across languages while still
    # invalidating on prompt edits.
    prompt_h = _prompt_hash(_TRANSLATION_SYSTEM_PROMPT)
    h = hashlib.sha256(
        f"{model}|{prompt_h}|{source_language}|{norm}".encode("utf-8"),
    ).hexdigest()[:24]
    return f"tr_{h}"


# ── Prompts ─────────────────────────────────────────────────────────────

_DETECTION_SYSTEM_PROMPT = """\
You are a language detection specialist for industrial safety documents.

Your task: determine the DOMINANT natural language of the given text.

Rules:
- Return the ISO 639-1 two-letter code (e.g., "en", "de", "ar", "nl", "fr").
- Ignore embedded non-language tokens: regulatory codes (DGUV, OSHA, ISO numbers), \
equipment model numbers, product names, company names, email addresses, URLs, \
file paths, and numeric values. These do NOT indicate the text's language.
- If a passage is primarily English with a few German equipment names, return "en".
- If a passage is primarily German with English technical abbreviations, return "de".
- Base your decision on the language of the connective prose (verbs, pronouns, \
articles, conjunctions), not the nouns alone.
- If the text is too short to determine confidently, still return your best guess \
and mark confidence "low".

Confidence levels:
- "high": clear dominant language with multiple sentences of prose
- "medium": short text but the structural words point to one language
- "low": very short, mostly technical tokens, or mixed unclear passages

Return ONLY a JSON object with this exact shape:
{"language": "<iso-639-1>", "confidence": "<high|medium|low>"}
"""

_TRANSLATION_SYSTEM_PROMPT = """\
You are a professional translator for industrial safety and operations documents.

Translate the user's text from {source_language_name} ({source_language_code}) to \
ENGLISH while preserving every structural and technical element.

## Preservation Rules (STRICT)

DO NOT translate, transliterate, or alter:
- Regulatory codes and standards (DGUV, OSHA, ISO, EN, BS, API, NFPA, ANSI, \
DIN, IEC, ATEX, and their numbers/revisions)
- Regulation clause references (e.g., "DGUV Regel 112-190", "ISO 14001:2015")
- Equipment names, product names, and model numbers (e.g., "Oxy K30", "Parat")
- Company and organization names (e.g., "Nogepa", "Oberbergamt Clausthal-Zellerfeld")
- Person names, acronyms used as proper nouns
- Numeric values, measurement units (bar, psi, mg/m3, ppm, °C), dates, times
- File paths, URLs, email addresses, phone numbers
- Code snippets, form field identifiers, checkbox markers

## Markdown Structure

Preserve every markdown construct unchanged:
- Headings (`#`, `##`, `###`) at the same level
- Ordered and unordered list markers (`-`, `*`, `1.`, `2.`)
- Table pipe syntax (`|`) and separator rows (`| --- |`)
- Code fences (```)
- Bold (`**...**`) and italics (`*...*`) wrappers
- HTML comments like `<!--PAGE:3-->` — keep exactly where they appear
- Links: translate the link text, keep the URL

Translate table CELL content and list ITEM content, but do not change the \
structural characters around them.

## Style

- Use clear, professional English appropriate for industrial safety documentation.
- Do not paraphrase or summarize. Translate every sentence.
- Do not add editor commentary, headers, or notes. Output only the translation.
- Do not wrap the output in additional code fences unless the input had them.

## Output Format

Return ONLY a JSON object with this exact shape:
{{"translated_text": "<the full translation preserving all markdown and protected tokens>"}}

No preamble, no commentary, no trailing text outside the JSON.
"""


_LANGUAGE_NAMES: dict[str, str] = {
    "de": "German",
    "ar": "Arabic",
    "nl": "Dutch",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "tr": "Turkish",
    "pl": "Polish",
    "no": "Norwegian",
    "sv": "Swedish",
    "da": "Danish",
    "fi": "Finnish",
    "cs": "Czech",
    "ro": "Romanian",
    "hu": "Hungarian",
    "el": "Greek",
    "he": "Hebrew",
    "fa": "Persian",
    "ur": "Urdu",
    "id": "Indonesian",
    "ms": "Malay",
    "vi": "Vietnamese",
    "th": "Thai",
    "hi": "Hindi",
}

RTL_LANGUAGES: frozenset[str] = frozenset({"ar", "he", "fa", "ur"})


def _language_name(code: str) -> str:
    return _LANGUAGE_NAMES.get(code.lower(), code)


# ── LLM call ────────────────────────────────────────────────────────────


async def _call_llm(
    system_prompt: str,
    user_text: str,
    *,
    model: str,
    max_output_tokens: int,
    reasoning_effort: str = "low",
) -> tuple[str, dict[str, Any]]:
    base_url = os.getenv("GPT54_BASE_URL")
    api_key = os.getenv("GPT54_API_KEY")
    if not base_url or not api_key:
        raise ValueError("GPT54_BASE_URL or GPT54_API_KEY not set")

    payload: dict = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": [{"type": "input_text", "text": user_text}]},
        ],
        "max_output_tokens": max_output_tokens,
    }
    if reasoning_effort:
        payload["reasoning"] = {"effort": reasoning_effort}

    response = await get_http_client(600.0).post(
        base_url,
        headers={"Content-Type": "application/json", "api-key": api_key},
        json=payload,
    )

    if response.status_code >= 400:
        try:
            error_json = response.json()
            error_msg = error_json.get("error", {}).get("message", response.text[:500])
        except Exception:
            error_msg = response.text[:500] or f"HTTP {response.status_code}"
        raise ValueError(f"Translation API {response.status_code}: {error_msg}")

    body = response.json()
    output_text = extract_output_text(body)
    if not output_text:
        raise ValueError("Translation API returned no text")

    usage = body.get("usage", {}) or {}
    usage_dict = {
        "input_tokens": int(usage.get("input_tokens", 0) or 0),
        "output_tokens": int(usage.get("output_tokens", 0) or 0),
    }
    return output_text, usage_dict


# ── Public API ──────────────────────────────────────────────────────────


async def detect_language(
    text: str,
    *,
    model: str = "gpt-5.4",
) -> dict[str, Any]:
    """Detect the dominant language of text. Cached by content hash.

    Returns dict: {"language": iso-639-1 code, "confidence": "high|medium|low"}.
    English returns {"language": "en", "confidence": "high"} for empty input.
    """
    text = text or ""
    if not text.strip():
        return {"language": "en", "confidence": "high"}

    cache = _get_cache()
    key = _detection_key(text, model)
    cached = cache.get(key, subdir=_DETECTION_SUBDIR)
    if isinstance(cached, dict) and "language" in cached:
        return cached

    # Truncate very long text for detection — first 3000 chars is plenty
    sample = text if len(text) <= 3000 else text[:3000]

    try:
        output_text, usage = await _call_llm(
            _DETECTION_SYSTEM_PROMPT,
            sample,
            model=model,
            max_output_tokens=4000,
            reasoning_effort="low",
        )
    except Exception as e:
        logger.warning("Language detection failed; defaulting to 'en': %s", e)
        return {"language": "en", "confidence": "low"}

    parsed = parse_llm_json(output_text, fallback="brace")
    if not isinstance(parsed, dict) or "language" not in parsed:
        logger.warning("Language detection: could not parse response; defaulting to 'en'")
        return {"language": "en", "confidence": "low"}

    language = str(parsed.get("language", "en")).strip().lower()
    confidence = str(parsed.get("confidence", "medium")).strip().lower()
    if confidence not in {"high", "medium", "low"}:
        confidence = "medium"

    result = {
        "language": language,
        "confidence": confidence,
        "model": model,
        "cost_usd": calculate_cost(model, usage["input_tokens"], usage["output_tokens"]),
    }
    cache.set(key, result, subdir=_DETECTION_SUBDIR)
    return result


async def translate_to_english(
    text: str,
    *,
    source_language: str,
    model: str = "gpt-5.4",
) -> dict[str, Any]:
    """Translate text to English. Cached by content hash.

    Returns dict: {"translated_text": str, "source_language": str, "cached": bool}.
    If source_language is "en" or empty, returns original text unchanged.
    """
    text = text or ""
    source_language = (source_language or "").strip().lower()

    if not text.strip() or source_language in {"", "en"}:
        return {"translated_text": text, "source_language": source_language or "en", "cached": False}

    cache = _get_cache()
    key = _translation_key(text, source_language, model)
    cached = cache.get(key, subdir=_TRANSLATION_SUBDIR)
    if isinstance(cached, dict) and "translated_text" in cached:
        return {**cached, "cached": True}

    system_prompt = _TRANSLATION_SYSTEM_PROMPT.format(
        source_language_name=_language_name(source_language),
        source_language_code=source_language,
    )

    # Output budget: generous — translations are often 1.2-1.5x source length
    # for German->English, and we want room for reasoning.
    max_output = max(8000, min(64000, len(text) // 2 + 8000))

    try:
        output_text, usage = await _call_llm(
            system_prompt,
            text,
            model=model,
            max_output_tokens=max_output,
            reasoning_effort="low",
        )
    except Exception as e:
        logger.error("Translation failed (lang=%s, len=%d): %s", source_language, len(text), e)
        raise

    parsed = parse_llm_json(output_text, fallback="brace")
    if not isinstance(parsed, dict) or "translated_text" not in parsed:
        raise ValueError("Translation response missing 'translated_text' field")

    translated_text = str(parsed["translated_text"])

    result = {
        "translated_text": translated_text,
        "source_language": source_language,
        "model": model,
        "cost_usd": calculate_cost(model, usage["input_tokens"], usage["output_tokens"]),
    }
    cache.set(key, result, subdir=_TRANSLATION_SUBDIR)
    return {**result, "cached": False}


# ── Pipeline-side helper: translate a batch of free-text fields ─────────


async def translate_fields(
    sample_text: str,
    fields: dict[str, str],
    *,
    model: str = "gpt-5.4",
) -> dict[str, Any]:
    """Detect a source text's language and translate a batch of named fields.

    Designed for metadata/chunk handlers that produce free-text output in the
    source language (e.g., ``summary.short_summary`` for a KCAD German doc).
    Each handler builds its result dict, then calls this helper to generate
    a parallel English payload stored under a ``_en`` sibling.

    Args:
        sample_text: A representative prose sample (e.g. the first ~3000
            chars of the extracted markdown) used for language detection.
            The detection call is content-hash cached, so repeat use across
            tasks for the same document is free.
        fields: Mapping of ``field_name → field_text``. Empty values are
            left as empty strings in the output. Order is preserved.

    Returns a dict::

        {
            "source_language": "de",
            "translated": {field_name: english_text, ...},  # fully populated
            "skipped": bool,      # True when source was detected as English
        }

    When ``skipped`` is True, ``translated`` still contains every field name
    mapped to the original text, so callers can store it uniformly without
    branching on the skip flag.
    """
    import asyncio

    detection = await detect_language(sample_text or "")
    source_language = str(detection.get("language") or "en").strip().lower()

    if source_language == "en" or not sample_text.strip():
        return {
            "source_language": source_language,
            "translated": {name: text for name, text in fields.items()},
            "skipped": True,
        }

    async def _one(text: str) -> str:
        if not text.strip():
            return ""
        try:
            result = await translate_to_english(
                text, source_language=source_language, model=model,
            )
            return str(result.get("translated_text") or text)
        except Exception:
            logger.exception("translate_fields: per-field translation failed")
            return text

    names = list(fields.keys())
    translated_list = await asyncio.gather(*[_one(fields[n]) for n in names])
    translated = dict(zip(names, translated_list))

    return {
        "source_language": source_language,
        "translated": translated,
        "skipped": False,
    }


# ── Chunk-pipeline helper: translate body + heading_path in place ───────


# PT-3: A chunk's text is flagged for GPT-5.4 re-detection when its
# non-ASCII character ratio crosses this threshold but langdetect tagged
# it English. Typical English chunks sit well below 1% non-ASCII even
# with incidental equipment names; German text averages 2-4% after
# umlauts + eszett; Arabic/CJK is essentially 100%. Threshold tuned to
# catch typical German while leaving a comfortable margin above clean
# English — closes the langdetect-weakness gap called out in the
# 2026-04-16-chunk-translation-design.md spec.
_NON_ASCII_RECONFIRM_THRESHOLD = 0.02


def _non_ascii_ratio(text: str) -> float:
    """Fraction of characters above ordinal 127. Zero for empty text."""
    if not text:
        return 0.0
    non_ascii = sum(1 for ch in text if ord(ch) > 127)
    return non_ascii / len(text)


async def translate_chunks_inplace(
    chunks: list[dict],
    *,
    max_concurrent: int = 8,
    model: str = "gpt-5.4",
) -> dict[str, Any]:
    """Populate `text_en`, `heading_path_en`, and `translation_status` on
    every chunk. Mutates ``chunks`` in place and returns a summary dict.

    ``translation_status`` (PT-2) is the single source of truth for
    downstream consumers (embedding, LLM judge, P3.2 gate, UI):

      - ``"applied"``         — translation succeeded; ``text_en`` is populated
      - ``"skipped_english"`` — chunk language is "en"; no translation needed
      - ``"skipped_empty"``   — chunk has no prose; no translation needed
      - ``"failed"``          — translation was attempted but the LLM call
                                raised or returned empty; ``text_en`` is NOT
                                populated. Signals the P3.2 gate to quarantine.

    PT-3 — GPT-5.4 reconfirm on suspicious langdetect "en": if a chunk
    labeled "en" has substantial non-ASCII content (``>= 3%`` of chars
    non-ASCII), we call ``detect_language`` (cached, GPT-5.4) before
    trusting the label. This closes the langdetect-misclassifies-German
    gap the original spec called out as a known limitation.

    PT-4 — cost is accumulated from the inner ``translate_to_english``
    and ``detect_language`` calls. Cache hits contribute 0; fresh calls
    add ``cost_usd``. ``chunk_document`` adds this into its result's
    cost_usd so the reported total reflects real spend.
    """
    import asyncio

    warnings: list[str] = []
    total_cost = 0.0
    detections_called = 0
    semaphore = asyncio.Semaphore(max_concurrent)

    # ── PT-3: reconfirm ambiguous "en" labels via GPT-5.4 detection ──
    # Runs before the translation pass so the body loop sees the
    # corrected language on the chunk. Only fires on chunks where
    # langdetect said "en" AND non-ASCII ratio crosses the threshold —
    # for clean English docs this costs 0 LLM calls.
    reconfirm_candidates: list[dict] = []
    for c in chunks:
        lang = (c.get("language") or "").strip().lower()
        if lang != "en":
            continue
        text = c.get("text") or ""
        if _non_ascii_ratio(text) >= _NON_ASCII_RECONFIRM_THRESHOLD:
            reconfirm_candidates.append(c)

    async def _reconfirm(chunk: dict) -> None:
        nonlocal total_cost, detections_called
        text = chunk.get("text") or ""
        async with semaphore:
            try:
                detection = await detect_language(text)
            except Exception as exc:
                warnings.append(
                    f"re-detection failed for {chunk.get('chunk_id', '?')}: {exc}"
                )
                return
        detections_called += 1
        total_cost += float(detection.get("cost_usd") or 0.0)
        new_lang = (detection.get("language") or "en").strip().lower()
        if new_lang and new_lang != "en":
            chunk["language"] = new_lang
            chunk["language_source"] = "llm_reconfirm"

    if reconfirm_candidates:
        await asyncio.gather(*[_reconfirm(c) for c in reconfirm_candidates])

    # ── Body translation pass ────────────────────────────────────────
    # Non-prose chunks (form / table / image) already have matching_text
    # in English from the chunker — translating their `text` field would
    # be a waste; their translation_status flows from the matching_text
    # presence check instead of a translate() call.

    async def _translate_body(chunk: dict) -> None:
        nonlocal total_cost
        lang = (chunk.get("language") or "").strip().lower()
        text = chunk.get("text") or ""
        if not text.strip():
            chunk["translation_status"] = "skipped_empty"
            return
        if lang in {"", "en"}:
            chunk["translation_status"] = "skipped_english"
            return
        async with semaphore:
            try:
                result = await translate_to_english(
                    text, source_language=lang, model=model,
                )
                translated = str(result.get("translated_text") or "")
                # Cost contribution is 0 on cache hit (calculate_cost on
                # cached result already reflects original call's cost).
                if not result.get("cached"):
                    total_cost += float(result.get("cost_usd") or 0.0)
                if translated and translated != text:
                    chunk["text_en"] = translated
                    chunk["translation_status"] = "applied"
                elif translated:
                    # Translator returned the source text unchanged —
                    # the source was already English despite the initial
                    # language detector claiming otherwise. Preserve the
                    # invariant "status='applied' ⇒ text_en is set" by
                    # recording this as a post-check English skip
                    # instead of a successful translation.
                    chunk["translation_status"] = "skipped_already_english"
                else:
                    chunk["translation_status"] = "failed"
            except Exception as exc:
                cid = chunk.get("chunk_id") or "?"
                warnings.append(f"text translation failed for {cid}: {exc}")
                chunk["translation_status"] = "failed"

    await asyncio.gather(*[_translate_body(c) for c in chunks])

    # ── Heading path segment translation ─────────────────────────────
    # Dedup across chunks so the backend content-hash cache gets maximal
    # reuse. A 53-chunk KCAD doc typically has ~15 unique segments; we
    # pay ~15 calls for all breadcrumbs instead of 53 × depth.
    unique_segments: dict[str, str | None] = {}
    for c in chunks:
        lang = (c.get("language") or "").strip().lower()
        if lang in {"", "en"}:
            continue
        path = c.get("heading_path") or ""
        for seg in path.split(" > "):
            if seg.strip() and seg not in unique_segments:
                unique_segments[seg] = None

    async def _translate_segment(seg: str) -> None:
        nonlocal total_cost
        source_lang = "en"
        for c in chunks:
            path = c.get("heading_path") or ""
            if seg in path.split(" > "):
                lc = (c.get("language") or "").strip().lower()
                if lc not in {"", "en"}:
                    source_lang = lc
                    break
        if source_lang == "en":
            return
        async with semaphore:
            try:
                r = await translate_to_english(
                    seg, source_language=source_lang, model=model,
                )
                tx = str(r.get("translated_text") or "")
                if tx:
                    unique_segments[seg] = tx
                if not r.get("cached"):
                    total_cost += float(r.get("cost_usd") or 0.0)
            except Exception as exc:
                warnings.append(
                    f"heading-segment translation failed ({seg!r}): {exc}"
                )

    await asyncio.gather(
        *[_translate_segment(s) for s in list(unique_segments.keys())]
    )

    for c in chunks:
        lang = (c.get("language") or "").strip().lower()
        if lang in {"", "en"}:
            continue
        path = c.get("heading_path") or ""
        if not path:
            continue
        segments = path.split(" > ")
        translated = [unique_segments.get(s) or s for s in segments]
        joined = " > ".join(translated)
        if joined != path:
            c["heading_path_en"] = joined

    translated_bodies = sum(1 for c in chunks if c.get("text_en"))
    translated_paths = sum(1 for c in chunks if c.get("heading_path_en"))
    failed_count = sum(
        1 for c in chunks if c.get("translation_status") == "failed"
    )
    return {
        "translated_bodies": translated_bodies,
        "translated_paths": translated_paths,
        "unique_heading_segments": len(unique_segments),
        "failed_count": failed_count,
        "detections_called": detections_called,
        "cost_usd": round(total_cost, 6),
        "warnings": warnings,
    }
