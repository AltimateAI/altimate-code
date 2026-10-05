/**
 * The `dbt_fault_injection` tool copies a project and runs its dbt code, so a project or profiles
 * directory outside the session's workspace needs the `external_directory` permission the bash
 * tool asks for, and relative paths resolve against the session directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import { runFaultInjection } from "../../src/altimate/native/connections/fault-injection"
import { DbtFaultInjectionTool } from "../../src/altimate/tools/dbt-fault-injection"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { initTool } from "./tool-fixture"

let received: Record<string, any> | undefined

beforeEach(async () => {
  received = undefined
  try {
    await Dispatcher.call("__trigger_hook__" as any, {} as any)
  } catch {}
  Dispatcher.register("dbt.fault_injection", async (params: any) => {
    received = params
    return { success: true }
  })
})

afterEach(() => {
  Dispatcher.register("dbt.fault_injection", (params: any) => runFaultInjection(params))
})

async function runTool(directory: string, args: Record<string, unknown>, deny = false) {
  const asked: any[] = []
  const tool = await initTool(DbtFaultInjectionTool)
  const outcome = await Instance.provide({
    directory,
    fn: () =>
      tool
        .execute(args, {
          sessionID: "test",
          messageID: "test",
          agent: "test",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => {},
          ask: async (request: any) => {
            asked.push(request)
            if (deny && request.permission === "external_directory") throw new Error("denied")
          },
        })
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        ),
  })
  return { asked, error: (outcome as { error?: unknown }).error }
}

describe("dbt_fault_injection permissions", () => {
  test("a project inside the workspace needs only the bash permission, for the commands that really run", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "dbt", "profiles.yml"), "p: {}\n")
    const { asked } = await runTool(tmp.path, { project_dir: "dbt", budget: 1 })
    expect(asked.map((a) => a.permission)).toEqual(["bash"])
    const project = path.join(tmp.path, "dbt")
    for (const command of ["parse", "compile", "build", "run", "test"]) {
      expect(asked[0].patterns).toContain(`dbt ${command} --project-dir ${project}`)
    }
    expect(received?.project_dir).toBe(project)
  })

  test("a relative profiles_dir resolves against the session directory", async () => {
    await using tmp = await tmpdir()
    await runTool(tmp.path, { project_dir: ".", profiles_dir: "profiles", budget: 1 })
    expect(received?.profiles_dir).toBe(path.join(tmp.path, "profiles"))
  })

  test("a project outside the workspace asks for external_directory before anything runs", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Bun.write(path.join(outside.path, "profiles.yml"), "p: {}\n")
    const { asked } = await runTool(tmp.path, { project_dir: outside.path, budget: 1 })
    expect(asked[0].permission).toBe("external_directory")
    expect(asked[0].patterns).toEqual([path.join(outside.path, "*")])
    expect(received?.project_dir).toBe(outside.path)
  })

  test("a profiles directory outside the workspace asks too", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    const { asked } = await runTool(tmp.path, { project_dir: ".", profiles_dir: outside.path, budget: 1 })
    expect(asked.filter((a) => a.permission === "external_directory").map((a) => a.patterns[0])).toEqual([
      path.join(outside.path, "*"),
    ])
  })

  test("a profiles.yml that is a link to a file outside the workspace is gated by its real location", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    await Bun.write(path.join(outside.path, "profiles.yml"), "p: {}\n")
    await Bun.write(path.join(tmp.path, "dbt_project.yml"), "name: p\nprofile: p\n")
    fs.symlinkSync(path.join(outside.path, "profiles.yml"), path.join(tmp.path, "profiles.yml"))
    const saved = process.env.DBT_PROFILES_DIR
    delete process.env.DBT_PROFILES_DIR
    try {
      const { asked } = await runTool(tmp.path, { project_dir: ".", budget: 1 })
      expect(asked.filter((a) => a.permission === "external_directory").map((a) => a.patterns[0])).toEqual([
        path.join(fs.realpathSync(outside.path), "*"),
      ])
    } finally {
      if (saved !== undefined) process.env.DBT_PROFILES_DIR = saved
    }
  })

  test("a dangling profiles.yml link is reported as an error result, not thrown", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "dbt_project.yml"), "name: p\nprofile: p\n")
    fs.symlinkSync(path.join(tmp.path, "missing.yml"), path.join(tmp.path, "profiles.yml"))
    const saved = process.env.DBT_PROFILES_DIR
    delete process.env.DBT_PROFILES_DIR
    try {
      const { asked, error } = await runTool(tmp.path, { project_dir: ".", budget: 1 })
      expect(error).toBeUndefined()
      expect(asked).toEqual([])
      expect(received).toBeUndefined()
    } finally {
      if (saved !== undefined) process.env.DBT_PROFILES_DIR = saved
    }
  })

  test("when external_directory is denied nothing is copied or run", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    const { asked, error } = await runTool(tmp.path, { project_dir: outside.path, budget: 1 }, true)
    expect(String(error)).toContain("denied")
    expect(received).toBeUndefined()
    expect(asked.map((a) => a.permission)).toEqual(["external_directory"])
  })
})
