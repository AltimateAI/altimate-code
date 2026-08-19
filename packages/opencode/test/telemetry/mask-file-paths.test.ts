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

describe("maskString paths — review + live-data hardening", () => {
  it("masks paths with embedded spaces (macOS home dirs, spaced repo names)", () => {
    expect(mask("File not found: /Users/Jane Doe/client repo/models/a.sql"))
      .toBe("File not found: <path>")
    expect(mask("No such file: C:\\Users\\Jane Doe\\my project\\models\\a.sql"))
      .toBe("No such file: <path>")
    expect(mask("could not read ~/my dbt/profiles config/profiles.yml"))
      .toBe("could not read <path>")
    // a trailing spaced filename is consumed; because the home rule sees the
    // dotted extension, the following prose word survives (the generic rules
    // still eat one end-of-string word after extensionless paths).
    expect(mask("open /Users/jdoe/some dir/file name.sql failed"))
      .toBe("open <path> failed")
  })

  it("does not let the space-continuation eat trailing prose", () => {
    expect(mask("File not found: /app/models/a.sql was deleted upstream"))
      .toBe("File not found: <path> was deleted upstream")
  })

  it("masks cloud-storage URIs (live leak: client GCS bucket + data layout)", () => {
    expect(mask("CSV table references gs://client-finance-import/inventory/users/file_date=2026-07-16/users.csv"))
      .toBe("CSV table references <path>")
    expect(mask("read failed: s3://acme-prod-lake/raw/orders/part-0001.parquet"))
      .toBe("read failed: <path>")
    // trailing single word at end-of-string is consumed (see doctrine note)
    expect(mask("abfss://container@account.dfs.core.windows.net/data/x failed"))
      .toBe("<path>")
  })

  it("still leaves public https doc-links alone (provider help URLs)", () => {
    expect(mask("see https://community.snowflake.com/s/ip-not-allowed for details"))
      .toBe("see https://community.snowflake.com/s/ip-not-allowed for details")
  })
})

describe("maskString paths — codex re-review round", () => {
  it("masks paths enclosed in brackets/braces", () => {
    expect(mask("failed [/Users/jdoe/client/model.sql]")).toBe("failed [<path>]")
    expect(mask("ctx {/home/jdoe/proj/x.yml} missing")).toBe("ctx {<path>} missing")
  })

  it("continues cloud object keys across spaces", () => {
    expect(mask("read s3://client-bucket/client data/raw file.csv"))
      .toBe("read <path>")
    expect(mask("gs://acme-lake/dir with spaces/part 0001.parquet not found"))
      .toBe("<path> not found")
  })

  it("masks a terminal spaced component at end-of-string or before punctuation", () => {
    expect(mask("Directory not found: /Users/jdoe/client repo")).toBe("Directory not found: <path>")
    expect(mask("could not open /Users/jdoe/client repo.")).toBe("could not open <path>.")
    expect(mask("bad dir [C:\\Users\\jdoe\\client repo]")).toBe("bad dir [<path>]")
  })

  it("still never eats mid-sentence prose after a path", () => {
    expect(mask("open /app/x.sql failed with error")).toBe("open <path> failed with error")
    expect(mask("File not found: /app/models/a.sql was deleted upstream"))
      .toBe("File not found: <path> was deleted upstream")
  })
})

describe("maskString paths — round 4 (spaced usernames, windows delimiters)", () => {
  it("masks the tail of a spaced username mid-sentence (home-rooted paths)", () => {
    expect(mask("No such file: /Users/Jane Doe does not exist"))
      .toBe("No such file: <path> does not exist")   // surname consumed, prose kept
    expect(mask("stat C:\\Users\\Jane Doe failed hard")).toBe("stat <path> failed hard")
  })

  it("home paths ending in a real file keep following prose (extension lookbehind)", () => {
    expect(mask("File not found: /Users/jdoe/models/a.sql was deleted upstream"))
      .toBe("File not found: <path> was deleted upstream")
  })

  it("windows paths keep their closing delimiters", () => {
    expect(mask("failed (C:\\Users\\jdoe\\x.sql)")).toBe("failed (<path>)")
    expect(mask("in [D:\\proj\\data\\y.csv], aborted")).toBe("in [<path>], aborted")
  })

  it("spaced Windows dirs still continue (Program Files shape)", () => {
    // dotted extension -> the trailing word is clearly prose and survives
    expect(mask("spawn C:\\Program Files (x86)\\dbt\\dbt.exe ENOENT"))
      .toBe("spawn <path> ENOENT")
  })
})

