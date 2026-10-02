// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { curate, lint } from "../../../src/altimate/learn/curator"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { validateCandidate } from "../../../src/altimate/learn/store"

function validate(text: string) {
  return validateCandidate("team-playbook", Playbook.serialize(Playbook.withBullets(
    Playbook.create({ name: "team-playbook" }), [{ id: "L-0001", text, helpful: 0, harmful: 0 }],
  )))
}

describe("verification lint respects clause negation", () => {
  for (const text of [
    "Skip the dbt tests step.",
    "Omit the dbt tests step.",
    "Disable the pre-commit hooks.",
    "Bypass required code review.",
    "Skip the project's CI checks.",
    "Run dbt test --exclude test.",
    "Run dbt build --exclude test.",
    "Run dbt build --exclude=test_type:generic.",
    "Disable dbt contracts before building.",
    "Disable all quality gates.",
    "Disable testing before merging.",
    "Do not run unit tests before merging.",
    "Run dbt build --exclude resource_type:test.",
    "Skip `dbt test` before committing.",
    "Do not skip tests; disable CI checks instead.",
    "Never skip unit tests, but bypass code review.",
    "Don't disable CI checks. Skip lint instead.",
    "Do not skip tests and disable CI checks instead.",
    "Do not skip tests instead disable CI checks.",
    "Do not skip tests then disable CI checks.",
    "Never skip unit tests yet bypass code review.",
  ]) test(`rejects: ${text}`, () => {
    expect(lint(text)).toBe("weakens verification")
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toEqual([])
    expect(validate(text)).toContain("weakens verification")
  })

  for (const text of [
    "Do not skip unit tests before committing.",
    "Never skip the dbt tests step.",
    "Don't disable CI checks.",
    "Do not ever bypass code review.",
    "Never omit lint checks.",
    "Don't turn off pre-commit hooks.",
    "Do not run dbt build --exclude test.",
    "Never use git commit --no-verify.",
    "Never use `git commit --no-verify`.",
    "Do not treat code review as optional.",
    "Do not skip tests or disable CI checks.",
    "Do not skip the dbt tests step or disable CI checks.",
    "Do not skip the dbt tests step and disable CI checks.",
    "Do not skip the dbt tests step, disable CI checks.",
    "Do not skip unit tests before committing, disable CI checks, or bypass code review.",
    "Never skip the dbt tests step, disable CI checks, and bypass code review.",
    "Do not change schemas, skip the dbt tests step.",
    "Run unit tests before committing.",
    "Skip duplicate input rows before processing.",
  ]) test(`accepts: ${text}`, () => {
    expect(lint(text)).toBeUndefined()
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toHaveLength(1)
    expect(validate(text)).toBeUndefined()
  })
})
