from pathlib import Path
from typing import Any, Optional

import yaml

_config: Optional[dict] = None


def load_config(config_path: str) -> dict:
    """Load configuration from YAML file."""
    global _config
    path = Path(config_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Config not found: {path}")

    with open(path) as f:
        _config = yaml.safe_load(f)

    if "paths" in _config:
        base = path.parent
        for key, value in _config["paths"].items():
            if isinstance(value, str) and not Path(value).is_absolute():
                _config["paths"][key] = str(base / value)

    return _config


def get_config(key: Optional[str] = None, default: Any = None) -> Any:
    """Get config value by dot-notation key (e.g., 'paths.cache_dir')."""
    if _config is None:
        return default
    if key is None:
        return _config

    current = _config
    for k in key.split("."):
        if isinstance(current, dict) and k in current:
            current = current[k]
        else:
            return default
    return current
