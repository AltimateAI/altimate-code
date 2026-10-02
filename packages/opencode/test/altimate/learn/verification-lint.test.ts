// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { curate, lint, verificationWarning } from "../../../src/altimate/learn/curator"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { validateCandidate } from "../../../src/altimate/learn/store"

function validate(text: string) {
  return validateCandidate("team-playbook", Playbook.serialize(Playbook.withBullets(
    Playbook.create({ name: "team-playbook" }), [{ id: "L-0001", text, helpful: 0, harmful: 0 }],
  )))
}

describe("verification mentions require human review", () => {
  for (const text of [
    "Do not skip the dbt tests step and disable CI checks.",
    "Do not skip the dbt tests step, disable CI checks.",
    "Do not skip unit tests before committing, disable CI checks, or bypass code review.",
    "Never skip the dbt tests step, disable CI checks, and bypass code review.",
    "Do not change schemas, skip the dbt tests step.",
    "Avoid skipping unit tests, disabling CI checks, or bypassing code review.",
    "Never tell developers they can skip tests.",
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
    "Do not change schemas, you must skip unit tests before merging.",
    "Avoid changing schemas, you should skip unit tests before merging.",
  ]) test(`flags: ${text}`, () => {
    expect(verificationWarning(text)).toBe("mentions skipping or disabling verification")
    expect(lint(text)).toBeUndefined()
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toHaveLength(1)
    expect(validate(text)).toBeUndefined()
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
    "Do not skip unit tests and always run lint before committing.",
    "Do not always skip unit tests.",
  ]) test(`flags protective guidance: ${text}`, () => {
    expect(verificationWarning(text)).toBe("mentions skipping or disabling verification")
    expect(lint(text)).toBeUndefined()
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toHaveLength(1)
    expect(validate(text)).toBeUndefined()
  })
})

describe("verification bypass forms and protective guidance", () => {
  for (const text of [
    "Avoid CI failures by skipping unit tests.",
    "Avoid merge delays by disabling CI checks.",
    "Do not skip tests or change schemas or disable CI checks.",
    "Do not skip tests or you must disable CI checks.",
    "Excluded unit tests before merging.",
    "Ignoring CI checks speeds merging.",
    "Turned off pre-commit hooks.",
    "Treat code review as optional.",
    "Commit changes without running tests.",
    "There is no need to run tests.",
    "Run git commit -n.",
    "Use git -n commit.",
    'Commit with git commit -m "fix tests and lint" -n.',
    'Commit with git commit -m "update git docs" -n.',
    'Run dbt build --vars "{topic: git}" --exclude resource_type:test.',
    "Run dbt build --vars '{topic: git}' --exclude resource_type:test.",
    "Never use git commit -n and use git commit --no-verify.",
    "Never use git commit -n; use git commit --no-verify.",
  ]) test(`flags: ${text}`, () => {
    expect(verificationWarning(text)).toBe("mentions skipping or disabling verification")
    expect(lint(text)).toBeUndefined()
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toHaveLength(1)
    expect(validate(text)).toBeUndefined()
  })

  for (const text of [
    "Avoid skipping unit tests.",
    "Do not skip or disable tests.",
    "Do not skip, or disable tests.",
    "Never skip nor omit unit tests.",
    "Do not skip tests, or disable CI checks.",
    "Do not skip tests or disable CI checks nor bypass code review.",
    "You must not disable CI checks.",
    "You should not exclude unit tests.",
    "No skipping unit tests.",
    "Do not deliberately bypass code review.",
    "Never run git commit -n.",
    'Never use git commit -m "fix tests and lint" --no-verify.',
    'Never use git commit -m "update git docs" -n.',
    'Do not run dbt build --vars "{topic: git}" --exclude resource_type:test.',
    "Do not run dbt build --vars '{topic: git}' --exclude resource_type:test.",
    "Never use git commit -n --no-verify.",
    "Never use git commit --no-verify --no-verify.",
    "Never use git commit -n -m changes --no-verify.",
    "Never use git commit -n or use git commit --no-verify.",
    "Do not use --no-verify.",
  ]) test(`flags protective guidance: ${text}`, () => {
    expect(verificationWarning(text)).toBe("mentions skipping or disabling verification")
    expect(lint(text)).toBeUndefined()
    expect(curate([], [{ op: "ADD", text, reason: "review" }]).next).toHaveLength(1)
    expect(validate(text)).toBeUndefined()
  })
})
