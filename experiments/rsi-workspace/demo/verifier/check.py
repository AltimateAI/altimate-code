#!/usr/bin/env python3
"""Team-convention CI for the acme_shop RSI benchmark.

usage: check.py <workdir> <task_id>
prints JSON {"task_id","pass","score","checks":[{"name","kind","ok","message"}]}
exit code 0 iff every check passed.

Env:
  DBT_BIN     path to dbt (default: dbt on PATH)
  DBT_PYTHON  python with duckdb installed (default: the python next to DBT_BIN, else this interpreter)

The agent's workdir is never modified: it is copied to a temp dir, pristine
seeds/macros/profile are restored on top, a fresh duckdb is seeded, and dbt
runs there. check_type (from the task json) selects the check set:
  staging          C1..C6 (new staging model)
  control_vip      K1..K4 (add a column to an existing model; no new conventions apply)
  control_analysis K1..K4 (ad-hoc analysis; conventions must NOT be applied)
Check kinds: "lint" (may name the rule, like a linter) and "data" (symptom only).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(os.path.dirname(HERE), "project")
DBT_BIN = os.environ.get("DBT_BIN") or shutil.which("dbt") or "dbt"
_adjacent_python = os.path.join(os.path.dirname(shutil.which(DBT_BIN) or DBT_BIN), "python")
DBT_PY = os.environ.get("DBT_PYTHON") or (_adjacent_python if os.path.isfile(_adjacent_python) else sys.executable)
DBT_TIMEOUT = 90

KINDS = {"C1": "lint", "C2": "lint", "C3": "lint", "C4": "data", "C5": "data", "C6": "lint",
         "K1": "data", "K2": "data", "K3": "data", "K4": "data"}

INSPECT = r"""
import duckdb, json, sys
db, table, model = sys.argv[1:4]
con = duckdb.connect(db, read_only=True)
def cols(schema, t):
    return [[r[0], r[1]] for r in con.execute(
        "select column_name, data_type from information_schema.columns "
        "where table_schema=? and table_name=? order by ordinal_position", [schema, t]).fetchall()]
out = {"src_cols": cols("raw", "raw_" + table)}
names = [c[0] for c in out["src_cols"]]
w = " where not _is_deleted" if "_is_deleted" in names else ""
out["src_total"] = con.execute(f"select count(*) from raw.raw_{table}").fetchone()[0]
out["src_live"] = con.execute(f"select count(*) from raw.raw_{table}{w}").fetchone()[0]
out["src_sums"] = {c: con.execute(f"select sum({c}) from raw.raw_{table}{w}").fetchone()[0]
                   for c in names if c.endswith("_cents")}
out["model_cols"] = cols("main", model)
mnames = [c[0] for c in out["model_cols"]]
out["model_rows"] = con.execute(f"select count(*) from main.{model}").fetchone()[0] if mnames else None
out["model_sums"] = {}
for c in names:
    if c.endswith("_cents") and c[:-6] in mnames:
        out["model_sums"][c] = con.execute(f"select sum({c[:-6]}) from main.{model}").fetchone()[0]
print(json.dumps(out, default=str))
"""

INSPECT_VIP = r"""
import duckdb, json, sys
con = duckdb.connect(sys.argv[1], read_only=True)
out = {}
out["cols"] = [[r[0], r[1]] for r in con.execute(
    "select column_name, data_type from information_schema.columns "
    "where table_schema='main' and table_name='stg_shop__customers' order by ordinal_position").fetchall()]
out["rows"] = con.execute("select count(*) from main.stg_shop__customers").fetchone()[0]
out["expected_rows"] = con.execute("select count(*) from raw.raw_customers").fetchone()[0]
if any(c[0] == "is_vip" for c in out["cols"]):
    bad = con.execute('''
        with exp as (select c.id as customer_id, count(o.id) >= 3 as vip
                     from raw.raw_customers c left join raw.raw_orders o on o.customer_id = c.id group by 1)
        select m.customer_id, m.is_vip, e.vip from main.stg_shop__customers m
        full join exp e using (customer_id)
        where m.is_vip is distinct from e.vip''').fetchall()
    out["bad"] = [list(b) for b in bad]
    out["n_vip"] = con.execute("select count(*) from main.stg_shop__customers where is_vip").fetchone()[0]
