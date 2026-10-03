"""Shared helpers for the learn-v1 benchmark drivers on the NEW lesson store (stdlib only).

  install_lessons(workdir, lessons, name, pinned_ids)  write .altimate-code/learn/<name>/approved.json (no SKILL.md)
  read_shown(workdir, session_id)                       [{id, tier, at}] from .altimate-code/learn/<name>/shown.jsonl
  parse_arm(arm)                                        arm string -> Arm (lessons / vague / none, env limits)
  retrieval_metrics(needed, shown, kinds)               recall / precision / recall by tier
  run_specs(specs, parallel, on_done)                   thread pool with the zero-tool-call watchdog
  preflight()                                           ALTIMATE_CMD must point at a checkout that has learn/delivery.ts

Importing this module patches `common` IN THIS PROCESS ONLY (common.py itself is not edited):
  * C.install_playbook understands a lessons token (see lessons_token), so C.run_task can start a run with approved
    lessons and no skill file, unchanged, through the normal `playbook` spec key;
  * C.user_env drops inherited ALTIMATE_LEARN_* variables so only an arm's own env_extra reaches the agent.

Store schema (packages/opencode/src/altimate/learn/lesson.ts, strict zod): id /^L-[0-9a-f]{4,}$/, text, tags[],
scope "project", pinned?, trigger?{paths?} (strict), helpful/harmful/applied nonnegative ints, coexists?[ids],
created, updated, provenance?. approved.json is a JSON array of these; unknown keys (e.g. the pool's `kind`) are
rejected by the store, so they are dropped here and kept only in the harness-side `kinds` map.
"""
import json
import os
import re
import shlex
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.dirname(HERE)
sys.path.insert(0, HARNESS)
import common as C  # noqa: E402

STORE_NAME = C.PLAYBOOK_NAME  # "team-playbook"
ID_RE = re.compile(r"^L-[0-9a-f]{4,}$")
FIXED_TS = "2026-10-01T00:00:00.000Z"
LIMIT_ENV = {"core": "ALTIMATE_LEARN_CORE_LESSONS", "retrieved": "ALTIMATE_LEARN_RETRIEVED_LESSONS",
             "budget": "ALTIMATE_LEARN_BUDGET_TOKENS", "session_max": "ALTIMATE_LEARN_SESSION_MAX_LESSONS",
             "request": "ALTIMATE_LEARN_REQUEST_LESSONS", "file": "ALTIMATE_LEARN_FILE_LESSONS", "filehook": "ALTIMATE_LEARN_FILE_HOOK"}
TOKEN_PREFIX = "\x00v1-lessons:"
ZERO_TOOL_LIMIT = 3  # same watchdog as run_baselines.sh


# ------------------------------------------------------------------ lesson sources

def learn_dir(workdir, name=STORE_NAME):
    C.validate_id(name, "lesson store name")
    return os.path.join(workdir, ".altimate-code", "learn", name)


def parse_playbook_md(text):
    """Bullets of a SKILL.md playbook -> lessons ('- [L-id] text <!-- h:N x:N -->')."""
    out = []
    for line in text.splitlines():
        m = re.match(r"^- \[(L-[0-9a-f]+)\] (.*?)(?:\s*<!--\s*h:(\d+)\s+x:(\d+).*?-->)?\s*$", line)
        if m:
            out.append({"id": m.group(1), "text": m.group(2).strip(), "helpful": int(m.group(3) or 0),
                        "applied": int(m.group(4) or 0)})
    return out


def resolve_path(p):
    for base in ("", os.getcwd(), HERE, HARNESS, os.path.join(HERE, "playbooks")):
        cand = os.path.join(base, p) if base else p
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    raise SystemExit(f"lesson source not found: {p}")


def load_lessons(path):
    """.jsonl (pool; one lesson per line) | .json (array, e.g. an approved.json) | .md (playbook bullets)."""
    path = resolve_path(path)
    text = open(path).read()
    if path.endswith(".md"):
        return parse_playbook_md(text)
    if path.endswith(".json"):
        return json.loads(text)
    return [json.loads(l) for l in text.splitlines() if l.strip()]


# ------------------------------------------------------------------ install / read

