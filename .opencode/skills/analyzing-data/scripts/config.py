"""Configuration utilities for the analyzing-data skill."""

import sys
import warnings
from pathlib import Path

# Legacy path (deprecated)
_LEGACY_CONFIG_DIR = Path.home() / ".astro" / "ai" / "config"
# New path
_NEW_CONFIG_DIR = Path.home() / ".astro" / "agents"

_legacy_warning_shown = False


def _check_legacy_path() -> Path | None:
    """Check if legacy config path exists and warn user to migrate.

    Returns the legacy path if it exists and should be used, None otherwise.
    """
    global _legacy_warning_shown

    if _LEGACY_CONFIG_DIR.exists() and not _NEW_CONFIG_DIR.exists():
        if not _legacy_warning_shown:
            warnings.warn(
                f"Deprecated config path: {_LEGACY_CONFIG_DIR}\n"
                f"  Please move your config to: {_NEW_CONFIG_DIR}\n"
                f"  Run: mv ~/.astro/ai/config ~/.astro/agents",
                DeprecationWarning,
                stacklevel=3,
            )
            # Also print to stderr for CLI visibility
            print(
                "WARNING: Using deprecated config path ~/.astro/ai/config/\n"
                "  Please migrate: mv ~/.astro/ai/config ~/.astro/agents",
                file=sys.stderr,
            )
            _legacy_warning_shown = True
        return _LEGACY_CONFIG_DIR
    return None


def get_kernel_venv_dir() -> Path:
    """Get the path to the kernel virtual environment directory."""
    legacy = _check_legacy_path()
    if legacy:
        return legacy.parent / "kernel_venv"
    return _NEW_CONFIG_DIR / "kernel_venv"


def get_kernel_connection_file() -> Path:
    """Get the path to the kernel connection file."""
    legacy = _check_legacy_path()
    if legacy:
        return legacy.parent / "kernel.json"
    return _NEW_CONFIG_DIR / "kernel.json"


def get_config_dir() -> Path:
    """Get the path to the config directory."""
    legacy = _check_legacy_path()
    if legacy:
        return legacy
    return _NEW_CONFIG_DIR
