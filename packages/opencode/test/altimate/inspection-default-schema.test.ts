import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as Registry from "../../src/altimate/native/connections/registry"
import { defaultInspectionSchema } from "../../src/altimate/native/connections/inspection-target"

afterEach(() => spyOn(Registry, "getConfig").mockRestore())

describe("defaultInspectionSchema for MongoDB", () => {
  test.each([
    [{ type: "mongodb", connection_string: "mongodb://host:27017/analytics?retryWrites=true" }, "analytics"],
    [{ type: "mongodb", connection_string: "mongodb+srv://u:p@cluster.example.net/my%20db" }, "my db"],
    [{ type: "mongodb", connection_string: "mongodb://host/", database: "explicit" }, "explicit"],
    [{ type: "mongodb", connection_string: "mongodb://host:27017/?tls=true" }, undefined],
    [{ type: "mongodb", connection_string: "mongodb://host" }, undefined],
  ])("%j -> %s", (config, expected) => {
    spyOn(Registry, "getConfig").mockReturnValue(config as never)
    expect(defaultInspectionSchema("w")).toBe(expected)
  })
})
