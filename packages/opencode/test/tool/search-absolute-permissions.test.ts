import { expect, test } from "bun:test"
import { Permission } from "../../src/permission"
import { readableSearchResults } from "../../src/altimate/search-read-permissions"

test("a later relative wildcard cannot hide an absolute read deny or ask", () => {
  for (const action of ["deny", "ask"] as const) {
    const permissions = Permission.fromConfig({
      read: {
        "/workspace/private/**": action,
        "*": "allow",
      },
    })
    expect(readableSearchResults(["/workspace/private/key.txt"], "/workspace", permissions)).toEqual({
      allowed: new Set(action === "deny" ? [] : ["/workspace/private/key.txt"]),
      patterns: action === "ask" ? ["/workspace/private/key.txt"] : [],
    })
  }
})
