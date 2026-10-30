---
title: Learn — Team Conventions from Corrections — Altimate Code
description: "Turn your corrections, repeated tool failures, and PR review comments into short, human-approved rules that Altimate Code loads into every relevant session."
---

# Learn

`altimate-code learn` turns feedback you already give into short rules and puts the relevant ones in front of the agent at the start of later sessions. The feedback comes from your corrections in chat, tools that keep failing, and review comments on merged GitHub pull requests. A rule looks like this: ``Convert `*_cents` columns to dollars in staging models.``

By default nothing becomes a rule until a person approves it, and the agent never has to decide to look a rule up. The harness selects the rules and adds them to the prompt. If you opt in to [fully automatic mode](#fully-automatic-mode), small candidates that pass every safety gate go live without review, and `learn rollback` undoes them.

Capture and reflection are off by default: nothing is recorded or sent to a model until you run `learn enable`, except in a project linked to an Altimate workspace whose "Learn from sessions" is on (see [Workspace rules](#workspace-rules)). Rules that a project already has approved are delivered, and a one-time reminder can suggest trying learn; `learn.enabled: false` (or `ALTIMATE_LEARN=0`) turns all of it off.

## Quick start

```bash
# 1. Turn it on for this project
altimate-code learn enable

# 2. Work normally. When you correct the agent, a signal is recorded locally.
#    Corrections are turned into candidate rules automatically (see "How it works").

# 3. See what has been captured and what is waiting
altimate-code learn status

# 4. Review the candidate rules and the diff against the approved set
altimate-code learn show

# 5. Approve them
altimate-code learn promote
```

To skip step 5 for small, safe candidates, run `altimate-code learn enable --auto-promote` instead of step 1. See [Fully automatic mode](#fully-automatic-mode).

Start the next session and the approved rules that match your request are in the prompt.

To start from history instead of waiting for new corrections, run `learn bootstrap` (past sessions in this project) or `learn import-reviews` (merged GitHub PRs). Both show what they will send and ask first. See [Commands](#commands).

## How it works

```
 capture ──► reflect ──► curate ──► review & promote ──► delivery
 signals     one model    lint,       you read the diff    core + retrieved rules
 on disk     call per     redact,     and approve          at session start, extra
             batch        dedupe,                          rules per request and
                          resolve                          per file, frozen per session
                          conflicts
```

### 1. Capture

With `learn.capture` on, four kinds of signal are written to `.altimate-code/learn/team-playbook/signals.jsonl`:

| Signal | When it is recorded |
|---|---|
| `user_correction` | A message of yours that follows a completed assistant turn and matches the correction classifier. The first message of a session is a task, never a correction. |
| `tool_retry` | The same tool fails three times in a row. |
| `review` / `ci` | You record it with `learn signal add`, or `import-reviews` records it from PR review comments. |
| `user` | You record it with `learn signal add --kind user`. Feedback passed to `learn reflect --feedback` is used for that reflection only and is not stored as a signal, so a failed reflection does not keep it. |

The correction classifier is a fixed list of text patterns ("that's wrong", "we always...", "use X instead of Y", "you forgot..."). It does not call a model. It favours precision over recall: a missed correction costs one rule, a false one adds noise. Thanks, "LGTM", and ordinary questions are not corrections.

Every signal is redacted for secrets and clipped to 2,000 characters before it is stored. Signals are stored only on your machine; reflection sends them to the model provider you use.

### 2. Reflect

Reflection is one model call that reads a digest of the session plus the open signals and proposes edits to the rule list. It runs when `learn.auto_reflect` is on, or when you run `learn reflect`.

| Trigger | Behaviour |
|---|---|
| End of `altimate-code run` | Reflects on that session's open signals before the command exits. |
| Threshold | In the TUI, when a session goes idle with 3 or more open signals. |
| Idle | In the TUI, 10 minutes after the session goes idle, if it still has open signals. New activity cancels the timer. |
| Startup recovery | Signals left over from earlier sessions are reflected on after the first idle of a new session, not during the first turn. Default limit: 3 reflections and 300 seconds per process. |
| Manual | `learn reflect --session <id>`, `--pending`, or with `--feedback`. |

Exiting the TUI saves signals but never waits on a model. A failed reflection is retried at the next trigger (a new signal, the next idle period, or the next startup) once its backoff has passed (1 minute, then doubling, capped at one day). Nothing retries on a timer. Only one process works on a given batch of signals at a time.

**What the model sees**, all redacted:

- the current rules, with ids and helpful/harmful counters;
- a digest of the session, capped at 24,000 characters (your prompts, tool calls with clipped inputs and outputs, the files written, the final message);
- the feedback, capped at 12,000 characters.

The reflector is told to treat the digest and feedback as untrusted data, to learn only from the external feedback, and to prefer no change. It runs with temperature 0 and no tools. The model is `learn.model` if set, otherwise the model the session used.

### 3. Curate

The model's proposals are not applied directly. A deterministic curator checks each one:

- **Lint.** A rule must be one line, at most 140 characters. It is rejected, not repaired, if it contains a shell command, a URL, a markdown link, an email address, an absolute path or `..`, a session or message id, a comment marker, text that looks like prompt injection, or something that looks like a secret.
- **Redaction.** Rule text echoed back in reports is redacted again. Other model output in reports and `history.jsonl` (rejected proposals, removal reasons) is not filtered a second time; the model only saw redacted input.
- **Dedupe.** A new rule that is at least 60% similar (word overlap) to an existing one is counted as "helpful" on the existing rule instead of being added.
- **Contradictions.** If a new or edited rule shares a code identifier in backticks (for example `` `amount_cents` ``) with an existing rule, it must say that it supersedes it or coexists with it. Two silent versions of the same rule are not allowed. A rule the reflector marks harmful and replaces in the same reflection is superseded implicitly. Superseded rules move to a retired list.
- **Replacement step.** If a rule is removed because it was wrong and no replacement was proposed, one narrow model call writes the corrected rule, or answers "none". Failures are queued for the next reflection.
- **Counters and removal.** Each rule has helpful and harmful counters. A rule is removed automatically only when it has at least two harmful marks, more harmful than helpful, from at least two different pieces of feedback.
- **Limits per reflection.** At most 3 added, 3 edited, 3 removed rules. Rules superseded implicitly by a replacement are not counted against the removal limit.
- **Store cap.** When the store passes `learn.max_stored`, the lowest-scoring rules are evicted. Pinned rules are not.
- **Verification flags.** A rule that mentions skipping, ignoring, or disabling tests, checks, CI, or review is not rejected. It is flagged, and flagged rules need explicit approval at promote.

The result is saved as a **candidate** (`candidate.json`). It has no effect on any session yet.

!!! note
    Overlap detection only sees identifiers inside backticks. A contradiction written in plain prose relies on the reflector and the replacement step to catch it.

### 4. Review and promote

You are the gate.

```bash
altimate-code learn show      # approved rules, candidate, flags, and a diff
altimate-code learn promote   # shows the diff again, asks to confirm
```

`promote` re-checks the candidate before it goes live: every rule is linted again, overlaps are checked again, and the candidate must be the same one whose diff you were shown. If the candidate changed in the meantime, promote stops and asks you to review again. The previous approved set is archived, so `learn rollback` can restore it.

Flagged rules (see verification flags above) appear as `WARNING` lines in the diff. Interactively, confirming the prompt approves them. In scripts, `promote --yes` refuses a candidate with flagged rules unless you also pass `--allow-flagged`. Outside a terminal, `promote` without `--yes` refuses to run.

### Fully automatic mode

Off by default. With `learn.auto_promote` on, a candidate that automatic reflection has just staged goes live without `learn promote` when every gate below passes. Learning then runs on its own: you correct the agent, reflection turns the correction into a rule, the rule is promoted, and the next session gets it.

```bash
altimate-code learn enable --auto-promote
```

This writes `learn.capture`, `learn.auto_reflect` and `learn.auto_promote` to the project config. Automatic promotion needs all three: `learn.auto_promote: true` or `ALTIMATE_LEARN_AUTO_PROMOTE=1` alone does nothing while capture or automatic reflection is off. `ALTIMATE_LEARN_AUTO_PROMOTE=1` or `0` overrides the config for one process.

`learn disable` writes `false` for all three, but environment variables override config: with `ALTIMATE_LEARN_CAPTURE`, `ALTIMATE_LEARN_AUTO` and `ALTIMATE_LEARN_AUTO_PROMOTE` set to `1`, automatic promotion stays on (`learn disable` reports which setting keeps learning active). `learn.enabled: false` or `ALTIMATE_LEARN=0` turns everything off, whatever the other settings say.

It runs only after automatic reflection (end of `run`, threshold, idle, startup recovery) on the default store, `team-playbook`. `learn reflect`, `learn bootstrap` and `learn import-reviews` always stage a candidate for review.

**Gates.** All must pass. Otherwise the candidate stays staged, the reason is recorded, and you review it as usual.

| Gate | Holds the candidate back when |
|---|---|
| Same candidate | The candidate is not exactly the one this reflection staged (it was edited, replaced, promoted, or rejected in the meantime). |
| Only this reflection | The candidate already had rule changes waiting for review before this reflection: from `learn reflect`, `bootstrap`, `import-reviews`, or an earlier candidate that was held back. |
| Validation | It fails the checks `learn promote` runs: lint, hidden characters, coexistence, and overlaps. |
| Feedback | No signal from a person or an external check is behind the reflection: it needs at least one correction (`user_correction`, including `learn signal add --kind user`), `review` or `ci` signal. Repeated tool failures (`tool_retry`) are captured automatically, so on their own they only stage a candidate. Also held when the feedback was flagged as an instruction to the model. |
| Verification flags | A rule it adds or changes mentions skipping or disabling verification. Those always need a person. |
| Your approvals | It would edit or remove a rule a person approved. A rule counts as automatic only while the approved set is exactly what the last automatic promotion published and the rule is not pinned. Any `learn promote`, `rollback`, `pin` or `unpin` makes every approved rule person-approved for good, even if the set later returns to the same contents; if that cannot be recorded, the command fails and changes nothing. A change to `approved.json` from outside learn, such as a pull, also makes them person-approved. Rules from another checkout count as person-approved. |
| Size | It adds, edits, or removes more than `learn.auto_promote_max_changes` rules (default 3), or changes only counters. |
| Rate | The store already had `learn.auto_promote_daily` automatic promotions (default 5) in the last 24 hours. |

A held-back candidate stays held: later reflections add to the same candidate, and it waits for you until you promote or reject it. Automatic promotion resumes after that.

Helpful and harmful counters on rules a person approved do not change with an automatic promotion, because they decide which rules fill the core tier. Those counter updates stay in the candidate for your next review. `learn show` lists them in the diff, and the next `learn promote` applies them. They do not block later automatic promotions.

**Seeing what happened.** At the end of `run`, the outcome line says which way it went:

```
learn: 1 signal -> +1 added; auto-promoted (previous rules archived as v3). Undo with `altimate-code learn rollback`
learn: 1 signal -> +1 added; staged .altimate-code/learn/team-playbook/candidate.json for review (not auto-promoted: daily limit reached (5 automatic promotions in 24 hours; learn.auto_promote_daily=5)), review with `altimate-code learn show`
```

The TUI has no outcome line. `learn status` shows whether automatic promotion is on, the last automatic promotion with the rules it added or changed and the ones it removed, and the last reason a candidate was held back (cleared by the next successful automatic promotion). A promotion that could not finish is not listed. When another process held the learn lock for the whole wait, the reason is not recorded; the outcome line still has it. `learn show` marks automatically promoted rules `(auto-promoted)`. History records each one as an `auto-promote` entry with the rule ids, removed ids, and the number of signals.

The state behind this is `.altimate-code/learn/<name>/auto-promote.json`. If it cannot be read, automatic promotion stops, `learn status` says so, and `learn promote`, `rollback`, `pin` and `unpin` refuse to run until it is fixed or deleted. Deleting the file restarts it, but it also resets the daily limit and makes every rule count as person-approved.

**Undo.** Each automatic promotion archives the previous approved set like `promote` does, including an empty set the first time, so `altimate-code learn rollback` restores the set from before the last promotion. Run it again to go back further. Like any rollback, it also discards the staged candidate (including counter updates waiting for review), the harmful marks, and the pending replacements; the signals they came from were already consumed.

**Why manual review stays the default.** In our benchmark, stale or contradicting rules were the one thing that hurt: 4 real rules plus 4 contradicting ones passed 1/9, and outdated rules left in place passed 0/9 (see [Benchmarks](#benchmarks)). A wrong rule is delivered to every later session until someone removes it. The gates make a bad automatic promotion small, rare, and easy to undo, but they cannot judge whether a rule is right. Approved rules live in `approved.json`, which is shared through Git, so read the diff before you commit it.

Automatic promotion runs no project command of its own (such as a test suite) before promoting.

### 5. Delivery

Only approved rules are ever delivered. Delivery is part of the prompt loop, not a tool the agent calls.

| Tier | What | Default | How it is chosen |
|---|---|---|---|
| Core | Rules added to every session | 15 (`learn.core_lessons`) | Pinned rules first, then highest helpful minus harmful. |
| Retrieved | Rules relevant to the first request | 15 (`learn.retrieved_lessons`) | Keyword search (BM25) over rule text, tags, and path triggers, against your first message plus any project files it names. |
| Per request | New rules relevant to a later message | 5 (`learn.request_lessons`) | Same search on each new message. Rules whose path triggers match a file the session has touched or the message names rank first. Added to that message as "Team rules for this request". |
| File hook | Rules that match a file the agent reads or edits | 5 per event (`learn.file_lessons`) | The rule's path trigger matches the file, or an identifier in the rule matches the file name. The most specific trigger wins: `models/staging/*.sql` ranks above `models/**`, so broad rules cannot crowd out narrow ones. Added to that tool result. |

The core and retrieved rules are rendered once, as a "Team rules" section, and **frozen for the session**: the text does not change on later turns, so the start of the prompt stays identical and can be cached by the provider. Later additions are appended to messages and tool results, never inserted into the earlier prompt. A rule is shown at most once per session, and no more than `learn.session_max_lessons` (40) are shown in total. After a compaction, the section is rebuilt from every rule shown so far.

A rule with path triggers is shown with its scope, for example `[applies to: models/staging/**] Convert *_cents columns with cents_to_dollars`, so the agent can tell when a retrieved rule does not apply to the file in front of it.

The agent never fetches a rule. If the rule is selected, it is in context. If it is not selected, the agent has no way to ask for it.

Delivery runs whenever approved rules exist in the project, even if `learn.capture` is later turned off. A person already approved them.

Delivery waits at most about 5 seconds for the learn lock; if another process still holds it, that request goes without rules. A store whose `approved.json` cannot be read is skipped and the others are still delivered. Every rule is checked again at delivery, including rules committed to the repository by hand: rules over 140 characters or rejected by the curator's lint are left out, and per-request and per-file notes are limited by `learn.budget_tokens`.

## Workspace rules

In a project linked to an Altimate workspace (`altimate-code link`), what you teach the agent can become a **team rule**: a one-line instruction every teammate's sessions in the workspace's repositories follow once the workspace owner approves it.

**When a rule is proposed.** A card appears above the input when:

- you correct the agent on the same topic in 2 or more sessions (also before the workspace has any rule);
- you correct a team rule the session was shown (the card proposes changing it, with the current text struck through);
- you ask the agent to remember something as a rule (the card appears as soon as the agent saves it, always as a new rule: changing a team rule comes from correcting it).

Cards are shown by the TUI and by the VS Code extension from its release with workspace rules, for the project they have open and in its top-level sessions. Where no attached client shows cards (`altimate-code run`, ACP, the Claude Code and Codex plugins, a subagent's session), the save tools work as they did before cards: a rule is saved for this project only, a memory to memory, and nothing goes to review; corrections are kept, and proposed the next time that session runs with a client that shows cards. A card you asked for ("remember …") that closes without an answer (after a day, or when the session server stops) is saved the same way. Requests are kept in the project's rules state while their card is open: if the server exits unexpectedly, or a save fails for a passing reason (a busy disk, a lock), the next session server that opens the project saves them. A request is dropped, with a log line, only when it can never be saved as asked (the project's memory or training is full, or the text is too long for a memory block). While 50 requested cards are open, a new request is saved right away instead of raising a card.

The card never blocks the input: keep typing, and answer it when you are ready. **ctrl+x p** (or a click) moves to the card; **←/→** choose an action, **Enter** confirms, **Esc** goes back to typing. The card shows the proposed wording, what it applies to, why it was proposed and your correction. **Enter** on the first action sends it to the owner's review queue (the workspace's **Rules** tab); for the workspace owner, it approves it at once instead. **e** edits the wording, and **n** ("Not a rule") stops a correction's topic from being proposed for 30 days (on a card you asked for, it just closes it). A rule that tells the agent to skip or disable verification (tests, CI, hooks, `--no-verify`) is flagged: the owner approves it with "Approve anyway", which takes a second Enter (a client answers it with the `approve_anyway` action; a plain `approve` is refused). Nothing reaches a teammate until it is approved. A card nobody answers is dropped when the session server stops, and after a day (an answer after that closes it instead). A card is answered for the account and workspace it was shown for: after signing in as someone else or relinking, it closes without sending anything.

**Rule or memory.** A personal preference ("I prefer CTEs") or a fact ("our warehouse is Snowflake") is saved to memory without review. When the wording does not say which, the card asks: Memory, Team rule, or Skip.

**Where they live.** Approved team rules are mirrored into the `workspace-rules` store (`.altimate-code/learn/workspace-rules/`), which is git-ignored and written only by sync: the name is reserved for it, and a store you create needs another `--name`. Your other stores, including one named `team`, are not touched. Team rules stop being delivered when the project is unlinked, when you sign out, when the workspace refuses access, and while workspaces are turned off (`ALTIMATE_DISABLE_WORKSPACE`); they come back with the next sync.

**After review.** Approved rules reach new sessions, and new requests and files in running ones, within a few minutes (a pull at session start and every 5 minutes; `/rules` → Sync now, or `altimate-code learn sync`). A session keeps the wording it was already shown. You see a notice when the owner approves or rejects your rule, with the reason. Usage is reported back to the workspace: how many sessions a rule was applied in, and how often you corrected the agent on its topic after it was shown ("corrected again").

**Learning on or off.** In order: the learning kill switch (`learn.enabled`, `ALTIMATE_LEARN`), `ALTIMATE_LEARN_CAPTURE`, a `learn.capture` your organization sets (managed config, MDM, the account's config, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR` or the home `~/.altimate-code` config; shown as "organization policy"), your `/rules` → "Turn learning on/off for me" choice, `learn.capture` (`learn enable` / `learn disable`), then the workspace's "Learn from sessions". The `/rules` choice is yours alone: it is kept in the project's git-ignored rules state, not in the project config, so it never reaches a teammate through a commit ("Follow the workspace setting again" clears it). It takes effect right away. Approved rules are delivered either way.

**Commands.** `/rules` in the TUI lists team rules and your proposals with their status. `altimate-code learn sync` syncs now; `learn status` shows the workspace rules line, your learning setting and the last proposal check. In a linked project, `learn bootstrap` and `learn import-reviews` list the rules they staged from history and ask before sending them to the owner's review in the named workspace (default no). Without a terminal, `--send-for-review` sends them; `--yes` only confirms the model step. Declined rules stay local candidates (`learn show`, `learn promote`).

## Learn vs memory vs a knowledge base

| | Learn (rules) | [Memory](../data-engineering/tools/memory-tools.md) | Knowledge base |
|---|---|---|---|
| What it holds | Short behavioural rules: "do X, not Y" | Facts and notes the agent chooses to save (warehouse config, decisions) | Reference material: docs, schemas, runbooks |
| Who writes it | The learn pipeline from evidence (corrections, failures, reviews) | The agent, when it decides to | People, or ingestion of existing documents |
| How it reaches the agent | The harness selects relevant rules and puts them in the prompt | Loaded at session start and read or written through memory tools | Searched or retrieved on demand |
| Quality control | Lint, redaction, dedupe, conflict handling, human approval | The agent's judgement | Editorial process |
| Changes behaviour? | Yes, that is its purpose | Sometimes, indirectly | No, it informs |
| When to use | "Stop making this mistake" | "Remember this fact" | "Look this up" |

Use learn for rules your team enforces that the agent keeps getting wrong. Use memory for facts about your setup that you do not want to repeat. Use a knowledge base for material that is too large or too detailed to put in a prompt, where the agent should look things up when needed.

Learn does not depend on the agent calling a tool. Memory tools and skills that are pulled on demand only help when the model decides to read them. In our own test the agent never opened a pull-style playbook skill in 2 of 12 relevant runs, and both of those runs failed. Learn selects rules before the model runs, so there is no such miss at the delivery step. (Selection can still miss; see [Limitations](#limitations).)

## Commands

All subcommands take `--name <store>` (default `team-playbook`) except `enable`, `disable`, and `nudge off`. Each store is a separate rule set in `.altimate-code/learn/<name>/`.

### enable / disable

Writes `learn.capture` and `learn.auto_reflect` to the project config (with `--auto-promote`, also `learn.auto_promote`): the highest-precedence existing config file for the current directory, including one in a subdirectory, or `.altimate-code/altimate-code.json` if none exists. `enable` also permanently dismisses the learning reminder in all projects. If another setting still keeps capture off after the write (an environment variable, or a user or global config), `enable` names it and exits with an error.

```bash
altimate-code learn enable
altimate-code learn enable --auto-promote
altimate-code learn disable
```

| Flag | Description |
|---|---|
| `--auto-promote` | Also turn on [fully automatic mode](#fully-automatic-mode). Without the flag, `enable` leaves an existing `learn.auto_promote` setting as it is. |

`disable` stops capture, automatic reflection, and automatic promotion. It does not delete anything, and approved rules keep being delivered. Environment variables (`ALTIMATE_LEARN_CAPTURE`, `ALTIMATE_LEARN_AUTO`, `ALTIMATE_LEARN_AUTO_PROMOTE`) override the written config; `ALTIMATE_LEARN=0` turns all learning off.

### status

Shows whether learning is on, whether it learns from your sessions and who decided that (your setting, the linked workspace's "Learn from sessions", or the default), whether automatic promotion is on with its last promotion and last held-back reason, rule counts (approved, candidate, retired), open signals, pending recoveries, the last reflection and its summary, the resolved limits, and rule recurrence. `--json` also includes the last reflection's token use and estimated cost.

**Recurrence** answers "was this rule shown, and did the user still correct the same thing?". It reads the newest 200 session snapshots and the recorded corrections. It makes no model calls and writes nothing. For each shown rule it counts sessions where a matching correction came:

| Count | Meaning |
|---|---|
| `recurred` | after the rule was shown, before the agent started answering the corrected request |
| `during` | while the agent was answering, for example a file-hook rule added mid-turn; the rule may have arrived too late |
| `unknown` | in an order that cannot be told, for example older corrections or a request replayed after compaction |
| `ambiguous` | when the correction matched more than one rule the session was shown in its current text |
| `earlier_version` | when the session was shown only an earlier version of the rule text; it never counts for the current text |

A correction matches a rule when it names one of the rule's full backtick identifiers plus another word from the rule, or contains at least 3 of the rule's words and 60% of them. A prefix or suffix identifier such as `_at` or `stg_` never matches on its own. Rules first shown after the correction are ignored for it. The text output lists only rules with a matching correction and summarizes the rest as "no observed correction". That is not proof the agent followed them. Corrections are recorded only while capture is on. Status also lists up to 5 identifiers that were corrected in 2 or more sessions with no matching current rule. They are taken from your local corrections and never leave the project. If the analysis fails, status shows `Recurrence unavailable` (`recurrence_error` in JSON), and the rest of the status still prints.

When the current text of a rule has `recurred` in 2 or more sessions, reflection marks it `r:N` in the playbook it sends the model. The model is asked to make the rule clearer or more specific when the feedback shows the wording is unclear, and to keep it when the agent simply did not follow a correct rule. It may narrow a rule only when the feedback shows the rule is too broad, and must keep the behavior the rule requires. The result is a candidate like any other and goes through the same review or automatic-promotion gates.

```bash
altimate-code learn status
altimate-code learn status --json
```

| Flag | Description |
|---|---|
| `--json` | Machine-readable output. |

### show

Prints approved rules, the candidate, a diff between them, and pending replacements. Each rule shows its id, text, and counters (`helpful`, `harmful`, `applied`). Flagged rules print a `WARNING` line. Rules over 140 characters from older stores are marked `long`.

```bash
altimate-code learn show
```

### search

Finds approved and retired rules. Every word you give must appear in the rule id, text, or tags. A rule id that matches nothing lists the closest ids instead.

```bash
altimate-code learn search "timestamp utc"
```

### reflect

Stages candidate edits from a session or from feedback you supply.

```bash
# From the signals captured in a session
altimate-code learn reflect --session <id>

# From every session with open signals
altimate-code learn reflect --pending

# From a CI log, as feedback on a session
altimate-code learn reflect --session <id> --feedback ci.log --feedback-kind ci
```

| Flag | Description |
|---|---|
| `--session <id>` | Session to learn from. Without `--feedback`, its captured signals are the feedback. |
| `--pending` | Reflect on every session with open signals. Cannot be combined with `--session`, `--trajectory`, or `--feedback`. |
| `--trajectory <file>` | A `trajectory export` file, for a session recorded in another project. Needs `--feedback`. |
| `--feedback <file>` | Feedback file, or `-` for stdin. |
| `--feedback-kind` | `verifier`, `ci`, `review`, or `user` (default `user`). |
| `--apply-paths <globs...>` | Path triggers for rules in a new store, and for existing rules in the store that have none. No default. |
| `-m, --model <provider/model>` | Model to use. Overrides `learn.model`. |
| `--timeout <seconds>` | Seconds to wait for the model (default 120). |
| `--json` | Machine-readable output. |

Without `--pending`, pass exactly one of `--session` or `--trajectory`. Find session ids with `altimate-code session list`.

### signals

Lists open signals. `--all` includes signals already used by a reflection.

```bash
altimate-code learn signals --session <id>
```

| Flag | Description |
|---|---|
| `--session <id>` | Only this session. |
| `--all` | Include consumed signals. |
| `--json` | Machine-readable output. |

### signal add

Records a signal from somewhere learn cannot see, such as a review comment or a CI log.

```bash
altimate-code learn signal add --kind review --text "Staging models must not select from raw sources directly."
```

| Flag | Description |
|---|---|
| `--kind` | Required. `review`, `ci`, or `user`. |
| `--text <string>` | The signal text. |
| `--file <path>` | Read the text from a file. Pass exactly one of `--text` or `--file`. |
| `--session <id>` | Session the signal belongs to (default `external`). |

### promote

Makes the candidate the approved set.

```bash
altimate-code learn promote
altimate-code learn promote --yes --allow-flagged
altimate-code learn promote --publish
```

| Flag | Description |
|---|---|
| `--yes` | Skip the confirmation prompt. Required outside a terminal. |
| `--allow-flagged` | With `--yes`: approve rules flagged for mentioning skipping or disabling verification. |
| `--publish` | After promoting, export the approved rules as a skill and publish it to the linked workspace. Not available when `ALTIMATE_DISABLE_WORKSPACE` is set. |
| `--replace` | With `--publish`: update your own same-name published playbook even if it was published from another checkout. |

### pin / unpin

Pins an approved rule. Pinned rules fill the core tier before any unpinned rule and are never evicted by `learn.max_stored`. They are still subject to `learn.core_lessons` and `learn.budget_tokens`: pin more than fit and the excess is not shown. Use it for rules that must apply whatever the request says. The change applies to the approved set directly, without `promote`, and to a staged candidate that still contains the rule. If the candidate removes the rule, the next promote removes it too; read the diff.

```bash
altimate-code learn pin L-8201
altimate-code learn unpin L-8201
```

Pinned rules count toward `learn.core_lessons`. Pin only a few.

### reject

Discards the staged candidate.

```bash
altimate-code learn reject
```

### rollback

Restores the previously promoted version. Each `promote` archives the version it replaces, and `rollback` uses the most recent one. It also discards the current candidate, because the candidate was built on the version you are leaving.

```bash
altimate-code learn rollback
```

### bootstrap

Seeds candidate rules from this project's past sessions. It looks for the same signals live capture would have recorded (corrections and repeated tool failures), then reflects on them.

```bash
altimate-code learn bootstrap --dry-run
altimate-code learn bootstrap --since 14d
```

Before anything is sent, it prints the number of sessions, the date range, the signals found, the model and provider, an input token estimate, and the limits. It then asks you to confirm. Outside a terminal you must pass `--yes` or `--dry-run`.

| Flag | Description |
|---|---|
| `--since` | Session creation boundary: a duration (`30d`, `24h`, `4w`) or an ISO date (default `30d`). |
| `--limit <n>` | Maximum root sessions to inspect (default 200). |
| `-m, --model <provider/model>` | Model to use. Default: `learn.model`, then the configured default model. |
| `--yes` | Confirm sending the displayed scope. Required outside a terminal. |
| `--dry-run` | Print the scope and the redacted signals. Sends nothing and changes no state. |
| `--max-reflections <n>` | Maximum reflection batches (default 20). `0` imports signals only and needs no model. |
| `--max-seconds <n>` | Total time budget after confirmation (default 300). |

Re-run it to finish pending reflections and continue to older sessions.

### import-reviews

Seeds candidate rules from human review comments on merged GitHub pull requests. It needs the `gh` CLI, installed and logged in for the repository's host.

```bash
altimate-code learn import-reviews --dry-run
altimate-code learn import-reviews --repo my-org/my-repo --since 60d
```

It fetches review threads and review bodies of merged PRs, prints what it found, and asks before sending anything. By default only comments from the repository's owners, members, and collaborators count (`--any-author` includes everyone), and only those made before the PR merged. Comments from the PR author, from bots, and trivial comments ("LGTM", emoji, very short text) are dropped. Review bodies count only when they approve or request changes.

| Flag | Description |
|---|---|
| `--repo <owner/name>` | Repository. Default: the project's GitHub or GitHub Enterprise remote. |
| `--since` | Merge boundary: a duration or an ISO date (default `30d`). |
| `--limit <n>` | Maximum merged PRs to inspect (default 50). |
| `--include-bots` | Include bot authors, overriding all bot filters. |
| `--any-author` | Include reviewers who are not owners, members, or collaborators. |
| `--bots <a,b>` | Extra bot logins to exclude. Also set with `learn.review_bots`. |
| `-m, --model <provider/model>` | Model to use. Default: `learn.model`, then the configured default model. |
| `--yes` | Confirm sending the displayed scope. Required outside a terminal. |
| `--dry-run` | Fetch and print the redacted comments. Sends nothing and changes no state. |
| `--max-reflections <n>` | Maximum reflection batches (default 20). `0` imports signals only. |

The built-in bot list is `coderabbitai`, `kilo-code-bot`, `cubic-dev-ai`, `cursor`, `dependabot`, `renovate`, `github-actions`, `chatgpt-codex-connector`, and `claude`. Any author whose type is Bot or whose login ends in `[bot]` is also excluded. If GitHub's rate limit runs low, the import pauses and prints when to resume. Re-run to continue from the last finished PR.

### nudge off

When capture is off and `learn.enabled` is on, the TUI can show one quiet tip after you have corrected the agent twice in a session. `nudge off` turns it off for every project. `learn enable` does the same.

```bash
altimate-code learn nudge off
```

## Configuration

Set these under `learn` in your project or user config. An environment variable overrides the config value, in both directions.

```json
{
  "learn": {
    "capture": true,
    "auto_reflect": true,
    "model": "provider/model",
    "core_lessons": 15,
    "retrieved_lessons": 15
  }
}
```

| Key | Env var | Default | Effect |
|---|---|---|---|
| `enabled` | `ALTIMATE_LEARN` (`1`/`true`, `0`/`false`, case-insensitive) | `true` | Master switch for rule delivery, capture, scheduling, automatic reflection, startup recovery and the TUI reminder. Explicit `learn` commands still work. |
| `capture` | `ALTIMATE_LEARN_CAPTURE` (`1`/`true`, `0`/`false`) | `false` | Record signals. When this is off, nothing is captured, scheduled, or reflected automatically. Commands you run yourself (`reflect`, `signal add`, `bootstrap`) still work. |
| `auto_reflect` | `ALTIMATE_LEARN_AUTO` (`1`/`true`, `0`/`false`) | `false` | Reflect on open signals automatically (end of `run`, threshold, idle, startup recovery). Needs `capture`. At the end of `run`, only that session is reflected, for at most 60 seconds; unfinished signals wait for the next run. |
| `auto_promote` | `ALTIMATE_LEARN_AUTO_PROMOTE` (`1`/`true`, `0`/`false`) | `false` | Promote a candidate staged by automatic reflection without review when every gate passes. Needs `capture` and `auto_reflect`. See [Fully automatic mode](#fully-automatic-mode). |
| `auto_promote_max_changes` | `ALTIMATE_LEARN_AUTO_PROMOTE_MAX_CHANGES` | `3` | Maximum rules one automatic promotion may add, edit, or remove. Larger candidates stay staged. |
| `auto_promote_daily` | `ALTIMATE_LEARN_AUTO_PROMOTE_DAILY` | `5` | Maximum automatic promotions per store in any 24 hours. `0` stops them. |
| `model` | `ALTIMATE_LEARN_MODEL` | the session's model for reflection; the configured default model for `bootstrap` and `import-reviews` | Model (`provider/model`) for automatic reflection, `bootstrap`, and `import-reviews`. |
| `core_lessons` | `ALTIMATE_LEARN_CORE_LESSONS` | `15` | Maximum core rules at session start. |
| `retrieved_lessons` | `ALTIMATE_LEARN_RETRIEVED_LESSONS` | `15` | Maximum retrieved rules at session start. |
| `request_lessons` | `ALTIMATE_LEARN_REQUEST_LESSONS` | `5` | Maximum rules added per later user message. `0` disables. |
| `file_hook` | `ALTIMATE_LEARN_FILE_HOOK` (`0`/`false` disables, `1`/`true` enables) | `true` | Add rules that match a file the agent reads or edits. |
| `file_lessons` | `ALTIMATE_LEARN_FILE_LESSONS` | `5` | Maximum rules added per file event. `0` disables. |
| `budget_tokens` | `ALTIMATE_LEARN_BUDGET_TOKENS` | `1500` | Token budget for the session-start "Team rules" section. Rules that do not fit are left out. |
| `session_max_lessons` | `ALTIMATE_LEARN_SESSION_MAX_LESSONS` | `40` | Maximum distinct rules shown in one session, across all tiers. |
| `max_stored` | `ALTIMATE_LEARN_MAX_STORED` | `1000` | Maximum stored rules. Enforced during curation. Pinned rules are kept. Must be 1 or more. |
| `recovery_max_reflections` | `ALTIMATE_LEARN_RECOVERY_MAX_REFLECTIONS` | `3` | Reflections a process may run on leftover signals at startup. |
| `recovery_max_seconds` | `ALTIMATE_LEARN_RECOVERY_MAX_SECONDS` | `300` | Time budget for startup recovery. |
| `review_bots` | none | `[]` | Extra bot logins that `import-reviews` excludes. |

The numeric limits must be non-negative integers. A value of `0` turns that tier off. `learn status` prints the limits that are in effect.

The server config API (`/config`) accepts every `learn` key listed above. Config files, HTTP APIs, and generated SDK clients share the same schema.

## Cost

### What a rule costs in context

Rules are limited to 140 characters, so at most about 35 tokens each. In our benchmark, 300 short rules added 5,400 tokens to a prompt compared with 15 retrieved ones, about 19 tokens per rule; full-length one-line rules measured about 56 tokens each. A path scope adds a few tokens to rules that have one.

At the default limits a session starts with up to 15 core and 15 retrieved rules, so at most 30 rules. That is about 1,050 tokens at 35 tokens each, under the 1,500-token section budget. Per-request and file additions can bring the total to 40 rules (the `session_max_lessons` cap), roughly 1,400 tokens plus the scope shown on rules with path triggers. The budget applies to the session-start section only; later additions are limited by count, not tokens.

### What a session pays

The section is the same on every model call in a session, so providers that cache prompt prefixes charge much less for it after the first call.

The arithmetic below uses an **example price, not a quote**: $3.00 per million input tokens, cache reads at 10% of that ($0.30), and cache writes at 125% ($3.75). Replace them with your model's prices. The session is 50 model calls with 1,050 rule tokens in each.

| | Calculation | Cost for the rules |
|---|---|---|
| No caching | 50 calls × 1,050 tokens × $3.00 / 1M | $0.158 |
| With caching | 1 write: 1,050 × $3.75 / 1M = $0.004; 49 reads: 49 × 1,050 × $0.30 / 1M = $0.015 | $0.019 |

Because the rule section does not change between turns, it does not break the cache. The exception is compaction, which rebuilds the history anyway and folds in rules added since the start. Rules that arrive later are appended to messages and tool results, so they extend the history instead of changing the start of the prompt.

### What learning itself costs

Reflection is a model call. Each one sends the current rules, the session digest (up to 24,000 characters), and the feedback (up to 12,000 characters). The replacement step adds a smaller call when a rule was removed without a replacement.

- Each reflection reports its token use and estimated cost. `learn reflect` prints them; `learn status --json` shows the last one.
- `bootstrap` and `import-reviews` print an input-token estimate before you confirm, and a summary after (tokens, estimated cost, and whether the tokens were estimated because the provider did not report them).
- `--max-reflections`, `--max-seconds`, and `--limit` bound the work. `--max-reflections 0` imports signals without calling a model.
- Set `learn.model` to a smaller model to lower the cost of reflection.

Measured in our benchmark (Gemini 3.1 Pro as the reflector, list prices):

| Operation | Tokens | Cost |
|---|---|---|
| One reflection | about 7,000 input, 1,700 output | about $0.05 |
| `bootstrap` over 8 past sessions (4 reflections, 3 rules) | 28,000 input, 6,700 output | $0.20, 54 seconds |
| `import-reviews --dry-run`, 10 merged PRs | none (GitHub only) | free |

A reflection with a smaller model (Gemini 3.1 Flash-Lite) took 7–9 seconds instead of 70.

The rules themselves did not change the cost of an agent run measurably while retrieval was on: runs cost $0.60–0.73 whether the project had 50, 300, or 1,000 rules. Loading all 1,000 rules into the prompt instead raised the first call from 21,000 to 58,000 input tokens and the cost per run by 34%.

## Privacy and safety

**What is stored, and where.** Everything is in `.altimate-code/learn/<name>/` in your project:

| File | Contents |
|---|---|
| `approved.json` | The live rules. |
| `candidate.json` | Staged rules waiting for review. |
| `retired.json` | Rules that were superseded or removed. |
| `versions/` | Archived previous approved sets, used by `rollback`. |
| `signals.jsonl` | Captured signals (redacted, clipped to 2,000 characters). |
| `history.jsonl` | What each reflection and promote changed, with token use. |
| `bootstrap.json`, `reviews.json` | Resume state for `bootstrap` and `import-reviews`. |
| `schedule.json` | Last reflection and retry backoff. |
| `shown.jsonl` | Which rules each session was shown. |
| `usage.json` | How often each rule was delivered. Kept out of `approved.json` so the committed file does not change every session. |
| `harmful.json`, `pending-replacements.jsonl` | Harmful marks waiting for a second source, and removals waiting for a replacement rule. |
| `migration.json` | Record of a migration from the earlier skill-file format. |

`promote --publish` also writes the exported skill to `.altimate-code/skills/<name>/SKILL.md`.

Session state (the frozen section, the redacted request text used for matching) is in `.altimate-code/learn/.sessions/`, shared by all stores.

Nothing is published to a workspace unless you run `promote --publish`. Reflection, `bootstrap`, and `import-reviews` send redacted text to the model provider (see below).

**Redaction.** Before signals, session excerpts, review comments, and request text are stored or sent to a model, they pass through a secret filter: known token formats, credential assignments such as `password=...`, credential arguments to commands, and long high-entropy strings. This is best-effort pattern matching. It will miss some secrets and can occasionally redact harmless text. Read the dry-run output of `bootstrap` and `import-reviews` before you confirm.

**What is sent to which model.**

| Operation | Sent | Model |
|---|---|---|
| Automatic reflection, `learn reflect` | Redacted session digest, redacted feedback, current rules | `--model`, `learn.model`, or the session's model |
| `bootstrap` | Redacted excerpts of past sessions in this project | `--model`, `learn.model`, or the default model |
| `import-reviews` | Redacted review comments | `--model`, `learn.model`, or the default model |

`bootstrap` and `import-reviews` show the scope and ask before sending, and `--dry-run` sends nothing. Automatic reflection does not ask each time. It is what you enabled with `learn enable`. It uses `learn.model` if set, otherwise the session's model. `import-reviews` also calls GitHub through `gh`.

**The human gate.** A candidate does nothing until you run `promote`. Rules from your own sessions, from imported reviews, and from model output all go through the same step. The reflector is told to ignore instructions inside the data it reads, and the curator rejects rules containing commands, URLs, paths, or injection phrases, but the promote step is the boundary you should rely on. Read the diff.

**Flagged rules.** A rule that mentions skipping, ignoring, or disabling tests, checks, CI, or review is flagged. It is shown with a warning, and it needs interactive confirmation or `--yes --allow-flagged`. The flag looks only at the wording. It also fires on a rule that says "never skip tests".

**When learning is off.** With capture off (`learn.capture=false` or `learn disable`), nothing is captured automatically, no signals are written, and no model is called unless you run a learn command yourself. Learn commands, including `learn status`, create `.altimate-code/learn/` and its `.gitignore`. With the master switch still on, two further exceptions apply:

- If approved rules already exist in the project, they are still delivered. Delivery writes session state under `.sessions/`, appends to `shown.jsonl`, and updates `usage.json`; it does not change `approved.json`. These files are not pruned automatically; delete `.sessions/` and `shown.jsonl` after active sessions have ended to reclaim space.
- The TUI reminder counts your corrections in memory for the current session and shows at most one tip per project and three in total across projects. Its only file is `learn-nudge.json` in the global state directory (normally `~/.local/state/altimate-code`). It holds hashed project ids, a count, and a dismissed flag, and no message text. `learn nudge off` or `learn enable` ends it permanently.

**Turning learn off completely.** Set `learn.enabled=false` in your config or `ALTIMATE_LEARN=0` in your environment. This also stops approved rule delivery (including `.sessions/`, `shown.jsonl` and `usage.json` writes) and the TUI reminder, even if capture or automatic reflection is configured on. Existing data stays in place. `ALTIMATE_LEARN` overrides config in both directions: `0`/`false` disables and `1`/`true` enables, case-insensitively. Explicit `learn` commands still run; `learn status` reports `enabled: false` and how to re-enable. `learn enable` sets capture and automatic reflection but leaves the master switch unchanged and reports when learning remains disabled.

## Benchmarks

We measured the effect of rules on a dbt benchmark with held-out tasks: the agent writes models for tasks it has not seen, and checks verify the result. Each arm was 18 runs (9 held-out, 3 repeats of 3 tasks, plus 6 control runs). With 9 runs per arm, small differences are noise.

**Experiment 1: does the number of rules matter?** Claude Haiku 4.5. The 4 real rules were mixed with 21, 46, or 96 irrelevant team conventions.

| Rules loaded | Held-out pass | First-call input tokens |
|---|---|---|
| 4 (real only) | 8/9 | 33,304 |
| 25 | 7/9 | 34,584 |
| 50 | 9/9 | 36,051 |
| 100 | 8/9 | 38,880 |

Irrelevant rules up to 100 did not reduce adherence. They added about 56 tokens per rule to every call (+17% at 100). Cost, not quality, is the reason to keep the number small. Separately, when the playbook was a skill the agent had to open, it did not open it in 2 of 12 relevant runs, and both runs failed.

**Experiment 2: rules that apply, overreach, or conflict.** Same setup.

| Arm | Held-out pass |
|---|---|
| 4 real rules | 8/9 |
| plus 36 applicable style rules (40 total) | 7/9 |
| the 4 rules reworded without scope | 8/9 |
| **4 real plus 4 stale, contradicting rules** | **1/9** |

Contradictions were the one thing that broke the agent. Size, applicability, and scope wording did not. This is why the curator enforces conflict handling.

**Experiment 3: conventions change.** The playbook starts with 4 outdated rules, a simulated teammate reviews against the new conventions, and the loop runs for 2 iterations. This used Gemini models, so compare only within this experiment.

| Setup | Held-out pass |
|---|---|
| No rules | 2/9 |
| Outdated rules left in place | 0/9 |
| Hand-written correct rules | 9/9 |
| Loop before the conflict handling, weak reflector | 3/9 and 4/9 |
| Loop with overlap guard, implicit supersede, and replacement step, weak reflector | 9/9 and 9/9 |
| Same, strong reflector | 9/9 |

A stale rule is worse than none. Without the replacement step, a weaker model marked stale rules harmful but never wrote the correction, so knowledge was lost. The guard, implicit supersede, and replacement step fixed that.

**Experiments 4–10: the shipped version.** Gemini 3.5 Flash as the agent; 18 runs per arm; a run whose agent turn did not complete counts as a failure. *Recall* is the share of the rules a task needed that were actually shown to the agent. The 4 real rules were hidden in pools of realistic rules for other parts of the project, about 5% of which used the same staging vocabulary.

| Question | Arm | Held-out pass | Recall |
|---|---|---|---|
| Baseline | No rules | 2/9 | – |
| Baseline | 4 real rules, always in the prompt | 9/9 | 100% |
| Scale | 50 rules, retrieval | 9/9 | 100% |
| Scale | 300 rules, retrieval | 9/9 | 100% |
| Scale | 1,000 rules, retrieval | 9/9 | 100% |
| Scale | 1,000 rules, all in the prompt | 9/9 | 100% |
| Short rules | 4 real rules, ≤140 characters vs full length | 8/9 vs 9/9 (the miss is an incomplete run) | 100% |
| Vague requests | 300 rules, file hook off | 5/9 | 50% |
| Vague requests | 300 rules, file hook on | 9/9 | 100% |
| Topic switch (second request) | 300 rules, session start only | 5/9 | 43% |
| Topic switch (second request) | 300 rules, plus per-request additions | 7/9 | 60% |
| Topic switch (second request) | 4 real rules, always in the prompt | 7/9 | 100% |
| Outdated rules | 4 outdated rules, no learning | 0/9 | – |
| Outdated rules | after 2 learning iterations, strong or weak reflector | 9/9 | – |
| Bootstrap | 3 rules learned from 8 past sessions | 9/9 | – |

What this shows:

- **Retrieval scales.** With the file hook and path triggers, every rule a task needed was shown, up to 1,000 stored rules, while the prompt stayed the same size. An earlier build missed the timestamp rule at 1,000 rules (6/9) because broad file-hook rules filled the per-file limit; ranking by path specificity fixed it.
- **The file hook matters most** when a request does not name the convention it needs ("add a model for disputes"). The rule arrives when the agent opens the file.
- **Topic switches are the weak spot.** A second, unrelated request in the same session gets only part of what it needs. Pin rules that must always apply, or start a new session for unrelated work.
- **Loading everything did not hurt quality on this model.** Retrieval's benefit was cost (26% cheaper per run at 1,000 rules), not accuracy. We could not run this comparison on Claude.
- **Review import** fetched 291 comments from 10 merged PRs and kept 17 after dropping bots, PR-author replies, duplicates, and trivial comments. We did not score the quality of rules learned from them.

Full setup, arms, and caveats are in the research notes in the repository under `research/rsi-workspace-learning-2026-09-30/` (`context-budget.md`, `findings.md`, `learn-v1-results.md`).

## Limitations

- **Retrieval is keyword-based.** Search is BM25 over rule text, tags, and path triggers. A request that shares no words, identifiers, or files with a rule will not retrieve it. Pin rules that must always apply (`learn pin <id>`) so they are in the core tier.
- **Core selection is by score.** The core tier is the top rules by pin, then helpful minus harmful. It is not a judgement of which rules are project-wide.
- **Only the first request picks the retrieved tier.** Later messages can add rules (up to 5 each), but the session-start section does not change after the first turn, except through compaction.
- **Guard rails are pattern-based.** The correction classifier, lint rules, secret redaction, and verification flags are regular expressions and heuristics. They miss some cases and flag some harmless ones.
- **Conflict detection sees backticked identifiers.** Two rules that contradict each other in prose, with no shared identifier in backticks, depend on the reflector and the replacement step.
- **Reflection quality depends on the model.** In our test a weaker reflector needed the replacement step to reach the same result as a stronger one. You still review every candidate.
- **Review import is GitHub only.** GitLab, Bitbucket, and other hosts are not supported. It reads merged PRs, not open ones.
- **Local rules are shared by hand.** In a project linked to a workspace, team rules are proposed and reviewed per rule (see [Workspace rules](#workspace-rules)). Rules in the project's local stores under `.altimate-code/learn/` are not: `promote --publish` exports them as a single-file workspace skill. Publishing a name that another checkout already published is refused unless you pass `--replace`, which only updates a skill you own. You can also commit the rules: learn creates `.altimate-code/learn/.gitignore`, which ignores everything except each store's `approved.json`, and delivery reads a committed `approved.json` in any checkout.
- **One rule set per `--name`.** Delivery reads every store in the project that has an `approved.json`.
- **Keyword retrieval can over-apply a rule.** A rule scoped to one kind of file can be retrieved for a request elsewhere that uses the same words, and the agent sometimes follows it there. In our benchmark a staging-model money rule was applied to an analysis that had to keep integer cents in 1 of 6 runs, in three of the retrieval arms. Showing the rule's scope did not remove it. Write the scope into the rule's path triggers.
- **Benchmarks are on dbt tasks, with small samples.** The results show direction, not exact lift for your repository.
- **Model availability is not a product limit.** Experiments 3–10 used Gemini models because Claude models were not available to the benchmark environment at that time. Learn works with any provider the CLI supports.

## Troubleshooting

**`learn show` lists no rules, or the agent does not seem to know them.**
Only approved rules are delivered. Check `learn status` for `candidate` counts and run `learn show` then `learn promote`. Rules are selected when a session's first request is processed, so start a new session after promoting. If the rules exist but a particular one did not appear, it either did not match your request or ranked below the count and budget limits; see [Limitations](#limitations) and consider pinning it. Also check that `core_lessons`, `retrieved_lessons`, and `budget_tokens` are not set to `0`, and that `learn.budget_tokens` is large enough for your rules.

**Nothing was learned.**
Run `learn status`. If capture is `off`, run `learn enable`. If capture is on, look at `learn signals`: with no open signals there is nothing to reflect on. The classifier only counts a message as a correction after the assistant has replied once, and it is deliberately strict. For a correction it missed, record it with `learn signal add --kind user --text "..."`. If signals exist but no candidate appeared, automatic reflection may not have run yet (the TUI waits for 3 signals or 10 idle minutes); run `learn reflect --pending`. A failed automatic reflection keeps its signals and retries at the next trigger after its backoff; the error shows in `learn status`. A failed `learn reflect` prints its error and may leave an older success under "Last reflection".

**Too many rules are flagged, or promote refuses.**
Flagged rules mention skipping, ignoring, or disabling tests, checks, CI, or review, even to forbid it. Read each `WARNING` in `learn show`. If they are fine, confirm interactively or run `learn promote --yes --allow-flagged`. If a rule is wrong, run `learn reject`, or edit the candidate and promote again. A "refusing to promote" message about overlaps means two rules share a backticked identifier without declaring how they relate; run `learn reflect` again so the reflector can resolve it, or edit the candidate.

**`import-reviews` fails with an auth or access error.**
The command checks three things in order. `gh --version` must work (install from `https://cli.github.com/`). `gh auth status --hostname <host>` must succeed (run `gh auth login --hostname <host>`; for GitHub Enterprise use that host). The account must be able to read the repository (`gh api repos/<owner>/<name>`). If the remote is not GitHub, pass `--repo owner/name` for a GitHub repository. If you hit GitHub's 1,000-result search limit, use a narrower `--since`.

**`bootstrap` finds nothing.**
It only looks at root sessions of this project and directory, created within `--since` (default 30 days), up to `--limit` sessions. Try `--since 90d`. It also needs corrections or repeated tool failures in those sessions, and it applies the same classifier as live capture. Run `learn bootstrap --dry-run` to see the scope and the signals without sending anything. If a previous run already imported the same sessions, their signals are not added again.

**A command asks for `--yes` and I am in a script.**
`promote`, `bootstrap`, and `import-reviews` refuse to run without a terminal unless you pass `--yes`. For the two imports, `--dry-run` is the preview that does not need it.