describe("maskString paths — round 5", () => {
  it("masks single-slash file: URIs (RFC 8089)", () => {
    expect(mask("read file:/Users/jdoe/client/model.sql failed"))
      .toBe("read <path> failed")
    expect(mask("open file:///home/jdoe/x.yml then retry")).toBe("open <path> then retry")
  })

  it("matches Windows home roots case-insensitively", () => {
    expect(mask("stat C:\\users\\Jane Doe does not exist"))
      .toBe("stat <path> does not exist")
  })

  it("recognizes long extensions so following prose survives", () => {
    expect(mask("/Users/jdoe/data.parquet was deleted"))
      .toBe("<path> was deleted")
    expect(mask("wrote /home/jdoe/out/events.jsonl then stopped"))
      .toBe("wrote <path> then stopped")
  })
})

describe("maskString paths — round 6 (unicode, colon anchors)", () => {
  it("masks unicode path components across spaces", () => {
    expect(mask("read /Users/Jane García/client/model.sql failed"))
      .toBe("read <path> failed")
    expect(mask("stat /Users/Jane García went missing")).toBe("stat <path> went missing")
    expect(mask("open /données/config épais/app.yml now")).toBe("open <path> now")
    // unspaced unicode kept working
    expect(mask("read /Users/José/client/model.sql failed")).toBe("read <path> failed")
  })

  it("recognizes paths directly after a colon", () => {
    expect(mask("ENOENT:/Users/jdoe/client/a.sql")).toBe("ENOENT:<path>")
    expect(mask("source:s3://customer-bucket/key")).toBe("source:<path>")
    expect(mask("at path:C:\\Users\\jdoe\\x.sql end")).toBe("at path:<path> end")
  })

  it("colon anchors never bite into URLs", () => {
    expect(mask("POST https://api.openai.com/v1/chat/completions failed"))
      .toBe("POST https://api.openai.com/v1/chat/completions failed")
    expect(mask("fetch //cdn.example.com/lib.js failed"))
      .toBe("fetch //cdn.example.com/lib.js failed")
    expect(mask("connect db-host:5432/postgres refused"))
      .toBe("connect db-host:5432/postgres refused")
  })
})

describe("maskString paths — round 7 (combining marks, punctuation boundaries)", () => {
  it("masks NFD-decomposed names (macOS filename normalization)", () => {
    const nfd = "/Users/Jane García/client/model.sql".normalize("NFD")
    expect(nfd).not.toBe("/Users/Jane García/client/model.sql".normalize("NFC")) // truly decomposed
    expect(mask(`read ${nfd} failed`)).toBe("read <path> failed")
  })

  it("masks names with curly apostrophes", () => {
    expect(mask("read /Users/Jane O’Connor/client/model.sql failed"))
      .toBe("read <path> failed")
  })

  it("recognizes ; and < as path boundaries, preserving closers", () => {
    expect(mask("ENOENT;/Users/jdoe/client/a.sql")).toBe("ENOENT;<path>")
    expect(mask("failed </Users/jdoe/client/model.sql>")).toBe("failed <<path>>")
    expect(mask("cfg=a.yml;/etc/dbt/profiles.yml;done")).toBe("cfg=a.yml;<path>;done")
  })
})

describe("maskString paths — round 8 (ASCII apostrophes in components)", () => {
  it("treats an apostrophe followed by a word char as path content", () => {
    expect(mask("read /Users/Jane/O'Connor/client/model.sql failed"))
      .toBe("read <path> failed")
    expect(mask("stat /Users/Jane O'Connor went missing")).toBe("stat <path> went missing")
  })

  it("still treats a closing apostrophe as a quote delimiter", () => {
    // path masks inside the quotes, closing quote survives for the quote rule
    expect(mask("open '/Users/jdoe/x.sql' failed")).toBe("open ? failed")
    expect(mask("open '/Users/jdoe/x.sql' failed")).not.toContain("jdoe")
  })
})

describe("maskString paths — closing round (delimiters inside components)", () => {
  it("continues through delimiters that a later separator proves are path content", () => {
    expect(mask("read /Users/Jane Doe/client, repo/models/a.sql failed"))
      .toBe("read <path> failed")
    expect(mask("open ~/reports,final/q3.csv now")).toBe("open <path> now")
  })

  it("a delimiter without a following separator stays a boundary", () => {
    expect(mask("read /app/data/x.csv, then /var/log/y.log failed"))
      .toBe("read <path>, then <path> failed")
    expect(mask("saw [/opt/dbt/a.yml], aborted")).toBe("saw [<path>], aborted")
  })
})

describe("maskString paths — fleet review round (ReDoS + separators)", () => {
  it("adversarial delimiter + slash-free run completes in linear time", () => {
    const t0 = performance.now()
    mask("/a/b, " + "a".repeat(5000))
    expect(performance.now() - t0).toBeLessThan(500) // was exponential: ~2s at 28 chars
  })

  it("delimiters attached directly to a separator continue the path", () => {
    expect(mask("read /data/a[b]/c.txt failed")).toBe("read <path> failed")
  })

  it("windows delimiter continuation accepts backslash separators", () => {
    expect(mask("del C:\\Users\\jdoe\\client, repo\\x.sql now")).toBe("del <path> now")
  })
})

