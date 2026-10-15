# Learn test fixtures

## `lint_cases.json`

Lesson texts with the client's verdict on each: `ok`, and the `reason` when it is refused. The verdict is
the per-text check `Store.validateCandidate` applies, `lint(text)` and then the normalization check
(`src/altimate/learn/curator.ts`). altimate-backend keeps a copy at
`tests/fixtures/learned_lessons/lint_cases.json` and validates submissions with a port of the same rules, so
both repositories run the same cases (`sync-effective.test.ts` here, `test_learned_lesson_lint.py` there).

The texts are the client's guardrail corpus, the curator test lists, and edge cases for UTF-16 length,
normalization and path triggers. After changing a lint rule, regenerate the verdicts from the client, add
cases for the new rule, then copy the file to the backend and port the rule there.

From `packages/opencode`:

```sh
bun -e '
import { lint, normalizeText } from "./src/altimate/learn/curator"
const file = "test/altimate/learn/fixtures/lint_cases.json"
const check = (t: string) => lint(t) ?? (normalizeText(t) !== t ? "contains hidden or non-normalized characters" : undefined)
const cases = (await Bun.file(file).json()).map(({ text }: { text: string }) => {
  const reason = check(text)
  return reason === undefined ? { text, ok: true } : { text, ok: false, reason }
})
await Bun.write(file, JSON.stringify(cases, null, 2) + "\n")
'
```

## `submission-hash-cases.json`

`/batch` items with the `submission_hash` altimate-backend computes for them (`material_hash` in
`app/crud/learned_lessons.py`, over a validated `BatchLessonItem`). Push matches results on exact hashes, so
`sync-effective.test.ts` checks that `submissionHash` here, and the test server's `materialHash`, produce the same
values. The cases cover non-ASCII text and tags, escapes, trigger paths, pinned, coexists refs and replaces. After
changing the hashed fields on either side, regenerate the file from the backend and keep the cases.
