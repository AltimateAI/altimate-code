# Learning reminder

`learn.enabled` is the master switch and defaults to `true`. The shared
`learnEnabled` helper in `config.ts` resolves it; `ALTIMATE_LEARN=0`/`false`
disables and `1`/`true` enables, case-insensitively, overriding config in both
directions. When disabled, lesson delivery and its `.sessions/`, `shown.jsonl`
and `usage.json` writes, capture, scheduling, automatic reflection, startup
recovery and the TUI reminder do not start. Explicit `learn` commands still
work. `learn status` reports the switch, and `learn enable` sets capture and
automatic reflection without changing it, explaining if learning stays disabled.

When capture is off and the master switch is on, the interactive TUI can show one
quiet reminder after two user corrections in a session, on the first idle event
after the second correction.
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

With capture off and the master switch on, already-approved lessons are still
delivered (writing `.sessions/` and possibly `shown.jsonl` and `usage.json` when
lessons are shown). The reminder can also write
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
