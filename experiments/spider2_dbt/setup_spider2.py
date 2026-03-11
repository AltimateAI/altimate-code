"""One-time setup: clone Spider2 repo, download DuckDB databases, verify deps.

Usage:
    python setup_spider2.py [--force]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from config import (
    ALTIMATE_CODE_BIN,
    BASE_DIR,
    DUCKDB_ZIP_DOWNLOADS,
    EXAMPLES_DIR,
    INCREMENTAL_DIR,
    REPORTS_DIR,
    RESULTS_DIR,
    SPIDER2_COMMIT,
    SPIDER2_DBT_DIR,
    SPIDER2_REPO_DIR,
    SPIDER2_REPO_URL,
    TASK_JSONL,
    WORKSPACE_DIR,
)


def run_cmd(cmd: list[str], cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    """Run a shell command with logging."""
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd, check=check, capture_output=False)


def clone_spider2(force: bool = False) -> None:
    """Sparse-clone Spider2 repo (only spider2-dbt/ directory)."""
    if SPIDER2_REPO_DIR.exists():
        if force:
            print(f"Removing existing repo at {SPIDER2_REPO_DIR}...")
            shutil.rmtree(SPIDER2_REPO_DIR)
        else:
            print(f"Spider2 repo already exists at {SPIDER2_REPO_DIR}. Use --force to re-clone.")
            return

    print("Cloning Spider2 repository (sparse, spider2-dbt/ only)...")
    SPIDER2_REPO_DIR.mkdir(parents=True, exist_ok=True)

    run_cmd(["git", "init"], cwd=str(SPIDER2_REPO_DIR))
    run_cmd(["git", "remote", "add", "origin", SPIDER2_REPO_URL], cwd=str(SPIDER2_REPO_DIR))
    run_cmd(["git", "config", "core.sparseCheckout", "true"], cwd=str(SPIDER2_REPO_DIR))

    sparse_file = SPIDER2_REPO_DIR / ".git" / "info" / "sparse-checkout"
    sparse_file.parent.mkdir(parents=True, exist_ok=True)
    sparse_file.write_text("spider2-dbt/\n")

    run_cmd(["git", "fetch", "--depth", "1", "origin", SPIDER2_COMMIT], cwd=str(SPIDER2_REPO_DIR))
    run_cmd(["git", "checkout", "FETCH_HEAD"], cwd=str(SPIDER2_REPO_DIR))

    if not SPIDER2_DBT_DIR.exists():
        print("ERROR: spider2-dbt/ directory not found after clone.")
        sys.exit(1)

    print(f"Spider2 repo cloned to {SPIDER2_REPO_DIR}")


def download_databases() -> None:
    """Download DuckDB database zips from Google Drive using gdown.

    Spider2 expects two zips in the spider2-dbt/ directory:
    - DBT_start_db.zip (example project databases)
    - dbt_gold.zip (gold standard evaluation databases)
    """
    # Check if zips already exist
    all_present = all(
        (SPIDER2_DBT_DIR / filename).exists()
        for _, filename in DUCKDB_ZIP_DOWNLOADS
    )
    if all_present:
        print("Database zips already present. Skipping download.")
        return

    print("Downloading DuckDB databases from Google Drive...")
    failed = []

    for gdrive_id, filename in DUCKDB_ZIP_DOWNLOADS:
        output = SPIDER2_DBT_DIR / filename
        if output.exists():
            print(f"  {filename} already exists, skipping.")
            continue

        url = f"https://drive.google.com/uc?id={gdrive_id}"
        result = run_cmd(["gdown", url, "-O", str(output)], check=False)
        if result.returncode != 0 or not output.exists():
            failed.append(filename)

    if failed:
        print("\nWARNING: Failed to download some files via gdown.")
        print("This often happens due to Google Drive rate limits.")
        print("Please download manually and place in:")
        print(f"  {SPIDER2_DBT_DIR}/")
        print()
        for _, filename in DUCKDB_ZIP_DOWNLOADS:
            if filename in failed:
                gdrive_id = next(gid for gid, fn in DUCKDB_ZIP_DOWNLOADS if fn == filename)
                print(f"  {filename}:")
                print(f"    https://drive.google.com/uc?id={gdrive_id}")
        print()
        print("Then re-run: python setup_spider2.py --skip-download")
        sys.exit(1)


def run_spider2_setup() -> None:
    """Run Spider2's own setup.py to extract databases into examples/ and gold/."""
    # Check if zips exist first
    for _, filename in DUCKDB_ZIP_DOWNLOADS:
        zip_path = SPIDER2_DBT_DIR / filename
        if not zip_path.exists():
            print(f"WARNING: {filename} not found, skipping Spider2 setup.")
            print("Run download step first or place files manually.")
            return

    setup_script = SPIDER2_DBT_DIR / "setup.py"
    if setup_script.exists():
        print("Running Spider2's setup.py to extract databases...")
        run_cmd([sys.executable, str(setup_script)], cwd=str(SPIDER2_DBT_DIR))
    else:
        print("No Spider2 setup.py found; skipping.")


