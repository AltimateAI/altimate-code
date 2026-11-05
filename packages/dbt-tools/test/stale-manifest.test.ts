import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { DBTProjectIntegrationAdapter, DBTProjectIntegrationAdapterEvents } from "@altimateai/dbt-integration"
import type { ParsedManifest } from "@altimateai/dbt-integration"
import { create } from "../src/adapter"
import { children, parents } from "../src/commands/graph"
import { schemaVerify } from "../src/commands/schema-verify"
import { recordManifest, staleManifestNote } from "../src/stale-manifest"

const WRITTEN_AT = Date.UTC(2026, 10, 5, 8, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const staleManifest = () =>
  recordManifest({ stale: { manifestPath: "/p/target/manifest.json", writtenAt: WRITTEN_AT } } as ParsedManifest)
const currentManifest = () => recordManifest({} as ParsedManifest)

afterEach(currentManifest)

describe("the stale manifest note", () => {
  test("is absent for a manifest the project check stands behind", () => {
    expect(staleManifestNote()).toBeUndefined()
  })

  test.each([
    [0, "0 minutes ago"],
    [MINUTE, "1 minute ago"],
    [59 * MINUTE, "59 minutes ago"],
    [2 * HOUR, "2 hours ago"],
    [47 * HOUR, "47 hours ago"],
    [72 * HOUR, "3 days ago"],
    // A clock set back since the manifest was written.
    [-HOUR, "0 minutes ago"],
  ])("written %i ms before now reads %s", (age, words) => {
    staleManifest()
    const note = staleManifestNote(WRITTEN_AT + age)
    expect(note?.message).toContain(`last successful parse, written ${words}.`)
    expect(note?.age_seconds).toBe(Math.max(0, age) / 1000)
  })

  test("names the manifest and when it was written", () => {
    staleManifest()
    expect(staleManifestNote(WRITTEN_AT)).toMatchObject({
      manifest_path: "/p/target/manifest.json",
      written_at: "2026-11-05T08:00:00.000Z",
    })
  })

  test("goes once a later parse is current", () => {
    staleManifest()
    currentManifest()
    expect(staleManifestNote()).toBeUndefined()
  })
})

describe("answers built from the manifest", () => {
  const models = [{ table: "model.p.b", label: "b" }]
  const graph = {
    getChildrenModels: () => models,
    getParentModels: () => models,
  } as unknown as DBTProjectIntegrationAdapter

  test.each([
    ["children", children],
    ["parents", parents],
  ])("%s stays a plain list on a current manifest", async (_name, command) => {
    expect(await command(graph, ["--model", "a"])).toEqual(models)
  })

  test.each([
    ["children", children],
    ["parents", parents],
  ])("%s leads with the note on a stale manifest", async (_name, command) => {
    staleManifest()
    const answer = await command(graph, ["--model", "a"])
    expect(Object.keys(answer)).toEqual(["stale_manifest", "models"])
    expect(answer).toMatchObject({ models })
  })

  const notInManifest = {
    parseManifest: async () => ({ nodeMetaMap: { lookupByBaseName: () => undefined } }),
  } as unknown as DBTProjectIntegrationAdapter

  test("schema-verify's answer is unchanged on a current manifest", async () => {
    expect(Object.keys(await schemaVerify(notInManifest, ["--model", "a"]))).toEqual(["error"])
  })

  test("schema-verify's errors say so too: a model missing from an old manifest may exist", async () => {
    staleManifest()
    expect(Object.keys(await schemaVerify(notInManifest, ["--model", "a"]))).toEqual(["stale_manifest", "error"])
  })
})

describe("create", () => {
  test("hears the parse `initialize` runs, which the commands answer from", async () => {
    const stale = { manifestPath: "/p/target/manifest.json", writtenAt: WRITTEN_AT }
    const initialize = spyOn(DBTProjectIntegrationAdapter.prototype, "initialize").mockImplementation(async function (
      this: DBTProjectIntegrationAdapter,
    ) {
      this.emit(DBTProjectIntegrationAdapterEvents.MANIFEST_PARSED, { stale })
    })
    try {
      await create({ projectRoot: "/p", pythonPath: "python3", dbtIntegration: "core", queryLimit: 500 })
      expect(staleManifestNote()?.manifest_path).toBe(stale.manifestPath)
    } finally {
      initialize.mockRestore()
    }
  })
})
