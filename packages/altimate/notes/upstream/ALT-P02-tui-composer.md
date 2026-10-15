# [FEATURE]: Expose prompt composer get, set, and focus to TUI plugins

Local draft only; duplicate search pending (offline). Open the feature issue and obtain design approval before opening a PR. The PR text describes an unapproved prototype.

## Feature issue body

### Feature hasn't been suggested before.

- [ ] I have verified this feature I'm about to request hasn't been suggested before.

### Describe the enhancement you want to request

A TUI plugin command may want to rewrite the current prompt or insert a suggested query for the user to review. The public plugin API can register commands but cannot read or replace the active draft and return focus to its editor.

Could `ctx.ui.composer` expose these synchronous methods?

```ts
get(): string | undefined
set(text: string): boolean
focus(): boolean
```

`get()` returns a text snapshot, or `undefined` when no composer is mounted. `set(text)` replaces the entire draft with plain text, clearing attachments, agent/skill mentions, and pasted-content metadata. It returns `false` when no composer is mounted. `focus()` attempts to focus the active editor and returns its actual focused state, including `false` when absent or unable to receive focus. Setting text does not implicitly focus or submit it.

For example, inside a plugin command:

```ts
const draft = ctx.ui.composer.get()
if (draft !== undefined && ctx.ui.composer.set(`Review this query:\n${draft}`))
  ctx.ui.composer.focus()
```

The prototype resolves the current prompt ref on every call, including after remounting. It wraps existing controls and exposes only text, without editor internals or submission middleware.

In v2.0.29, `UI` has no composer API (`packages/plugin/src/tui/context.ts:490`). Host-only `PromptRef` already exposes `current`, `set`, and `focus` (`packages/tui/src/component/prompt/index.tsx:88`), with the active ref held in `packages/tui/src/context/prompt.tsx:4`. `emptyPrompt()` defines a clean draft at `packages/tui/src/prompt/history.tsx:30`.

#### Open questions for maintainers

- Is a plain-text snapshot and full replacement the right initial contract?
- Should clearing attachment and mention/paste metadata require a more explicit method name?
- Should these controls remain limited to the active composer, with submission considered separately?

## PR title

`feat(tui): expose prompt composer controls to plugins`

## PR description

### Issue for this PR

No issue exists yet. This local draft awaits a feature issue and design approval.

### Type of change

- [ ] Bug fix
- [x] New feature
- [ ] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

Adds `ui.composer.get/set/focus` so TUI plugin commands can inspect or replace the active draft and focus its editor. The adapter reads the current `PromptRef` on each call. Replacement starts from `emptyPrompt()` to clear stale attachment and mention metadata; focus reports whether the editor actually received focus. The change touches the public TUI context, its host adapter, and a test file.

### How did you verify your code works?

Recorded prototype runs passed both new headless tests and the related plugin API suites (26 tests total), TUI/plugin typechecks, and the root check. The new tests exercise real plugin-context construction, command dispatch, the prompt registry, and OpenTUI textarea rendering through a `PromptRef` fixture. They assert draft replacement, metadata cleanup, focus, absent/remounted refs, empty text, and refused focus. They do not render the full production Prompt component. No tests were rerun while drafting.

Reviewer commands from `packages/tui`: `bun test test/plugin-composer.test.tsx` and `bun typecheck`; also run `bun typecheck` from `packages/plugin` and `bun run check` from the repository root.

### Screenshots / recordings

Pending. Before opening a UI PR, capture a before/after recording of a plugin command replacing a draft and focusing the production composer. Headless character-frame assertions are not a live TUI recording.

### Checklist

- [ ] I have tested my changes locally
- [ ] I have not included unrelated changes in this PR

## Local source verification (not part of the paste bodies)

Baseline references above were read from `git show v2.0.29:<path>`. Prototype-only references use commit `2c05c221c7`: `packages/plugin/src/tui/context.ts:494` (public methods), `packages/tui/src/plugin/api.tsx:213` (adapter), and `packages/tui/test/plugin-composer.test.tsx:99` and `:114` (two tests). Recorded results and the outstanding live capture were checked against the local findings' verification table. Keep checkboxes unchecked until the eventual upstream patch is verified.
