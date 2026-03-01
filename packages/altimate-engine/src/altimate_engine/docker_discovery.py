from __future__ import annotations

from typing import Any

# Only include DB types the engine has connectors for
IMAGE_MAP = {
    "postgres": {
        "type": "postgres",
        "port": 5432,
        "env_user": "POSTGRES_USER",
        "env_password": "POSTGRES_PASSWORD",
        "env_database": "POSTGRES_DB",
    },
    "mysql": {
        "type": "mysql",
        "port": 3306,
        "env_user": "MYSQL_USER",
        "env_password": "MYSQL_PASSWORD",
        "env_database": "MYSQL_DATABASE",
        "alt_password": "MYSQL_ROOT_PASSWORD",
    },
    "mariadb": {
        "type": "mysql",
        "port": 3306,
        "env_user": "MARIADB_USER",
        "env_password": "MARIADB_PASSWORD",
        "env_database": "MARIADB_DATABASE",
        "alt_password": "MARIADB_ROOT_PASSWORD",
    },
    "mcr.microsoft.com/mssql": {
        "type": "sqlserver",
        "port": 1433,
        "env_password": "SA_PASSWORD",
    },
}


def _match_image(image: str) -> dict[str, Any] | None:
    image_lower = image.lower()
    for pattern, config in IMAGE_MAP.items():
        if pattern in image_lower:
            return config
    return None


def _extract_port(container: Any, default_port: int) -> int | None:
    ports = container.attrs.get("NetworkSettings", {}).get("Ports", {})
    for port_key, mappings in ports.items():
        if mappings:
            host_port = mappings[0].get("HostPort")
            if host_port:
                return int(host_port)
    return None


def discover_containers() -> list[dict[str, Any]]:
    try:
        import docker
    except ImportError:
        return []

    try:
        client = docker.from_env()
    except Exception:
        return []

    results = []

    for container in client.containers.list():
        try:
            image_name = container.attrs.get("Config", {}).get("Image", "")
            image_config = _match_image(image_name)
            if not image_config:
                continue

            env_vars = {}
            for env in container.attrs.get("Config", {}).get("Env", []):
                if "=" in env:
                    key, value = env.split("=", 1)
                    env_vars[key] = value

            port = _extract_port(container, image_config["port"])
            if port is None:
                continue

            conn: dict[str, Any] = {
                "container_id": container.id[:12],
                "name": container.name,
                "image": image_name,
                "db_type": image_config["type"],
                "host": "localhost",
                "port": port,
                "status": container.status,
            }

            if "env_user" in image_config and image_config["env_user"] in env_vars:
                conn["user"] = env_vars[image_config["env_user"]]
            if (
                "env_password" in image_config
                and image_config["env_password"] in env_vars
            ):
                conn["password"] = env_vars[image_config["env_password"]]
            elif (
                "alt_password" in image_config
                and image_config["alt_password"] in env_vars
            ):
                conn["password"] = env_vars[image_config["alt_password"]]
            if (
                "env_database" in image_config
                and image_config["env_database"] in env_vars
            ):
                conn["database"] = env_vars[image_config["env_database"]]

            results.append(conn)
        except Exception:
            continue

    return results