describe("maskString paths — fleet round 2 (relative, symbols, cloud tails)", () => {
  it("masks dot-relative paths (unambiguous ./ and ../ prefixes)", () => {
    expect(mask("read failed: ./customers/acme/models/private.sql")).toBe("read failed: <path>")
    expect(mask("open ../client-repo/profiles.yml now")).toBe("open <path> now")
  })

  it("continues spaced components that start with symbols", () => {
    expect(mask("read /Users/Jane Doe/client #1/models/a.sql failed"))
      .toBe("read <path> failed")
  })

  it("cloud object keys consume a terminal spaced component like home paths", () => {
    expect(mask("read s3://customer-bucket/client repo failed")).toBe("read <path> failed")
    // dotted extension still protects following prose
    expect(mask("read s3://customer-bucket/data.csv failed to download"))
      .toBe("read <path> failed to download")
  })
})

describe("maskString paths — fleet round 3 (composed rules)", () => {
  it("delimiter lookahead accepts multi-word components", () => {
    expect(mask("read /data/x, big client repo/models/a.sql done")).toBe("read <path> done")
  })

  it("terminal dotted filename may span multiple words", () => {
    expect(mask("read /Users/jdoe/reports/Q4 final reviewed version.sql failed"))
      .toBe("read <path> failed")
  })

  it("first POSIX segment may contain symbols or emoji", () => {
    expect(mask("read /#clients/acme/private.sql failed")).toBe("read <path> failed")
    expect(mask("read /💾/acme/private.sql failed")).toBe("read <path> failed")
  })

  it("named-user tilde homes mask", () => {
    expect(mask("could not read ~jane/client-repo/profiles.yml")).toBe("could not read <path>")
  })

  it("apostrophes survive inside spaced components", () => {
    expect(mask("stat /Users/Jane Doe's client/models/a.sql now")).toBe("stat <path> now")
  })

  it("multi-word lookahead stays linear on adversarial input", () => {
    const t0 = performance.now()
    mask("/a/b, " + "word ".repeat(1000))
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe("maskString paths — fleet round 4 (parens in components, nested homes)", () => {
  it("continues through ) when a later separator proves it is path content", () => {
    expect(mask("read /Users/jdoe/client)repo/models/a.sql failed")).toBe("read <path> failed")
    // closing paren without a following separator stays preserved
    expect(mask("failed (from /opt/dbt/bin/dbt)")).toBe("failed (from <path>)")
  })

  it("nested home roots get home-rule masking (WSL, Silverblue)", () => {
    expect(mask("stat /mnt/c/Users/Jane Doe does not exist"))
      .toBe("stat <path> does not exist")
    expect(mask("check /var/home/jane went missing")).toBe("check <path> missing")
  })
})

describe("maskString paths — fleet round 5 (dot-relative windows, attached filenames)", () => {
  it("masks Windows dot-relative paths", () => {
    expect(mask(String.raw`read .\customers\acme\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`open ..\client-repo\profiles.yml now`)).toBe("open <path> now")
  })

  it("dot-relative prefix never fires on dotted prose or printed escapes", () => {
    expect(mask("wait...\\ hmm that failed")).toBe("wait...\\ hmm that failed")
    expect(mask("unexpected token .\\n at position 5")).toBe("unexpected token .\\n at position 5")
  })

  it("attached dotted terminal filename proves a delimiter (all rule families)", () => {
    expect(mask("read /Users/jdoe/project;draft.sql")).toBe("read <path>")
    expect(mask("C:\\Users\\jdoe\\proj;draft.sql gone")).toBe("<path> gone")
    expect(mask("s3://bucket/dir;file.csv loaded")).toBe("<path> loaded")
  })

  it("attached delimiter without separator or dotted filename stays a boundary", () => {
    // shell-style `;cmd` must not be eaten — documented residue
    expect(mask("cd /Users/jdoe/proj;ls failed")).toBe("cd <path>;ls failed")
    expect(mask("shell: cd /opt/app; rm -rf tmp")).toBe("shell: cd <path>; rm -rf tmp")
  })

  it("tab is a field boundary, not path continuation (documented residue)", () => {
    // tab-delimited log columns after a path must survive; the bare relative
    // fragment after the tab is the documented undecidable-fragment boundary
    expect(mask("/Users/jdoe/client\tsecret/models/a.sql")).toBe("<path> secret/models/a.sql")
  })

  it("extension-proof delimiter branch stays linear on adversarial input", () => {
    let t0 = performance.now()
    mask("/a/b/x;" + "a".repeat(5000))
    expect(performance.now() - t0).toBeLessThan(500)
    t0 = performance.now()
    mask("/a/b/x;" + "a.".repeat(2500))
    expect(performance.now() - t0).toBeLessThan(500)
  })
})
