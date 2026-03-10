#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "click>=8.0.0",
#     "jupyter-client>=8.0.0",
#     "ipykernel>=6.0.0",
#     "pyyaml>=6.0",
#     "python-dotenv>=1.0.0",
#     "cryptography>=41.0.0",
# ]
# ///
"""CLI for the analyzing-data skill.

Usage:
    uv run scripts/cli.py start    # Start kernel with Snowflake
    uv run scripts/cli.py exec "df = run_sql('SELECT ...')"
    uv run scripts/cli.py status   # Check kernel status
    uv run scripts/cli.py stop     # Stop kernel
"""

import json
import shutil
import sys

import click

# Add parent directory to path for lib imports
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from kernel import KernelManager
from warehouse import WarehouseConfig
import cache


def check_uv_installed():
    """Check if uv is installed and provide helpful error if not."""
    if not shutil.which("uv"):
        click.echo("Error: uv is not installed.", err=True)
        click.echo(
            "Install with: curl -LsSf https://astral.sh/uv/install.sh | sh", err=True
        )
        sys.exit(1)


@click.group()
@click.version_option(version="0.1.0")
def main():
    """Jupyter kernel CLI for data analysis with Snowflake."""
    pass


@main.group()
def warehouse():
    """Manage warehouse connections."""


@warehouse.command("list")
def warehouse_list():
    """List available warehouse connections."""
    try:
        config = WarehouseConfig.load()
        if not config.connectors:
            click.echo("No warehouses configured")
            return

        default_name, _ = config.get_default()
        for name, conn in config.connectors.items():
            marker = " (default)" if name == default_name else ""
            click.echo(f"{name}: {conn.connector_type()}{marker}")
    except FileNotFoundError:
        click.echo("No warehouse config found at ~/.astro/agents/warehouse.yml")
    except Exception as e:
        click.echo(f"Error: {e}", err=True)


@main.command()
@click.option("--warehouse", "-w", help="Warehouse name from config")
def start(warehouse: str | None):
    """Start kernel with Snowflake connection."""
    check_uv_installed()
    km = KernelManager()

    if km.is_running:
        click.echo("Kernel already running")
        return

    try:
        config = WarehouseConfig.load()
        wh_name, wh_config = (
            (warehouse, config.connectors[warehouse])
            if warehouse
            else config.get_default()
        )
        click.echo(f"Using warehouse: {wh_name}")
    except FileNotFoundError as e:
        click.echo(f"Error: {e}", err=True)
        click.echo(
            "Create ~/.astro/agents/warehouse.yml with your Snowflake credentials",
            err=True,
        )
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)

    env_vars = wh_config.get_env_vars_for_kernel()
    extra_packages = wh_config.get_required_packages()

    km.start(env_vars=env_vars, extra_packages=extra_packages)

    result = km.execute(wh_config.to_python_prelude(), timeout=60.0)
    if not result.success:
        click.echo(f"Connection error:\n{result.error}", err=True)
        km.stop()
        sys.exit(1)
    click.echo(result.output)


@main.command("exec")
@click.argument("code")
@click.option("--timeout", "-t", default=30.0, help="Timeout in seconds")
def execute(code: str, timeout: float):
    """Execute Python code in the kernel. Auto-starts kernel if not running."""
    km = KernelManager()

    if not km.is_running:
        check_uv_installed()
        try:
            config = WarehouseConfig.load()
            wh_name, wh_config = config.get_default()
            click.echo(f"Starting kernel with: {wh_name}", err=True)
            env_vars = wh_config.get_env_vars_for_kernel()
            extra_packages = wh_config.get_required_packages()
            km.start(env_vars=env_vars, extra_packages=extra_packages)
            result = km.execute(wh_config.to_python_prelude(), timeout=60.0)
            if result.output:
                click.echo(result.output, err=True)
            if not result.success:
                click.echo(f"Connection error:\n{result.error}", err=True)
                km.stop()
                sys.exit(1)
        except Exception as e:
            click.echo(f"Error starting kernel: {e}", err=True)
            sys.exit(1)

    result = km.execute(code, timeout=timeout)
    if result.output:
        click.echo(result.output, nl=False)
    if result.error:
        click.echo(result.error, err=True)
        sys.exit(1)


@main.command()
def stop():
    """Stop the kernel."""
    KernelManager().stop()


