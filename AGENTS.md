# altimate-code agent guide

This file applies to the whole repository. Package-specific guides (for example `packages/opencode/AGENTS.md`) add to it.

# Cost side effects

Check every feature for spend that grows with user data instead of with the conversation, and flag it in the PR template's "Cost side effects" section, even when the answer is "None". The PR-standards check flags a missing or empty section on contributor PRs (it skips team members), and the review bots check every PR against `REVIEW.md` focus area 12. Examples: model calls per row, batch, file or item inside a tool; hidden model calls (sub-calls in tools, background or automatic calls); unbounded warehouse queries, scans or exports; starting cloud resources. Users' tables can hold millions of rows, so a per-row design that looks cheap in a test can cost thousands of dollars per question.

Such a path must be:

- Off by default, or bounded by a hard cap that does not scale with data size.
- Above the cap, shown as a cost estimate and run only after the user confirms.
- On the cheapest adequate model by default, with no prompt-cache breakpoint on one-off content (a cache write costs more than uncached input and is never read back).
- Counted in session cost and traces, so its spend is visible.

Bulk labeling of text through the session model is the cautionary case: on by default, it cost about 7x the agent sessions themselves on one evaluation day, and none of it appeared in traces.