print(json.dumps(out, default=str))
"""

INSPECT_AN = r"""
import duckdb, json, sys
con = duckdb.connect(sys.argv[1], read_only=True)
out = {}
cur = con.execute(open(sys.argv[2]).read())
out["cols"] = [d[0] for d in cur.description]
out["rows"] = [[str(v) for v in r] for r in cur.fetchall()]
exp = con.execute('''select cast(date_trunc('month', created) as date) as month, payment_method,
                            count(*) as payments, sum(amount_cents) as total_cents
                     from raw.raw_payments group by 1, 2''').fetchall()
out["expected"] = [[str(v) for v in r] for r in exp]
print(json.dumps(out))
"""

ANALYSIS_COLS = ["month", "payment_method", "payments", "total_cents"]
CUSTOMER_COLS = ["customer_id", "first_name", "last_name", "email", "country"]


def singular(table):
    if table.endswith("ies"):
        return table[:-3] + "y"
    return table[:-1] if table.endswith("s") else table


def strip_comments(sql):
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    sql = re.sub(r"\{#.*?#\}", "", sql, flags=re.S)
    return re.sub(r"--[^\n]*", "", sql)


def run(cmd, cwd, timeout=DBT_TIMEOUT):
    env = dict(os.environ, DBT_SEND_ANONYMOUS_USAGE_STATS="false", DO_NOT_TRACK="1", NO_COLOR="1")
    try:
        p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:  # missing binary, timeout
        return 99, f"{type(e).__name__}: {e}"


def tail(text, n=6):
    lines = [l for l in re.sub(r"\x1b\[[0-9;]*m", "", text).splitlines() if l.strip()]
    errs = [l.strip() for l in lines if "rror" in l][:n]
    return " | ".join(errs or [l.strip() for l in lines[-n:]])[:600]


def emit(task_id, checks):
    ok = sum(1 for c in checks if c["ok"])
    print(json.dumps({
        "task_id": task_id,
        "pass": bool(checks) and ok == len(checks),
        "score": round(ok / len(checks), 3) if checks else 0.0,
        "checks": checks,
    }, indent=2))
    return 0 if checks and ok == len(checks) else 1


def duck(script, *args, cwd):
    rc, out = run([DBT_PY, "-c", script, *args], cwd, timeout=30)
    try:
        return json.loads(out.strip().splitlines()[-1])
    except Exception:
        return None


def load_manifest(work):
    try:
        return json.load(open(os.path.join(work, "target", "manifest.json")))
    except Exception:
        return None


def make_sandbox(workdir, tmp):
    """Copy the agent's workdir, restore pristine seeds/macros/profile, seed a fresh duckdb."""
    work = os.path.join(tmp, "p")
    if os.path.isdir(workdir):
        shutil.copytree(workdir, work, ignore=shutil.ignore_patterns(
            ".git", "target", "logs", "*.duckdb", "*.duckdb.wal", ".user.yml"))
    else:
        os.makedirs(work)
    seeds = os.path.join(work, "seeds")
    if os.path.commonpath([os.path.realpath(tmp), os.path.realpath(seeds)]) != os.path.realpath(tmp):
        raise ValueError("sandbox restore path escapes the verifier temporary directory")
    shutil.rmtree(seeds, ignore_errors=True)
    shutil.copytree(os.path.join(PROJECT, "seeds"), seeds)
    shutil.copytree(os.path.join(PROJECT, "macros"), os.path.join(work, "macros"), dirs_exist_ok=True)
    for f in ("dbt_project.yml", "profiles.yml"):
        shutil.copy(os.path.join(PROJECT, f), os.path.join(work, f))
    flags = ["--profiles-dir", work, "--project-dir", work]
    rc, out = run([DBT_BIN, "seed"] + flags, work)
    return work, flags, (None if rc == 0 else f"dbt seed failed in verifier sandbox: {tail(out)}")


