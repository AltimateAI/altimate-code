from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class Connector(ABC):
    @abstractmethod
    def connect(self) -> Any:
        pass

    @abstractmethod
    def execute(self, sql: str, params: tuple | list | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        pass

    @abstractmethod
    def list_schemas(self) -> list[str]:
        pass

    @abstractmethod
    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        pass

    @abstractmethod
    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        pass

    @abstractmethod
    def close(self) -> None:
        pass

    def set_statement_timeout(self, timeout_ms: int) -> None:
        """Set a per-session statement timeout. Override in subclasses that support it.

        Args:
            timeout_ms: Maximum query execution time in milliseconds.
        """
        pass

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
