import YAML from "yaml"
import { makeFinding, type Finding } from "./finding"
import type { ChangedFile } from "./diff-filter"

/**
 * dbt unit tests whose fixtures cannot exercise the model. When every `given`
 * input has `rows: []`:
 *  - `expect` with no rows: the test passes whatever the model does;
 *  - `expect` with rows: the model has nothing to transform, so the test can
 *    only pass if the model emits constant rows.
 * One empty input is normal (an empty `this` for an `is_incremental` test), so
 * the rule needs all of them empty. Only unit tests added or changed in this
 * PR are checked; `format: csv`/`sql` fixtures are skipped.
 */

interface UnitTest {
  name?: string
  model?: string
  given?: Array<{ input?: string; rows?: unknown; format?: string }>
  expect?: { rows?: unknown; format?: string }
}

function unitTestsOf(doc: unknown): Map<string, UnitTest> {
  const out = new Map<string, UnitTest>()
  const list = (doc as { unit_tests?: unknown })?.unit_tests
  if (!Array.isArray(list)) return out
  for (const t of list) {
    if (t && typeof t === "object" && typeof (t as UnitTest).name === "string") out.set((t as UnitTest).name!, t as UnitTest)
  }
  return out
}

const isDict = (f?: string) => f === undefined || f === "dict"

export function detectUnitTestFixtures(file: ChangedFile, oldContent?: string, newContent?: string): Finding[] {
  if (file.status === "deleted" || !newContent) return []
  let newDoc: unknown
  let oldDoc: unknown
  try {
    newDoc = YAML.parse(newContent)
    oldDoc = oldContent ? YAML.parse(oldContent) : undefined
  } catch {
    return []
  }
  const before = unitTestsOf(oldDoc)
  const out: Finding[] = []
  for (const [name, test] of unitTestsOf(newDoc)) {
    const prev = before.get(name)
    if (prev && JSON.stringify(prev) === JSON.stringify(test)) continue
    const given = Array.isArray(test.given) ? test.given : []
    const allInputsEmpty = given.length > 0 && given.every((g) => isDict(g.format) && Array.isArray(g.rows) && g.rows.length === 0)
    const expectRows = test.expect?.rows
    if (!allInputsEmpty || !isDict(test.expect?.format) || !Array.isArray(expectRows)) continue
    const model = test.model ?? ""
    const passesAnyway = expectRows.length === 0
    out.push(
      makeFinding({
        severity: passesAnyway ? "suggestion" : "warning",
        category: "test_coverage",
        title: passesAnyway
          ? `${model || name}: unit test \`${name}\` cannot fail`
          : `${model || name}: unit test \`${name}\` expects rows from empty inputs`,
        body: passesAnyway
          ? "Every `given` input has `rows: []` and `expect` has no rows, so the test passes whatever the model does. " +
            "Add input rows that exercise the logic under test."
          : `Every \`given\` input has \`rows: []\` but \`expect\` has ${expectRows.length} row(s): the model has nothing to transform. ` +
            "Add input rows that exercise the changed logic.",
        file: file.path,
        model: model || undefined,
        confidence: "high",
        evidence: { tool: "unit-test-fixtures", result: { rule: passesAnyway ? "unit_test_cannot_fail" : "unit_test_empty_inputs", test: name } },
        ruleKey: `test_coverage:unit-test-empty-inputs:${name}`,
      }),
    )
  }
  return out
}
