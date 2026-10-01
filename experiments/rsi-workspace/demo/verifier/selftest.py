#!/usr/bin/env python3
"""Self-test for the verifier: gold solutions must pass, naive/over-applied ones must fail.

usage: selftest.py [--all-naive]
Prepares workdirs under a temp dir via prepare_workdir.py (never touches project/).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.dirname(HERE)
TASKS = os.path.join(HERE, "tasks")

NAIVE = "select * from {{{{ source('{source}', '{table}') }}}}\n"
OVERAPPLIED = {
    # converts to dollars even though the ticket asks for cents
    "control-payments-by-month": (
        "analyses/payments_by_month.sql",
        "select cast(date_trunc('month', created) as date) as month, payment_method, count(*) as payments,\n"
        "       {{ cents_to_dollars('sum(amount_cents)') }} as total_cents\n"
        "from {{ source('billing', 'payments') }} group by 1, 2\n"),
    # applies the soft-delete filter that the customers source does not have
    "control-customers-vip": (
        "models/staging/shop/stg_shop__customers.sql",
        "select id as customer_id, first_name, last_name, email, country,\n"
        "  (select count(*) from {{ source('shop', 'orders') }} o where o.customer_id = c.id) >= 3 as is_vip\n"
        "from {{ source('shop', 'customers') }} c where not _is_deleted\n"),
}


def check(workdir, task_id):
    p = subprocess.run([sys.executable, os.path.join(HERE, "check.py"), workdir, task_id],
                       capture_output=True, text=True)
    return json.loads(p.stdout)


def prepare(task_id, dest):
    subprocess.run([sys.executable, os.path.join(DEMO, "prepare_workdir.py"), task_id, dest],
                   check=True, capture_output=True, text=True)


def show(label, res, secs):
    print(f"\n=== {label}: pass={res['pass']} score={res['score']} ({secs:.1f}s)")
    for c in res["checks"]:
        print(f"  [{'ok' if c['ok'] else 'FAIL'}] {c['name']} ({c['kind']}): {c['message']}")


def auto_gold(task, dest):
    """Write a convention-following solution for any staging task, derived from the seed CSV header."""
    import csv
    import re
    table, source, model = task["table"], task["source"], task["target_model"]
    header = next(csv.reader(open(os.path.join(DEMO, "project", "seeds", f"raw_{table}.csv"))))
    seeds_yml = open(os.path.join(DEMO, "project", "seeds", "_seeds.yml")).read()
    m = re.search(rf"name: raw_{table}\n\s+config:\n\s+column_types: \{{(.*?)\}}", seeds_yml)
    types = dict(x.strip().split(": ") for x in m.group(1).split(",")) if m else {}
    ent = table[:-3] + "y" if table.endswith("ies") else table[:-1]
    cols = []
    for c in header:
        if c == "id":
            cols.append(f"id as {ent}_id")
        elif c == "_is_deleted":
            continue
        elif c.endswith("_cents"):
            cols.append(f"{{{{ cents_to_dollars('{c}') }}}} as {c[:-6]}")
        elif types.get(c) == "timestamp":
            cols.append(f"{{{{ to_utc('{c}') }}}} as {re.sub('_ts$', '', c)}_at")
        else:
            cols.append(c)
    where = "\n    where not _is_deleted" if "_is_deleted" in header else ""
    sql = (f"with source as (\n\n    select * from {{{{ source('{source}', '{table}') }}}}{where}\n\n),\n\n"
           f"renamed as (\n\n    select\n        " + ",\n        ".join(cols) + "\n    from source\n\n)\n\nselect * from renamed\n")
    d = os.path.join(dest, "models", "staging", source)
    open(os.path.join(d, model + ".sql"), "w").write(sql)
    ypath = os.path.join(d, f"_{source}__models.yml")
    entry = (f"\n  - name: {model}\n    columns:\n      - name: {ent}_id\n        tests:\n          - unique\n          - not_null\n")
    base = open(ypath).read() if os.path.exists(ypath) else "version: 2\n\nmodels:"
    open(ypath, "w").write(base.rstrip("\n") + "\n" + entry)


def main():
    if "--all-gold" in sys.argv:  # every staging task solved by the generator must pass
        tmp = tempfile.mkdtemp(prefix="rsi_allgold_")
        failed = []
        try:
            for f in sorted(os.listdir(TASKS)):
                task = json.load(open(os.path.join(TASKS, f)))
                if task["check_type"] != "staging":
                    continue
                dest = os.path.join(tmp, task["id"])
                prepare(task["id"], dest)
                auto_gold(task, dest)
                res = check(dest, task["id"])
                print(task["id"], "pass" if res["pass"] else "FAIL", res["score"])
                if not res["pass"]:
                    failed.append(task["id"])
                    show(task["id"], res, 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        print("ALL-GOLD", "OK" if not failed else f"FAILED: {failed}")
        return 1 if failed else 0
    all_naive = "--all-naive" in sys.argv
    tmp = tempfile.mkdtemp(prefix="rsi_selftest_")
    results = []
    try:
        cases = []
        for tid in ["train-refunds", "heldout-invoices", "control-customers-vip", "control-payments-by-month"]:
            cases.append((f"gold:{tid}", tid, "gold", True))
        naive_ids = sorted(f[:-5] for f in os.listdir(TASKS)
                           if json.load(open(os.path.join(TASKS, f)))["check_type"] == "staging")
        if not all_naive:
            naive_ids = ["train-refunds", "heldout-invoices"]
        for tid in naive_ids:
            cases.append((f"naive:{tid}", tid, "naive", False))
        for tid in OVERAPPLIED:
            cases.append((f"overapplied:{tid}", tid, "overapplied", False))
        cases.append(("empty-garbage-workdir:train-refunds", "train-refunds", "garbage", False))
        cases.append(("unknown-task", "no-such-task", "garbage", False))
        for label, tid, mode, expect in cases:
            dest = os.path.join(tmp, label.replace(":", "_"))
            task_path = os.path.join(TASKS, tid + ".json")
            t0 = time.time()
            if mode == "garbage":
                os.makedirs(dest)
                if tid != "no-such-task":
                    open(os.path.join(dest, "junk.txt"), "w").write("x")
            else:
                prepare(tid, dest)
                task = json.load(open(task_path))
                if mode == "gold":
                    shutil.copytree(os.path.join(HERE, "gold", tid), dest, dirs_exist_ok=True)
                elif mode == "naive":
                    p = os.path.join(dest, f"models/staging/{task['source']}/{task['target_model']}.sql")
                    open(p, "w").write(NAIVE.format(source=task["source"], table=task["table"]))
                else:
                    rel, body = OVERAPPLIED[tid]
                    os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
                    open(os.path.join(dest, rel), "w").write(body)
            res = check(dest, tid)
            show(label, res, time.time() - t0)
            results.append((label, res["pass"] == expect))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    bad = [l for l, ok in results if not ok]
    print("\nSELFTEST", "OK" if not bad else f"FAILED: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
