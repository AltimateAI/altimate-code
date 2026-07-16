import { describe, expect, test } from "bun:test"
import { classifyInstallSource, normalizeInstallSource } from "@/plugin/tui/altimate/skill-ops"

// classifyInstallSource is the shared classifier for the DialogSkillList's "Install <query>"
// affordance and installSkillDirect. Keeping the two in lockstep matters: an earlier version
// of the list used `q.includes("/") && q.length >= 3`, which offered the Install option for
// skill-search queries like `dbt/snowflake` — the installer then rejected them as
// "Path not found". These tests pin the classifier's edge cases so the two can't drift.
describe("classifyInstallSource", () => {
  test("recognises github owner/repo shorthand", () => {
    expect(classifyInstallSource("anthropics/skills")).toBe("owner-repo")
    expect(classifyInstallSource("owner/repo.git")).toBe("owner-repo")
    expect(classifyInstallSource("Owner_1/repo-2.name")).toBe("owner-repo")
  })

  test("recognises http(s) URLs", () => {
    expect(classifyInstallSource("https://github.com/anthropics/skills.git")).toBe("github-url")
    expect(classifyInstallSource("http://example.com/thing")).toBe("github-url")
  })

  test("recognises POSIX absolute paths", () => {
    expect(classifyInstallSource("/tmp/my-skill")).toBe("absolute-path")
    expect(classifyInstallSource("/home/user/skills/foo")).toBe("absolute-path")
  })

  test("recognises Windows drive-letter paths", () => {
    expect(classifyInstallSource("C:\\Users\\me\\skills")).toBe("absolute-path")
    expect(classifyInstallSource("D:/skills/foo")).toBe("absolute-path")
  })

  test("rejects short strings that the installer would refuse", () => {
    expect(classifyInstallSource("a")).toBeNull()
    expect(classifyInstallSource("ab")).toBeNull()
    expect(classifyInstallSource("")).toBeNull()
  })

  test("rejects multi-slash paths that aren't clean owner/repo (search terms, sub-paths)", () => {
    // Historically `q.includes("/")` misfired on these — a skill search for "dbt/snowflake"
    // would surface an Install option that installSkillDirect then refused.
    expect(classifyInstallSource("owner/repo/subpath")).toBeNull()
    expect(classifyInstallSource("dbt/snowflake/thing")).toBeNull()
  })

  test("rejects `~`-prefixed and relative paths — ambiguous with skill names", () => {
    expect(classifyInstallSource("~/skills/foo")).toBeNull()
    expect(classifyInstallSource("./local")).toBeNull()
    expect(classifyInstallSource("../thing")).toBeNull()
  })

  test("rejects bare identifiers with no slash and no path prefix", () => {
    expect(classifyInstallSource("skill-name")).toBeNull()
    expect(classifyInstallSource("dbt-snowflake")).toBeNull()
  })

  test("strips trailing dots and `.git` before classifying", () => {
    expect(classifyInstallSource("owner/repo.git")).toBe("owner-repo")
    expect(classifyInstallSource("https://github.com/x/y.git")).toBe("github-url")
    expect(classifyInstallSource("owner/repo.")).toBe("owner-repo")
  })

  test("trims surrounding whitespace before classifying", () => {
    expect(classifyInstallSource("  owner/repo  ")).toBe("owner-repo")
    expect(classifyInstallSource("\thttps://github.com/x/y\n")).toBe("github-url")
  })
})

// normalizeInstallSource is the shared trim/strip helper that installSkillDirect uses
// before building a clone URL from an `owner/repo` shorthand. Without it, an input like
// `owner/repo.git` (accepted by the classifier because it strips `.git`) would produce
// `https://github.com/owner/repo.git.git` — real bug flagged in review.
describe("normalizeInstallSource", () => {
  test("strips a trailing `.git` suffix", () => {
    expect(normalizeInstallSource("owner/repo.git")).toBe("owner/repo")
    expect(normalizeInstallSource("https://github.com/x/y.git")).toBe("https://github.com/x/y")
  })

  test("strips trailing dots", () => {
    expect(normalizeInstallSource("owner/repo.")).toBe("owner/repo")
    expect(normalizeInstallSource("owner/repo...")).toBe("owner/repo")
  })

  test("trims surrounding whitespace", () => {
    expect(normalizeInstallSource("  owner/repo  ")).toBe("owner/repo")
    expect(normalizeInstallSource("\n\towner/repo\r\n")).toBe("owner/repo")
  })

  test("returns the source unchanged when nothing to strip", () => {
    expect(normalizeInstallSource("owner/repo")).toBe("owner/repo")
    expect(normalizeInstallSource("/tmp/skills")).toBe("/tmp/skills")
    expect(normalizeInstallSource("")).toBe("")
  })
})