def lesson_record(l, pinned_ids=(), strip_paths=False):
    """One store record (exact lesson.ts shape). Raises on anything the store's own parser would reject."""
    if not ID_RE.fullmatch(l.get("id", "")):
        raise ValueError(f"invalid lesson id {l.get('id')!r}")
    if not str(l.get("text", "")).strip():
        raise ValueError(f"empty lesson text for {l['id']}")
    for key in ("helpful", "harmful", "applied"):
        value = l.get(key, 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{key} must be a nonnegative integer for {l['id']}")
    rec = {
        "id": l["id"], "text": l["text"], "tags": [str(t) for t in (l.get("tags") or [])], "scope": "project",
        "helpful": int(l.get("helpful", 0)), "harmful": int(l.get("harmful", 0)), "applied": int(l.get("applied", 0)),
        "created": l.get("created") or FIXED_TS, "updated": l.get("updated") or FIXED_TS,
    }
    if l["id"] in set(pinned_ids) or l.get("pinned") is True:
        rec["pinned"] = True
    paths = (l.get("trigger") or {}).get("paths")
    if paths and not strip_paths:
        rec["trigger"] = {"paths": list(paths)}
    if l.get("coexists"):
        rec["coexists"] = list(l["coexists"])
    if l.get("provenance"):
        rec["provenance"] = str(l["provenance"])
    return rec


def install_lessons(workdir, lessons, name=STORE_NAME, pinned_ids=(), strip_paths=False):
    """Start a run with these approved lessons and NO skill file: .altimate-code/learn/<name>/approved.json.

    The product's Delivery activates when .altimate-code/learn exists and an approved.json is readable (no
    `learn enable` needed). Returns the written path."""
    records = [lesson_record(l, pinned_ids, strip_paths) for l in lessons]
    ids = [r["id"] for r in records]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate lesson ids")
    d = learn_dir(workdir, name)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "approved.json")
    with open(path, "w") as f:
        json.dump(records, f, indent=2, sort_keys=True)
        f.write("\n")
    return path


def read_json_array(path):
    return json.load(open(path)) if os.path.isfile(path) else []


def read_approved(workdir, name=STORE_NAME):
    return read_json_array(os.path.join(learn_dir(workdir, name), "approved.json"))


def read_shown(workdir, session_id=None, name=STORE_NAME):
    """Lessons the product showed, from shown.jsonl ({session,id,tier,at,queryHash} per line, appended by
    Delivery.log). First record per id wins. session_id=None -> all sessions in this workdir.
    tier: core | retrieved (session start), request (per-request addition), file (file hook)."""
    seen, out = set(), []
    for r in C.read_jsonl(os.path.join(learn_dir(workdir, name), "shown.jsonl")):
        if session_id and r.get("session") != session_id:
            continue
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append({"id": r["id"], "tier": r.get("tier"), "at": r.get("at")})
    return out


def retrieval_metrics(needed, shown, kinds=None):
    """needed: lesson ids the task needs. shown: read_shown() list. kinds: {id: real|near|distractor}."""
    tier_of = {s["id"]: s["tier"] for s in shown}
    found = [n for n in needed if n in tier_of]
    by_tier = {}
    for n in found:
        by_tier[tier_of[n]] = by_tier.get(tier_of[n], 0) + 1
    shown_kinds = {}
    for s in shown:
        k = (kinds or {}).get(s["id"], "?")
        shown_kinds[k] = shown_kinds.get(k, 0) + 1
    return {
        "needed": list(needed), "n_shown": len(shown), "found": found,
        "recall": (len(found) / len(needed)) if needed else None,
        "recall_by_tier": by_tier, "tiers": {n: tier_of.get(n) for n in needed},
        "precision": (len(found) / len(shown)) if shown and needed else None,
        "shown_by_tier": {t: sum(1 for s in shown if s["tier"] == t) for t in {s["tier"] for s in shown}},
        "shown_kinds": shown_kinds,
    }


# ------------------------------------------------------------------ arms

class Arm:
    def __init__(self, label, kind, pool=None, lessons=None, env=None, pinned=(), strip_paths=False, kinds=None):
        self.label, self.kind, self.pool = label, kind, pool
        self.lessons = lessons or []
        self.env = env or {}
        self.pinned, self.strip_paths = tuple(pinned), strip_paths
        self.kinds = kinds or {}

    @property
    def token(self):
        """The `playbook` spec value for C.run_task: None (no lessons) or a lessons token."""
        if not self.lessons:
            return None
        return lessons_token(self.lessons, STORE_NAME, self.pinned, self.strip_paths)

    @property
    def splits(self):
        return ["vague", "control"] if self.kind == "vague" else ["heldout", "control"]


def lessons_token(lessons, name=STORE_NAME, pinned=(), strip_paths=False):
    return TOKEN_PREFIX + json.dumps({"lessons": lessons, "name": name, "pinned": list(pinned),
                                      "strip_paths": strip_paths})