@main.command()
def restart():
    """Restart the kernel (stop + start)."""
    km = KernelManager()
    km.stop()

    try:
        config = WarehouseConfig.load()
        wh_name, wh_config = config.get_default()
        click.echo(f"Restarting kernel with: {wh_name}")
        env_vars = wh_config.get_env_vars_for_kernel()
        extra_packages = wh_config.get_required_packages()
        km.start(env_vars=env_vars, extra_packages=extra_packages)
        result = km.execute(wh_config.to_python_prelude(), timeout=60.0)
        if result.output:
            click.echo(result.output)
        if not result.success:
            click.echo(f"Connection error:\n{result.error}", err=True)
            sys.exit(1)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


@main.command()
@click.option("--json", "as_json", is_flag=True)
def status(as_json: bool):
    """Check kernel status."""
    info = KernelManager().status()
    if as_json:
        click.echo(json.dumps(info, indent=2))
    else:
        if info["running"]:
            click.echo(
                f"Kernel: {'running' if info['responsive'] else 'running (unresponsive)'}"
            )
        else:
            click.echo("Kernel: not running")


@main.command("install")
@click.argument("packages", nargs=-1, required=True)
def install_packages(packages: tuple):
    """Install additional packages into the kernel environment.

    Example: uv run scripts/cli.py install plotly scipy
    """
    km = KernelManager()
    success, message = km.install_packages(list(packages))
    if success:
        click.echo(message)
    else:
        click.echo(f"Error: {message}", err=True)
        sys.exit(1)


@main.command()
def ensure():
    """Ensure kernel is running (start if needed). Used by hooks."""
    check_uv_installed()
    km = KernelManager()
    if km.is_running:
        return

    try:
        config = WarehouseConfig.load()
        wh_name, wh_config = config.get_default()
        click.echo(f"Starting kernel with: {wh_name}", err=True)
        env_vars = wh_config.get_env_vars_for_kernel()
        extra_packages = wh_config.get_required_packages()
        km.start(env_vars=env_vars, extra_packages=extra_packages)
        result = km.execute(wh_config.to_python_prelude(), timeout=60.0)
        if result.output:
            click.echo(result.output, err=True)
    except Exception as e:
        click.echo(f"Warning: {e}", err=True)
        km.start()


@main.group()
def concept():
    """Manage concept cache (concept -> table mappings)."""
    pass


@concept.command("lookup")
@click.argument("name")
def concept_lookup(name: str):
    """Look up a concept to find its table."""
    result = cache.lookup_concept(name)
    if result:
        click.echo(json.dumps(result, indent=2))
    else:
        click.echo(f"Concept '{name}' not found")


@concept.command("learn")
@click.argument("name")
@click.argument("table")
@click.option("--key-column", "-k", help="Primary key column")
@click.option("--date-column", "-d", help="Date column for filtering")
def concept_learn(name: str, table: str, key_column: str, date_column: str):
    """Store a concept -> table mapping."""
    cache.learn_concept(name, table, key_column, date_column)
    click.echo(f"Learned: '{name}' -> {table}")


@concept.command("list")
def concept_list():
    """List all learned concepts."""
    concepts = cache.list_concepts()
    if concepts:
        click.echo(json.dumps(concepts, indent=2))
    else:
        click.echo("No concepts cached yet")


@main.group()
def pattern():
    """Manage pattern cache (query strategies)."""
    pass


@pattern.command("lookup")
@click.argument("question")
def pattern_lookup(question: str):
    """Find patterns matching a question."""
    matches = cache.lookup_pattern(question)
    if matches:
        click.echo(json.dumps(matches, indent=2))
    else:
        click.echo("No matching patterns found")


@pattern.command("learn")
@click.argument("name")
@click.option(
    "--question-types",
    "-q",
    multiple=True,
    required=True,
    help="Question types this pattern handles",
)
@click.option("--strategy", "-s", multiple=True, required=True, help="Strategy steps")
@click.option("--tables", "-t", multiple=True, required=True, help="Tables used")
@click.option("--gotchas", "-g", multiple=True, help="Gotchas/warnings")
@click.option("--example", "-e", help="Example SQL query")
def pattern_learn(
    name: str,
    question_types: tuple,
    strategy: tuple,
    tables: tuple,
    gotchas: tuple,
    example: str,
):
    """Store a query pattern/strategy."""
    cache.learn_pattern(
        name=name,
        question_types=list(question_types),
        strategy=list(strategy),
        tables_used=list(tables),
        gotchas=list(gotchas),
        example_query=example,
    )
    click.echo(f"Learned pattern: '{name}'")


