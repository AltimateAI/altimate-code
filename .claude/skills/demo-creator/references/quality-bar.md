# Quality bar — the gate for demo + blog

Score each item. If any **must-pass** fails, loop back and fix; do not ship.

## The demo (clip)

Must-pass (both modes):
- [ ] **Real.** The clip reconciles with the session trace / `--format json`. Nothing shown
      is absent from the real run.
- [ ] **Value is shown.** altimate-code visibly *does* the valuable thing on camera (runs the
      diff, flags the defect, proves equivalence) — not narrated, not merely claimed. It's in
      `learnings.md`'s value-moment evidence, or you don't have it.
- [ ] **Legible.** Text is readable at the size it'll embed; no clipped lines.
- [ ] **One moment.** A single freezable frame makes the point.

Must-pass (comparison mode only):
- [ ] **Fair baseline.** claude-code (`claude -p`), same model + prompt + fixture; the only
      difference is altimate-code itself. Baseline failure is the *natural* result, not a
      strawman (no sabotaged prompt).
- [ ] **altimate actually comes out ahead.** Visible, not narrated. If it ties or loses, drop
      the comparison and ship showcase-only (or report it) — see value-wedge.md.

Should-pass:
- [ ] ≤ ~45s of watchable content; dead air trimmed (idle compression only, no faking).
- [ ] The value moment lands in the first half of the clip.

## The blog

Must-pass (anti-slop — the `humanizer` skill enforces most of these):
- [ ] Opens with a **real pain + a real quote** (sourced), not "In today's data landscape…".
- [ ] **Shows, doesn't claim.** Showcase: the clip shows altimate-code doing the valuable
      thing. Comparison: the baseline → after contrast is in the clip. Either way, demonstrated.
- [ ] Names the **specific capability** that made the difference (not "AI magic").
- [ ] Has a **Replicate it yourself** section a reader could actually follow to the same
      result (exact commands; matches REPLICATE.md / the fixture scripts).
- [ ] **Honest about limits.** Says where it wouldn't help / what the baseline got right.
- [ ] No feature-list dump, no rule-of-three filler, no "delve/leverage/seamless", minimal
      em-dashes, no fabricated metrics.

Should-pass (the `viral-tech-blog` layer):
- [ ] A title that states the surprising result, not the topic.
- [ ] One quotable stat or coined phrase a reader could repeat.
- [ ] A first line that hooks (the surprising claim or the pain), not a throat-clear.
- [ ] An ending that invites discussion (a question, a tradeoff, a "where this breaks").

## The rendered page / HTML artifact (if you build one)
Inspecting the clips is NOT inspecting the page. If you produce an HTML demo page or
publish an artifact, you MUST render the actual page and look at it:
- [ ] Render it (`chrome --headless=new --screenshot --window-size=W,H file://…`) and Read
      the PNG. Don't trust that the markup "looks right" in source.
- [ ] No empty/dead layout cells — a common bug is an N-column grid with content in only
      one cell (check every `grid-template-columns` has a child per column).
- [ ] Embedded GIFs aren't mostly empty space. A static screenshot shows GIF frame 1
      (often a near-empty terminal); that's an artifact of the capture, but ALSO re-render
      the GIF at a row count that matches its real content so the live clip isn't 80% void
      (e.g. `claude -p` print-mode output is tiny — crop it with `agg --rows`).
- [ ] Page body never scrolls sideways; wide blocks have their own `overflow-x:auto`.
- [ ] Self-contained: assets embedded as data URIs (artifact CSP blocks external hosts).

## Series-level (when shipping multiple clips)
- [ ] Each clip is independent and proves a distinct capability.
- [ ] Together they tell one coherent "this is why altimate-code" story.
- [ ] No clip repeats another's value moment.

## Honesty ledger (always write into MANIFEST.md)
- What was proven, with which trace ids.
- What was NOT proven / where altimate tied or lost.
- Any idle-trimming or edits applied to clips (and confirmation no output was fabricated).
