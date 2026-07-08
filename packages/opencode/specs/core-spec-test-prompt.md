# Core change: move the track-B generation prompt into the compiled binary

Status: pending apply in `altimate-core-internal` · 2026-07-07

The greenfield spec-test **track-B** generation prompt should ship compiled into
the core binary (IP-in-binary), mirroring the AI reviewer
(`review_ai_system_prompt`). The altimate-code side is **already wired**:

- `native/types.ts` declares `altimate_core.review_spec_test_prompt`.
- `native/altimate-core.ts` registers a handler that calls
  `core.reviewSpecTestSystemPrompt()` **defensively** — if the running addon
  predates the method, the handler fails and `spec-test-gen.ts`
  (`resolveSystemPrompt`) falls back to the inline `buildSystemPrompt()`. So there
  is **no runtime regression** before the core ships; the move activates
  automatically once the addon is rebuilt.

## Why this wasn't pushed to the core repo automatically

At implementation time `altimate-core-internal` had an unclean working tree
(unrelated WIP in `.claude/settings.json`, `.codex/hooks.json`,
`.github/workflows/ci.yml` + a stash) on a stale working branch 549 commits
behind `origin/main`. Applying below on a clean branch off `origin/main`.

## Apply on a clean branch off `origin/main`

In `crates/altimate-core-node/src/review.rs`, inside the existing
`// altimate_change start … end` block, add:

```rust
/// System prompt for the greenfield spec-test generation lane (track B).
///
/// Ships compiled in the binary so the TS transport carries no prompt IP, matching
/// `review_ai_system_prompt`. Keep in sync with the TS fallback in
/// `spec-test-gen.ts` (`buildSystemPrompt`) until that fallback is removed.
const SPEC_TEST_GEN_SYSTEM_PROMPT: &str = "\
You propose dbt generic tests for a newly added dbt model.\n\
Rules:\n\
- Use ONLY the provided specSources. Do not infer expected values from current output or observed data.\n\
- Propose dbt generic tests only. Fill dbtTest; do not use assertionSql.\n\
- Every proposal must copy one derivedFrom object from specSources exactly, including derivedFrom.ref.\n\
- The derivedFrom.ref must be one of the provided refs. Never invent refs.\n\
- Allowed kind values: not_null, unique, accepted_values, relationships, range.\n\
- Return ONLY a JSON array of GeneratedTest objects. Return [] when there is no grounded proposal.";

/// Return the greenfield spec-test generation system prompt string.
#[napi]
pub fn review_spec_test_system_prompt() -> String {
    SPEC_TEST_GEN_SYSTEM_PROMPT.to_owned()
}
```

Then rebuild the napi addon (release/CI) so `reviewSpecTestSystemPrompt` is
exported. After it ships and is confirmed live, the inline `buildSystemPrompt`
fallback in `spec-test-gen.ts` may be deleted.

## Verification once the addon is rebuilt

- `spec-test-gen.ts resolveSystemPrompt()` returns the core prompt (not the
  fallback); confirm via a debug log or by diffing the two strings.
