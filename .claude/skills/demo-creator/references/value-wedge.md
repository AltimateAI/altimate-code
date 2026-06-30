# Finding the wedge (and an optional, honest baseline)

The whole demo hinges on one question: **what does altimate-code do here that's worth it —
and can we make a viewer SEE that in 20 seconds?** Sometimes the clearest way to show it is
altimate-code alone (showcase); sometimes it's a head-to-head with a generic agent
(comparison). Decide per angle; default to showcase.

## Step 1 — Map pain → a specific capability

A vague "it's an AI agent for data" is not a wedge. Tie each researched pain to a concrete,
named altimate-code capability that a generic agent lacks or does worse. Examples of real
capabilities to reach for (verify the tool/skill exists before you claim it):

- **SQL/transform equivalence** — `altimate_core_rewrite` with `verify_equivalence`,
  `altimate_core_equivalence`. Proves a rewrite didn't change results. Generic agents just
  *assert* equivalence.
- **Deterministic SQL checks** — `altimate-code check` (lint / validate / safety / policy /
  pii, no LLM). Catches issues a chat agent eyeballs and misses.
- **dbt-native understanding** — lineage, impact, cost-attribution, scheduling skills;
  compiled-SQL awareness (not regex over Jinja).
- **Warehouse cost intelligence** — finops skills, dry-run cost, full-scan/spill detection.
- **Multi-warehouse schema awareness** — real schema introspection vs guessing column names.

If the pain you found doesn't map to one of these (or another real, demonstrable
capability), it is **not a demo angle**. Cut it. A demo of a generic capability any agent
has tells the viewer nothing about why to choose us.

## Step 2 — Pick the mode

**Showcase (default).** Show altimate-code doing the task, and let the specific thing it
does carry the value: it runs the SQL and diffs the output, it runs `check` and flags a real
defect, it traces lineage and shows the blast radius, it proves equivalence. The viewer sees
the value directly. No second agent. Use this whenever the capability is self-evidently
useful on its own — which is most of the time.

**Comparison (optional).** Add a **claude-code** (`claude -p`) control on the same
prompt/fixture/model only when the value *is* the contrast — "a general agent skips this
step; altimate-code doesn't." It answers "I already have Claude Code; why switch?" but it
costs you a fair-test burden (below) and only works if altimate-code actually comes out
ahead. If unsure, start showcase; add the comparison only if the contrast turns out real.

If you do compare, keep it FAIR and ATTRIBUTABLE: same model, same prompt, same fixture, so
the only difference is altimate-code. Hold the model constant (`--model` / `--baseline-model`).
A fallback control is **capability-disabled in-fork** (`--baseline-mode disable --baseline-deny
<tool>`), useful to isolate one specific tool. Never give the baseline a worse model, vaguer
prompt, or broken env — a rigged contrast is worse than no contrast.

## Step 3 — The honesty gate

Watch the real run(s). Then:

- **Showcase:** did altimate-code actually do the valuable thing on camera (the diff ran, the
  defect was flagged, equivalence was proved)? If yes → ship. If it only *claimed* to, or
  didn't get there → no demo yet; change the task or report honestly.
- **Comparison:** altimate clearly ahead → ship the contrast. Tie/marginal → drop the
  comparison (you may still ship the showcase) and say so. Baseline wins/altimate regresses →
  do not ship a contrast; report it — a real product finding beats a fake demo.

## Step 4 — Name the value moment

Every clip needs ONE frame you could freeze and put on a slide: equivalence VERIFIED; `check`
flagging a real defect; the SQL-vs-output `diff` coming back zero; lineage showing the blast
radius. In showcase mode that frame stands alone; in comparison mode it's the frame the
baseline never produces. Design the prompt so that moment happens on camera. If you can't
name the value moment, the demo isn't ready.
