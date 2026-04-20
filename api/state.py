"""Trimmed startup state for the standalone consolidation backend.

The full project's state module discovers PDFs on disk, supplements
from extraction caches, and syncs to Azure Blob. None of that applies
to a consolidation-only bundle — the views and metadata pkls already
live on disk and are the source of truth. This module only initializes
the shared CacheManager so `api.translation` can read/write its
content-hash caches.
"""

import logging
from pathlib import Path

from .config import load_config
from .cache import CacheManager

PROJECT_ROOT = Path(__file__).resolve().parent.parent
logger = logging.getLogger(__name__)

cache: CacheManager | None = None
documents: list[dict] = []


def startup() -> None:
    """Load config + initialize the cache manager."""
    global cache
    load_config(str(PROJECT_ROOT / "config.yaml"))
    cache = CacheManager()
    logger.info("Consolidation standalone startup complete")
