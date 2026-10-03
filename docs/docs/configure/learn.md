---
title: Learn — Team Conventions from Corrections — Altimate Code
description: "Turn your corrections, repeated tool failures, and PR review comments into short, human-approved lessons that Altimate Code loads into every relevant session."
---

# Learn

`altimate-code learn` turns feedback you already give into short rules ("lessons") and puts the relevant ones in front of the agent at the start of later sessions. The feedback comes from your corrections in chat, tools that keep failing, and review comments on merged GitHub pull requests. A lesson looks like this: ``Convert `*_cents` columns to dollars in staging models.``

Nothing becomes a lesson until a person approves it, and the agent never has to decide to look a lesson up. The harness selects the lessons and adds them to the prompt.

Learning is off by default.

## Quick start

```bash
# 1. Turn it on for this project
altimate-code learn enable

# 2. Work normally. When you correct the agent, a signal is recorded locally.
#    Corrections are turned into candidate lessons automatically (see "How it works").

# 3. See what has been captured and what is waiting
altimate-code learn status

# 4. Review the candidate lessons and the diff against the approved set
altimate-code learn show

# 5. Approve them
altimate-code learn promote
```

Start the next session and the approved lessons that match your request are in the prompt.

To start from history instead of waiting for new corrections, run `learn bootstrap` (past sessions in this project) or `learn import-reviews` (merged GitHub PRs). Both show what they will send and ask first. See [Commands](#commands).

## How it works

```
 capture ──► reflect ──► curate ──► review & promote ──► delivery
 signals     one model    lint,       you read the diff    core + retrieved lessons
 on disk     call per     redact,     and approve          at session start, extra
             batch        dedupe,                          lessons per request and
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
| `user` | Feedback you pass to `learn reflect --feedback`. |

The correction classifier is a fixed list of text patterns ("that's wrong", "we always...", "use X instead of Y", "you forgot..."). It does not call a model. It favours precision over recall: a missed correction costs one lesson, a false one adds noise. Thanks, "LGTM", and ordinary questions are not corrections.

Every signal is redacted for secrets and clipped to 2,000 characters before it is stored. Signals stay on your machine.

### 2. Reflect

Reflection is one model call that reads a digest of the session plus the open signals and proposes edits to the lesson list. It runs when `learn.auto_reflect` is on, or when you run `learn reflect`.

| Trigger | Behaviour |
|---|---|
| End of `altimate-code run` | Reflects on that session's open signals before the command exits. |
| Threshold | In the TUI, when a session goes idle with 3 or more open signals. |
| Idle | In the TUI, 10 minutes after the session goes idle, if it still has open signals. New activity cancels the timer. |
| Startup recovery | Signals left over from earlier sessions are reflected on after the first idle of a new session, not during the first turn. Default limit: 3 reflections and 300 seconds per process. |
| Manual | `learn reflect --session <id>`, `--pending`, or with `--feedback`. |

Exiting the TUI saves signals but never waits on a model. A failed reflection is retried with backoff (1 minute, then doubling, capped at one day). Only one process works on a given batch of signals at a time.

**What the model sees**, all redacted:

- the current lessons, with ids and helpful/harmful counters;
- a digest of the session, capped at 24,000 characters (your prompts, tool calls with clipped inputs and outputs, the files written, the final message);
- the feedback, capped at 12,000 characters.

The reflector is told to treat the digest and feedback as untrusted data, to learn only from the external feedback, and to prefer no change. It runs with temperature 0 and no tools. The model is `learn.model` if set, otherwise the model the session used.

### 3. Curate

The model's proposals are not applied directly. A deterministic curator checks each one:

- **Lint.** A lesson must be one line, at most 140 characters. It is rejected, not repaired, if it contains a shell command, a URL, a markdown link, an email address, an absolute path or `..`, a session or message id, a comment marker, text that looks like prompt injection, or something that looks like a secret.
- **Redaction.** Text echoed back in reports is redacted again.
- **Dedupe.** A new lesson that is at least 60% similar (word overlap) to an existing one is counted as "helpful" on the existing lesson instead of being added.
- **Contradictions.** If a new or edited lesson shares a code identifier in backticks (for example `` `amount_cents` ``) with an existing lesson, it must say that it supersedes it or coexists with it. Two silent versions of the same rule are not allowed. Superseded lessons move to a retired list.
- **Replacement step.** If a lesson is removed because it was wrong and no replacement was proposed, one narrow model call writes the corrected rule, or answers "none". Failures are queued for the next reflection.
- **Counters and removal.** Each lesson has helpful and harmful counters. A lesson is removed automatically only when it has at least two harmful marks, more harmful than helpful, from at least two different pieces of feedback.
- **Limits per reflection.** At most 3 added, 3 edited, 3 removed lessons.
- **Store cap.** When the store passes `learn.max_stored`, the lowest-scoring lessons are evicted. Pinned lessons are not.
- **Verification flags.** A lesson that mentions skipping, ignoring, or disabling tests, checks, CI, or review is not rejected. It is flagged, and flagged lessons need explicit approval at promote.

The result is saved as a **candidate** (`candidate.json`). It has no effect on any session yet.

!!! note
    Overlap detection only sees identifiers inside backticks. A contradiction written in plain prose relies on the reflector and the replacement step to catch it.

### 4. Review and promote

You are the gate.

```bash
altimate-code learn show      # approved lessons, candidate, flags, and a diff
altimate-code learn promote   # shows the diff again, asks to confirm
```

`promote` re-checks the candidate before it goes live: every lesson is linted again, overlaps are checked again, and the candidate must be the same one whose diff you were shown. If the candidate changed in the meantime, promote stops and asks you to review again. The previous approved set is archived, so `learn rollback` can restore it.

Flagged lessons (see verification flags above) appear as `WARNING` lines in the diff. Interactively, confirming the prompt approves them. In scripts, `promote --yes` refuses a candidate with flagged lessons unless you also pass `--allow-flagged`. Outside a terminal, `promote` without `--yes` refuses to run.

### 5. Delivery

Only approved lessons are ever delivered. Delivery is part of the prompt loop, not a tool the agent calls.

| Tier | What | Default | How it is chosen |
|---|---|---|---|
| Core | Lessons added to every session | 15 (`learn.core_lessons`) | Pinned lessons first, then highest helpful minus harmful. |
| Retrieved | Lessons relevant to the first request | 15 (`learn.retrieved_lessons`) | Keyword search (BM25) over lesson text, tags, and path triggers, against your first message plus any project files it names. |
| Per request | New lessons relevant to a later message | 5 (`learn.request_lessons`) | Same search on each new message. Lessons whose path triggers match a file the session has touched or the message names rank first. Added to that message as "Team rules for this request". |
| File hook | Lessons that match a file the agent reads or edits | 5 per event (`learn.file_lessons`) | The lesson's path trigger matches the file, or an identifier in the lesson matches the file name. The most specific trigger wins: `models/staging/*.sql` ranks above `models/**`, so broad lessons cannot crowd out narrow ones. Added to that tool result. |

The core and retrieved lessons are rendered once, as a "Team rules" section, and **frozen for the session**: the text does not change on later turns, so the start of the prompt stays identical and can be cached by the provider. Later additions are appended to messages and tool results, never inserted into the earlier prompt. A lesson is shown at most once per session, and no more than `learn.session_max_lessons` (40) are shown in total. After a compaction, the section is rebuilt from every lesson shown so far.

A lesson with path triggers is shown with its scope, for example `[applies to: models/staging/**] Convert *_cents columns with cents_to_dollars`, so the agent can tell when a retrieved lesson does not apply to the file in front of it.

The agent never fetches a lesson. If the lesson is selected, it is in context. If it is not selected, the agent has no way to ask for it.

Delivery runs whenever approved lessons exist in the project, even if `learn.capture` is later turned off. A person already approved them.

## Learn vs memory vs a knowledge base

| | Learn (lessons) | [Memory](../data-engineering/tools/memory-tools.md) | Knowledge base |
|---|---|---|---|
| What it holds | Short behavioural rules: "do X, not Y" | Facts and notes the agent chooses to save (warehouse config, decisions) | Reference material: docs, schemas, runbooks |
| Who writes it | The learn pipeline from evidence (corrections, failures, reviews) | The agent, when it decides to | People, or ingestion of existing documents |
| How it reaches the agent | The harness selects relevant lessons and puts them in the prompt | Loaded at session start and read or written through memory tools | Searched or retrieved on demand |
| Quality control | Lint, redaction, dedupe, conflict handling, human approval | The agent's judgement | Editorial process |
| Changes behaviour? | Yes, that is its purpose | Sometimes, indirectly | No, it informs |
| When to use | "Stop making this mistake" | "Remember this fact" | "Look this up" |

Use learn for rules your team enforces that the agent keeps getting wrong. Use memory for facts about your setup that you do not want to repeat. Use a knowledge base for material that is too large or too detailed to put in a prompt, where the agent should look things up when needed.

Learn does not depend on the agent calling a tool. Memory tools and skills that are pulled on demand only help when the model decides to read them. In our own test the agent never opened a pull-style playbook skill in 2 of 12 relevant runs, and both of those runs failed. Learn selects lessons before the model runs, so there is no such miss at the delivery step. (Selection can still miss; see [Limitations](#limitations).)

## Commands

All subcommands take `--name <store>` (default `team-playbook`) unless noted. Each store is a separate lesson set in `.altimate-code/learn/<name>/`.

### enable / disable

Writes `learn.capture` and `learn.auto_reflect` to the project config (the highest-precedence existing project config file, or `.altimate-code/altimate-code.json` if none exists). `enable` also permanently dismisses the learning reminder in all projects.

```bash
altimate-code learn enable
altimate-code learn disable
```

`disable` stops capture and automatic reflection. It does not delete anything, and approved lessons keep being delivered.

### status

Shows whether learning is on, lesson counts (approved, candidate, retired), open signals, pending recoveries, the last reflection and its summary, and the resolved limits. `--json` also includes the last reflection's token use and estimated cost.

```bash
altimate-code learn status
altimate-code learn status --json
```

| Flag | Description |
|---|---|
| `--json` | Machine-readable output. |

### show

Prints approved lessons, the candidate, a diff between them, and pending replacements. Each lesson shows its id, text, and counters (`helpful`, `harmful`, `applied`). Flagged lessons print a `WARNING` line. Lessons over 140 characters from older stores are marked `long`.

```bash
altimate-code learn show
```

### search

Finds approved and retired lessons. Every word you give must appear in the lesson id, text, or tags.

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
| `--apply-paths <globs...>` | Path triggers for lessons in a new store. No default. |
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
| `--allow-flagged` | With `--yes`: approve lessons flagged for mentioning skipping or disabling verification. |
| `--publish` | After promoting, export the approved lessons as a skill and publish it to the linked workspace. Needs `ALTIMATE_WORKSPACE=1`. |
| `--replace` | With `--publish`: update your own same-name published playbook even if it was published from another checkout. |

### pin / unpin

Pins an approved lesson. A pinned lesson is always in the core tier, ahead of every unpinned lesson, and is never evicted by `learn.max_stored`. Use it for rules that must apply whatever the request says. The change applies to the approved set directly, without `promote`, and to a staged candidate as well, so the next promote keeps it.

```bash
altimate-code learn pin L-8201
altimate-code learn unpin L-8201
```

Pinned lessons count toward `learn.core_lessons`. Pin only a few.

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

Seeds candidate lessons from this project's past sessions. It looks for the same signals live capture would have recorded (corrections and repeated tool failures), then reflects on them.

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
| `--max-reflections <n>` | Maximum reflection batches (default 20). `0` imports signals only. |
| `--max-seconds <n>` | Total time budget after confirmation (default 300). |

Re-run it to finish pending reflections and continue to older sessions.

### import-reviews

Seeds candidate lessons from human review comments on merged GitHub pull requests. It needs the `gh` CLI, installed and logged in for the repository's host.

```bash
altimate-code learn import-reviews --dry-run
altimate-code learn import-reviews --repo my-org/my-repo --since 60d
```

It fetches review threads and review bodies of merged PRs, prints what it found, and asks before sending anything. Comments from the PR author, from bots, and trivial comments ("LGTM", emoji, very short text) are dropped. Review bodies count only when they approve or request changes.

| Flag | Description |
|---|---|
| `--repo <owner/name>` | Repository. Default: the project's GitHub or GitHub Enterprise remote. |
| `--since` | Merge boundary: a duration or an ISO date (default `30d`). |
| `--limit <n>` | Maximum merged PRs to inspect (default 50). |
| `--include-bots` | Include bot authors, overriding all bot filters. |
| `--bots <a,b>` | Extra bot logins to exclude. Also set with `learn.review_bots`. |
| `-m, --model <provider/model>` | Model to use. Default: `learn.model`, then the configured default model. |
| `--yes` | Confirm sending the displayed scope. Required outside a terminal. |
| `--dry-run` | Fetch and print the redacted comments. Sends nothing and changes no state. |
| `--max-reflections <n>` | Maximum reflection batches (default 20). `0` imports signals only. |

The built-in bot list is `coderabbitai`, `kilo-code-bot`, `cubic-dev-ai`, `cursor`, `dependabot`, `renovate`, `github-actions`, `chatgpt-codex-connector`, and `claude`. Any author whose type is Bot or whose login ends in `[bot]` is also excluded. If GitHub's rate limit runs low, the import pauses and prints when to resume. Re-run to continue from the last finished PR.

### nudge off

When learning is off, the TUI can show one quiet tip after you have corrected the agent twice in a session. `nudge off` turns it off for every project. `learn enable` does the same.

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
| `capture` | `ALTIMATE_LEARN_CAPTURE` (`1`/`true`, `0`/`false`) | `false` | Record signals. Nothing is captured, scheduled, or reflected when this is off. |
| `auto_reflect` | `ALTIMATE_LEARN_AUTO` (`1`/`true`, `0`/`false`) | `false` | Reflect on open signals automatically (end of `run`, threshold, idle, startup recovery). Needs `capture`. |
| `model` | `ALTIMATE_LEARN_MODEL` | the session's model | Model (`provider/model`) for automatic reflection, `bootstrap`, and `import-reviews`. |
| `core_lessons` | `ALTIMATE_LEARN_CORE_LESSONS` | `15` | Maximum core lessons at session start. |
| `retrieved_lessons` | `ALTIMATE_LEARN_RETRIEVED_LESSONS` | `15` | Maximum retrieved lessons at session start. |
| `request_lessons` | `ALTIMATE_LEARN_REQUEST_LESSONS` | `5` | Maximum lessons added per later user message. `0` disables. |
| `file_hook` | `ALTIMATE_LEARN_FILE_HOOK` (`0`/`false` disables, `1`/`true` enables) | `true` | Add lessons that match a file the agent reads or edits. |
| `file_lessons` | `ALTIMATE_LEARN_FILE_LESSONS` | `5` | Maximum lessons added per file event. `0` disables. |
| `budget_tokens` | `ALTIMATE_LEARN_BUDGET_TOKENS` | `1500` | Token budget for the session-start "Team rules" section. Lessons that do not fit are left out. |
| `session_max_lessons` | `ALTIMATE_LEARN_SESSION_MAX_LESSONS` | `40` | Maximum distinct lessons shown in one session, across all tiers. |
| `max_stored` | `ALTIMATE_LEARN_MAX_STORED` | `1000` | Maximum stored lessons. Enforced during curation. Pinned lessons are kept. Must be 1 or more. |
| `recovery_max_reflections` | `ALTIMATE_LEARN_RECOVERY_MAX_REFLECTIONS` | `3` | Reflections a process may run on leftover signals at startup. |
| `recovery_max_seconds` | `ALTIMATE_LEARN_RECOVERY_MAX_SECONDS` | `300` | Time budget for startup recovery. |
| `review_bots` | none | `[]` | Extra bot logins that `import-reviews` excludes. |

The numeric limits must be non-negative integers. A value of `0` turns that tier off. `learn status` prints the limits that are in effect.

## Cost

### What a lesson costs in context

Lessons are limited to 140 characters, so at most about 35 tokens each. In our benchmark, 300 short lessons added 5,400 tokens to a prompt compared with 15 retrieved ones, about 19 tokens per lesson; full-length one-line rules measured about 56 tokens each. A path scope adds a few tokens to lessons that have one.

At the default limits a session starts with up to 15 core and 15 retrieved lessons, so at most 30 lessons. That is about 1,050 tokens at 35 tokens each, under the 1,500-token section budget. Per-request and file additions can bring the total to 40 lessons, or about 1,400 tokens, which is the `session_max_lessons` cap.

### What a session pays

The section is the same on every model call in a session, so providers that cache prompt prefixes charge much less for it after the first call.

The arithmetic below uses an **example price, not a quote**: $3.00 per million input tokens, cache reads at 10% of that ($0.30), and cache writes at 125% ($3.75). Replace them with your model's prices. The session is 50 model calls with 1,050 lesson tokens in each.

| | Calculation | Cost for the lessons |
|---|---|---|
| No caching | 50 calls × 1,050 tokens × $3.00 / 1M | $0.158 |
| With caching | 1 write: 1,050 × $3.75 / 1M = $0.004; 49 reads: 49 × 1,050 × $0.30 / 1M = $0.015 | $0.019 |

Because the lesson section never changes during a session, it does not break the cache. Lessons that arrive later are appended to messages and tool results, so they extend the history instead of changing the start of the prompt.

### What learning itself costs

Reflection is a model call. Each one sends the current lessons, the session digest (up to 24,000 characters), and the feedback (up to 12,000 characters). The replacement step adds a smaller call when a lesson was removed without a replacement.

- Each reflection reports its token use and estimated cost. `learn reflect` prints them; `learn status --json` shows the last one.
- `bootstrap` and `import-reviews` print an input-token estimate before you confirm, and a summary after (tokens, estimated cost, and whether the tokens were estimated because the provider did not report them).
- `--max-reflections`, `--max-seconds`, and `--limit` bound the work. `--max-reflections 0` imports signals without calling a model.
- Set `learn.model` to a smaller model to lower the cost of reflection.

Measured in our benchmark (Gemini 3.1 Pro as the reflector, list prices):

| Operation | Tokens | Cost |
|---|---|---|
| One reflection | about 7,000 input, 1,700 output | about $0.05 |
| `bootstrap` over 8 past sessions (4 reflections, 3 lessons) | 28,000 input, 6,700 output | $0.20, 54 seconds |
| `import-reviews --dry-run`, 10 merged PRs | none (GitHub only) | free |

A reflection with a smaller model (Gemini 3.1 Flash-Lite) took 7–9 seconds instead of 70.

The lessons themselves did not change the cost of an agent run measurably while retrieval was on: runs cost $0.60–0.73 whether the project had 50, 300, or 1,000 lessons. Loading all 1,000 lessons into the prompt instead raised the first call from 21,000 to 58,000 input tokens and the cost per run by 34%.

## Privacy and safety

**What is stored, and where.** Everything is in `.altimate-code/learn/<name>/` in your project:

| File | Contents |
|---|---|
| `approved.json` | The live lessons. |
| `candidate.json` | Staged lessons waiting for review. |
| `retired.json` | Lessons that were superseded or removed. |
| `versions/` | Archived previous approved sets, used by `rollback`. |
| `signals.jsonl` | Captured signals (redacted, clipped to 2,000 characters). |
| `history.jsonl` | What each reflection and promote changed, with token use. |
| `bootstrap.json`, `reviews.json` | Resume state for `bootstrap` and `import-reviews`. |
| `schedule.json` | Last reflection and retry backoff. |
| `shown.jsonl`, `.sessions/` | Which lessons each session was shown. Session state keeps the frozen section. |

Nothing is uploaded unless you run `promote --publish`.

**Redaction.** Before any text is stored or sent to a model, it passes through a secret filter: known token formats, credential assignments such as `password=...`, credential arguments to commands, and long high-entropy strings. This is best-effort pattern matching. It will miss some secrets and can occasionally redact harmless text. Read the dry-run output of `bootstrap` and `import-reviews` before you confirm.

**What is sent to which model.**

| Operation | Sent | Model |
|---|---|---|
| Automatic reflection, `learn reflect` | Redacted session digest, redacted feedback, current lessons | `--model`, `learn.model`, or the session's model |
| `bootstrap` | Redacted excerpts of past sessions in this project | `--model`, `learn.model`, or the default model |
| `import-reviews` | Redacted review comments | `--model`, `learn.model`, or the default model |

`bootstrap` and `import-reviews` show the scope and ask before sending, and `--dry-run` sends nothing. Automatic reflection does not ask each time. It is what you enabled with `learn enable`, and you can read its model choice in `learn status` and `learn.model`. `import-reviews` also calls GitHub through `gh`.

**The human gate.** A candidate does nothing until you run `promote`. Lessons from your own sessions, from imported reviews, and from model output all go through the same step. The reflector is told to ignore instructions inside the data it reads, and the curator rejects lessons containing commands, URLs, paths, or injection phrases, but the promote step is the boundary you should rely on. Read the diff.

**Flagged lessons.** A lesson that mentions skipping, ignoring, or disabling tests, checks, CI, or review is flagged. It is shown with a warning, and it needs interactive confirmation or `--yes --allow-flagged`. The flag looks only at the wording. It also fires on a lesson that says "never skip tests".

**When learning is off.** Nothing is captured, no signals are written, no model is called, and no learning files are created. Two exceptions:

- If approved lessons already exist in the project, they are still delivered.
- The TUI reminder counts your corrections in memory for the current session and shows at most one tip per project and three in total across projects. Its only file is `learn-nudge.json` in the global state directory (normally `~/.local/state/altimate-code`). It holds hashed project ids, a count, and a dismissed flag, and no message text. `learn nudge off` or `learn enable` ends it permanently.

## Benchmarks

We measured the effect of lessons on a dbt benchmark with held-out tasks: the agent writes models for tasks it has not seen, and checks verify the result. Each arm was 18 runs (9 held-out, 3 repeats of 3 tasks, plus 6 control runs). With 9 runs per arm, small differences are noise.

**Experiment 1: does the number of lessons matter?** Claude Haiku 4.5. The 4 real lessons were mixed with 21, 46, or 96 irrelevant team conventions.

| Lessons loaded | Held-out pass | First-call input tokens |
|---|---|---|
| 4 (real only) | 8/9 | 33,304 |
| 25 | 7/9 | 34,584 |
| 50 | 9/9 | 36,051 |
| 100 | 8/9 | 38,880 |

Irrelevant lessons up to 100 did not reduce adherence. They added about 56 tokens per rule to every call (+17% at 100). Cost, not quality, is the reason to keep the number small. Separately, when the playbook was a skill the agent had to open, it did not open it in 2 of 12 relevant runs, and both runs failed.

**Experiment 2: lessons that apply, overreach, or conflict.** Same setup.

| Arm | Held-out pass |
|---|---|
| 4 real lessons | 8/9 |
| plus 36 applicable style rules (40 total) | 7/9 |
| the 4 lessons reworded without scope | 8/9 |
| **4 real plus 4 stale, contradicting lessons** | **1/9** |

Contradictions were the one thing that broke the agent. Size, applicability, and scope wording did not. This is why the curator enforces conflict handling.

**Experiment 3: conventions change.** The playbook starts with 4 outdated lessons, a simulated teammate reviews against the new conventions, and the loop runs for 2 iterations. This used Gemini models, so compare only within this experiment.

| Setup | Held-out pass |
|---|---|
| No lessons | 2/9 |
| Outdated lessons left in place | 0/9 |
| Hand-written correct lessons | 9/9 |
| Loop before the conflict handling, weak reflector | 3/9 and 4/9 |
| Loop with overlap guard, implicit supersede, and replacement step, weak reflector | 9/9 and 9/9 |
| Same, strong reflector | 9/9 |

A stale lesson is worse than none. Without the replacement step, a weaker model marked stale lessons harmful but never wrote the correction, so knowledge was lost. The guard, implicit supersede, and replacement step fixed that.

**Experiments 4–10: the shipped version.** Gemini 3.5 Flash as the agent; 18 runs per arm. *Recall* is the share of the lessons a task needed that were actually shown to the agent. The 4 real lessons were hidden in pools of realistic lessons for other parts of the project, about 5% of which used the same staging vocabulary.

| Question | Arm | Held-out pass | Recall |
|---|---|---|---|
| Baseline | No lessons | 3/9 | – |
| Baseline | 4 real lessons, always in the prompt | 9/9 | 100% |
| Scale | 50 lessons, retrieval | 9/9 | 100% |
| Scale | 300 lessons, retrieval | 9/9 | 100% |
| Scale | 1,000 lessons, retrieval | 9/9 | 100% |
| Scale | 1,000 lessons, all in the prompt | 9/9 | 100% |
| Short lessons | 4 real lessons, ≤140 characters vs full length | 9/9 vs 9/9 | 100% |
| Vague requests | 300 lessons, file hook off | 5/9 | 50% |
| Vague requests | 300 lessons, file hook on | 9/9 | 100% |
| Topic switch (second request) | 300 lessons, session start only | 5/9 | 43% |
| Topic switch (second request) | 300 lessons, plus per-request additions | 7/9 | 60% |
| Topic switch (second request) | 4 real lessons, always in the prompt | 7/9 | 100% |
| Outdated lessons | 4 outdated lessons, no learning | 0/9 | – |
| Outdated lessons | after 2 learning iterations, strong or weak reflector | 9/9 | – |
| Bootstrap | 3 lessons learned from 8 past sessions | 9/9 | – |

What this shows:

- **Retrieval scales.** With the file hook and path triggers, every lesson a task needed was shown, up to 1,000 stored lessons, while the prompt stayed the same size. An earlier build missed the timestamp lesson at 1,000 lessons (6/9) because broad file-hook lessons filled the per-file limit; ranking by path specificity fixed it.
- **The file hook matters most** when a request does not name the convention it needs ("add a model for disputes"). The lesson arrives when the agent opens the file.
- **Topic switches are the weak spot.** A second, unrelated request in the same session gets only part of what it needs. Pin rules that must always apply, or start a new session for unrelated work.
- **Loading everything did not hurt quality on this model.** Retrieval's benefit was cost (26% cheaper per run at 1,000 lessons), not accuracy. We could not run this comparison on Claude.
- **Review import** fetched 291 comments from 10 merged PRs and kept 17 after dropping bots, PR-author replies, duplicates, and trivial comments. We did not score the quality of lessons learned from them.

Full setup, arms, and caveats are in the research notes in the repository under `research/rsi-workspace-learning-2026-09-30/` (`context-budget.md`, `findings.md`, `learn-v1-results.md`).

## Limitations

- **Retrieval is keyword-based.** Search is BM25 over lesson text, tags, and path triggers. A request that shares no words, identifiers, or files with a lesson will not retrieve it. Pin lessons that must always apply (`learn pin <id>`) so they are in the core tier.
- **Core selection is by score.** The core tier is the top lessons by pin, then helpful minus harmful. It is not a judgement of which lessons are project-wide.
- **Only the first request picks the retrieved tier.** Later messages can add lessons (up to 5 each), but the session-start section does not change after the first turn, except through compaction.
- **Guard rails are pattern-based.** The correction classifier, lint rules, secret redaction, and verification flags are regular expressions and heuristics. They miss some cases and flag some harmless ones.
- **Conflict detection sees backticked identifiers.** Two lessons that contradict each other in prose, with no shared identifier in backticks, depend on the reflector and the replacement step.
- **Reflection quality depends on the model.** In our test a weaker reflector needed the replacement step to reach the same result as a stronger one. You still review every candidate.
- **Review import is GitHub only.** GitLab, Bitbucket, and other hosts are not supported. It reads merged PRs, not open ones.
- **Sharing with the team is manual for now.** Lessons live in the project's `.altimate-code/learn/` directory. `promote --publish` exports them as a workspace skill. It is last-writer-wins per skill name, and the skill is a single file. Per-lesson sharing and review in a workspace needs backend changes to workspace memory that are not shipped. You can also commit the lessons: learn creates `.altimate-code/learn/.gitignore`, which ignores everything except each store's `approved.json`, and delivery reads a committed `approved.json` in any checkout.
- **One lesson set per `--name`.** Delivery reads every store in the project that has an `approved.json`.
- **Keyword retrieval can over-apply a lesson.** A lesson scoped to one kind of file can be retrieved for a request elsewhere that uses the same words, and the agent sometimes follows it there. In our benchmark a staging-model money rule was applied to an analysis that had to keep integer cents in 1 of 6 runs. Showing the lesson's scope reduced this but did not remove it. Write the scope into the lesson's path triggers.
- **Benchmarks are on dbt tasks, with small samples.** The results show direction, not exact lift for your repository.
- **Model availability is not a product limit.** Experiments 3–10 used Gemini models because Claude models were not available to the benchmark environment at that time. Learn works with any provider the CLI supports.

## Troubleshooting

**`learn show` lists no lessons, or the agent does not seem to know them.**
Only approved lessons are delivered. Check `learn status` for `candidate` counts and run `learn show` then `learn promote`. Lessons are selected when a session's first request is processed, so start a new session after promoting. If the lessons exist but a particular one did not appear, it did not match your request; see [Limitations](#limitations) and consider pinning it. Also check that `core_lessons`, `retrieved_lessons`, and `budget_tokens` are not set to `0`, and that `learn.budget_tokens` is large enough for your lessons.

**Nothing was learned.**
Run `learn status`. If capture is `off`, run `learn enable`. If capture is on, look at `learn signals`: with no open signals there is nothing to reflect on. The classifier only counts a message as a correction after the assistant has replied once, and it is deliberately strict. For a correction it missed, record it with `learn signal add --kind user --text "..."`. If signals exist but no candidate appeared, automatic reflection may not have run yet (the TUI waits for 3 signals or 10 idle minutes); run `learn reflect --pending`. A failed reflection keeps its signals and retries with backoff; the error shows in `learn status` under "Last reflection".

**Too many lessons are flagged, or promote refuses.**
Flagged lessons mention skipping, ignoring, or disabling tests, checks, CI, or review, even to forbid it. Read each `WARNING` in `learn show`. If they are fine, confirm interactively or run `learn promote --yes --allow-flagged`. If a lesson is wrong, run `learn reject`, or edit the candidate and promote again. A "refusing to promote" message about overlaps means two lessons share a backticked identifier without declaring how they relate; run `learn reflect` again so the reflector can resolve it, or edit the candidate.

**`import-reviews` fails with an auth or access error.**
The command checks three things in order. `gh --version` must work (install from `https://cli.github.com/`). `gh auth status --hostname <host>` must succeed (run `gh auth login --hostname <host>`; for GitHub Enterprise use that host). The account must be able to read the repository (`gh api repos/<owner>/<name>`). If the remote is not GitHub, pass `--repo owner/name` for a GitHub repository. If you hit GitHub's 1,000-result search limit, use a narrower `--since`.

**`bootstrap` finds nothing.**
It only looks at root sessions of this project and directory, created within `--since` (default 30 days), up to `--limit` sessions. Try `--since 90d`. It also needs corrections or repeated tool failures in those sessions, and it applies the same classifier as live capture. Run `learn bootstrap --dry-run` to see the scope and the signals without sending anything. If a previous run already imported the same sessions, their signals are not added again.

**A command asks for `--yes` and I am in a script.**
`promote`, `bootstrap`, and `import-reviews` refuse to run without a terminal unless you pass `--yes`. For the two imports, `--dry-run` is the preview that does not need it.
