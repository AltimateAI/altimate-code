# Recording mechanics: asciinema + agg (primary), vhs (fallback)

## Why this stack

- **asciinema** records the **real pty session** — including when you run it inside iTerm.
  Output is a `.cast` (JSON-lines of timing + bytes): copy-pasteable, replayable, and a
  faithful record of what actually happened. This is the authenticity anchor.
- **agg** renders a `.cast` to an animated `.gif`. Crucially it renders the **captured real
  run**, so the GIF is the real session — not a re-execution.
- **vhs** is a *scripted* recorder: it re-runs the command in its own synthetic terminal.
  Use it only when you want a perfectly clean, deterministic "polished" version and you've
  already proven the real behavior with an asciinema cast. Never let vhs output be the only
  evidence a thing worked.

Install once: `brew install asciinema agg` (vhs already present: `brew install vhs`).

## Primary path — record a real run

`scripts/record.sh` wraps this. The essence:

```bash
# Record the real command. asciinema runs it and captures everything.
asciinema rec --overwrite --command "<the real command>" clips/<angle>.cast
# Render that exact cast to a GIF.
agg --cols 100 --rows 30 --font-size 22 clips/<angle>.cast clips/<angle>.gif
```

Keep the terminal small (≈100×30) so the GIF is legible when embedded. Set a readable
font size. For long agent runs, prefer non-interactive `altimate-code run --yolo` so the
session ends on its own (asciinema stops when the command exits).

### Handling long / nondeterministic agent runs
- Use `altimate-code run --yolo --max-turns N` so it can't run away.
- Trim dead air after the fact if needed: edit the `.cast` (it's just timed events) or use
  `asciinema` quantize-style trimming; agg has `--idle-time-limit` to cap long pauses:
  `agg --idle-time-limit 2 ...` collapses gaps >2s. This keeps clips watchable without
  faking anything — it only compresses waiting, not output.

## Fallback path — vhs (scripted polish)

A `.tape` drives a synthetic terminal. Useful patterns (vhs ≥0.11 supports these):

```
Require altimate-code
Output clips/<angle>.gif
Set FontSize 22
Set Width 1000
Set Height 600
Type "altimate-code run --yolo 'PROMPT'"  Enter
Wait@180s /Done|✔|session ended/        # wait for a completion marker, not a fixed sleep
Screenshot clips/frames/<angle>/value-moment.png
Sleep 2s
```

`Wait@<timeout> /regex/` blocks until output matches — essential because agent runs vary in
length. `Screenshot` grabs a frame at that instant (no ffmpeg needed). Because vhs re-runs
the command, treat its GIF as illustrative and keep the asciinema cast as the real record.

## Extracting frames for visual inspection (`scripts/inspect.sh`)

From a GIF:
```bash
ffmpeg -i clips/<angle>.gif -vf "fps=1" clips/frames/<angle>/f_%03d.png   # 1 frame/sec
```
Then `Read` the PNGs to verify legibility and the value moment. Also dump a few from the
baseline GIF so you can eyeball the contrast side by side.

## Authenticity cross-check
After recording, reconcile the clip with the real run:
- `altimate-code trace list` → find the session; `altimate-code trace view <id>`.
- Or read `runs/<angle>.json` (the `--format json` event stream).
The tools the clip appears to call, and the result it shows, must be present there. If the
GIF shows a verified-equivalence badge, the json/trace must contain that verification event.
