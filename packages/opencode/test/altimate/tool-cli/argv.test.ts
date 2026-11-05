import { describe, expect, test } from "bun:test"
import { foldStdinArgs } from "../../../src/altimate/tool-cli/argv"

describe("foldStdinArgs", () => {
  test("folds `--args -` into `--args=-`", () => {
    expect(foldStdinArgs(["tool", "run", "sql_format", "--args", "-", "--json"])).toEqual([
      "tool",
      "run",
      "sql_format",
      "--args=-",
      "--json",
    ])
  })

  test("leaves inline JSON and other dashes untouched", () => {
    expect(foldStdinArgs(["tool", "run", "x", "--args", '{"a":1}'])).toEqual(["tool", "run", "x", "--args", '{"a":1}'])
    expect(foldStdinArgs(["run", "-"])).toEqual(["run", "-"])
    expect(foldStdinArgs(["tool", "run", "x", "--args=-"])).toEqual(["tool", "run", "x", "--args=-"])
  })
})
