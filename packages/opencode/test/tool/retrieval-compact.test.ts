import { describe, expect, test } from "bun:test"

import { Retrieval } from "../../src/tool/retrieval"

describe("Retrieval.compactDescription", () => {
  test("keeps a short single sentence unchanged", () => {
    expect(Retrieval.compactDescription("Analyze dbt models.")).toBe("Analyze dbt models.")
  })

  test("takes only the first sentence of a multi-sentence description", () => {
    const text = "Find flaky tests. Runs hourly to find real-world gaps. Uses a critic."
    expect(Retrieval.compactDescription(text)).toBe("Find flaky tests.")
  })

  test("collapses whitespace and newlines", () => {
    expect(Retrieval.compactDescription("Analyze\n  dbt   models. More detail follows.")).toBe("Analyze dbt models.")
  })

  test("caps very long sentences with an ellipsis", () => {
    const long = "A".repeat(400) + "."
    const result = Retrieval.compactDescription(long, 160)
    expect(result.length).toBeLessThanOrEqual(160)
    expect(result.endsWith("…")).toBe(true)
  })

  test("handles undefined and empty input", () => {
    expect(Retrieval.compactDescription(undefined)).toBe("")
    expect(Retrieval.compactDescription("   ")).toBe("")
  })

  test("does not mis-cut on an abbreviation's period", () => {
    expect(Retrieval.compactDescription("e.g. run the linter before committing.")).toBe(
      "e.g. run the linter before committing.",
    )
  })

  test("does not mis-cut on a decimal version number", () => {
    expect(Retrieval.compactDescription("Supports v2.0 models and newer releases.")).toBe(
      "Supports v2.0 models and newer releases.",
    )
  })

  test("does not mis-cut on a bare URL", () => {
    expect(Retrieval.compactDescription("See https://example.com for details and more context here.")).toBe(
      "See https://example.com for details and more context here.",
    )
  })
})
