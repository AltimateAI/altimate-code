---
name: demo-creator
description: |
  Turn a one-line problem statement into a REAL recorded terminal demo (a series of
  small clips) plus a blog post showing HOW to do it with altimate-code and WHY that's
  worth it. Use when the user asks to "make a demo", "record a demo", "create a demo +
  blog", or "show off capability X" for altimate-code. Pipeline: deep research the real
  pain -> critique -> design -> record a genuine `altimate-code run` -> extract what the
  session teaches -> visually inspect the frames -> write the blog -> critique loop until
  it clears the bar. Runs in showcase mode (altimate-code alone) by default, or comparison
  mode (vs claude-code) when a head-to-head sharpens the point. Always ships "replicate it
  yourself" steps.
license: MIT
compatibility: claude-code opencode
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - WebFetch
  - WebSearch
  - AskUserQuestion
  - Skill
  - Agent
  - Task
---

# Demo Creator: real demos that prove why altimate-code is better

You produce **demos people believe** and **blogs that earn the click**. A demo is worth
nothing if it's staged, and a blog is worth nothing if it lists features instead of
showing a win. This skill forces both to be real and both to be earned.

The output is usually **a series of small, tight clips** — one value-moment each — not one
long recording. Small clips are easier to record cleanly, easier to embed, and easier for
a reader to actually watch.

## The two laws (do not break these)

1. **Recordings are of real runs.** You record an actual `altimate-code run`, never typed-up
   fake output. After recording, verify what the clip shows against the session trace
   (`altimate-code trace view <id>`) and/or the `--format json` event stream. If the clip
   shows something the run didn't do, the clip is invalid — re-record.
2. **Value is shown, not asserted.** The "why use altimate-code" must come from what the
   recording actually shows the tool doing — never from adjectives. Don't narrate a benefit
   the clip doesn't demonstrate. If, when you watch the real run, altimate-code didn't
   actually do the valuable thing, you have no demo yet: change the task, or report it
   honestly. We are selling trust; a staged or overclaimed demo destroys it.

If you ever feel pressure to fudge either law to "make the demo look good," stop and tell
the user the honest result instead.

## Two modes — baseline is OPTIONAL

Pick per angle (you can mix across a series):

- **Showcase mode (default).** Just show how altimate-code does the task, and let the
  *specific thing it does* — runs the SQL and diffs it, runs `check`, traces lineage,
  proves equivalence — be the reason to use it. No second agent. This is the right mode
  when the capability is self-evidently valuable on its own (e.g. "it verified the output,"
  "it caught the defect"). The viewer sees the value directly; you don't need a foil.
- **Comparison mode (optional).** Add a **claude-code** (`claude -p`) control on the same
  prompt/fixture/model when a head-to-head genuinely sharpens the point — i.e. the value is
  "altimate-code does X that a general agent skips." Only use it when altimate-code actually
  comes out ahead on the real runs; if it ties or loses, drop the comparison (you may still
  ship the showcase) and say so. An in-fork capability-disabled control is a fallback — see
  value-wedge.md.

Default to showcase. Reach for comparison only when the contrast is the point and it's real.

## When to use / not use

**Use it** when the user wants a demo and/or blog that shows an altimate-code capability on
a real use case.

**Don't use it** for: pure docs/READMEs, slide decks, or marketing copy with no running
software behind it. Those don't need a recorded real run.

## Inputs

