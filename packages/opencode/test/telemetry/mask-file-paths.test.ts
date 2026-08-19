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

describe("maskString paths — fleet round 6 (backslash components, extended-length homes)", () => {
  it("keeps literal backslashes as path content in slash-delimited rules", () => {
    expect(mask(String.raw`read s3://bucket/customer data\raw/models/a.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`stat /opt/a\b/c/d.sql failed`)).toBe("stat <path> failed")
  })

  it("recognizes extended-length Windows home paths", () => {
    expect(mask(String.raw`\\?\C:\Users\Jane Doe does not exist`)).toBe("<path> does not exist")
    expect(mask(String.raw`stat \\?\C:\Users\Jane Doe\models\a.sql failed`)).toBe("stat <path> failed")
  })

  it("backslash-permissive run class never bleeds into following prose", () => {
    expect(mask(String.raw`use /pattern/ with \d+ tokens`)).toBe(String.raw`use <path> with \d+ tokens`)
    expect(mask(String.raw`glob /opt/data/*.sql \n escaped`)).toBe(String.raw`glob <path> \n escaped`)
  })

  it("widened run class stays linear on adversarial input", () => {
    const t0 = performance.now()
    mask("s3://b/k " + "w\\x ".repeat(1200))
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe("maskString paths — fleet round 7 (double spaces, current-drive-rooted windows)", () => {
  it("continues across a double space inside a component", () => {
    expect(mask("read /Users/Jane  Doe/client/model.sql failed")).toBe("read <path> failed")
  })

  it("three or more spaces stay a column boundary", () => {
    expect(mask("read /opt/data/x.sql    404 NotFound")).toBe("read <path> 404 NotFound")
  })

  it("masks current-drive-rooted windows paths, home and generic", () => {
    expect(mask(String.raw`read \Users\Jane Doe\models\a.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`open \inetpub\wwwroot\app\web.config denied`)).toBe("open <path> denied")
  })

  it("rooted opener never eats regex or escape prose", () => {
    // proof requires two >=2-word-char components: 1-char escape classes and
    // quantifier-bearing runs both fail it
    expect(mask(String.raw`expected pattern \d+\.\d+ but got x`)).toBe(String.raw`expected pattern \d+\.\d+ but got x`)
    expect(mask(String.raw`escape chain \n\r\t here`)).toBe(String.raw`escape chain \n\r\t here`)
    expect(mask(String.raw`match \bword\b boundary`)).toBe(String.raw`match \bword\b boundary`)
  })

  it("double-space continuation stays linear on adversarial input", () => {
    const t0 = performance.now()
    mask("/Users/x/y" + "  zz".repeat(1200))
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe("maskString paths — fleet round 8 (ANSI, drive-relative, quote delimiters)", () => {
  it("strips ANSI CSI sequences before masking", () => {
    expect(mask("\x1b[31m/Users/jdoe/client/a.sql\x1b[0m failed")).toBe("<path> failed")
    // an ANSI-split credential must still be caught by the sk- rule
    expect(mask("token sk-\x1b[31mabc12345678901234567890\x1b[0m end")).toBe("token sk-*** end")
  })

  it("masks drive-relative windows paths, generic and home", () => {
    expect(mask(String.raw`read C:client-repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read C:Users\Jane Doe\client\a.sql failed`)).toBe("read <path> failed")
    // colon-bearing prose without a backslash chain never matches
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
  })

  it("continues through quote characters a later separator proves", () => {
    expect(mask(`read /Users/jdoe/client"repo/models/a.sql failed`)).toBe("read <path> failed")
    // paired inline-code backticks stay intact
    expect(mask("run `dbt build` in `/opt/proj/app` now")).toBe("run `dbt build` in `<path>` now")
  })
})

describe("maskString paths — fleet round 9 (quote-pair safety, pipes, OSC)", () => {
  it("a closing quote directly before a slash stays a boundary (pairing never shifts)", () => {
    // the eaten quote used to shift pairing and leak the next quoted value
    expect(mask(`read "/a/b"/c "secret data" end`)).toBe("read ?/c ? end")
    // mid-component quotes (non-empty run before the separator) still mask
    expect(mask(`read /Users/jdoe/client"repo/models/a.sql failed`)).toBe("read <path> failed")
  })

  it("pipe is a path anchor but plain pipe prose never matches", () => {
    expect(mask("ENOENT|/Users/jdoe/client/a.sql")).toBe("ENOENT|<path>")
    expect(mask("source|s3://customer-bucket/private/a.csv")).toBe("source|<path>")
    expect(mask("a|b or c|d plain prose")).toBe("a|b or c|d plain prose")
  })

  it("strips OSC hyperlink escapes so wrapped paths still mask", () => {
    expect(mask("\x1b]8;;vscode://file//x\x1b\\/Users/jdoe/client/a.sql\x1b]8;;\x1b\\ failed"))
      .toBe("<path> failed")
  })
})

describe("maskString paths — fleet round 10 (spaced first components, drive-relative slashes)", () => {
  it("masks spaced first components in dot-relative paths", () => {
    expect(mask("read ./client repo/models/private.sql failed")).toBe("read <path> failed")
    expect(mask(String.raw`read .\client repo\models\a.sql failed`)).toBe("read <path> failed")
  })

  it("accepts forward slashes in drive-relative paths, digit ratios never match", () => {
    expect(mask("read C:client-repo/models/private.sql failed")).toBe("read <path> failed")
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
    expect(mask("rated e:10/20 shown")).toBe("rated e:10/20 shown")
  })

  it("spaced prefix components stay linear on adversarial input", () => {
    const t0 = performance.now()
    mask("./" + "a b ".repeat(1500))
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe("maskString paths — fleet round 11 (home-rule reach: spaced prefixes, UNC; drive-relative breadth)", () => {
  it("home rules reach through spaced prefix components and UNC shares", () => {
    expect(mask("stat /mnt disk/c/Users/Jane Doe does not exist")).toBe("stat <path> does not exist")
    expect(mask(String.raw`stat \\fileserver\Users\Jane Doe does not exist`)).toBe("stat <path> does not exist")
    expect(mask(String.raw`stat \\?\UNC\srv\share\Users\Jane Doe is gone`)).toBe("stat <path> is gone")
  })

  it("drive-relative backslash proof accepts spaced and dotted first components", () => {
    expect(mask(String.raw`read C:client repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read C:.client\models\private.sql failed`)).toBe("read <path> failed")
    // slash-proven form keeps the letter-first guard: ratios never match
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
  })

  it("UNC home opener stays linear on adversarial input", () => {
    const t0 = performance.now()
    mask("\\\\" + "srv ".repeat(1500) + "x")
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe("maskString paths — fleet round 12 (rooted proof breadth, tilde home tail)", () => {
  it("rooted proof accepts spaced and symbol-bearing components", () => {
    expect(mask(String.raw`open \Program Files\Altimate\secret.sql denied`)).toBe("open <path> denied")
    expect(mask(String.raw`read \client repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read \#client\models\private.sql failed`)).toBe("read <path> failed")
    // regex-prose guards must keep failing the proof
    expect(mask(String.raw`expected pattern \d+\.\d+ but got x`)).toBe(String.raw`expected pattern \d+\.\d+ but got x`)
  })

  it("tilde homes use the unconditional home tail", () => {
    expect(mask("stat ~/client repo does not exist")).toBe("stat <path> does not exist")
    expect(mask("read ~jane/Client Secret now")).toBe("read <path> now")
  })
})

describe("maskString paths — fleet round 13 (multi-word PII tails, proof punctuation, bounded scans)", () => {
  it("high-PII tail consumes capitalized word runs (middle names, multi-word keys)", () => {
    expect(mask("/Users/Mary Jane Smith does not exist")).toBe("<path> does not exist")
    expect(mask("C:\\Users\\Mary Jane Smith does not exist")).toBe("<path> does not exist")
    expect(mask("s3://bucket/Client Top Secret does not exist")).toBe("<path> does not exist")
    // lowercase prose still costs exactly one word
    expect(mask("/Users/jdoe was not found on this system")).toBe("<path> not found on this system")
  })

  it("rooted proof accepts parenthesized/dotted components", () => {
    expect(mask(String.raw`open \Program Files (x86)\Altimate\secret.sql denied`)).toBe("open <path> denied")
    expect(mask(String.raw`expected pattern \d+\.\d+ but got x`)).toBe(String.raw`expected pattern \d+\.\d+ but got x`)
  })

  it("delimiter runs are linear: bounded proof scans", () => {
    let t0 = performance.now()
    mask("C:\\a\\b" + ")".repeat(2000) + "\\c")
    expect(performance.now() - t0).toBeLessThan(200)
    t0 = performance.now()
    mask(")a".repeat(2500) + "/x")
    expect(performance.now() - t0).toBeLessThan(200)
  })
})

describe("maskString paths — fleet round 14 (fs-limit bounds, shallow forms)", () => {
  it("proof scans reach the filesystem component limit (255)", () => {
    expect(mask("/Users/jdoe/client)" + "a".repeat(65) + "/models/private.sql leaked")).toBe("<path> leaked")
    // delimiter runs stay linear at the raised bound
    const t0 = performance.now()
    mask("C:\\a\\b" + ")".repeat(2000) + "\\c")
    expect(performance.now() - t0).toBeLessThan(300)
  })

  it("shallow rooted windows paths mask via the dotted-terminal proof", () => {
    expect(mask(String.raw`read \client-repo\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`open \Program Files\app.exe denied`)).toBe("open <path> denied")
    expect(mask(String.raw`match \bword\b boundary`)).toBe(String.raw`match \bword\b boundary`)
  })

  it("terminal-only dot-relative paths mask when extension-bearing", () => {
    expect(mask("read ./customer_secret.sql failed")).toBe("read <path> failed")
    expect(mask("read ../customer_secret.sql now")).toBe("read <path> now")
    // extensionless ./x stays out — undecidable against prose tokens
    expect(mask("see ./x plain token")).toBe("see ./x plain token")
  })
})

describe("maskString paths — fleet round 15 (spaced shallow terminals, name particles, extensionless rooted)", () => {
  it("shallow dot-relative accepts spaced dotted terminals", () => {
    expect(mask("read ./Q4 final report.sql failed")).toBe("read <path> failed")
  })

  it("PII tails cross lowercase name particles and caseless scripts", () => {
    expect(mask("/Users/Mary van der Berg does not exist")).toBe("<path> does not exist")
    expect(mask("/Users/李 小 明 does not exist")).toBe("<path> does not exist")
    // ordinary lowercase prose still costs exactly one word
    expect(mask("/Users/jdoe was not found on this system")).toBe("<path> not found on this system")
  })

  it("rooted proof accepts spaced-first-component extensionless paths", () => {
    expect(mask(String.raw`open \Program Files\Altimate denied`)).toBe("open <path>")
    expect(mask(String.raw`match \bword\b boundary`)).toBe(String.raw`match \bword\b boundary`)
  })
})

describe("maskString paths — fleet round 16 (case folding out of the tail gate)", () => {
  it("home/cloud rules are engine-independent: no i flag, hand-expanded case", () => {
    // lowercase prose after a home path costs exactly one word — this is the
    // assertion that silently broke under V8's conformant /iu folding
    expect(mask("/Users/jdoe was not found on this system")).toBe("<path> not found on this system")
    // the case-insensitive coverage the i flag used to provide still holds
    expect(mask("stat c:\\users\\jane doe missing")).toBe("stat <path> missing")
    expect(mask("check /users/jane went missing")).toBe("check <path> missing")
    expect(mask("read S3://Bucket/Key now")).toBe("read <path>")
    expect(mask(String.raw`stat \\?\unc\srv\share\Users\Jane Doe gone`)).toBe("stat <path> gone")
  })
})

describe("maskString paths — fleet round 17 (legacy home roots, longer extensions)", () => {
  it("legacy Documents and Settings roots get home treatment", () => {
    expect(mask(String.raw`stat C:\Documents and Settings\Jane Doe does not exist`))
      .toBe("stat <path> does not exist")
  })

  it("extensions up to 14 chars count as proof and as prose guards", () => {
    expect(mask("read ./customer_secret.properties failed")).toBe("read <path> failed")
    expect(mask("read ../private.configuration now")).toBe("read <path> now")
    // the suppression direction: prose after a long-extension file survives
    expect(mask("/Users/jdoe/app.properties was deleted")).toBe("<path> was deleted")
  })
})

describe("maskString paths — fleet round 18 (mixed spaced runs in delimiter proofs)", () => {
  it("a delimiter proof may combine an initial run with spaced runs", () => {
    expect(mask("/Users/jdoe/client)repo name/models/private.sql failed")).toBe("<path> failed")
    // all four boundary controls hold
    expect(mask("failed (from /opt/dbt/bin/dbt)")).toBe("failed (from <path>)")
    expect(mask(`read "/a/b"/c "secret data" end`)).toBe("read ?/c ? end")
    expect(mask("cd /Users/jdoe/proj;ls failed")).toBe("cd <path>;ls failed")
  })

  it("unified proof stays linear", () => {
    const t0 = performance.now()
    mask("C:\\a\\b" + ")".repeat(2000) + "\\c")
    expect(performance.now() - t0).toBeLessThan(300)
  })
})
