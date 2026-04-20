import hashlib
import logging
import os
import pickle
from pathlib import Path
from typing import Any, Iterable, Optional

from .config import get_config

logger = logging.getLogger(__name__)

try:
    from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
    from azure.storage.blob import BlobServiceClient, ContainerClient
except Exception:  # pragma: no cover - optional dependency
    BlobServiceClient = None
    ContainerClient = None
    ResourceExistsError = Exception
    ResourceNotFoundError = Exception


DEFAULT_CACHE_SUBDIRS = (
    "extractions",
    "metadata/summary",
    "metadata/activities",
    "metadata/sections",
    "metadata/section_types",
    "metadata/assets",
    "metadata/labeling_region",
    "metadata/labeling_regulation_orgs",
    "metadata/labeling_customers",
    "metadata/labeling_environment",
    "metadata/detect_rig_label",
    "metadata/validate_rig_label",
    "metadata/detect_region",
    "metadata/detect_regulation_orgs",
    "metadata/detect_customers",
    "metadata/concept_classification",
    "metadata/concept_two_pass",
    "metadata/document_title",
    "metadata/document_details",
    "metadata/document_details_validation",
    "metadata/document_details_validation_full",
    "metadata/table_of_contents",
)


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    return bool(value)


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _env(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned if cleaned else None


class AzureBlobCache:
    def __init__(self, cfg: dict | None = None):
        cfg = cfg if isinstance(cfg, dict) else {}

        self.enabled = False
        self.prefix = ""
        self.sync_current_extractions_on_startup = True
        self.managed_subdirs = {"extractions"}
        self._container_client = None

        container_sas_url = _env("AZURE_BLOB_CONTAINER_SAS_URL") or cfg.get("container_sas_url")
        connection_string = _env("AZURE_BLOB_CONNECTION_STRING") or cfg.get("connection_string")
        container = _env("AZURE_BLOB_CONTAINER") or cfg.get("container")
        prefix = _env("AZURE_BLOB_CACHE_PREFIX")
        if prefix is None:
            prefix = cfg.get("prefix", "")
        self.prefix = str(prefix).strip("/")

        managed_subdirs = (
            _env("AZURE_BLOB_CACHE_MANAGED_SUBDIRS")
            or _env("AZURE_BLOB_CACHE_UPLOAD_SUBDIRS")
            or cfg.get("managed_subdirs")
            or cfg.get("upload_subdirs")
            or ["extractions"]
        )
        self.managed_subdirs = set(_as_list(managed_subdirs)) or {"extractions"}

        sync_on_startup = _env("AZURE_BLOB_SYNC_CURRENT_EXTRACTIONS_ON_STARTUP")
        if sync_on_startup is None:
            sync_on_startup = cfg.get("sync_current_extractions_on_startup", True)
        self.sync_current_extractions_on_startup = _as_bool(sync_on_startup, True)

        enabled_value = _env("AZURE_BLOB_CACHE_ENABLED")
        if enabled_value is None:
            enabled_value = cfg.get("enabled")
        enabled = _as_bool(enabled_value, bool(container_sas_url or (connection_string and container)))
        if not enabled:
            logger.info("Azure blob cache disabled")
            return

        if BlobServiceClient is None:
            logger.warning(
                "Azure blob cache requested but dependency missing. "
                "Install azure-storage-blob to enable cloud cache."
            )
            return

        if not container_sas_url and (not connection_string or not container):
            logger.warning(
                "Azure blob cache enabled but missing connection info "
                "(AZURE_BLOB_CONTAINER_SAS_URL or AZURE_BLOB_CONNECTION_STRING + AZURE_BLOB_CONTAINER)."
            )
            return

        try:
            if container_sas_url:
                if ContainerClient is None:
                    logger.warning(
                        "Azure blob cache requested via SAS URL but dependency missing. "
                        "Install azure-storage-blob to enable cloud cache."
                    )
                    return
                container_client = ContainerClient.from_container_url(container_sas_url)
            else:
                service_client = BlobServiceClient.from_connection_string(connection_string)
                container_client = service_client.get_container_client(container)
                try:
                    container_client.get_container_properties()
                except ResourceNotFoundError:
                    try:
                        container_client.create_container()
                    except ResourceExistsError:
                        pass
            self._container_client = container_client
            self.enabled = True
            logger.info(
                "Azure blob cache enabled (container=%s, prefix=%s, managed_subdirs=%s)",
                container_client.container_name,
                self.prefix or "<root>",
                sorted(self.managed_subdirs),
            )
        except Exception as e:
            logger.warning("Failed to initialize Azure blob cache; falling back to local cache: %s", e)

    def manages_subdir(self, subdir: str) -> bool:
        return self.enabled and subdir in self.managed_subdirs

    def _blob_name(self, *, subdir: str, filename: str) -> str:
        parts = [part.strip("/") for part in (self.prefix, subdir, filename) if str(part).strip("/")]
        return "/".join(parts)

    def upload(self, *, subdir: str, filename: str, data: bytes, overwrite: bool) -> str:
        if not self.manages_subdir(subdir):
            return "disabled"

        blob_name = self._blob_name(subdir=subdir, filename=filename)
        try:
            self._container_client.upload_blob(name=blob_name, data=data, overwrite=overwrite)
            return "uploaded"
        except ResourceExistsError:
            return "exists"
        except Exception as e:
            logger.error("Cloud cache upload failed for %s: %s", blob_name, e)
            return "failed"

    def exists(self, *, subdir: str, filename: str) -> bool:
        if not self.manages_subdir(subdir):
            return False
        blob_name = self._blob_name(subdir=subdir, filename=filename)
        try:
            return bool(self._container_client.get_blob_client(blob_name).exists())
        except Exception as e:
            logger.warning("Cloud cache existence check failed for %s: %s", blob_name, e)
            return False

    def download(self, *, subdir: str, filename: str) -> bytes | None:
        if not self.manages_subdir(subdir):
            return None
        blob_name = self._blob_name(subdir=subdir, filename=filename)
        try:
            return self._container_client.download_blob(blob_name).readall()
        except ResourceNotFoundError:
            return None
        except Exception as e:
            logger.warning("Cloud cache download failed for %s: %s", blob_name, e)
            return None

    def delete(self, *, subdir: str, filename: str) -> None:
        if not self.manages_subdir(subdir):
            return
        blob_name = self._blob_name(subdir=subdir, filename=filename)
        try:
            self._container_client.delete_blob(blob_name)
        except ResourceNotFoundError:
            return
        except Exception as e:
            logger.warning("Cloud cache delete failed for %s: %s", blob_name, e)

    def list_filenames(self, *, subdir: str) -> list[str]:
        if not self.manages_subdir(subdir):
            return []
        prefix = self._blob_name(subdir=subdir, filename="")
        if prefix and not prefix.endswith("/"):
            prefix = f"{prefix}/"
        try:
            files: list[str] = []
            for blob in self._container_client.list_blobs(name_starts_with=prefix):
                blob_name = str(getattr(blob, "name", ""))
                if not blob_name:
                    continue
                files.append(Path(blob_name).name)
            return sorted(set(files))
        except Exception as e:
            logger.warning("Cloud cache list failed for subdir %s: %s", subdir, e)
            return []


class CacheManager:
    def __init__(self):
        self.cache_dir = Path(get_config("paths.cache_dir", "cache/")).resolve()

        cache_cfg = get_config("cache", {})
        configured_subdirs = _as_list(cache_cfg.get("subdirs") if isinstance(cache_cfg, dict) else None)
        self._known_subdirs = set(DEFAULT_CACHE_SUBDIRS)
        self._known_subdirs.update(configured_subdirs)
        for subdir in sorted(self._known_subdirs):
            (self.cache_dir / subdir).mkdir(parents=True, exist_ok=True)

        cloud_cfg = {}
        if isinstance(cache_cfg, dict) and isinstance(cache_cfg.get("cloud"), dict):
            cloud_cfg.update(cache_cfg["cloud"])
        top_level_cloud_cfg = get_config("cloud_cache", {})
        if isinstance(top_level_cloud_cfg, dict):
            cloud_cfg.update(top_level_cloud_cfg)
        self.cloud = AzureBlobCache(cloud_cfg)
        self.sync_current_extractions_on_startup = self.cloud.sync_current_extractions_on_startup
        # Default covers both backends so Docling (canonical) and
        # LLM-direct (deprecated fallback) extractions are cloud-managed
        # in parallel during the Docling-only migration window.
        # "extract_docling_" matches every schema version — v1 today,
        # future v2 via the version bump — so cloud coverage doesn't
        # need a config update when EXTRACTION_SCHEMA_VERSION changes.
        extraction_prefixes = (
            _env("AZURE_BLOB_CACHE_EXTRACTION_KEY_PREFIXES")
            or cloud_cfg.get("extraction_key_prefixes")
            or ["extract_docling_", "extract_llm_v1_"]
        )
        self._cloud_extraction_key_prefixes = (
            tuple(_as_list(extraction_prefixes))
            or ("extract_docling_", "extract_llm_v1_")
        )

    def _ensure_subdir(self, subdir: str) -> None:
        if subdir in self._known_subdirs:
            return
        (self.cache_dir / subdir).mkdir(parents=True, exist_ok=True)
        self._known_subdirs.add(subdir)

    def _filename_for_key(self, key: str) -> str:
        clean = "".join(c if c.isalnum() or c in "-_" else "_" for c in key)
        return f"{clean}.pkl"

    def _path(self, key: str, subdir: str = "extractions") -> Path:
        self._ensure_subdir(subdir)
        return self.cache_dir / subdir / self._filename_for_key(key)

    def local_keys(self, *, subdir: str = "extractions") -> list[str]:
        self._ensure_subdir(subdir)
        subdir_path = self.cache_dir / subdir
        keys: list[str] = []
        for path in sorted(subdir_path.glob("*.pkl")):
            if not path.is_file():
                continue
            keys.append(path.stem)
        return keys

    def _is_cloud_managed_key(self, key: str, subdir: str) -> bool:
        if not self.cloud.manages_subdir(subdir):
            return False
        if subdir != "extractions":
            return True
        return any(key.startswith(prefix) for prefix in self._cloud_extraction_key_prefixes)

    def _hydrate_from_cloud(self, key: str, subdir: str) -> bool:
        if not self._is_cloud_managed_key(key, subdir):
            return False

        path = self._path(key, subdir)
        payload = self.cloud.download(subdir=subdir, filename=path.name)
        if payload is None:
            return False

        try:
            # Validate downloaded bytes before writing to disk.
            pickle.loads(payload)
        except Exception:
            logger.warning("Cloud cache payload invalid for key %s (subdir=%s)", key, subdir)
            return False

        try:
            with open(path, "wb") as f:
                f.write(payload)
            return True
        except Exception as e:
            logger.error("Failed writing hydrated cache for %s: %s", key, e)
            return False

    def has(self, key: str, subdir: str = "extractions") -> bool:
        path = self._path(key, subdir)
        if path.exists():
            return True
        if self._is_cloud_managed_key(key, subdir):
            return self.cloud.exists(subdir=subdir, filename=path.name)
        return False

    def get(self, key: str, subdir: str = "extractions") -> Optional[Any]:
        p = self._path(key, subdir)

        if not p.exists():
            self._hydrate_from_cloud(key, subdir)

        if not p.exists():
            return None
        try:
            with open(p, "rb") as f:
                return pickle.load(f)
        except Exception:
            p.unlink(missing_ok=True)
            # Retry once by pulling from cloud in case local file was corrupted.
            if self._hydrate_from_cloud(key, subdir):
                try:
                    with open(p, "rb") as f:
                        return pickle.load(f)
                except Exception:
                    p.unlink(missing_ok=True)
            return None

    def set(self, key: str, value: Any, subdir: str = "extractions") -> None:
        path = self._path(key, subdir)
        try:
            with open(path, "wb") as f:
                pickle.dump(value, f)
        except Exception as e:
            logger.error("Cache write failed for %s: %s", key, e)
            return

        # Immediately mirror managed subdirs to cloud cache.
        if self._is_cloud_managed_key(key, subdir):
            try:
                payload = pickle.dumps(value)
            except Exception as e:
                logger.error("Cache serialization failed for cloud upload %s: %s", key, e)
                return
            self.cloud.upload(subdir=subdir, filename=path.name, data=payload, overwrite=True)

    def delete(self, key: str, subdir: str = "extractions") -> None:
        path = self._path(key, subdir)
        try:
            path.unlink(missing_ok=True)
        except Exception as e:
            logger.error("Cache delete failed for %s: %s", key, e)
        if self._is_cloud_managed_key(key, subdir):
            self.cloud.delete(subdir=subdir, filename=path.name)

    def sync_local_keys_to_cloud(
        self,
        keys: Iterable[str],
        *,
        subdir: str = "extractions",
        require_success: bool = True,
        overwrite_remote: bool = False,
    ) -> dict[str, Any]:
        unique_keys = list(dict.fromkeys(keys))
        stats = {
            "subdir": subdir,
            "keys_considered": len(unique_keys),
            "uploaded": 0,
            "already_remote": 0,
            "skipped_unmanaged_key": 0,
            "missing_local": 0,
            "invalid_local": 0,
            "skipped_not_success": 0,
            "failed": 0,
            "cloud_enabled": self.cloud.enabled,
            "managed_subdir": self.cloud.manages_subdir(subdir),
            "extraction_key_prefixes": list(self._cloud_extraction_key_prefixes),
        }

        if not self.cloud.manages_subdir(subdir):
            return stats

        for key in unique_keys:
            if not self._is_cloud_managed_key(key, subdir):
                stats["skipped_unmanaged_key"] += 1
                continue
            path = self._path(key, subdir)
            if not path.exists():
                stats["missing_local"] += 1
                continue
            try:
                payload = path.read_bytes()
                cached = pickle.loads(payload)
            except Exception:
                path.unlink(missing_ok=True)
                stats["invalid_local"] += 1
                continue

            if require_success and (not isinstance(cached, dict) or not cached.get("success")):
                stats["skipped_not_success"] += 1
                continue

            status = self.cloud.upload(
                subdir=subdir,
                filename=path.name,
                data=payload,
                overwrite=overwrite_remote,
            )
            if status == "uploaded":
                stats["uploaded"] += 1
            elif status == "exists":
                stats["already_remote"] += 1
            else:
                stats["failed"] += 1

        return stats

    def sync_cloud_subdir_to_local(
        self,
        *,
        subdir: str = "extractions",
        overwrite_local: bool = False,
    ) -> dict[str, Any]:
        stats = {
            "subdir": subdir,
            "downloaded": 0,
            "already_local": 0,
            "failed": 0,
            "cloud_enabled": self.cloud.enabled,
            "managed_subdir": self.cloud.manages_subdir(subdir),
            "remote_count": 0,
        }

        if not self.cloud.manages_subdir(subdir):
            return stats

        filenames = self.cloud.list_filenames(subdir=subdir)
        stats["remote_count"] = len(filenames)
        self._ensure_subdir(subdir)
        subdir_path = self.cache_dir / subdir

        for filename in filenames:
            local_path = subdir_path / filename
            if local_path.exists() and not overwrite_local:
                stats["already_local"] += 1
                continue
            payload = self.cloud.download(subdir=subdir, filename=filename)
            if payload is None:
                stats["failed"] += 1
                continue
            try:
                pickle.loads(payload)
                local_path.write_bytes(payload)
                stats["downloaded"] += 1
            except Exception:
                stats["failed"] += 1

        return stats
