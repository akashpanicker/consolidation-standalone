"""Pipeline configuration and path resolution."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "cache"

# Source document directories
HP_DOCS_DIR = PROJECT_ROOT / "data" / "hp"
KCAD_DOCS_DIR = PROJECT_ROOT / "data" / "kcad"

# Cache subdirectories
EXTRACTIONS_DIR = CACHE_DIR / "extractions"
CHUNKS_DIR = CACHE_DIR / "chunks"
METADATA_DIR = CACHE_DIR / "metadata"
EMBEDDINGS_DIR = CACHE_DIR / "embeddings"
DEDUP_DIR = CACHE_DIR / "dedup"
CONSOLIDATION_DIR = CACHE_DIR / "consolidation"
CONSOLIDATION_VIEWS_DIR = CONSOLIDATION_DIR / "views"

# Embedding config
EMBEDDING_MODEL = "text-embedding-3-large"
EMBEDDING_DIMS = 3072
EMBEDDING_BATCH_SIZE = 16

# Retrieval config
ROUTING_MAX_HP_CANDIDATES = 10
RETRIEVAL_TOP_K = 5
JUDGE_ASSESS_TOP_K = 3

# Dedup config
DEDUP_COSINE_THRESHOLD = 0.95

# Judge config
JUDGE_MODEL = "gpt-5.4"
JUDGE_REASONING_EFFORT = "medium"
JUDGE_MAX_OUTPUT_TOKENS = 8192

# Evaluator config
EVALUATIONS_DIR = CONSOLIDATION_DIR / "evaluations"
EVALUATOR_MODEL = "gpt-5.4"
EVALUATOR_REASONING_EFFORT = "medium"
EVALUATOR_MAX_OUTPUT_TOKENS = 32768  # Larger than judge — sections have multiple block verdicts with evidence
EVALUATOR_TIER2_MAX_OUTPUT_TOKENS = 16384  # Per-block, smaller
EVALUATOR_PARALLEL_WORKERS = 5


def sanitize_filename(filename: str) -> str:
    """Convert a PDF filename to a cache-safe slug (matches api/chunking.py convention)."""
    import re
    stem = Path(filename).stem
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", stem) + "_pdf"


def ensure_dirs() -> None:
    """Create all cache subdirectories if they don't exist."""
    for d in (EMBEDDINGS_DIR, DEDUP_DIR, CONSOLIDATION_DIR, CONSOLIDATION_VIEWS_DIR, EVALUATIONS_DIR):
        d.mkdir(parents=True, exist_ok=True)
