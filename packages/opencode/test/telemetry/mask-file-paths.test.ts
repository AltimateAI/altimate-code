/**
 * maskString file-path masking.
 *
 * The masking chain deliberately covered keys, bearers, emails, internal hosts
 * and quoted strings — but had no rule for filesystem paths, so UNQUOTED paths
 * in error text reached App Insights raw (a live 32-machine
 * core_failure/file_not_found cluster carried full /Users/<name>/… paths:
 * OS username + client repo structure). Quoted paths were coincidentally
 * destroyed by the quote rule, which is why the gap went unnoticed.
 */
import { describe, expect, it } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"

const mask = Telemetry.maskString

describe("maskString file paths", () => {
  it("masks home-directory paths (the PII case: username + repo layout)", () => {
    expect(mask("File not found: /Users/jdoe/Documents/client-repos/Platform_Project/models/05_da.sql"))
      .toBe("File not found: <path>")
    expect(mask("ENOENT: no such file or directory, open /home/jdoe/dbt/profiles.yml"))
      .toBe("ENOENT: no such file or directory, open <path>")
    expect(mask("could not read ~/dbt/profiles.yml")).toBe("could not read <path>")
  })

  it("masks Windows drive and UNC paths", () => {
    expect(mask("No such file: C:\\Users\\jdoe\\project\\models\\a.sql")).toBe("No such file: <path>")
    expect(mask("read failed for \\\\fileserver\\share\\models\\x.sql")).toBe("read failed for <path>")
  })

  it("masks project-rooted absolute paths (client repo structure)", () => {
    expect(mask("File not found: /app/models/stg_quickbooks__estimate.sql"))
      .toBe("File not found: <path>")
    expect(mask("Manifest path for deferral does not exist: /data/warehouse/target/manifest.json"))
      .toBe("Manifest path for deferral does not exist: <path>")
  })

  it("masks paths at string start and inside punctuation", () => {
    expect(mask("/Users/jdoe/x/y.sql was deleted")).toBe("<path> was deleted")
    expect(mask("failed (from /opt/dbt/bin/dbt)")).toBe("failed (from <path>)")
    expect(mask("--project-dir=/srv/analytics/dbt")).toBe("--project-dir=<path>")
  })

  it("does NOT mask non-path slashes", () => {
    expect(mask("content-type application/json rejected")).toBe("content-type application/json rejected")
    expect(mask("requirement dbt-core~=1.11.0 not satisfied")).toBe("requirement dbt-core~=1.11.0 not satisfied")
    expect(mask("on 8/17/2026 at 3:2 ratio 1/2")).toBe("on 8/17/2026 at 3:2 ratio 1/2")
    expect(mask("endpoint /mcp returned 404")).toBe("endpoint /mcp returned 404")
  })

  it("leaves public URL paths to the URL rules (never word-anchored)", () => {
    expect(mask("POST https://api.openai.com/v1/chat/completions failed"))
      .toBe("POST https://api.openai.com/v1/chat/completions failed")
    // internal hosts keep their existing, stronger treatment
    expect(mask("GET http://localhost:8080/api/x timed out")).toContain("<internal-host>")
  })

  it("composes with the earlier rules in the chain", () => {
    // credential first, then the path
    expect(mask("sk-abcdefghijklmnopqrstuvwx leaked into /Users/jdoe/log.txt"))
      .toBe("sk-*** leaked into <path>")
    // quoted path still collapses via the quote rule — no leak either way
    expect(mask("open '/Users/jdoe/x.sql' failed")).not.toContain("jdoe")
  })
})
