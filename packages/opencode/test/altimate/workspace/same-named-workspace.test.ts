// altimate_change - new file
//
// The link pickers open on the caller's own workspace that already has the name a quick
// create would use, never on a colleague's, and creating another workspace with that
// name takes a deliberate choice.
import { describe, expect, test } from "bun:test"
import {
  NAME_COLLATOR,
  confirmsNamesake,
  displayWorkspaceName,
  findNamesakes,
  linkPickerOpensOn,
  namesakeHint,
} from "../../../src/altimate/workspace/workspace-name"

const ME = 10
const COLLEAGUE = 20
const ws = (id: number, name: string, ownerId?: number) => ({ id, name, ownerId })

describe("findNamesakes: which names match", () => {
  test.each([
    ["exact name", [ws(1, "analytics")], "analytics", [1]],
    ["case differs", [ws(1, "Analytics")], "analytics", [1]],
    ["case differs beyond ASCII: ß and SS", [ws(1, "Straße")], "STRASSE", [1]],
    ["case differs beyond ASCII: capital sharp S and SS", [ws(1, "ẞ")], "SS", [1]],
    ["Greek final sigma", [ws(1, "ΟΔΟΣ")], "οδος", [1]],
    ["a ligature against its letters", [ws(1, "ﬁnance")], "FINANCE", [1]],
    ["dotless i stays distinct from i", [ws(1, "ı")], "i", []],
    ["an accent is a different name", [ws(1, "café")], "cafe", []],
    ["Danish aa is not å", [ws(1, "aa")], "å", []],
    ["NFD and NFC spellings are one name", [ws(1, "café")], "café", [1]],
    ["surrounding and inner whitespace differ", [ws(1, "  data   platform ")], "data platform", [1]],
    ["a control character in the listed name", [ws(1, "analy\u0007tics")], "analy tics", [1]],
    ["a control character in the proposed name", [ws(1, "analy tics")], "analy\u0007tics", [1]],
    ["a zero-width space in the listed name is ignored", [ws(1, "analy​tics")], "analytics", [1]],
    ["a bidi control in the listed name is ignored", [ws(1, "analy؜tics")], "analytics", [1]],
    ["no workspace has the name", [ws(1, "marketing"), ws(2, "finance")], "analytics", []],
    ["a longer name that only starts the same", [ws(1, "analytics-prod")], "analytics", []],
    ["every namesake, in list order", [ws(3, "analytics"), ws(5, "x"), ws(4, "ANALYTICS")], "analytics", [3, 4]],
    ["an empty proposed name matches nothing", [ws(1, "")], "   ", []],
    ["an empty list", [], "analytics", []],
  ] as const)("%s", (_label, list, proposed, expected) => {
    expect(findNamesakes(list, proposed, ME).all.map((w) => w.id)).toEqual([...expected])
  })

  test("returns the listed objects themselves, so callers keep each id and display name", () => {
    const listed = ws(7, "Analytics", ME)
    const found = findNamesakes([ws(1, "other"), listed], "analytics", ME)
    expect(found.all[0]).toBe(listed)
    expect(found.own).toBe(listed)
  })

  test("the collator is pinned to en, whatever the host locale", () => {
    // Under a Turkish default an unpinned collator stops pairing I with i.
    expect(NAME_COLLATOR.resolvedOptions().locale).toBe("en")
  })
})

describe("findNamesakes: which namesake a picker may open on", () => {
  test.each([
    ["mine", [ws(1, "analytics", ME)], ME, 1],
    ["a colleague's", [ws(1, "analytics", COLLEAGUE)], ME, undefined],
    ["a colleague's first, then mine: mine", [ws(1, "analytics", COLLEAGUE), ws(2, "analytics", ME)], ME, 2],
    ["two of mine: the first", [ws(1, "analytics", ME), ws(2, "Analytics", ME)], ME, 1],
    ["owner not reported by the server", [ws(1, "analytics")], ME, undefined],
    ["caller unknown", [ws(1, "analytics", ME)], undefined, undefined],
  ] as const)("%s", (_label, list, userId, expected) => {
    expect(findNamesakes(list, "analytics", userId).own?.id).toBe(expected)
  })
})

describe("namesakeHint", () => {
  const mine = ws(1, "analytics", ME)
  const theirs = ws(2, "analytics", COLLEAGUE)
  const unknownOwner = ws(3, "analytics")
  const other = ws(4, "marketing", ME)
  const list = [mine, theirs, unknownOwner, other]
  test.each([
    ["my namesake", mine, ME, "same name as this project"],
    ["a colleague's namesake", theirs, ME, "same name, owned by someone else"],
    ["a namesake whose owner is not reported", unknownOwner, ME, "same name as this project"],
    ["a namesake when the caller is unknown", theirs, undefined, "same name as this project"],
    ["a workspace with another name", other, ME, undefined],
  ] as const)("%s", (_label, row, userId, expected) => {
    expect(namesakeHint(row, findNamesakes(list, "analytics", userId), userId)).toBe(expected)
  })
})

describe("linkPickerOpensOn", () => {
  test.each([
    ["linked, with my namesake: the link", 9, [ws(1, "analytics", ME)], 9],
    ["unlinked, with my namesake: the namesake", undefined, [ws(1, "analytics", ME)], 1],
    ["unlinked, with only a colleague's namesake: create", undefined, [ws(1, "analytics", COLLEAGUE)], "create"],
    ["unlinked, no namesake: create", undefined, [ws(1, "marketing", ME)], "create"],
  ] as const)("%s", (_label, currentId, list, expected) => {
    expect(linkPickerOpensOn(currentId, findNamesakes(list, "analytics", ME))).toBe(expected)
  })
})

describe("confirmsNamesake", () => {
  const withNamesake = findNamesakes([ws(1, "analytics", COLLEAGUE)], "analytics", ME)
  const without = findNamesakes([ws(1, "marketing", ME)], "analytics", ME)
  test.each([
    ["create, name taken", "create", withNamesake, true],
    ["browser, name taken", "browser", withNamesake, true],
    ["an existing workspace, name taken", "workspace", withNamesake, false],
    ["create, name free", "create", without, false],
    ["browser, name free", "browser", without, false],
  ] as const)("%s", (_label, choice, namesakes, expected) => {
    expect(confirmsNamesake(choice, namesakes)).toBe(expected)
  })
})

describe("displayWorkspaceName", () => {
  test.each([
    ["bidi controls are stripped", "‮analytics⁦x⁩؜", "analyticsx"],
    ["a newline cannot break the line", "ana\nlytics", "ana lytics"],
    ["plain text is unchanged", "analytics", "analytics"],
  ] as const)("%s", (_label, name, expected) => {
    expect(displayWorkspaceName(name)).toBe(expected)
  })
})