# ---------------------------------------------------------------- staging
def find_built_model(workdir, source):
    """The single new/changed stg_<source>__*.sql vs the pristine project, or None (zero or several)."""
    sdir = os.path.join(workdir, "models", "staging", source)
    pdir = os.path.join(PROJECT, "models", "staging", source)
    if not os.path.isdir(sdir):
        return None
    cands = []
    for f in sorted(os.listdir(sdir)):
        if not (f.startswith(f"stg_{source}__") and f.endswith(".sql")):
            continue
        orig = os.path.join(pdir, f)
        if not os.path.isfile(orig) or open(orig, errors="replace").read() != open(os.path.join(sdir, f), errors="replace").read():
            cands.append(f[:-4])
    return cands[0] if len(cands) == 1 else None


def check_staging(task, workdir, work, flags, seed_err, add):
    source, table, model = task["source"], task["table"], task["target_model"]
    expected_model = model
    sdir = f"models/staging/{source}"
    sql_rel = f"{sdir}/{model}.sql"
    yml_rel = f"{sdir}/_{source}__models.yml"
    pk = singular(table) + "_id"
    sql = None

    # C1 location / naming
    sql_path = os.path.join(workdir, sql_rel)
    if os.path.isfile(sql_path):
        sql = strip_comments(open(sql_path, errors="replace").read())
        add("C1_location_naming", True, f"found {sql_rel}")
    else:
        found = []
        if os.path.isdir(os.path.join(workdir, "models")):
            for dp, _, fs in os.walk(os.path.join(workdir, "models")):
                found += [os.path.relpath(os.path.join(dp, f), workdir) for f in fs
                          if f.endswith(".sql") and table in f]
        hint = f" Found instead: {', '.join(found)}." if found else ""
        built_name = find_built_model(workdir, source)
        if built_name:
            # C1 stays strict; C2-C6 are evaluated on the model the agent actually built.
            model = built_name
            sql_rel = f"{sdir}/{model}.sql"
            sql = strip_comments(open(os.path.join(workdir, sql_rel), errors="replace").read())
            hint += f" Remaining checks were evaluated on {sql_rel}."
        add("C1_location_naming", False,
            f"{sdir}/{expected_model}.sql does not exist. Team rule: staging models live in models/staging/<source>/ "
            f"and are named stg_<source>__<entity>.sql (here: {expected_model}).{hint}")

    # C6 build
    built, manifest = False, None
    if seed_err:
        add("C6_dbt_build", False, seed_err)
    else:
        rc, out = run([DBT_BIN, "build", "--select", model] + flags, work)
        manifest = load_manifest(work)
        in_manifest = f"model.acme_shop.{model}" in (manifest or {}).get("nodes", {})
        if rc != 0:
            add("C6_dbt_build", False, f"`dbt build --select {model}` failed: {tail(out)}")
        elif not in_manifest:
            add("C6_dbt_build", False, f"dbt did not find a model named {model}; nothing was built.")
        else:
            built = True
            add("C6_dbt_build", True, f"`dbt build --select {model}` succeeded (model and its tests)")

    # C2 primary key + yaml tests (from the dbt manifest)
    nodes = (manifest or {}).get("nodes", {})
    mnode = nodes.get(f"model.acme_shop.{model}")
    if mnode is None and sql is None:
        add("C2_primary_key_and_tests", False, f"{model} does not exist, so its `{pk}` key and tests cannot be checked.")
    elif manifest is None:
        add("C2_primary_key_and_tests", False, "dbt could not parse the project, so the key and YAML tests cannot be checked.")
    else:
        problems = []
        if mnode is None:
            problems.append(f"{model} is not a dbt model")
        else:
            patch = (mnode.get("patch_path") or "").split("://")[-1]
            if patch != yml_rel:
                problems.append(
                    f"model is not declared in {yml_rel}" +(f" (declared in {patch})" if patch else "")
                    + f". Team rule: each source folder has one _{source}__models.yml with its models")
            tests = {(n.get("test_metadata") or {}).get("name") for n in nodes.values()
                     if n.get("resource_type") == "test" and n.get("attached_node") == mnode["unique_id"]
                     and n.get("column_name") == pk}
            missing = [t for t in ("unique", "not_null") if t not in tests]
            if missing:
                problems.append(f"column `{pk}` is missing {' and '.join(missing)} test(s) in {yml_rel}")
        if sql is not None and not re.search(rf"\bas\s+{pk}\b", sql, re.I):
            problems.append(f"primary key `id` is not renamed to `{pk}` (Team rule: <singular_entity>_id)")
        if problems:
            add("C2_primary_key_and_tests", False, f"{model}: " + "; ".join(problems) + ".")
        else:
            add("C2_primary_key_and_tests", True, f"`{pk}` renamed; unique + not_null declared in {yml_rel}")

    # inspect the built database
    info = None
    db = os.path.join(work, "acme.duckdb")
    if os.path.isfile(db):
        info = duck(INSPECT, db, table, model, cwd=work)
    src_cols = (info or {}).get("src_cols") or []
    model_cols = [c[0] for c in (info or {}).get("model_cols", [])]
    model_types = {c[0]: c[1] for c in (info or {}).get("model_cols", [])}
    have_out = built and bool(model_cols)
    cents = [c[0] for c in src_cols if c[0].endswith("_cents")]
    ts_cols = [c[0] for c in src_cols if str(c[1]).upper().startswith("TIMESTAMP")]
    has_del = any(c[0] == "_is_deleted" for c in src_cols)

    # C3 money
    if sql is None:
        add("C3_money_cents_to_dollars", False, f"{model} does not exist; cannot check money columns ({', '.join(cents)}).")
    elif not cents:
        add("C3_money_cents_to_dollars", True, "no money columns in this source")
    else:
        probs = []
        for c in cents:
            new = c[:-6]
            if not re.search(r"cents_to_dollars\(\s*['\"]?" + re.escape(c) + r"['\"]?\s*\)", sql):
                probs.append(
                    f"column `{c}` exposed raw. Team rule: money columns must be converted with "
                    f"{{{{ cents_to_dollars() }}}} and renamed without the _cents suffix ({new})")
            elif have_out:
                if new not in model_cols:
                    probs.append(f"converted money column should be named `{new}` (drop the _cents suffix)")
                else:
                    want = (info["src_sums"].get(c) or 0) / 100.0
                    got = info["model_sums"].get(c) or 0
                    if abs(float(got) - want) > 0.05:
                        probs.append(f"`{new}` values do not equal {c}/100 (sum {got} vs expected {want:.2f})")
        if have_out:
            raw = [c for c in model_cols if c.endswith("_cents")]
            if raw:
                probs.append(f"column(s) {', '.join('`'+c+'`' for c in raw)} still carry the _cents suffix. "
                             "Team rule: no *_cents columns in staging output")
        add("C3_money_cents_to_dollars", not probs,
            f"{model}: " + "; ".join(probs) + "." if probs else f"{', '.join(cents)} converted via cents_to_dollars and renamed")

    # C4 timestamps (data-style: symptoms only)
    if sql is None:
        add("C4_timestamps_utc_at", False, f"{model} does not exist; cannot check timestamp columns ({', '.join(ts_cols)}).")
    elif not ts_cols:
        add("C4_timestamps_utc_at", True, "no timestamp columns in this source")
    else:
        probs = []
        for c in ts_cols:
            stem = re.sub(r"(_ts|_at)$", "", c)
            new = stem + "_at"
            if not re.search(r"to_utc\(\s*['\"]?" + re.escape(c) + r"['\"]?\s*\)", sql):
                probs.append(f"column `{c}` is not timezone-normalized; the downstream join against the finance "
                             "calendar (UTC) fails on it")
            elif have_out:
                if new not in model_cols:
                    like = [m for m in model_cols if m.startswith(stem)]
                    probs.append(f"timestamp output column(s) {', '.join('`'+m+'`' for m in like) or '(none)'} "
                                 "do not follow the team's timestamp naming suffix")
                elif not str(model_types.get(new, "")).upper().startswith("TIMESTAMP"):
                    probs.append(f"`{new}` is not a timestamp")
        if have_out:
            leftover = [c for c in ts_cols if c in model_cols]
            if leftover:
                probs.append(f"timestamp column(s) {', '.join('`'+c+'`' for c in leftover)} pass through "
                             "un-normalized and un-renamed")
        add("C4_timestamps_utc_at", not probs,
            f"{model}: " + "; ".join(probs) + "." if probs else f"{', '.join(ts_cols)} normalized to UTC and named *_at")

    # C5 soft deletes (data-style: symptoms only)
    if not has_del:
        add("C5_soft_deletes", True, "source has no soft-delete flag; not applicable")
    elif not have_out:
        add("C5_soft_deletes", False,
            f"{model} could not be inspected (missing or does not build); row reconciliation against the source cannot run.")
    else:
        probs = []
        n, live = info["model_rows"], info["src_live"]
        if n != live:
            probs.append(f"returned {n} rows; the reconciliation against the source system expects {live}. "
                         f"{abs(n - live)} row(s) should not reach analytics")
        if "_is_deleted" in model_cols:
            probs.append("exposes internal column `_is_deleted`, which must not reach analytics")
        add("C5_soft_deletes", not probs,
            f"{model}: " + "; ".join(probs) + "." if probs else f"row count matches reconciliation ({n}); no internal flags exposed")


