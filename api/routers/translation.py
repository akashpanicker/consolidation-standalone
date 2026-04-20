"""Shared translation + language detection endpoints.

Domain-neutral: same service is consumed by the Consolidation UI, the
Extraction tab, the Metadata tab, and the Chunks tab. Primitives live in
:mod:`api.translation` (content-hash cached detect + translate). This
router is a thin HTTP facade over them.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..translation import RTL_LANGUAGES, detect_language, translate_to_english

logger = logging.getLogger(__name__)

router = APIRouter(tags=["translation"])


class TranslateRequest(BaseModel):
    text: str
    source_language: str | None = None


class DetectLanguageRequest(BaseModel):
    text: str


@router.post("/translate")
async def translate(body: TranslateRequest):
    """Translate text to English. Cached by content hash.

    - If ``source_language`` is omitted or ``"en"``, detection runs first.
    - If the effective language is English, returns the input unchanged.
    - Repeat calls on the same text are free (content-hash cache).
    """
    text = body.text or ""
    if not text.strip():
        return {
            "translated_text": "",
            "source_language": "en",
            "is_rtl": False,
            "detected": False,
            "cached": False,
        }

    source_language = (body.source_language or "").strip().lower()
    detected = False

    if not source_language or source_language == "en":
        detection = await detect_language(text)
        source_language = detection.get("language", "en")
        detected = True

    if source_language == "en":
        return {
            "translated_text": text,
            "source_language": "en",
            "is_rtl": False,
            "detected": detected,
            "cached": False,
        }

    try:
        result = await translate_to_english(
            text,
            source_language=source_language,
        )
    except Exception as e:
        logger.exception("Translation failed for source_language=%s", source_language)
        raise HTTPException(502, f"Translation failed: {e}")

    return {
        "translated_text": result["translated_text"],
        "source_language": result["source_language"],
        "is_rtl": result["source_language"] in RTL_LANGUAGES,
        "detected": detected,
        "cached": result.get("cached", False),
    }


@router.post("/detect-language")
async def detect(body: DetectLanguageRequest):
    """Detect the dominant language of a text sample.

    Cheap, cached. Returns ``{"language": iso-code, "confidence": "high|medium|low"}``.
    Callers use this to decide whether to auto-translate *before* paying the
    translation cost.
    """
    text = body.text or ""
    if not text.strip():
        return {"language": "en", "confidence": "high"}

    try:
        result = await detect_language(text)
    except Exception as e:
        logger.exception("Language detection failed")
        raise HTTPException(502, f"Language detection failed: {e}")

    return {
        "language": result.get("language", "en"),
        "confidence": result.get("confidence", "medium"),
    }
