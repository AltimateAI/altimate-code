import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { PromptProfiles } from "../../src/altimate/prompts/profiles"
import { EXPECTED_BYTES, EXPECTED_SHA256, sha256 } from "./prompt-identity"

const { assemble, BUILDER_PROFILE, FRAGMENTS, PROMPT_BUILDER } = PromptProfiles

// The byte-identity gate for the workload-adaptive harness PR 1 (compile-time
// split of builder.txt into core + packs). The assembled default profile must
// reproduce the pre-split builder.txt byte-for-byte — this is the entire
// quality argument for the split: identical bytes, identical behavior, no eval
// run needed. The pin lives in ./prompt-identity (shared with the agent
// registry test and the subprocess helper).

describe("builder profile byte identity", () => {
  test("assembled default profile is byte-identical to the pre-split builder.txt", () => {
    expect(Buffer.byteLength(PROMPT_BUILDER, "utf8")).toBe(EXPECTED_BYTES)
    expect(sha256(PROMPT_BUILDER)).toBe(EXPECTED_SHA256)
  })

  test("assembly is a plain ordered concatenation of the fragments", () => {
    expect(assemble(BUILDER_PROFILE)).toBe(PROMPT_BUILDER)
    let rest = PROMPT_BUILDER
    for (const name of BUILDER_PROFILE) {
      expect(rest.startsWith(FRAGMENTS[name])).toBe(true)
      rest = rest.slice(FRAGMENTS[name].length)
    }
    // Fragments cover the whole prompt — nothing appended outside the profile.
    expect(rest).toBe("")
  })

  test("every fragment is non-empty, newline-terminated, and used at most once per profile", () => {
    for (const [name, text] of Object.entries(FRAGMENTS)) {
      expect(text.length, `fragment ${name} is empty`).toBeGreaterThan(0)
      // Fragments carry their own trailing newline; profiles join with "".
      expect(text.endsWith("\n"), `fragment ${name} must end with a newline`).toBe(true)
    }
    for (const profile of [BUILDER_PROFILE]) {
      expect(new Set(profile).size).toBe(profile.length)
    }
    // The default profile uses every fragment exactly once (the split is total).
    expect([...BUILDER_PROFILE].map(String).sort()).toEqual(Object.keys(FRAGMENTS).sort())
  })
})

describe("assembly determinism across processes and environments", () => {
  // We have been burned by cwd-dependent behavior repeatedly: assemble in two
  // separate processes, from different cwds and different HOMEs, and require
  // the same pinned bytes both times.
  const helper = path.join(import.meta.dir, "prompt-profiles-hash-helper.ts")

  function assembleInSubprocess(cwd: string, home: string): string {
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "run", helper],
      cwd,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0)
    return new TextDecoder().decode(proc.stdout).trim()
  }

  test("two fresh processes with different cwd and HOME produce identical pinned bytes", () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-profiles-a-"))
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-profiles-b-"))
    try {
      const a = assembleInSubprocess(tmpA, tmpA)
      const b = assembleInSubprocess(tmpB, tmpB)
      expect(a).toBe(`${EXPECTED_SHA256} ${EXPECTED_BYTES}`)
      expect(b).toBe(a)
    } finally {
      fs.rmSync(tmpA, { recursive: true, force: true })
      fs.rmSync(tmpB, { recursive: true, force: true })
    }
  }, 30_000)
})