def parse_arm(arm):
    """none | lessons:<source>[;core=N][;retrieved=N][;budget=N][;session_max=N][;nopaths][;pin=real|ID,ID][;only=KIND]
       | vague:<source|none>[same options].   <source> is a .jsonl pool, .json array or .md playbook.
    Limits left out keep the product defaults (core 15, retrieved 15, budget 1500, session_max 40)."""
    head, *params = arm.split(";")
    kind, _, src = head.partition(":")
    if kind not in ("none", "lessons", "vague"):
        raise SystemExit(f"unknown arm {arm!r} (none | lessons:<pool>[;opts] | vague:<pool|none>[;opts])")
    if kind == "none" and src:
        raise SystemExit("none does not accept a lesson source")
    env, pinned, strip, only = {}, [], False, None
    for p in params:
        k, _, v = p.partition("=")
        if k in LIMIT_ENV:
            if int(v) < 0:
                raise SystemExit(f"{k} must be nonnegative")
            env[LIMIT_ENV[k]] = str(int(v))
        elif k == "nopaths":
            strip = True
        elif k == "pin":
            pinned = v.split(",")
        elif k == "only":
            only = v
        else:
            raise SystemExit(f"unknown arm option {p!r} in {arm!r}")
    lessons, kinds = [], {}
    if src and src != "none":
        pool = load_lessons(src)
        kinds = {l["id"]: l.get("kind", "?") for l in pool}
        if only:
            pool = [l for l in pool if l.get("kind") == only]
        if pinned == ["real"]:
            pinned = [l["id"] for l in pool if l.get("kind") == "real"]
        lessons = pool
    elif kind == "lessons":
        raise SystemExit(f"{arm!r}: lessons arm needs a source")
    return Arm(arm, "none" if kind == "none" else kind, src or None, lessons, env, pinned, strip, kinds)


# ------------------------------------------------------------------ process-local patches of common

_orig_install_playbook = C.install_playbook
_orig_user_env = C.user_env


def _install_playbook(workdir, text):
    if text.startswith(TOKEN_PREFIX):
        d = json.loads(text[len(TOKEN_PREFIX):])
        install_lessons(workdir, d["lessons"], d["name"], d["pinned"], d["strip_paths"])
    else:
        _orig_install_playbook(workdir, text)


def _user_env(*a, **k):
    env = _orig_user_env(*a, **k)
    for key in [x for x in env if x.startswith("ALTIMATE_LEARN_")]:
        env.pop(key)
    return env


C.install_playbook = _install_playbook
C.user_env = _user_env


def preflight():
    """ALTIMATE_CMD must run a checkout with the new learn store (the rsi worktree), else every lessons arm
    silently measures nothing."""
    entry = next((p for p in shlex.split(C.ALTIMATE_CMD)
                  if p.endswith("packages/opencode/src/index.ts")), None)
    if not entry:
        sys.exit(f"cannot find packages/opencode/src/index.ts in ALTIMATE_CMD={C.ALTIMATE_CMD!r}")
    root = os.path.abspath(os.path.join(os.path.dirname(entry), "../../.."))
    src = os.path.join(root, "packages", "opencode", "src", "altimate", "learn")
    if not os.path.isfile(os.path.join(src, "delivery.ts")):
        sys.exit(f"ALTIMATE_CMD needs PR #1405 learn features ({src}/delivery.ts is missing)")
    return root


# ------------------------------------------------------------------ runner with watchdog

class Watchdog:
    """Stops an arm after ZERO_TOOL_LIMIT runs that made zero tool calls (install or worktree vanished)."""

    def __init__(self, limit=ZERO_TOOL_LIMIT):
        self.limit, self.zero, self.lock = limit, 0, threading.Lock()

    @property
    def tripped(self):
        return self.zero >= self.limit

    def note(self, rec):
        if rec.get("tool_calls", 0) == 0:
            with self.lock:
                self.zero += 1


def run_specs(specs, parallel, on_done=None, fn=None, watchdog=None):
    """Like C.run_many (order kept, failures recorded) plus the watchdog: once tripped, queued specs are skipped.
    Returns (records, tripped)."""
    fn = fn or C.run_task
    wd = watchdog or Watchdog()

    def one(s):
        if wd.tripped:
            return None
        try:
            r = fn(s)
        except Exception as e:
            r = {"task": s["task"]["id"], "split": s["task"]["split"], "arm": s["arm"], "user": s.get("user", "a"),
                 "run_idx": s.get("run_idx", 0), "pass": False, "score": 0.0, "checks": {}, "error": repr(e),
                 "leak": False, "tool_calls": 0, "completed": False}
            C.log("run failed:", repr(e))
        wd.note(r)
        if on_done:
            on_done(r)
        return r
    with ThreadPoolExecutor(max_workers=max(1, parallel)) as ex:
        recs = [r for r in ex.map(one, specs) if r is not None]
    if wd.tripped:
        C.log(f"ENV-BROKEN: {wd.zero} runs with 0 tool calls; arm stopped")
    return recs, wd.tripped