@pattern.command("record")
@click.argument("name")
@click.option("--success/--failure", default=True, help="Record success or failure")
def pattern_record(name: str, success: bool):
    """Record pattern outcome (success/failure)."""
    result = cache.record_pattern_outcome(name, success)
    if result:
        click.echo(f"Recorded {'success' if success else 'failure'} for '{name}'")
    else:
        click.echo(f"Pattern '{name}' not found")


@pattern.command("list")
def pattern_list():
    """List all learned patterns."""
    patterns = cache.list_patterns()
    if patterns:
        click.echo(json.dumps(patterns, indent=2))
    else:
        click.echo("No patterns cached yet")


@pattern.command("delete")
@click.argument("name")
def pattern_delete(name: str):
    """Delete a pattern by name."""
    if cache.delete_pattern(name):
        click.echo(f"Deleted pattern: '{name}'")
    else:
        click.echo(f"Pattern '{name}' not found")


# --- Cache Management ---


@main.group("cache")
def cache_group():
    """Manage cache (status, clear)."""
    pass


@cache_group.command("status")
def cache_status():
    """Show cache statistics."""
    stats = cache.cache_stats()
    click.echo(json.dumps(stats, indent=2))


@cache_group.command("clear")
@click.option(
    "--type",
    "cache_type",
    type=click.Choice(["all", "concepts", "patterns"]),
    default="all",
    help="What to clear",
)
@click.option("--stale-only", is_flag=True, help="Only clear entries older than TTL")
@click.confirmation_option(prompt="Are you sure you want to clear the cache?")
def cache_clear(cache_type: str, stale_only: bool):
    """Clear cache entries."""
    result = cache.clear_cache(cache_type, purge_stale_only=stale_only)
    click.echo(
        f"Cleared {result['concepts_cleared']} concepts, "
        f"{result['patterns_cleared']} patterns"
    )


# --- Table Schema Cache ---


@main.group()
def table():
    """Manage table schema cache."""
    pass


@table.command("lookup")
@click.argument("full_name")
def table_lookup(full_name: str):
    """Look up a cached table schema (DATABASE.SCHEMA.TABLE)."""
    result = cache.get_table(full_name)
    if result:
        click.echo(json.dumps(result, indent=2))
    else:
        click.echo(f"Table '{full_name}' not in cache")


@table.command("cache")
@click.argument("full_name")
@click.option("--columns", "-c", help="JSON array of column definitions")
@click.option("--row-count", "-r", type=int, help="Row count")
@click.option("--comment", help="Table description")
def table_cache(full_name: str, columns: str, row_count: int, comment: str):
    """Cache a table's schema.

    Example: uv run scripts/cli.py table cache DB.SCHEMA.TABLE -c '[{"name":"id","type":"INT"}]'
    """
    if columns:
        cols = json.loads(columns)
    else:
        cols = []
    cache.set_table(full_name, cols, row_count, comment)
    click.echo(f"Cached table: '{full_name}'")


@table.command("list")
def table_list():
    """List all cached table schemas."""
    tables = cache.list_tables()
    if tables:
        # Show summary (name + column count + cached_at)
        for name, info in tables.items():
            col_count = len(info.get("columns", []))
            cached_at = info.get("cached_at", "unknown")[:10]
            click.echo(f"{name}: {col_count} columns (cached {cached_at})")
    else:
        click.echo("No tables cached yet")


@table.command("delete")
@click.argument("full_name")
def table_delete(full_name: str):
    """Remove a table from cache."""
    if cache.delete_table(full_name):
        click.echo(f"Deleted table: '{full_name}'")
    else:
        click.echo(f"Table '{full_name}' not found")


# --- Bulk Import ---


@concept.command("import")
@click.option("--path", "-p", type=click.Path(exists=True), help="Path to warehouse.md")
def concept_import(path: str):
    """Import concepts from warehouse.md Quick Reference table.

    Parses markdown tables with: | Concept | Table | Key Column | Date Column |
    """
    from pathlib import Path as P

    file_path = P(path) if path else None
    count = cache.load_concepts_from_warehouse_md(file_path)
    if count > 0:
        click.echo(f"Imported {count} concepts from warehouse.md")
    else:
        click.echo("No concepts found in warehouse.md")


if __name__ == "__main__":
    main()