# ---------------------------------------------------------------- controls
def check_control_vip(task, workdir, work, flags, seed_err, add):
    model = "stg_shop__customers"
    nodes_ok = False
    if seed_err:
        add("K1_builds_with_tests", False, seed_err)
    else:
        rc, out = run([DBT_BIN, "build", "--select", f"+{model}", "stg_shop__orders"] + flags, work)
        nodes_ok = rc == 0
        add("K1_builds_with_tests", nodes_ok,
            "customers and orders staging models build and their tests pass" if nodes_ok
            else f"`dbt build` of the existing staging models failed: {tail(out)}")
    info = duck(INSPECT_VIP, os.path.join(work, "acme.duckdb"), cwd=work) if nodes_ok else None
    cols = [c[0] for c in (info or {}).get("cols", [])]
    types = {c[0]: c[1] for c in (info or {}).get("cols", [])}
    if not info or "is_vip" not in cols:
        add("K2_is_vip_values", False, f"{model} has no `is_vip` column" if info else f"{model} could not be inspected (build failed)")
    elif str(types["is_vip"]).upper() != "BOOLEAN":
        add("K2_is_vip_values", False, f"`is_vip` should be boolean, got {types['is_vip']}")
    elif info["bad"]:
        add("K2_is_vip_values", False,
            f"`is_vip` is wrong for {len(info['bad'])} customer(s) (e.g. customer_id={info['bad'][0][0]}: "
            f"got {info['bad'][0][1]}, expected {info['bad'][0][2]}); customers with >= 3 orders are VIPs")
    else:
        add("K2_is_vip_values", True, f"`is_vip` correct for all customers ({info['n_vip']} VIPs)")
    if not info:
        add("K3_existing_contract_intact", False, f"{model} could not be inspected")
    else:
        extra = [c for c in cols if c not in CUSTOMER_COLS + ["is_vip"]]
        missing = [c for c in CUSTOMER_COLS if c not in cols]
        probs = []
        if extra:
            probs.append(f"unexpected extra/renamed column(s) {extra}")
        if missing:
            probs.append(f"existing column(s) {missing} were removed or renamed")
        if info["rows"] != info["expected_rows"]:
            probs.append(f"returns {info['rows']} rows but the customers source has {info['expected_rows']}; "
                         "no customers should be dropped")
        add("K3_existing_contract_intact", not probs,
            f"{model}: " + "; ".join(probs) + "." if probs else "existing columns and row count unchanged")
    # K4: unrelated model untouched
    try:
        norm = lambda p: re.sub(r"\s+", " ", strip_comments(open(p).read())).strip()
        rel = "models/staging/shop/stg_shop__orders.sql"
        same = norm(os.path.join(workdir, rel)) == norm(os.path.join(PROJECT, rel))
    except Exception:
        same = False
    add("K4_unrelated_models_untouched", same,
        "stg_shop__orders unchanged" if same else "stg_shop__orders.sql was modified or removed; it is out of scope for this ticket")


