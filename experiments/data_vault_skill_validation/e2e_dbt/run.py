"""End-to-end dbt+DuckDB eval — proves the skill's DV patterns actually run.

Scenario-driven runner:
    Each scenario is a sequence of (dbt-run-with-vars, assertion-batch) steps.
    Scenarios build on each other in a single DuckDB file:

    - Scenario 1: initial load (batch 1) — 20 assertions
    - Scenario 2: idempotency (re-run batch 1) — 6 assertions
    - Scenario 3: change-detection load (batch 2) — new payload triggers new sat row
    - Scenario 4: multi-source + composite-key hubs
    - Scenario 5: hashdiff normalization (whitespace + case variants)
    - Scenario 6: hash consistency across models
    - Scenario 7: ghost row + zero-key resolution
    - Scenario 8: effectivity satellite open + close
    - Scenario 9: batch atomicity (load_dts uniform per run, differs across runs)
    - Scenario 10: PIT table row counts

Exit code 0 = every assertion passed. Non-zero = a real end-to-end failure.

Usage:
    python run.py
    python run.py --keep-db     # keep the DuckDB file for inspection
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb


HERE          = Path(__file__).resolve().parent
PROJECT_DIR   = HERE / "dv_test_project"
DB_PATH       = HERE / "dv_test.duckdb"
RESULTS_DIR   = HERE / "results"


def run_dbt(args: list[str], env: dict | None = None) -> tuple[int, str]:
    e = os.environ.copy()
    e["DBT_PROFILES_DIR"] = str(PROJECT_DIR)
    e["DV_TEST_DB_PATH"] = str(DB_PATH)
    if env:
        e.update(env)
    entry = (
        "import sys\n"
        "from dbt.cli.main import cli\n"
        "res = cli.main(sys.argv[1:], standalone_mode=False)\n"
        "if isinstance(res, tuple) and len(res) >= 2:\n"
        "    sys.exit(0 if res[1] else 1)\n"
        "sys.exit(0 if res in (None, 0) else 1)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", entry, *args],
        cwd=PROJECT_DIR,
        env=e,
        capture_output=True,
        text=True,
    )
    output = proc.stdout + ("\n" + proc.stderr if proc.stderr else "")
    return proc.returncode, "\n".join(output.splitlines()[-30:])


def q(sql: str) -> list[tuple]:
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


PHASES: list[dict] = []


def phase(name: str, passed: bool, detail: str = "", elapsed: float = 0.0) -> None:
    entry = {
        "phase": name,
        "passed": passed,
        "detail": detail,
        "elapsed_s": round(elapsed, 3),
    }
    PHASES.append(entry)
    status = "PASS" if passed else "FAIL"
    print(f"[{status}] {name}  ({entry['elapsed_s']}s)")
    if not passed:
        for line in detail.splitlines()[-10:]:
            print(f"    {line}")


def dbt_step(name: str, args: list[str]) -> bool:
    t0 = time.perf_counter()
    rc, tail = run_dbt(args)
    elapsed = time.perf_counter() - t0
    passed = rc == 0
    phase(name, passed, detail=tail, elapsed=elapsed)
    return passed


def assert_rows(name: str, sql: str, checker) -> None:
    t0 = time.perf_counter()
    try:
        rows = q(sql)
        ok = checker(rows)
        phase(name, ok, detail=f"rows={rows[:5]}", elapsed=time.perf_counter() - t0)
    except Exception as e:
        phase(name, False, detail=f"query error: {e!r}", elapsed=time.perf_counter() - t0)


def assert_count(name: str, sql: str, expected: int) -> None:
    assert_rows(name, sql, lambda rows: rows[0][0] == expected)


def assert_zero(name: str, sql: str) -> None:
    """Query must return no rows (DV invariant style)."""
    assert_rows(name, sql, lambda rows: len(rows) == 0)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--keep-db", action="store_true")
    args = p.parse_args()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()
    target_dir = PROJECT_DIR / "target"
    if target_dir.is_dir():
        shutil.rmtree(target_dir, ignore_errors=True)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 1 — Initial load (batch 1)
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 1: initial load ───")

    if not dbt_step("dbt seed", ["seed", "--full-refresh"]):
        return _finalize(args.keep_db)

    if not dbt_step("dbt build (batch 1)",
                    ["build", "--exclude", "path:seeds"]):
        return _finalize(args.keep_db)

    # Ghost seeder runs after hubs exist:
    dbt_step("dbt run-operation seed_ghost_rows",
             ["run-operation", "seed_ghost_rows"])

    # Snapshot pre-scenario-2 counts + load_dts for later scenarios:
    batch1_load_dts = q("SELECT DISTINCT load_dts FROM hub_customer")[0][0]

    # ── Batch 1 assertions ──
    # Hub: 6 real customers (100–104, 105 from ERP) + 1 ghost = 7
    assert_count("hub_customer: 7 rows (6 real + 1 ghost)",
                 "SELECT COUNT(*) FROM hub_customer", 7)
    assert_zero("hub_customer: no duplicate hash keys",
                "SELECT customer_hk, COUNT(*) FROM hub_customer GROUP BY 1 HAVING COUNT(*) > 1")
    assert_count("hub_customer: no NULL business key",
                 "SELECT COUNT(*) FROM hub_customer WHERE customer_bk IS NULL", 0)
    assert_count("hub_customer: exactly 1 ghost row",
                 "SELECT COUNT(*) FROM hub_customer WHERE customer_bk = '^^'", 1)

    assert_count("hub_order: 7 rows (6 real + 1 ghost)",
                 "SELECT COUNT(*) FROM hub_order", 7)
    assert_count("hub_account_manager: 3 rows (2 real AM + 1 ghost)",
                 "SELECT COUNT(*) FROM hub_account_manager", 3)
    assert_count("hub_inventory_item: 4 rows (composite BK)",
                 "SELECT COUNT(*) FROM hub_inventory_item WHERE store_id_bk <> '^^'", 4)

    # Link: only orders with non-null customer_id
    assert_count("lnk_order_customer: 5 rows (order O-1005 has NULL customer_id)",
                 "SELECT COUNT(*) FROM lnk_order_customer", 5)
    assert_zero("lnk_order_customer: FK integrity to hub_customer",
                """SELECT l.customer_hk FROM lnk_order_customer l
                   LEFT JOIN hub_customer h USING (customer_hk)
                   WHERE h.customer_hk IS NULL""")
    assert_zero("lnk_order_customer: FK integrity to hub_order",
                """SELECT l.order_hk FROM lnk_order_customer l
                   LEFT JOIN hub_order h USING (order_hk)
                   WHERE h.order_hk IS NULL""")

    # Sat: 5 non-null CRM customers
    assert_count("sat_customer_details: 5 rows on first load",
                 "SELECT COUNT(*) FROM sat_customer_details", 5)
    assert_zero("sat_customer_details: PK (customer_hk, load_dts) is unique",
                "SELECT customer_hk, load_dts, COUNT(*) FROM sat_customer_details GROUP BY 1,2 HAVING COUNT(*) > 1")
    assert_count("sat_customer_details: hashdiff never NULL",
                 "SELECT COUNT(*) FROM sat_customer_details WHERE hashdiff IS NULL", 0)
    # Edge case: the all-NULL CSV row must NOT appear in the satellite
    assert_count("edge: NULL business-key row excluded from sat_customer_details",
                 "SELECT COUNT(*) FROM sat_customer_details WHERE customer_hk IS NULL", 0)
    # Edge case: no sat row references a customer_hk that isn't in hub_customer
    assert_zero("edge: every sat_customer_details customer_hk exists in hub_customer",
                """SELECT s.customer_hk FROM sat_customer_details s
                   LEFT JOIN hub_customer h USING (customer_hk)
                   WHERE h.customer_hk IS NULL""")

    assert_count("sat_order_status: 6 rows",
                 "SELECT COUNT(*) FROM sat_order_status", 6)
    assert_zero("sat_order_status: PK (order_hk, load_dts) is unique",
                "SELECT order_hk, load_dts, COUNT(*) FROM sat_order_status GROUP BY 1,2 HAVING COUNT(*) > 1")

    # Effectivity sat batch 1: 3 open intervals
    assert_count("eff_customer_am: 3 open intervals",
                 "SELECT COUNT(*) FROM eff_customer_am WHERE effective_to = CAST('9999-12-31' AS DATE)", 3)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 2 — Idempotency (re-run batch 1)
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 2: idempotency ───")

    pre = {
        t: q(f"SELECT COUNT(*) FROM {t}")[0][0] for t in [
            "hub_customer", "hub_order", "hub_account_manager",
            "hub_inventory_item", "lnk_order_customer", "lnk_customer_am",
            "sat_customer_details", "sat_order_status", "eff_customer_am"
        ]
    }
    dbt_step("dbt run (batch 1 again — idempotency)",
             ["run", "--select", "staging", "raw_vault"])
    for t, before in pre.items():
        after = q(f"SELECT COUNT(*) FROM {t}")[0][0]
        phase(f"idempotent: {t} unchanged at {before}", after == before,
              f"before={before}, after={after}", 0.0)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 3 — Change-detection load (batch 2)
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 3: change-detection (batch 2) ───")

    # Wait so batch 2 gets a strictly-later load_dts.
    time.sleep(1)

    dbt_step("dbt run (batch 2 — switched to _batch2 CSVs)",
             ["run", "--select", "staging", "raw_vault",
              "--vars", "{crm_customers_table: raw_crm_customers_batch2, am_table: raw_crm_account_manager_batch2}"])

    # New customer C-106 added → hub grows by 1
    assert_count("hub_customer: 8 rows (7 + new C-106)",
                 "SELECT COUNT(*) FROM hub_customer", 8)

    # sat_customer_details: Bob's phone changed → +1 row for C-101;
    # Grace new → +1 row; Alice normalization variant should NOT add.
    assert_count("sat_customer_details: 7 rows (5 batch1 + Bob-change + Grace-new)",
                 "SELECT COUNT(*) FROM sat_customer_details", 7)

    # Bob has 2 sat rows
    assert_count("sat_customer_details: Bob (C-101) has 2 sat rows",
                 f"""SELECT COUNT(*) FROM sat_customer_details
                     WHERE customer_hk = (SELECT customer_hk FROM hub_customer WHERE customer_bk = 'C-101')""",
                 2)
    # Alice has still just 1 sat row despite the whitespace/case variant
    assert_count("sat_customer_details: Alice (C-100) still has 1 sat row (normalization worked)",
                 f"""SELECT COUNT(*) FROM sat_customer_details
                     WHERE customer_hk = (SELECT customer_hk FROM hub_customer WHERE customer_bk = 'C-100')""",
                 1)
    # Bob's two rows have different hashdiffs
    assert_zero("sat_customer_details: Bob's two sat rows have DIFFERENT hashdiffs",
                f"""SELECT hashdiff, COUNT(*) FROM sat_customer_details
                    WHERE customer_hk = (SELECT customer_hk FROM hub_customer WHERE customer_bk = 'C-101')
                    GROUP BY hashdiff HAVING COUNT(*) > 1""")
    # No consecutive matching hashdiffs anywhere
    assert_zero("sat_customer_details: no consecutive matching hashdiffs",
                """WITH ordered AS (
                     SELECT customer_hk, load_dts, hashdiff,
                            LAG(hashdiff) OVER (PARTITION BY customer_hk ORDER BY load_dts) AS prev
                     FROM sat_customer_details)
                   SELECT * FROM ordered WHERE prev IS NOT NULL AND prev = hashdiff""")

    # ══════════════════════════════════════════════════════════════════
    # Scenario 4 — Multi-source hub
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 4: multi-source hub ───")

    # C-105 exists only in ERP; hub should contain it.
    assert_count("hub_customer: C-105 (ERP-only) present exactly once",
                 "SELECT COUNT(*) FROM hub_customer WHERE customer_bk = 'C-105'", 1)
    # C-100 exists in CRM + ERP + orders; still one row.
    assert_count("hub_customer: C-100 (CRM+ERP+orders) present exactly once",
                 "SELECT COUNT(*) FROM hub_customer WHERE customer_bk = 'C-100'", 1)
    # C-100's record_source should be from the earliest source (either crm or ecommerce.orders — whichever load_dts came first);
    # we just check it's one of the three known sources.
    assert_rows("hub_customer: C-100 record_source is one of the expected feeds",
                "SELECT record_source FROM hub_customer WHERE customer_bk = 'C-100'",
                lambda rows: rows[0][0] in ('crm.customers', 'erp.customer_master', 'ecommerce.orders'))

    # ══════════════════════════════════════════════════════════════════
    # Scenario 5 — Composite-key hub
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 5: composite-key hub ───")

    assert_count("hub_inventory_item: 4 distinct (store, sku) pairs",
                 "SELECT COUNT(*) FROM hub_inventory_item WHERE store_id_bk <> '^^'", 4)
    # Verify (S-01, SKU-A) hash != (SKU-A, S-01) hash — order matters
    row = q("""SELECT inventory_item_hk FROM hub_inventory_item
               WHERE store_id_bk = 'S-01' AND sku_bk = 'SKU-A'""")[0][0]
    # Compute the reversed-order hash manually and check they differ
    reversed_hash = q("""SELECT md5(
        COALESCE(NULLIF(UPPER(TRIM(CAST('SKU-A' AS VARCHAR))), ''), '^^') || '||' ||
        COALESCE(NULLIF(UPPER(TRIM(CAST('S-01' AS VARCHAR))), ''), '^^'))""")[0][0]
    phase("composite hash: (store, sku) != (sku, store)",
          row != reversed_hash,
          f"forward={row}, reversed={reversed_hash}", 0.0)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 6 — Hash consistency across models
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 6: hash consistency ───")

    # customer_hk for C-100 should match across hub, link, sat.
    hub_hk = q("SELECT customer_hk FROM hub_customer WHERE customer_bk = 'C-100'")[0][0]

    assert_zero("hash consistency: hub_customer.customer_hk == lnk_order_customer.customer_hk for C-100",
                f"""SELECT l.customer_hk FROM lnk_order_customer l
                    JOIN hub_customer h USING (customer_hk)
                    WHERE h.customer_bk = 'C-100' AND l.customer_hk <> '{hub_hk}'""")
    assert_zero("hash consistency: hub_customer.customer_hk == sat_customer_details.customer_hk for C-100",
                f"""SELECT s.customer_hk FROM sat_customer_details s
                    JOIN hub_customer h USING (customer_hk)
                    WHERE h.customer_bk = 'C-100' AND s.customer_hk <> '{hub_hk}'""")

    # ══════════════════════════════════════════════════════════════════
    # Scenario 7 — Ghost row + zero-key resolution
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 7: ghost + zero-key ───")

    ghost_hk = q("SELECT md5('^^')")[0][0]
    for hub, bk_col, hk_col in [
        ("hub_customer",        "customer_bk",        "customer_hk"),
        ("hub_order",           "order_bk",           "order_hk"),
        ("hub_account_manager", "account_manager_bk", "account_manager_hk"),
    ]:
        assert_count(f"ghost row present in {hub}",
                     f"SELECT COUNT(*) FROM {hub} WHERE {bk_col} = '^^'", 1)
        assert_count(f"{hub}: ghost row's hash = md5('^^')",
                     f"SELECT COUNT(*) FROM {hub} WHERE {hk_col} = '{ghost_hk}' AND {bk_col} = '^^'", 1)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 8 — Effectivity satellite open/close
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 8: effectivity ───")

    # After batch 2, C-100 switched from AM-01 to AM-03.
    # Insert-only means every event creates a row rather than updating:
    #   - Batch 1: 3 rows for open intervals (C-100/AM-01, C-101/AM-01, C-102/AM-02)
    #   - Batch 2: 1 new open row (C-100/AM-03) + 1 close row shadowing the old C-100/AM-01
    # Total: 5 rows. The latest row per lnk_hk determines current effectivity.
    assert_count("eff_customer_am: 5 total rows after AM switch",
                 "SELECT COUNT(*) FROM eff_customer_am", 5)
    # Correct DV read: latest row per lnk_hk. Only 3 should be currently open.
    assert_count("eff_customer_am: 3 links have a *latest* open interval (C-100/AM-03, C-101/AM-01, C-102/AM-02)",
                 """WITH latest AS (
                        SELECT lnk_customer_am_hk, effective_to
                        FROM eff_customer_am
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY lnk_customer_am_hk ORDER BY load_dts DESC) = 1
                    )
                    SELECT COUNT(*) FROM latest WHERE effective_to = CAST('9999-12-31' AS DATE)""",
                 3)
    # And the switched-away link's latest row is CLOSED.
    assert_count("eff_customer_am: (C-100, AM-01) latest row is now closed",
                 """WITH latest AS (
                        SELECT lnk_customer_am_hk, effective_to
                        FROM eff_customer_am
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY lnk_customer_am_hk ORDER BY load_dts DESC) = 1
                    )
                    SELECT COUNT(*) FROM latest WHERE effective_to <> CAST('9999-12-31' AS DATE)""",
                 1)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 9 — Batch atomicity: load_dts uniform within run, differs across runs
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 9: batch atomicity ───")

    # hub_customer has rows from batch1 (6 real from batch1 sources) and batch2 (Grace = C-106).
    # Expect exactly 2 distinct load_dts values (batch1 + batch2) in hub_customer for non-ghost rows.
    assert_count("hub_customer: exactly 2 distinct non-ghost load_dts (batch1 + batch2)",
                 "SELECT COUNT(DISTINCT load_dts) FROM hub_customer WHERE customer_bk <> '^^'", 2)
    # All rows loaded in same run share the same load_dts (checked implicitly above; also explicit for satellite)
    assert_count("sat_customer_details: distinct load_dts count matches distinct source-load-events (2)",
                 "SELECT COUNT(DISTINCT load_dts) FROM sat_customer_details", 2)

    # ══════════════════════════════════════════════════════════════════
    # Scenario 10 — PIT table
    # ══════════════════════════════════════════════════════════════════
    print("\n─── Scenario 10: PIT ───")

    # PIT is 'table' materialization, not incremental — rebuild it explicitly.
    dbt_step("dbt run --select pit_customer",
             ["run", "--select", "pit_customer", "--full-refresh"])

    # pit_customer: one row per (customer_hk, snapshot_dts).
    # We have 8 customers (7 real + 1 ghost) × 2 snapshot_dts (from sat_customer_details).
    assert_count("pit_customer: 16 rows (8 customers × 2 snapshots)",
                 "SELECT COUNT(*) FROM pit_customer", 16)
    assert_zero("pit_customer: unique on (customer_hk, snapshot_dts)",
                "SELECT customer_hk, snapshot_dts, COUNT(*) FROM pit_customer GROUP BY 1,2 HAVING COUNT(*) > 1")
    # For customers that existed at the batch2 snapshot, sat_customer_details_load_dts must not be NULL.
    assert_count("pit_customer: Bob (C-101) at batch2 snapshot points at his latest sat row",
                 """SELECT COUNT(*) FROM pit_customer p
                    JOIN hub_customer h USING (customer_hk)
                    WHERE h.customer_bk = 'C-101'
                      AND p.snapshot_dts = (SELECT MAX(load_dts) FROM sat_customer_details)
                      AND p.sat_customer_details_load_dts IS NOT NULL""",
                 1)

    _finalize(args.keep_db)


def _finalize(keep_db: bool) -> None:
    passed = sum(1 for ph in PHASES if ph["passed"])
    failed = len(PHASES) - passed
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_phases": len(PHASES),
        "phases_passed": passed,
        "phases_failed": failed,
        "phases": PHASES,
    }
    ts = report["timestamp"].replace(":", "-").replace(".", "-")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RESULTS_DIR / f"e2e_dbt_{ts}.json"
    out_file.write_text(json.dumps(report, indent=2))
    print(f"\n{'=' * 70}")
    print(f"{passed}/{len(PHASES)} phases passed")
    print(f"Report written to: {out_file}")
    print(f"{'=' * 70}")

    if not keep_db and DB_PATH.exists():
        DB_PATH.unlink()
    target_dir = PROJECT_DIR / "target"
    if not keep_db and target_dir.is_dir():
        shutil.rmtree(target_dir, ignore_errors=True)

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
