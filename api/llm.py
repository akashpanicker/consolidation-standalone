"""Shared LLM utilities — HTTP client pool, pricing, cost calculation,
JSON parsing, and response text extraction.

This module has ZERO imports from other api.* modules to prevent circular deps.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ── HTTP Client Pool ─────────────────────────────────────────────────────────

_clients: dict[float, httpx.AsyncClient] = {}


def get_http_client(timeout: float = 600.0) -> httpx.AsyncClient:
    """Return a shared AsyncClient for the given timeout (one per unique value)."""
    if timeout not in _clients:
        _clients[timeout] = httpx.AsyncClient(timeout=httpx.Timeout(timeout))
    return _clients[timeout]


# ── Model Pricing ────────────────────────────────────────────────────────────

_BASE_PRICING: dict[str, dict[str, float]] = {
    "gpt-5.2": {"input": 2.00, "output": 8.00},
}

# Text-only endpoints (metadata, chunking) — default tier
MODEL_PRICING: dict[str, dict[str, float]] = {
    **_BASE_PRICING,
    "gpt-5.4": {"input": 2.00, "output": 8.00},
}
DEFAULT_PRICING: dict[str, float] = {"input": 2.00, "output": 8.00}

# Vision/PDF endpoints (extraction) — higher per-token cost for image input
VISION_PRICING: dict[str, dict[str, float]] = {
    **_BASE_PRICING,
    "gpt-5.4": {"input": 2.50, "output": 15.00},
}
VISION_DEFAULT_PRICING: dict[str, float] = {"input": 2.50, "output": 15.00}


def calculate_cost(
    model: str, input_tokens: int, output_tokens: int, *, vision: bool = False,
) -> float:
    """Calculate USD cost from token counts.

    Use ``vision=True`` for endpoints that send images (extraction, validation).
    """
    if vision:
        pricing = VISION_PRICING.get(model, VISION_DEFAULT_PRICING)
    else:
        pricing = MODEL_PRICING.get(model, DEFAULT_PRICING)
    return round(
        (input_tokens / 1_000_000) * pricing["input"]
        + (output_tokens / 1_000_000) * pricing["output"],
        6,
    )


# ── JSON Parsing ─────────────────────────────────────────────────────────────

_FENCE_RE = re.compile(r"^```(?:json|markdown)?\s*|\s*```$", re.IGNORECASE)


def clean_llm_json(text: str) -> str:
    """Strip markdown code fences from LLM output."""
    return _FENCE_RE.sub("", text.strip())


def parse_llm_json(
    text: str,
    fallback: str = "brace",
) -> dict | list | None:
    """Parse JSON from LLM output with optional fallback extraction.

    fallback modes:
      "brace"   — try full parse, then extract outermost {...}
      "bracket" — try full parse, then extract outermost [...]
      "none"    — strict, no fallback
    """
    cleaned = clean_llm_json(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    if fallback == "none":
        return None

    open_char, close_char = ("{", "}") if fallback == "brace" else ("[", "]")
    start = cleaned.find(open_char)
    end = cleaned.rfind(close_char)
    if start >= 0 and end > start:
        try:
            return json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError:
            pass
    return None


# ── Response Extraction ──────────────────────────────────────────────────────


def extract_output_text(body: dict[str, Any]) -> str:
    """Extract the text content from an Azure OpenAI Responses API body.

    Handles both {"text": "..."} and {"type": "output_text", "text": "..."} formats.
    Returns empty string if no text found.
    """
    for item in body.get("output", []):
        if item.get("type") != "message":
            continue
        for ci in item.get("content", []):
            if isinstance(ci, dict):
                text = ci.get("text") or ""
                if text:
                    return str(text)
                if ci.get("type") == "output_text" and ci.get("text"):
                    return str(ci["text"])
    return ""