def check_control_analysis(task, workdir, work, flags, seed_err, add):
    name = task["target_model"]
    rel = f"analyses/{name}.sql"
    exists = os.path.isfile(os.path.join(workdir, rel))
    add("K1_file_exists", exists, f"found {rel}" if exists else f"{rel} does not exist")
    compiled = None
    if not exists or seed_err:
        add("K2_compiles", False, seed_err or "nothing to compile")
    else:
        rc, out = run([DBT_BIN, "compile", "--select", name] + flags, work)
        cp = os.path.join(work, "target", "compiled", "acme_shop", rel)
        if rc == 0 and os.path.isfile(cp):
            compiled = cp
            add("K2_compiles", True, "analysis compiles")
        else:
            add("K2_compiles", False, f"`dbt compile --select {name}` failed: {tail(out)}")
    res = duck(INSPECT_AN, os.path.join(work, "acme.duckdb"), compiled, cwd=work) if compiled else None
    if res is None:
        add("K3_runs_expected_columns", False, "analysis did not run against the warehouse" if compiled else "analysis could not be run")
        add("K4_numbers_match_finance_export", False, "analysis could not be run")
        return
    if res["cols"] != ANALYSIS_COLS:
        add("K3_runs_expected_columns", False, f"returned columns {res['cols']}, expected {ANALYSIS_COLS}")
        add("K4_numbers_match_finance_export", False, "cannot compare numbers without the expected columns")
        return
    add("K3_runs_expected_columns", True, f"runs and returns {ANALYSIS_COLS} ({len(res['rows'])} rows)")
    norm = lambda rows: sorted((r[0][:10], r[1], str(int(float(r[2]))), str(int(float(r[3])))) for r in rows)
    try:
        got, want = norm(res["rows"]), norm(res["expected"])
    except Exception as e:
        add("K4_numbers_match_finance_export", False, f"non-numeric values in result: {e}")
        return
    if got == want:
        add("K4_numbers_match_finance_export", True, f"all {len(want)} month/method totals match the processor's cent totals")
    else:
        diff = next((g for g in got if g not in want), None) or (want[0] if want else None)
        w_row = next((w for w in want if diff and w[:2] == diff[:2]), None)
        add("K4_numbers_match_finance_export", False,
            f"{len(set(got) ^ set(want))} month/method row(s) differ from the finance export, e.g. "
            f"{diff[:2] if diff else ''}: got payments/total_cents {diff[2:] if diff else ''} vs expected {w_row[2:] if w_row else 'missing'}")