- A **problem statement** (e.g. *"a good demo on building spark pipelines using
  altimate-code and pyspark"*). If missing, ask for it.
- Optional: target audience (practitioner vs exec), where artifacts should go, whether one
  clip or a series.

## Output layout

Create `demos/<topic-slug>/` at the repo root:

```text
demos/<topic-slug>/
  research.md          # phase 1: real pains + verbatim quotes + sources
  demo-spec.md         # phase 3: angles, fixtures, prompts, baseline controls
  fixture/             # phase 4: the real use-case project the agent operates on
  clips/
    <angle>.cast       # asciinema recording of the REAL run
    <angle>.gif        # GIF rendered from that exact cast (agg)
    <angle>.baseline.cast / .gif   # ONLY in comparison mode
    frames/<angle>/*.png           # extracted frames for visual inspection
  runs/<angle>.json    # --format json event stream (authenticity proof)
  learnings.md         # phase 6.5: what each session actually did + taught (mined from the trace)
  blog.md              # phase 7: the post, clips embedded
  demo.html            # phase 7.5: self-contained page published as a Claude artifact
  REPLICATE.md         # exact steps for a reader to reproduce it
  MANIFEST.md          # phase 9: index of everything + trace ids
```

The blog markdown is ALSO copied to the Obsidian vault per the user's global rule:
`/Users/anandgupta/obsidian/altimate/Research/<topic>/<Title>.md`.

## Workflow

Track these as TaskCreate items so progress is visible. Each phase has a gate — don't
advance until it passes.

### Phase 0 — Frame
- Slugify the topic. Decide single clip vs **series of 2–4** (default: series).
- Create the output dir. Write down the *claim* you intend to prove in one sentence.

### Phase 1 — Deep research (grounded in real pain)
- Use the `deep-research` skill or `parallel:parallel-web-search` (fallback: WebSearch +
  WebFetch). Mine Reddit (r/dataengineering etc.), Hacker News, Stack Overflow, eng blogs.
- For each pain capture: a label, **1–2 verbatim quotes (<25 words) with source URLs**,
  a rough commonness signal, and a concrete scenario.
- Write `research.md`. **Gate:** at least one pain with a real, traceable quote.
- For a long/independent search, spawn a background `Agent` so you can author in parallel.

### Phase 2 — Critique the research (honesty gate)
- For each pain, name the **specific** altimate-code capability that addresses it (a real
  tool/skill — e.g. `sql_analyze`, `altimate_core_rewrite` w/ `verify_equivalence`,
  dbt lineage/cost skills, `check`, warehouse tools). Read `references/value-wedge.md`.
- Drop any pain where we don't genuinely win, or where the help is really infra/ops, not a
  terminal coding agent. Keep the **2–4 strongest "we win here"** angles.
- **Gate:** if nothing genuinely wins, STOP and report that honestly. Don't fabricate.

### Phase 3 — Design the demo(s)
- For each angle write, in `demo-spec.md`: the real fixture, the exact prompt to
  `altimate-code run`, the **value moment** (the single frame that makes the point), and the
  **mode** — showcase (default) or comparison. Only choose comparison if a `claude -p`
  control genuinely sharpens the point and altimate-code is expected to win; see
  value-wedge.md.
- Keep each clip scoped to ONE moment. If it needs a paragraph to explain, split it.

### Phase 4 — Build the real fixture
- A small but genuine project with a real bug/gap/decision the agent resolves. Not a toy
  with the answer pre-written. For PySpark, `scripts/setup_pyspark_fixture.sh` bootstraps a
  `local[*]` env (real execution, no cluster).
- **Gate:** the fixture runs and actually exhibits the problem before the agent touches it.

### Phase 5 — Record (real runs)
- **Showcase mode:** `scripts/record.sh <topic> <angle> --cwd <fixture> --banner '<prompt>'
  -- altimate-code run --yolo --trace '<prompt>'` records the real run with **asciinema** →
  `.cast`, then renders to `.gif` with **agg**. `vhs` is the optional scripted-polish
  fallback (see `references/recording.md`).
- **Authenticity comes from the SAME recorded run, not a re-run.** The clip's proof is that
  `.cast` PLUS the `--trace` written by *that* invocation (grab its trace id from the cast /
  `altimate-code trace list`). Do NOT run `altimate-code run --format json` a second time to
  "get the json" — a fresh agent run is nondeterministic and would authenticate a different
  session than the one on screen. (In comparison mode, `baseline_vs_altimate.sh` captures
  `--format json` from the very run it records, which is fine — one run, one artifact.)
- **Comparison mode (optional):** also run `scripts/baseline_vs_altimate.sh <topic> <angle>
  --cwd <fixture> --prompt '...' --reset-from <pristine>` to capture the `claude -p` control
  on the same prompt/model, and record its clip too.
- **Gate:** `.cast` + `.gif` (+ the recorded run's trace id) exist for the altimate run (plus
  the baseline variant in comparison mode).

### Phase 6 — Visual inspection (use your eyes)
- `scripts/inspect.sh <topic> <angle>` extracts key PNG frames. **Read them** and confirm:
  legible at embed size; the value moment is visible; no stack-trace garbage or dead air;
  timing is watchable. In comparison mode, also confirm the baseline genuinely struggles
  where altimate wins.
- Cross-check the frames against `runs/<angle>.json` / `trace view` — nothing shown may be
  absent from the real run. **Gate:** if any check fails, fix the fixture/tape and
  re-record. Loop here, don't paper over it in the blog.
- **If you also build an HTML demo page or publish an artifact, RENDER IT and look** —
  `chrome --headless=new --screenshot --window-size=W,H file://…`, then Read the PNG.
  Inspecting the clips is not inspecting the page; layout bugs (empty grid cells, GIFs that
  are mostly empty terminal) only show in the rendered page. See `quality-bar.md`.

### Phase 6.5 — Learn from the session
- Run `scripts/extract_learnings.sh <topic> <angle>` to mine the recorded session
  (`runs/<angle>.json` + the trace + the run log) into `learnings.md`: the tool/command
  sequence altimate-code actually ran, the value moment(s), anything surprising (a defect it
  caught, a bug it hit), and a one-line "why this matters." This is sourced from the REAL
  run, so it's both demo material AND a check on law #2 — if the "value moment" isn't in the
  extracted sequence, you don't have it.
- Two outputs from the learnings:
  1. **Into the blog** (phase 7): the "what it actually did" beat comes straight from here,
     not from your memory of the run.
  2. **Back into the skill / memory:** if the session taught something reusable — a product
     bug, an env gotcha, a prompt that reliably triggers the value behavior, a fixture
     pattern that works — append it to `MANIFEST.md`'s ledger and, if it should persist
     across sessions, save it to memory. Each demo run makes the next one sharper.

### Phase 7 — Write the blog
- Invoke `blog-writer` (structure/voice) and `viral-tech-blog` (hook/title/shareability).
  Use `templates/blog.md.tmpl` as the skeleton: open with the researched pain + a real
  quote, then **show what altimate-code did** (sourced from `learnings.md`) with the clip,
  and name the one capability that made it valuable. In comparison mode, add the
  baseline → after contrast; in showcase mode, the value stands on its own. Close with
  **Replicate it yourself** (exact commands — also write `REPLICATE.md`).
- Embed clips (GIF inline; link the `.cast` for copy-paste). Save `blog.md`, then copy to
  the Obsidian vault path above.

### Phase 7.5 — Publish as a Claude artifact
- **Load the `artifact-design` skill first** (required before authoring the page), and design
  a real visual identity — don't ship the generic dark-terminal / mono-headline default.
- Author the page as an HTML template (the blog content + the clips as
  `<img src="clips/<angle>.gif">`). Then make it self-contained:
  `scripts/build_artifact.sh <topic> <template.html> --render` inlines every clip as a base64
  data URI (the artifact CSP blocks external hosts) → writes `demo.html` and renders a
  screenshot.
- **RENDER-INSPECT before publishing** (this is mandatory, not optional — see the artifact
  checklist in `quality-bar.md`): Read the rendered PNG and confirm no empty grid cells, no
  mostly-empty GIFs, no horizontal scroll, legible type. Fix and rebuild until clean.
- Publish `demo.html` with the **Artifact** tool. On later edits, redeploy to the **same**
  file path so it keeps the same URL; keep the favicon stable across redeploys. Record the
  artifact URL in MANIFEST.md.

### Phase 8 — Critique loop
- Run the `humanizer` skill (kill AI-slop) and self-critique against
  `references/quality-bar.md`. Optionally run `consensus:review` on the draft.
- Loop back to the phase that failed (re-research, re-record, rewrite) until the bar is met
  or the budget is spent. **State residual weaknesses honestly** in MANIFEST.md.

### Phase 9 — Deliver
- Write `MANIFEST.md`: every clip + cast + frame dir, the blog (local + vault paths),
  REPLICATE.md, research sources, and the **trace ids** for each recorded run (so anyone
  can re-verify authenticity). Summarize what was proven and what wasn't.

## References (read when you reach the relevant phase)
- `references/value-wedge.md` — finding the real "why us" and designing an honest baseline.
- `references/recording.md` — asciinema/agg/vhs mechanics, Wait-for-completion, frames.
- `references/quality-bar.md` — the gate rubric for the demo and the blog.

## Reused skills (invoke, don't reimplement)
`deep-research` / `parallel:parallel-web-search` (phase 1), `blog-writer` + `viral-tech-blog`
(phase 7), `humanizer` + `consensus:review` (phase 8).
