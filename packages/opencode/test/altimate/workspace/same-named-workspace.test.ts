// altimate_change - new file
//
// The link pickers open on a listed workspace that already has the name a quick
// create would use, instead of on "create", so a second workspace with the same name
// takes a deliberate choice.
import { describe, expect, test } from "bun:test"
import { sameNamedWorkspace } from "../../../src/altimate/workspace/workspace-name"

const ws = (id: number, name: string) => ({ id, name })

describe("sameNamedWorkspace", () => {
  test.each([
    ["exact name", [ws(1, "analytics")], "analytics", 1],
    ["case differs", [ws(1, "Analytics")], "analytics", 1],
    ["surrounding and inner whitespace differ", [ws(1, "  data   platform ")], "data platform", 1],
    ["a control character in the listed name", [ws(1, "analy\u0007tics")], "analy tics", 1],
    ["no workspace has the name", [ws(1, "marketing"), ws(2, "finance")], "analytics", undefined],
    ["a longer name that only starts the same", [ws(1, "analytics-prod")], "analytics", undefined],
    ["the first of two namesakes wins", [ws(3, "analytics"), ws(4, "ANALYTICS")], "analytics", 3],
    ["an empty proposed name matches nothing", [ws(1, "")], "   ", undefined],
    ["an empty list", [], "analytics", undefined],
  ] as const)("%s", (_label, list, proposed, expected) => {
    expect(sameNamedWorkspace(list, proposed)?.id).toBe(expected)
  })

  test("returns the listed object itself, so callers keep its id and display name", () => {
    const listed = ws(7, "Analytics")
    expect(sameNamedWorkspace([ws(1, "other"), listed], "analytics")).toBe(listed)
  })
})
