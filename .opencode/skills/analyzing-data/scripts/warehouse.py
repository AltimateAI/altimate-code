"""Warehouse configuration and database connection management."""

from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv

from config import get_config_dir
from connectors import DatabaseConnector, create_connector


def get_warehouse_config_path() -> Path:
    return get_config_dir() / "warehouse.yml"


def _load_env_file() -> None:
    env_path = get_config_dir() / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    if Path(".env").exists():
        load_dotenv(".env", override=True)


@dataclass
class WarehouseConfig:
    connectors: dict[str, DatabaseConnector] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None) -> "WarehouseConfig":
        _load_env_file()
        if path is None:
            path = get_warehouse_config_path()
        if not path.exists():
            raise FileNotFoundError(f"Config not found: {path}")
        with open(path) as f:
            data = yaml.safe_load(f)
        if not data:
            raise ValueError(f"No configs in {path}")

        connectors: dict[str, DatabaseConnector] = {}
        for name, config in data.items():
            conn = create_connector(config)
            conn.validate(name)
            connectors[name] = conn

        return cls(connectors=connectors)

    def get_default(self) -> tuple[str, DatabaseConnector]:
        if not self.connectors:
            raise ValueError("No warehouse configs")
        name = next(iter(self.connectors))
        return name, self.connectors[name]