CHECKERS = {"staging": check_staging, "control_vip": check_control_vip, "control_analysis": check_control_analysis}


def main():
    if len(sys.argv) != 3:
        print("usage: check.py <workdir> <task_id>", file=sys.stderr)
        return 2
    workdir, task_id = os.path.abspath(sys.argv[1]), sys.argv[2]
    checks = []

    def add(name, ok, message, kind=None):
        checks.append({"name": name, "kind": kind or KINDS.get(name[:2], "lint"), "ok": bool(ok), "message": message})

    try:
        task = json.load(open(os.path.join(HERE, "tasks", task_id + ".json")))
        checker = CHECKERS[task.get("check_type", "staging")]
    except Exception as e:
        add("task", False, f"cannot load task {task_id}: {e}")
        return emit(task_id, checks)

    tmp = tempfile.mkdtemp(prefix="rsi_verify_")
    try:
        work, flags, seed_err = make_sandbox(workdir, tmp)
        checker(task, workdir, work, flags, seed_err, add)
    except Exception as e:  # never crash on garbage
        add("verifier_error", False, f"verifier internal error: {type(e).__name__}: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    order = ["C1", "C2", "C3", "C4", "C5", "C6", "K1", "K2", "K3", "K4"]
    checks.sort(key=lambda c: order.index(c["name"][:2]) if c["name"][:2] in order else 9)
    return emit(task_id, checks)


if __name__ == "__main__":
    sys.exit(main())