def verify_dependencies() -> None:
    """Verify all required tools are available."""
    print("\nVerifying dependencies...")
    errors = []

    # Python packages
    for pkg_name, import_name in [("duckdb", "duckdb"), ("dbt-core", "dbt"), ("pandas", "pandas")]:
        try:
            __import__(import_name)
            print(f"  {pkg_name}: OK")
        except ImportError:
            errors.append(f"  Missing Python package: {pkg_name} (pip install {pkg_name})")

    # dbt-duckdb adapter
    try:
        result = subprocess.run(
            ["dbt", "--version"], capture_output=True, text=True, check=False
        )
        if result.returncode == 0:
            version_lines = result.stdout.strip().splitlines()
            for line in version_lines:
                if "duckdb" in line.lower():
                    print(f"  dbt-duckdb: {line.strip()}")
                    break
            else:
                print("  Warning: dbt-duckdb adapter may not be installed.")
        else:
            errors.append("  dbt CLI returned error")
    except FileNotFoundError:
        errors.append("  dbt CLI not found (pip install dbt-core dbt-duckdb)")

    # altimate-code
    result = subprocess.run(
        [ALTIMATE_CODE_BIN, "--version"], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        errors.append(f"  altimate-code CLI not found at: {ALTIMATE_CODE_BIN}")
    else:
        print(f"  altimate-code: {result.stdout.strip()}")

    # Task file
    task_jsonl = SPIDER2_DBT_DIR / "examples" / "spider2-dbt.jsonl"
    if not task_jsonl.exists():
        # Try alternative name
        task_jsonl = TASK_JSONL
    if not task_jsonl.exists():
        errors.append(f"  Task file not found: {task_jsonl}")
    else:
        import json
        tasks = [json.loads(line) for line in task_jsonl.read_text().strip().splitlines()]
        print(f"  Tasks found: {len(tasks)}")

    # Examples directory
    if not EXAMPLES_DIR.exists():
        errors.append(f"  Examples directory not found: {EXAMPLES_DIR}")
    else:
        examples = [d for d in EXAMPLES_DIR.iterdir() if d.is_dir()]
        print(f"  Example projects: {len(examples)}")

    # Check for DuckDB files in examples (indicates setup.py ran)
    duckdb_count = sum(1 for _ in EXAMPLES_DIR.rglob("*.duckdb")) if EXAMPLES_DIR.exists() else 0
    print(f"  DuckDB files in examples: {duckdb_count}")
    if duckdb_count == 0:
        print("  Warning: No .duckdb files found — databases may not be extracted yet.")

    if errors:
        print("\nERRORS:")
        for err in errors:
            print(err)
        sys.exit(1)

    print("\nAll dependencies verified.")


def create_directories() -> None:
    """Create workspace and results directories."""
    for d in [WORKSPACE_DIR, RESULTS_DIR, INCREMENTAL_DIR, REPORTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)
    print("Directories created.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Set up Spider 2.0-DBT benchmark environment")
    parser.add_argument("--force", action="store_true", help="Force re-clone of Spider2 repo")
    parser.add_argument("--skip-download", action="store_true", help="Skip database download")
    args = parser.parse_args()

    print("=" * 60)
    print("Spider 2.0-DBT Benchmark Setup")
    print("=" * 60)

    clone_spider2(force=args.force)

    if not args.skip_download:
        download_databases()

    run_spider2_setup()
    create_directories()
    verify_dependencies()

    print("\n" + "=" * 60)
    print("Setup complete! Next steps:")
    print("  python run_benchmark.py              # Run benchmark")
    print("  python run_benchmark.py --tasks 5    # Smoke test (first 5)")
    print("=" * 60)


if __name__ == "__main__":
    main()
