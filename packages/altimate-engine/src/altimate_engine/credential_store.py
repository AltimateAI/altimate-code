from __future__ import annotations

from typing import Any

SERVICE_NAME = "altimate-code"

SENSITIVE_FIELDS = {
    "password",
    "private_key_passphrase",
    "access_token",
    "ssh_password",
    "connection_string",
}

_keyring_cache: bool | None = None


def _keyring_available() -> bool:
    global _keyring_cache
    if _keyring_cache is not None:
        return _keyring_cache
    try:
        import keyring
        _keyring_cache = True
    except ImportError:
        _keyring_cache = False
    return _keyring_cache


def store_credential(name: str, field: str, value: str) -> bool:
    if not _keyring_available():
        return False
    import keyring
    try:
        keyring.set_password(SERVICE_NAME, f"{name}/{field}", value)
        return True
    except Exception:
        return False


def get_credential(name: str, field: str) -> str | None:
    if not _keyring_available():
        return None
    import keyring
    try:
        return keyring.get_password(SERVICE_NAME, f"{name}/{field}")
    except Exception:
        return None


def delete_all_credentials(name: str) -> None:
    if not _keyring_available():
        return
    import keyring
    for field in SENSITIVE_FIELDS:
        try:
            keyring.delete_password(SERVICE_NAME, f"{name}/{field}")
        except Exception:
            pass


def resolve_config(name: str, config: dict[str, Any]) -> dict[str, Any]:
    resolved = dict(config)
    for field in SENSITIVE_FIELDS:
        if resolved.get(field) is None:
            cred = get_credential(name, field)
            if cred is not None:
                resolved[field] = cred
    return resolved


def save_connection(name: str, config: dict[str, Any], config_path: str | None = None) -> dict[str, Any]:
    from pathlib import Path
    import json

    if config_path is None:
        config_path = str(Path.home() / ".altimate-code" / "connections.json")

    path = Path(config_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    existing = {}
    if path.exists():
        with open(path) as f:
            existing = json.load(f)

    safe_config = {k: v for k, v in config.items() if k not in SENSITIVE_FIELDS}
    for field in SENSITIVE_FIELDS:
        if field in config and config[field] is not None:
            store_credential(name, field, str(config[field]))
            safe_config[field] = None

    existing[name] = safe_config
    with open(path, "w") as f:
        json.dump(existing, f, indent=2)

    return safe_config


def remove_connection(name: str, config_path: str | None = None) -> bool:
    from pathlib import Path
    import json

    if config_path is None:
        config_path = str(Path.home() / ".altimate-code" / "connections.json")

    path = Path(config_path)
    if not path.exists():
        return False

    with open(path) as f:
        existing = json.load(f)

    if name not in existing:
        return False

    del existing[name]
    delete_all_credentials(name)

    with open(path, "w") as f:
        json.dump(existing, f, indent=2)

    return True
