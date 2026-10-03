# Learning reminder

When learning is off, the interactive TUI can show one quiet reminder after two
user corrections in a session, on the first idle event after the second correction.
It uses the existing local correction classifier, loaded lazily in the TUI. It
does not call a model, capture signals, or save message text, correction counts,
or classifier results. Counts are per session and disappear when the TUI exits.
Only messages following a completed assistant turn count.

The reminder never runs in `run`, JSON output, CI (including an empty `CI`
environment variable), or with non-TTY input or output. It is suppressed when
`learn.capture` is true or `ALTIMATE_LEARN_CAPTURE` enables capture.
It is also suppressed in `attach`: a remote server's capture environment is
not available to the TUI, and the suggested local enable command may not apply
to that server. Locally launched TUIs share their worker's capture environment.

Apart from delivery of already-approved lessons (which writes `.sessions/`, `shown.jsonl` and `usage.json`), the exception to “learning off writes no learning state” is
`learn-nudge.json` in the global state directory (`$XDG_STATE_HOME/altimate-code`,
normally `~/.local/state/altimate-code`). It contains only `shownProjectHashes`,
`totalCount`, and `dismissed`. The reminder is limited to once per project and
three times across all projects. A project is identified by a SHA-256 hash of
its existing project ID (shared by linked worktrees), with a canonical root
path fallback for directories without a repository. Neither the ID nor the raw
path is stored.

Updates use an exclusive sibling staging file and atomic rename, so concurrent
TUIs share the same limits. No project learning files are created. If state
cannot be safely read or updated, the reminder is skipped. An interrupted
staging write is left in place rather than risking concurrent replacement.

The TUI's toast has no dismissal button. It includes the command
`altimate-code learn nudge off` as its “Don't show again” action. That command
and `altimate-code learn enable` permanently dismiss reminders in all projects,
including after learning is subsequently disabled.
