// altimate_change - new file
import { describe, expect, test } from "bun:test"
import * as Playbook from "../../../src/altimate/learn/playbook"

const SAMPLE = `---
name: team-playbook
description: "${Playbook.PLAYBOOK_DESCRIPTION}"
applyPaths: ["dbt_project.yml"]
---
${Playbook.HEADER}

Hand-written note that must survive.
- [L-3f2a] Staging models filter soft-deleted rows. <!-- h:4 x:0 -->
- not a managed bullet
- [L-00ab] Timestamps are UTC. <!-- h:0 x:1 -->

Trailing prose.
`

describe("playbook", () => {
  test("session rendering is lesson text only", () => {
    const lessons = [
      { id: "L-0001", text: "Keep timestamps in UTC.", helpful: 4, harmful: 2 },
      { id: "L-0002", text: "Preserve `amount_cents` as integers.", helpful: 9, harmful: 0 },
    ]
    expect(Playbook.renderLessons(lessons)).toBe("Keep timestamps in UTC.\nPreserve `amount_cents` as integers.")
    expect(Playbook.renderLessons([])).toBe("")
  })
  test("round trip is lossless", () => {
    expect(Playbook.serialize(Playbook.parse(SAMPLE))).toBe(SAMPLE)
  })

  test("round trip is lossless without frontmatter or trailing newline", () => {
    for (const t of ["", "just text", "- [L-0001] a <!-- h:1 x:2 -->", "---\nunclosed\n- [L-0001] a <!-- h:1 x:2 -->\n"])
      expect(Playbook.serialize(Playbook.parse(t))).toBe(t)
  })

  test("parses bullets with counters; unknown lines stay raw", () => {
    const b = Playbook.bullets(Playbook.parse(SAMPLE))
    expect(b).toEqual([
      { id: "L-3f2a", text: "Staging models filter soft-deleted rows.", helpful: 4, harmful: 0 },
      { id: "L-00ab", text: "Timestamps are UTC.", helpful: 0, harmful: 1 },
    ])
  })

  test("round trip preserves coexist links alongside old bullets", () => {
    const text = SAMPLE.replace("h:4 x:0", "h:4 x:0 c:L-00ab,L-1234")
    const pb = Playbook.parse(text)
    expect(Playbook.bullets(pb)[0].coexists).toEqual(["L-00ab", "L-1234"])
    expect(Playbook.bullets(pb)[1].coexists).toBeUndefined()
    expect(Playbook.serialize(pb)).toBe(text)
    const edited = Playbook.bullets(pb)
    edited[0].helpful++
    expect(Playbook.serialize(Playbook.withBullets(pb, edited))).toBe(text.replace("h:4 x:0", "h:5 x:0"))
  })

  test("withBullets keeps surrounding text, drops, edits and appends", () => {
    const pb = Playbook.parse(SAMPLE)
    const next = Playbook.withBullets(pb, [
      { id: "L-3f2a", text: "Edited.", helpful: 5, harmful: 0 },
      { id: "L-0e01", text: "Added.", helpful: 0, harmful: 0 },
    ])
    const text = Playbook.serialize(next)
    expect(text).toContain("Hand-written note that must survive.")
    expect(text).toContain("- not a managed bullet")
    expect(text).toContain("Trailing prose.")
    expect(text).toContain("- [L-3f2a] Edited. <!-- h:5 x:0 -->")
    expect(text).not.toContain("L-00ab")
    expect(Playbook.bullets(Playbook.parse(text)).map((b) => b.id)).toEqual(["L-3f2a", "L-0e01"])
  })

  test("withBullets keeps superseding bullets at the original position", () => {
    const pb = Playbook.parse(SAMPLE)
    const next = Playbook.withBullets(pb, [
      { id: "L-0e01", text: "Replacement.", helpful: 0, harmful: 0 },
      Playbook.bullets(pb)[1],
    ], { "L-3f2a": "L-0e01" })
    expect(Playbook.serialize(next)).toBe(SAMPLE.replace(
      "- [L-3f2a] Staging models filter soft-deleted rows. <!-- h:4 x:0 -->",
      "- [L-0e01] Replacement. <!-- h:0 x:0 -->",
    ))
  })

  test("withBullets follows successive replacements and drops removed replacements", () => {
    const pb = Playbook.parse(SAMPLE)
    const replacement = { id: "L-0e02", text: "Final replacement.", helpful: 0, harmful: 0 }
    const replacements = { "L-3f2a": "L-0e01", "L-0e01": "L-0e02" }
    const next = Playbook.withBullets(pb, [replacement, Playbook.bullets(pb)[1]], replacements)
    expect(Playbook.serialize(next)).toContain("Final replacement. <!-- h:0 x:0 -->\n- not a managed bullet")
    const removed = Playbook.withBullets(pb, [Playbook.bullets(pb)[1]], replacements)
    expect(Playbook.bullets(removed).map((b) => b.id)).toEqual(["L-00ab"])
    expect(Playbook.serialize(removed)).toContain("- not a managed bullet")
  })

  test("create: applyPaths vs alwaysApply, no provenance, ends with newline", () => {
    const withPaths = Playbook.serialize(Playbook.create({ name: "team-playbook", applyPaths: ["dbt_project.yml"] }))
    expect(withPaths).toContain('applyPaths: ["dbt_project.yml"]')
    expect(withPaths).not.toContain("alwaysApply")
    const always = Playbook.serialize(Playbook.create({ name: "team-playbook" }))
    expect(always).toContain("alwaysApply: true")
    expect(always).toContain(`description: ${JSON.stringify(Playbook.PLAYBOOK_DESCRIPTION)}`)
    expect(always.endsWith("\n")).toBe(true)
    const filled = Playbook.serialize(
      Playbook.withBullets(Playbook.create({ name: "team-playbook" }), [{ id: "L-0001", text: "A.", helpful: 0, harmful: 0 }]),
    )
    expect(filled.endsWith("<!-- h:0 x:0 -->\n")).toBe(true)
    expect(filled.indexOf(Playbook.HEADER)).toBeLessThan(filled.indexOf("L-0001"))
  })

  test("generated frontmatter parses with the skill loader's frontmatter library", async () => {
    const matter = (await import("gray-matter")).default
    const fm = matter(Playbook.serialize(Playbook.create({ name: "team-playbook", applyPaths: ["dbt_project.yml"] }))).data
    expect(fm).toEqual({ name: "team-playbook", description: Playbook.PLAYBOOK_DESCRIPTION, applyPaths: ["dbt_project.yml"] })
  })

  test("ids are short hex and avoid collisions", () => {
    const id = Playbook.newId()
    expect(id).toMatch(/^L-[0-9a-f]{4}$/)
    const taken = new Set<string>()
    for (let i = 0; i < 200; i++) taken.add(Playbook.newId(taken))
    expect(taken.size).toBe(200)
  })

  test("name validation", () => {
    expect(Playbook.validateName("team-playbook")).toBe("team-playbook")
    for (const bad of ["../x", "A", "a/b", "", "a--b", "-a"]) expect(() => Playbook.validateName(bad)).toThrow()
  })
})
