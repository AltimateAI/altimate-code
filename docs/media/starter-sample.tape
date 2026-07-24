# VHS tape — recording of the /starter sample materialization outcome.
#
# Renders docs/media/starter-sample.gif. Records what a user actually gets
# after they pick "Open sample project" from the first-run activation
# dialog: a materialized dbt project at ~/altimate-sample-dbt/ with a
# pre-compiled manifest that /discover and /review can walk without any
# external tools installed.
#
# NOT recorded here: the interactive TUI dialog itself. That path requires
# a live-authed session (the dialog gates on `useReady()` which needs a
# real provider or the setupComplete signal from finishing OAuth).
# Scripting that in VHS needs an auth-mock harness we don't have yet —
# tracked as a follow-up. This recording proves the LEAF flow (sample
# materialization) is working end-to-end against the shipped asset
# resolver + marker + copy logic committed in Phases 3 & 4a.
#
# The bun one-liners are wrapped in a helper script
# (starter-sample-demo.sh) because VHS's `Type` command can't reliably
# escape long nested-quote shell one-liners.
#
# Render:  vhs docs/media/starter-sample.tape
# Cleanup: the demo script cleans up its own $HOME/altimate-sample-demo
#          directory at the end.

Output docs/media/starter-sample.gif

Set Shell "bash"
Set FontSize 14
Set Width 1000
Set Height 640
Set Theme "Builtin Solarized Dark"
Set PlaybackSpeed 1.2

Env REPO_ROOT ""

Hide
Type "cd $(git rev-parse --show-toplevel) && export REPO_ROOT=$(pwd) && rm -rf $HOME/altimate-sample-demo && clear"
Enter
Show
Sleep 400ms

# Materialize
Type "# Materialize the shipped starter sample (what /starter does inside the TUI)"
Enter
Sleep 400ms
Type "bash docs/media/starter-sample-demo.sh materialize"
Enter
Sleep 3500ms

# List
Type "clear && echo '== Contents of the materialized sample ==' && bash docs/media/starter-sample-demo.sh list"
Enter
Sleep 2500ms

# Full tree
Type "clear && echo '== dbt project shape ==' && bash docs/media/starter-sample-demo.sh find"
Enter
Sleep 3000ms

# Marker
Type "clear && echo '== .altimate-sample.json (conflict-detection marker) ==' && bash docs/media/starter-sample-demo.sh marker"
Enter
Sleep 3500ms

# Manifest presence
Type "clear && echo '== target/manifest.json size (pre-compiled — /discover + /review use this) ==' && bash docs/media/starter-sample-demo.sh manifest-size"
Enter
Sleep 2500ms

# README
Type "clear && echo '== README (what to try) ==' && bash docs/media/starter-sample-demo.sh readme"
Enter
Sleep 4500ms

# Reuse
Type "clear && echo '== Second call → reuses existing dir, no re-copy =='"
Enter
Type "bash docs/media/starter-sample-demo.sh reused"
Enter
Sleep 4000ms

Hide
Type "bash docs/media/starter-sample-demo.sh cleanup"
Enter
Show
Sleep 200ms
