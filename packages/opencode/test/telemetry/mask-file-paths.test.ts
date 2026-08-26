/**
 * maskString file-path masking.
 *
 * The masking chain deliberately covered keys, bearers, emails, internal hosts
 * and quoted strings — but had no rule for filesystem paths, so UNQUOTED paths
 * in error text reached App Insights raw (a live 32-machine
 * core_failure/file_not_found cluster carried full /Users/<name>/… paths:
 * OS username + client repo structure). Quoted paths were coincidentally
 * destroyed by the quote rule, which is why the gap went unnoticed.
 *
 * Structure: one describe per subject — preprocessing, each path family,
 * anchors, in-component delimiters, extensions, the must-not-mask set, and
 * performance budgets. Doctrine throughout: over-masking is the correct
 * failure mode; "path content vs prose" past an unproven delimiter is
 * undecidable and stays a documented boundary.
 */
import { describe, expect, it } from "bun:test"
import os from "os"
import { Telemetry } from "../../src/altimate/telemetry"

const mask = Telemetry.maskString


// ANSI/OSC sequences are stripped before any rule; paths under the local
// user's home/cwd are replaced by exact literal match; separator-free
// strings skip the path stack entirely.
describe("maskString paths — preprocessing — escape stripping, known-prefix literals, fast path", () => {
  it("strips ANSI CSI sequences before masking", () => {
    expect(mask("\x1b[31m/Users/jdoe/client/a.sql\x1b[0m failed")).toBe("<path> failed")
    // an ANSI-split credential must still be caught by the sk- rule
    expect(mask("token sk-\x1b[31mabc12345678901234567890\x1b[0m end")).toBe("token sk-*** end")
  })

  it("strips OSC hyperlink escapes so wrapped paths still mask", () => {
    expect(mask("\x1b]8;;vscode://file//x\x1b\\/Users/jdoe/client/a.sql\x1b]8;;\x1b\\ failed"))
      .toBe("<path> failed")
  })

  it("paths under the local home mask by exact literal — any username shape", () => {
    const home = os.homedir()
    expect(mask(`ENOENT: no such file ${home}/client repo/秘密 file.sql retry`)).toBe("ENOENT: no such file <path> retry")
    expect(mask(`stat ${home} does not exist`)).toBe("stat <path> not exist")
  })

  it("paths under cwd mask by exact literal", () => {
    expect(mask(`failed in ${process.cwd()}/models/private.sql now`)).toBe("failed in <path> now")
  })

  it("literal mop-up never orphans a spaced terminal (structure runs first)", () => {
    const home = os.homedir()
    expect(mask(`stat ${home}/client repo does not exist`)).toBe("stat <path> does not exist")
  })

  it("known-prefix literals never fire mid-token; home STRUCTURE still does", () => {
    const home = os.homedir()
    // the literal layer is token-boundary guarded, but a home root embedded
    // in a URL still masks structurally — it carries the username
    expect(mask(`see https://example.com${home}/docs now`)).toBe("see https://example.com<path>")
    expect(mask(`at path:${home}/x.sql end`)).toBe("at path:<path> end")
    // a longer token that merely contains the home string is left alone
    expect(mask(`id=abc${home.replace(/[\\/]/g, "_")}xyz ok`)).toBe(`id=abc${home.replace(/[\\/]/g, "_")}xyz ok`)
  })

  it("a credential or quoted value straddling the 8 KB cut never ships in the clear", () => {
    // the cut backs off to whitespace and to before any unbalanced quote, so a
    // straddling token is dropped whole (or masked) — never emitted in part
    const pad = '"' + "A".repeat(8170) + '" '
    expect(mask(pad + "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).not.toContain("ABCDEFGH")
    expect(mask(pad + "sk-abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("sk-abc")
    expect(mask(pad + '"customer-secret-value-here"')).not.toContain("customer")
    expect(mask('"' + "A".repeat(8180) + '" "customer secret value here"')).not.toContain("customer")
    // tab / newline boundaries count as whitespace for the back-off
    expect(mask("x".repeat(8100) + "\t/Users/jdoe/secret-client-repo/models")).not.toContain("jdoe")
    expect(mask("x".repeat(8100) + "\n/Users/jdoe/secret-client-repo/models")).not.toContain("jdoe")
  })

  it("masking never throws when the cwd has been deleted", () => {
    const os = require("os")
    const fs = require("fs")
    const path = require("path")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gone-"))
    const prev = process.cwd()
    try {
      process.chdir(dir)
      mask("warm the cache /x/y.sql")
      fs.rmdirSync(dir)
      expect(() => mask("error after cwd vanished /opt/app/x.sql")).not.toThrow()
    } finally {
      process.chdir(prev)
    }
  })

  it("separator-free strings take the fast path unchanged", () => {
    expect(mask("invalid_token: authentication expired, retry later"))
      .toBe("invalid_token: authentication expired, retry later")
  })
})

// The high-PII class. Home rules must reach every root spelling: POSIX and
// Windows homes, nested mounts (WSL), UNC shares, extended-length and
// legacy prefixes — matched case-insensitively without the i flag
// (conformant engines fold \p{Lu} under /iu, which would break the
// capitalized-tail gate; JSC does not fold — never rely on the divergence).
describe("maskString paths — home-rooted paths — roots and reach", () => {
  it("masks home-directory paths (the PII case: username + repo layout)", () => {
    expect(mask("File not found: /Users/jdoe/Documents/client-repos/Platform_Project/models/05_da.sql"))
      .toBe("File not found: <path>")
    expect(mask("ENOENT: no such file or directory, open /home/jdoe/dbt/profiles.yml"))
      .toBe("ENOENT: no such file or directory, open <path>")
    expect(mask("could not read ~/dbt/profiles.yml")).toBe("could not read <path>")
  })

  it("matches Windows home roots case-insensitively", () => {
    expect(mask("stat C:\\users\\Jane Doe does not exist"))
      .toBe("stat <path> does not exist")
  })

  it("nested home roots get home-rule masking (WSL, Silverblue)", () => {
    expect(mask("stat /mnt/c/Users/Jane Doe does not exist"))
      .toBe("stat <path> does not exist")
    expect(mask("check /var/home/jane went missing")).toBe("check <path> missing")
  })

  it("recognizes extended-length Windows home paths", () => {
    expect(mask(String.raw`\\?\C:\Users\Jane Doe does not exist`)).toBe("<path> does not exist")
    expect(mask(String.raw`stat \\?\C:\Users\Jane Doe\models\a.sql failed`)).toBe("stat <path> failed")
  })

  it("JSON-doubled separators still get home treatment", () => {
    expect(mask(String.raw`stat \\fileserver\\Users\\Jane Doe gone`)).toBe("stat <path> gone")
    expect(mask(String.raw`stat C:\\Users\\Jane Doe missing`)).toBe("stat <path> missing")
  })

  it("home rules reach through spaced prefix components and UNC shares", () => {
    expect(mask("stat /mnt disk/c/Users/Jane Doe does not exist")).toBe("stat <path> does not exist")
    expect(mask(String.raw`stat \\fileserver\Users\Jane Doe does not exist`)).toBe("stat <path> does not exist")
    expect(mask(String.raw`stat \\?\UNC\srv\share\Users\Jane Doe is gone`)).toBe("stat <path> is gone")
  })

  it("legacy Documents and Settings roots get home treatment", () => {
    expect(mask(String.raw`stat C:\Documents and Settings\Jane Doe does not exist`))
      .toBe("stat <path> does not exist")
  })

  it("forward-slash UNC homes get the high-PII tail", () => {
    expect(mask("stat //fileserver/share/Users/Jane Doe does not exist"))
      .toBe("stat <path> does not exist")
    expect(mask("fetch //cdn.example.com/lib.js failed")).toBe("fetch //cdn.example.com/lib.js failed")
  })

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

// Home paths and cloud keys consume one unconditional trailing word plus
// capitalized/caseless/particle continuations, so full names mask; other
// rules take a terminal word only at end-of-string/punctuation; a dotted
// extension suppresses the tail so following prose survives.
describe("maskString paths — terminal components and tails — spaced, unicode, multi-word names", () => {
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

  it("masks a terminal spaced component at end-of-string or before punctuation", () => {
    expect(mask("Directory not found: /Users/jdoe/client repo")).toBe("Directory not found: <path>")
    expect(mask("could not open /Users/jdoe/client repo.")).toBe("could not open <path>.")
    expect(mask("bad dir [C:\\Users\\jdoe\\client repo]")).toBe("bad dir [<path>]")
  })

  it("masks the tail of a spaced username mid-sentence (home-rooted paths)", () => {
    expect(mask("No such file: /Users/Jane Doe does not exist"))
      .toBe("No such file: <path> does not exist")   // surname consumed, prose kept
    expect(mask("stat C:\\Users\\Jane Doe failed hard")).toBe("stat <path> failed hard")
  })

  it("home paths ending in a real file keep following prose (extension lookbehind)", () => {
    expect(mask("File not found: /Users/jdoe/models/a.sql was deleted upstream"))
      .toBe("File not found: <path> was deleted upstream")
  })

  it("masks unicode path components across spaces", () => {
    expect(mask("read /Users/Jane García/client/model.sql failed"))
      .toBe("read <path> failed")
    expect(mask("stat /Users/Jane García went missing")).toBe("stat <path> went missing")
    expect(mask("open /données/config épais/app.yml now")).toBe("open <path> now")
    // unspaced unicode kept working
    expect(mask("read /Users/José/client/model.sql failed")).toBe("read <path> failed")
  })

  it("masks NFD-decomposed names (macOS filename normalization)", () => {
    const nfd = "/Users/Jane García/client/model.sql".normalize("NFD")
    expect(nfd).not.toBe("/Users/Jane García/client/model.sql".normalize("NFC")) // truly decomposed
    expect(mask(`read ${nfd} failed`)).toBe("read <path> failed")
  })

  it("masks names with curly apostrophes", () => {
    expect(mask("read /Users/Jane O’Connor/client/model.sql failed"))
      .toBe("read <path> failed")
  })

  it("apostrophes survive inside spaced components", () => {
    expect(mask("stat /Users/Jane Doe's client/models/a.sql now")).toBe("stat <path> now")
  })

  it("continues across a double space inside a component", () => {
    expect(mask("read /Users/Jane  Doe/client/model.sql failed")).toBe("read <path> failed")
  })

  it("high-PII tail consumes capitalized word runs (middle names, multi-word keys)", () => {
    expect(mask("/Users/Mary Jane Smith does not exist")).toBe("<path> does not exist")
    expect(mask("C:\\Users\\Mary Jane Smith does not exist")).toBe("<path> does not exist")
    expect(mask("s3://bucket/Client Top Secret does not exist")).toBe("<path> does not exist")
    // lowercase prose still costs exactly one word
    expect(mask("/Users/jdoe was not found on this system")).toBe("<path> not found on this system")
  })

  it("PII tails cross lowercase name particles and caseless scripts", () => {
    expect(mask("/Users/Mary van der Berg does not exist")).toBe("<path> does not exist")
    expect(mask("/Users/李 小 明 does not exist")).toBe("<path> does not exist")
    // ordinary lowercase prose still costs exactly one word
    expect(mask("/Users/jdoe was not found on this system")).toBe("<path> not found on this system")
  })

  it("nonbreaking spaces continue components; tabs stay boundaries", () => {
    expect(mask("read /Users/Jane Doe/client/model.sql failed")).toBe("read <path> failed")
    expect(mask("/Users/jdoe/client\tsecret/models/a.sql")).toBe("<path> secret/models/a.sql")
  })

  it("name particles work across nonbreaking spaces", () => {
    expect(mask("/Users/Mary\u00A0van\u00A0der\u00A0Berg does not exist")).toBe("<path> does not exist")
  })
})

describe("maskString paths — windows paths — drive, UNC, relative, and rooted forms", () => {
  it("masks Windows drive and UNC paths", () => {
    expect(mask("No such file: C:\\Users\\jdoe\\project\\models\\a.sql")).toBe("No such file: <path>")
    expect(mask("read failed for \\\\fileserver\\share\\models\\x.sql")).toBe("read failed for <path>")
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

  it("windows delimiter continuation accepts backslash separators", () => {
    expect(mask("del C:\\Users\\jdoe\\client, repo\\x.sql now")).toBe("del <path> now")
  })

  it("masks Windows dot-relative paths", () => {
    expect(mask(String.raw`read .\customers\acme\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`open ..\client-repo\profiles.yml now`)).toBe("open <path> now")
  })

  it("dot-relative prefix never fires on dotted prose or printed escapes", () => {
    expect(mask("wait...\\ hmm that failed")).toBe("wait...\\ hmm that failed")
    expect(mask("unexpected token .\\n at position 5")).toBe("unexpected token .\\n at position 5")
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

  it("masks drive-relative windows paths, generic and home", () => {
    expect(mask(String.raw`read C:client-repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read C:Users\Jane Doe\client\a.sql failed`)).toBe("read <path> failed")
    // colon-bearing prose without a backslash chain never matches
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
  })

  it("accepts forward slashes in drive-relative paths, digit ratios never match", () => {
    expect(mask("read C:client-repo/models/private.sql failed")).toBe("read <path> failed")
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
    expect(mask("rated e:10/20 shown")).toBe("rated e:10/20 shown")
  })

  it("drive-relative backslash proof accepts spaced and dotted first components", () => {
    expect(mask(String.raw`read C:client repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read C:.client\models\private.sql failed`)).toBe("read <path> failed")
    // slash-proven form keeps the letter-first guard: ratios never match
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
  })

  it("rooted proof accepts spaced and symbol-bearing components", () => {
    expect(mask(String.raw`open \Program Files\Altimate\secret.sql denied`)).toBe("open <path> denied")
    expect(mask(String.raw`read \client repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read \#client\models\private.sql failed`)).toBe("read <path> failed")
    // regex-prose guards must keep failing the proof
    expect(mask(String.raw`expected pattern \d+\.\d+ but got x`)).toBe(String.raw`expected pattern \d+\.\d+ but got x`)
  })

  it("rooted proof accepts parenthesized/dotted components", () => {
    expect(mask(String.raw`open \Program Files (x86)\Altimate\secret.sql denied`)).toBe("open <path> denied")
    expect(mask(String.raw`expected pattern \d+\.\d+ but got x`)).toBe(String.raw`expected pattern \d+\.\d+ but got x`)
  })

  it("shallow rooted windows paths mask via the dotted-terminal proof", () => {
    expect(mask(String.raw`read \client-repo\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`open \Program Files\app.exe denied`)).toBe("open <path> denied")
    expect(mask(String.raw`match \bword\b boundary`)).toBe(String.raw`match \bword\b boundary`)
  })

  it("rooted proof accepts spaced-first-component extensionless paths", () => {
    expect(mask(String.raw`open \Program Files\Altimate denied`)).toBe("open <path>")
    expect(mask(String.raw`match \bword\b boundary`)).toBe(String.raw`match \bword\b boundary`)
  })

  it("forward-slash UNC masks; dotted hosts stay protocol-relative URLs", () => {
    expect(mask("open //fileserver/client-share/private.sql failed")).toBe("open <path> failed")
    // dotless-server discriminator: dotted first components are URL hosts
    expect(mask("fetch //cdn.example.com/lib.js failed")).toBe("fetch //cdn.example.com/lib.js failed")
  })

  it("slash drive-relative proof needs only a letter; ratios stay out", () => {
    expect(mask("read C:.client/models/private.sql failed")).toBe("read <path> failed")
    expect(mask("read C:client repo/models/private.sql failed")).toBe("read <path> failed")
    expect(mask("score C:8/10 fine")).toBe("score C:8/10 fine")
    expect(mask("avg C:8.5/10 shown")).toBe("avg C:8.5/10 shown")
  })

  it("one-char rooted components defer proof to the next component", () => {
    expect(mask(String.raw`read \a\client\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`escape chain \n\r\t here`)).toBe(String.raw`escape chain \n\r\t here`)
  })

  it("drive-relative letter scan reaches the component limit", () => {
    expect(mask("read C:" + "1".repeat(65) + "a/models/private.sql failed")).toBe("read <path> failed")
  })

  it("rooted components carry + and & at length 3+; quantified escapes never do", () => {
    expect(mask(String.raw`read \C++ Projects\client\secret.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read \R&D\client\secret.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`pattern \n+\r+ found`)).toBe(String.raw`pattern \n+\r+ found`)
  })

  it("drive-relative terminal filenames mask when the extension carries a letter", () => {
    expect(mask("read C:123_customer_secret.sql failed")).toBe("read <path> failed")
    expect(mask("read C:.env.local failed")).toBe("read <path> failed")
    expect(mask("read C:customer secret.sql failed")).toBe("read <path> failed")
    // versions and ratios have all-numeric extensions and never qualify
    expect(mask("avg C:8.5 shown")).toBe("avg C:8.5 shown")
    expect(mask("version C:1.2.3 tagged")).toBe("version C:1.2.3 tagged")
  })

  it("shallow explicit windows terminals mask (POSIX symmetry)", () => {
    expect(mask("read C:customer_secret.sql failed")).toBe("read <path> failed")
    expect(mask(String.raw`read .\customer_secret.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read \customer_secret.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`expected \d+\.\d+ but got x`)).toBe(String.raw`expected \d+\.\d+ but got x`)
  })
})

describe("maskString paths — posix paths — absolute, dot-relative, and shallow forms", () => {
  it("masks project-rooted absolute paths (client repo structure)", () => {
    expect(mask("File not found: /app/models/stg_quickbooks__estimate.sql"))
      .toBe("File not found: <path>")
    expect(mask("Manifest path for deferral does not exist: /data/warehouse/target/manifest.json"))
      .toBe("Manifest path for deferral does not exist: <path>")
  })

  it("masks dot-relative paths (unambiguous ./ and ../ prefixes)", () => {
    expect(mask("read failed: ./customers/acme/models/private.sql")).toBe("read failed: <path>")
    expect(mask("open ../client-repo/profiles.yml now")).toBe("open <path> now")
  })

  it("first POSIX segment may contain symbols or emoji", () => {
    expect(mask("read /#clients/acme/private.sql failed")).toBe("read <path> failed")
    expect(mask("read /💾/acme/private.sql failed")).toBe("read <path> failed")
  })

  it("masks spaced first components in dot-relative paths", () => {
    expect(mask("read ./client repo/models/private.sql failed")).toBe("read <path> failed")
    expect(mask(String.raw`read .\client repo\models\a.sql failed`)).toBe("read <path> failed")
  })

  it("terminal-only dot-relative paths mask when extension-bearing", () => {
    expect(mask("read ./customer_secret.sql failed")).toBe("read <path> failed")
    expect(mask("read ../customer_secret.sql now")).toBe("read <path> now")
    // extensionless ./x stays out — undecidable against prose tokens
    expect(mask("see ./x plain token")).toBe("see ./x plain token")
  })

  it("shallow dot-relative accepts spaced dotted terminals", () => {
    expect(mask("read ./Q4 final report.sql failed")).toBe("read <path> failed")
  })

  it("single-component absolute files mask; URL interiors never do", () => {
    expect(mask("read /customer_secret.sql failed")).toBe("read <path> failed")
    // scheme colons and protocol-relative slashes are excluded from the
    // shallow-absolute form — URL pins elsewhere in this suite stay green
    expect(mask("see https://community.snowflake.com/s/ip-not-allowed for details"))
      .toBe("see https://community.snowflake.com/s/ip-not-allowed for details")
  })

  it("errno-style colon prefixes anchor single-component files", () => {
    expect(mask("ENOENT:/private.sql failed")).toBe("ENOENT:<path> failed")
    // the protocol-relative guard alone protects URLs — full pin set stays green
    expect(mask("fetch //cdn.example.com/lib.js failed")).toBe("fetch //cdn.example.com/lib.js failed")
  })

  it("explicit shallow paths take many spaced words; deep tails keep the prose cap", () => {
    expect(mask("read ./Q1 final audited customer revenue report.sql failed")).toBe("read <path> failed")
    // prose after a deep extensionless path must NOT be chased to a dotted token
    expect(mask("read /opt/x error reading the project config.yml here"))
      .toBe("read <path> error reading the project config.yml here")
  })
})

describe("maskString paths — tilde paths", () => {
  it("named-user tilde homes mask", () => {
    expect(mask("could not read ~jane/client-repo/profiles.yml")).toBe("could not read <path>")
  })

  it("tilde homes use the unconditional home tail", () => {
    expect(mask("stat ~/client repo does not exist")).toBe("stat <path> does not exist")
    expect(mask("read ~jane/Client Secret now")).toBe("read <path> now")
  })

  it("backslash tilde paths mask; regex tilde prose never does", () => {
    expect(mask(String.raw`read ~\client-repo\models\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read ~jane\Client Secret\a.sql now`)).toBe("read <path> now")
    expect(mask(String.raw`regex ~\d+ used here`)).toBe(String.raw`regex ~\d+ used here`)
    expect(mask("approx ~5 items left")).toBe("approx ~5 items left")
  })

  it("dot-prefixed backslash tilde paths mask; escaped-dot regex prose never does", () => {
    expect(mask(String.raw`read ~\.config\altimate\secret.json failed`)).toBe("read <path> failed")
    expect(mask(String.raw`sub ~\.\d pattern`)).toBe(String.raw`sub ~\.\d pattern`)
  })

  it("symbol-bearing first components mask (parity with rooted proofs)", () => {
    expect(mask(String.raw`read ~\C++ Projects\client\secret.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`read ~\R&D\client\secret.sql failed`)).toBe("read <path> failed")
  })

  it("one-char components mask when the next component proves the path", () => {
    expect(mask(String.raw`read ~\a\client\private.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`chain ~\w\d+ used`)).toBe(String.raw`chain ~\w\d+ used`)
    expect(mask(String.raw`escapes ~\n\r\t here`)).toBe(String.raw`escapes ~\n\r\t here`)
  })
})

describe("maskString paths — cloud storage URIs", () => {
  it("masks cloud-storage URIs (live leak: client GCS bucket + data layout)", () => {
    expect(mask("CSV table references gs://client-finance-import/inventory/users/file_date=2026-07-16/users.csv"))
      .toBe("CSV table references <path>")
    expect(mask("read failed: s3://acme-prod-lake/raw/orders/part-0001.parquet"))
      .toBe("read failed: <path>")
    // trailing single word at end-of-string is consumed (see doctrine note)
    expect(mask("abfss://container@account.dfs.core.windows.net/data/x failed"))
      .toBe("<path>")
  })

  it("continues cloud object keys across spaces", () => {
    expect(mask("read s3://client-bucket/client data/raw file.csv"))
      .toBe("read <path>")
    expect(mask("gs://acme-lake/dir with spaces/part 0001.parquet not found"))
      .toBe("<path> not found")
  })

  it("masks single-slash file: URIs (RFC 8089)", () => {
    expect(mask("read file:/Users/jdoe/client/model.sql failed"))
      .toBe("read <path> failed")
    expect(mask("open file:///home/jdoe/x.yml then retry")).toBe("open <path> then retry")
  })

  it("cloud object keys consume a terminal spaced component like home paths", () => {
    expect(mask("read s3://customer-bucket/client repo failed")).toBe("read <path> failed")
    // dotted extension still protects following prose
    expect(mask("read s3://customer-bucket/data.csv failed to download"))
      .toBe("read <path> failed to download")
  })
})

// The anchor class: whitespace, quotes, brackets, comparison/shell
// operators, pipes, redirects, colons, and closing delimiters.
describe("maskString paths — anchors — where a path may begin", () => {
  it("masks paths at string start and inside punctuation", () => {
    expect(mask("/Users/jdoe/x/y.sql was deleted")).toBe("<path> was deleted")
    expect(mask("failed (from /opt/dbt/bin/dbt)")).toBe("failed (from <path>)")
    expect(mask("--project-dir=/srv/analytics/dbt")).toBe("--project-dir=<path>")
  })

  it("masks paths enclosed in brackets/braces", () => {
    expect(mask("failed [/Users/jdoe/client/model.sql]")).toBe("failed [<path>]")
    expect(mask("ctx {/home/jdoe/proj/x.yml} missing")).toBe("ctx {<path>} missing")
  })

  it("recognizes paths directly after a colon", () => {
    expect(mask("ENOENT:/Users/jdoe/client/a.sql")).toBe("ENOENT:<path>")
    expect(mask("source:s3://customer-bucket/key")).toBe("source:<path>")
    expect(mask("at path:C:\\Users\\jdoe\\x.sql end")).toBe("at path:<path> end")
  })

  it("recognizes ; and < as path boundaries, preserving closers", () => {
    expect(mask("ENOENT;/Users/jdoe/client/a.sql")).toBe("ENOENT;<path>")
    expect(mask("failed </Users/jdoe/client/model.sql>")).toBe("failed <<path>>")
    expect(mask("cfg=a.yml;/etc/dbt/profiles.yml;done")).toBe("cfg=a.yml;<path>;done")
  })

  it("pipe is a path anchor but plain pipe prose never matches", () => {
    expect(mask("ENOENT|/Users/jdoe/client/a.sql")).toBe("ENOENT|<path>")
    expect(mask("source|s3://customer-bucket/private/a.csv")).toBe("source|<path>")
    expect(mask("a|b or c|d plain prose")).toBe("a|b or c|d plain prose")
  })

  it("shell redirection operators anchor paths", () => {
    expect(mask("echo x >/Users/jdoe/client/private.log failed")).toBe("echo x ><path> failed")
    expect(mask("cmd 2>/home/jdoe/output.log crashed")).toBe("cmd 2><path> crashed")
    expect(mask("if a > b then c")).toBe("if a > b then c")
  })

  it("closing delimiters anchor paths in structured stderr", () => {
    expect(mask("[ENOENT]/Users/jdoe/client/a.sql")).toBe("[ENOENT]<path>")
    expect(mask("error)/Users/jdoe/client/a.sql")).toBe("error)<path>")
    expect(mask("math (a+b)/(c+d) here")).toBe("math (a+b)/(c+d) here")
  })

  it("closing braces anchor paths", () => {
    expect(mask("{ENOENT}/Users/jdoe/client/a.sql")).toBe("{ENOENT}<path>")
    expect(mask("json {a}/{b} template")).toBe("json {a}/{b} template")
  })

  it("shell ampersands anchor paths", () => {
    expect(mask("cmd&&/Users/jdoe/client/private.sh failed")).toBe("cmd&&<path> failed")
    expect(mask("AT&T report ready")).toBe("AT&T report ready")
  })
})

// A delimiter or quote inside a component is path content only when a
// later separator or attached dotted filename proves it; otherwise it is
// a permanent boundary (shell ;cmd, closing quotes/parens are preserved,
// and quote pairing can never shift).
describe("maskString paths — delimiters and quotes inside components — separator-proven continuation", () => {
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

  it("delimiters attached directly to a separator continue the path", () => {
    expect(mask("read /data/a[b]/c.txt failed")).toBe("read <path> failed")
  })

  it("continues spaced components that start with symbols", () => {
    expect(mask("read /Users/Jane Doe/client #1/models/a.sql failed"))
      .toBe("read <path> failed")
  })

  it("longer bridges need a deep continuation, not just a later slash", () => {
    // <=2 words: first-segment proof; 3-6 words: the continuation must
    // itself look like a path (another separator or a dotted extension)
    expect(mask("read /data/x, client repo/models/a.sql done")).toBe("read <path> done")
    // delimiter proofs stay light: 3+ words after a comma read as prose
    expect(mask("read /data/x, big client repo/models/a.sql done"))
      .toBe("read <path>, big client repo/models/a.sql done")
    // a 4-word prose bridge to a lone slashed token stays a boundary
    expect(mask("read /data/x, see the big report/summary now"))
      .toBe("read <path>, see the big report/summary now")
  })

  it("continues through ) when a later separator proves it is path content", () => {
    expect(mask("read /Users/jdoe/client)repo/models/a.sql failed")).toBe("read <path> failed")
    // closing paren without a following separator stays preserved
    expect(mask("failed (from /opt/dbt/bin/dbt)")).toBe("failed (from <path>)")
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

  it("keeps literal backslashes as path content in slash-delimited rules", () => {
    expect(mask(String.raw`read s3://bucket/customer data\raw/models/a.sql failed`)).toBe("read <path> failed")
    expect(mask(String.raw`stat /opt/a\b/c/d.sql failed`)).toBe("stat <path> failed")
  })

  it("backslash-permissive run class never bleeds into following prose", () => {
    expect(mask(String.raw`use /pattern/ with \d+ tokens`)).toBe(String.raw`use <path> with \d+ tokens`)
    expect(mask(String.raw`glob /opt/data/*.sql \n escaped`)).toBe(String.raw`glob <path> \n escaped`)
  })

  it("continues through quote characters a later separator proves", () => {
    expect(mask(`read /Users/jdoe/client"repo/models/a.sql failed`)).toBe("read <path> failed")
    // paired inline-code backticks stay intact
    expect(mask("run `dbt build` in `/opt/proj/app` now")).toBe("run `dbt build` in `<path>` now")
  })

  it("a closing quote directly before a slash stays a boundary (pairing never shifts)", () => {
    // the eaten quote used to shift pairing and leak the next quoted value
    expect(mask(`read "/a/b"/c "secret data" end`)).toBe("read ?/c ? end")
    // mid-component quotes (non-empty run before the separator) still mask
    expect(mask(`read /Users/jdoe/client"repo/models/a.sql failed`)).toBe("read <path> failed")
  })

  it("a delimiter proof may combine an initial run with spaced runs", () => {
    expect(mask("/Users/jdoe/client)repo name/models/private.sql failed")).toBe("<path> failed")
    // all four boundary controls hold
    expect(mask("failed (from /opt/dbt/bin/dbt)")).toBe("failed (from <path>)")
    expect(mask(`read "/a/b"/c "secret data" end`)).toBe("read ?/c ? end")
    expect(mask("cd /Users/jdoe/proj;ls failed")).toBe("cd <path>;ls failed")
  })
})

// Extensions serve as proof (shallow explicit paths) and as prose guards
// (suppression after dotted files); bounded at 30 chars, unicode-aware.
describe("maskString paths — filename extensions", () => {
  it("recognizes long extensions so following prose survives", () => {
    expect(mask("/Users/jdoe/data.parquet was deleted"))
      .toBe("<path> was deleted")
    expect(mask("wrote /home/jdoe/out/events.jsonl then stopped"))
      .toBe("wrote <path> then stopped")
  })

  it("terminal dotted filename may span multiple words", () => {
    expect(mask("read /Users/jdoe/reports/Q4 final reviewed version.sql failed"))
      .toBe("read <path> failed")
  })

  it("extensions up to 14 chars count as proof and as prose guards", () => {
    expect(mask("read ./customer_secret.properties failed")).toBe("read <path> failed")
    expect(mask("read ../private.configuration now")).toBe("read <path> now")
    // the suppression direction: prose after a long-extension file survives
    expect(mask("/Users/jdoe/app.properties was deleted")).toBe("<path> was deleted")
  })

  it("hyphenated extensions prove shallow paths", () => {
    expect(mask("read ./client.code-workspace failed")).toBe("read <path> failed")
    expect(mask(String.raw`open \client\private.code-workspace denied`)).toBe("open <path> denied")
  })

  it("unicode extensions prove explicit paths", () => {
    expect(mask("read ./customer.配置 failed")).toBe("read <path> failed")
    expect(mask("read /秘密.配置 now")).toBe("read <path> now")
  })

  it("combining marks count in extensions", () => {
    expect(mask("read ./customer.é failed")).toBe("read <path> failed")
  })

  it("extensions up to 30 chars prove explicit paths", () => {
    expect(mask("read ./customer.sublime-workspace failed")).toBe("read <path> failed")
    expect(mask("/Users/jdoe/app.properties was deleted")).toBe("<path> was deleted")
  })
})

describe("maskString paths — prose survives around a masked path", () => {
  // A spaced run may only bridge to a later separator under strict proof
  // (<= 2 clean words, no delimiter/colon words, a letter reachable past the
  // separator). URLs, dates, fractions, MIME types, and second path-ish
  // tokens no longer prove a bridge, so the clause between a path and any
  // later slash survives.
  it("later slashes never swallow the clause between", () => {
    expect(mask("open /app/x.sql failed, see https://docs.example.com/e/123"))
      .toBe("open <path> failed, see https://docs.example.com/e/123")
    expect(mask("open /app/x.sql failed on 8/17/2026 today")).toBe("open <path> failed on 8/17/2026 today")
    expect(mask("open /app/x.sql failed at ratio 1/2 today")).toBe("open <path> failed at ratio 1/2 today")
    expect(mask("open /app/x.sql failed: application/json expected"))
      .toBe("open <path> failed: application/json expected")
    expect(mask("Model /app/models/a.sql references missing source raw/orders"))
      .toBe("Model <path> references missing source raw/orders")
  })

  it("internal-host classification is preserved after a path", () => {
    expect(mask("read /opt/x.sql then GET http://10.0.0.5/api/y failed"))
      .toBe("read <path> then GET <internal-host> failed")
  })

  it("distinct errors keep distinct masked text (errorHash identity)", () => {
    const a = mask("Model /app/models/a.sql references missing source raw/orders")
    const b = mask("Model /app/models/b.sql references missing column raw/customers")
    expect(a).not.toBe(b)
  })

  it("4+-word directory components mask whole in every family", () => {
    expect(mask("read /data/my big client folder/models/x.sql")).toBe("read <path>")
    expect(mask("read /srv/acme corp data warehouse/models/x.sql")).toBe("read <path>")
    expect(mask(String.raw`read C:\data\my big client folder\models\x.sql`)).toBe("read <path>")
    expect(mask("s3://bucket/my big client folder/models/x.parquet")).toBe("<path>")
    expect(mask("read ~/w0 w1 w2 w3/models/x.sql")).toBe("read <path>")
    expect(mask("read //srv/share/Users/jdoe/w0 w1 w2 w3/x.sql")).toBe("read <path>")
    expect(mask("read /data/w0 w1 w2 w3/x.sql")).toBe("read <path>")
  })

  it("windowsHome segments cannot bridge prose to a later home root", () => {
    const out = mask("open //server.example.com/share/x failed on 8/17/2026/Users/jdoe/secret.txt")
    // the prose survives; the date fragment glued to the home path goes with
    // it (a home root anchors mid-token by design — the username must mask)
    expect(out).toContain("failed on 8")
    expect(out).not.toContain("jdoe")
    const out2 = mask(String.raw`open \\server\share\x failed with many ordinary bridge words here/Users/jdoe/secret.txt`)
    expect(out2).toContain("failed with many ordinary bridge words here")
    expect(out2).not.toContain("jdoe")
  })

  it("FQDN UNC /home/ and /homes/ shares mask", () => {
    expect(mask("ENOENT: //server.example.com/share/home/jdoe/secret.txt")).toBe("ENOENT: <path>")
    expect(mask("ENOENT: //server.example.com/share/homes/jdoe/secret.txt")).toBe("ENOENT: <path>")
  })

  it("home roots anchor mid-token: glued or URL-embedded usernames still mask", () => {
    expect(mask("prose here now/Users/jdoe/secret.txt")).toBe("prose here now<path>")
    expect(mask("see https://example.com/Users/jdoe/profile now")).toBe("see https://example.com<path>")
  })

  it("FQDN UNC homes mask; schemed public URLs stay", () => {
    expect(mask("ENOENT: //server.example.com/share/Users/jdoe/secret.txt")).toBe("ENOENT: <path>")
    expect(mask("see https://community.snowflake.com/s/ip-not-allowed for details"))
      .toBe("see https://community.snowflake.com/s/ip-not-allowed for details")
  })
})

describe("maskString paths — known-prefix freshness", () => {
  it("cwd literals follow process.chdir (shallow extensionless roots)", () => {
    const os = require("os")
    const fs = require("fs")
    const path = require("path")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "customer-repo-"))
    const prev = process.cwd()
    try {
      process.chdir(dir)
      const real = fs.realpathSync(dir)
      // the post-chdir cwd must be in the literal list: whichever layer wins,
      // the directory name (customer-identifying) never survives
      const out = mask(`stat ${real} failed`)
      expect(out).not.toContain(real)
      expect(out).not.toContain("customer-repo")
      expect(out).toContain("<path>")
    } finally {
      process.chdir(prev)
      fs.rmdirSync(dir)
    }
  })
})

// The must-not-mask set and the by-design residue: public URLs, non-path
// slashes, mid-sentence prose, column-aligned log output, and tab as a
// field boundary.
describe("maskString paths — must NOT mask — prose, URLs, and documented boundaries", () => {
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

  it("still leaves public https doc-links alone (provider help URLs)", () => {
    expect(mask("see https://community.snowflake.com/s/ip-not-allowed for details"))
      .toBe("see https://community.snowflake.com/s/ip-not-allowed for details")
  })

  it("still never eats mid-sentence prose after a path", () => {
    expect(mask("open /app/x.sql failed with error")).toBe("open <path> failed with error")
    expect(mask("File not found: /app/models/a.sql was deleted upstream"))
      .toBe("File not found: <path> was deleted upstream")
  })

  it("colon anchors never bite into URLs", () => {
    expect(mask("POST https://api.openai.com/v1/chat/completions failed"))
      .toBe("POST https://api.openai.com/v1/chat/completions failed")
    expect(mask("fetch //cdn.example.com/lib.js failed"))
      .toBe("fetch //cdn.example.com/lib.js failed")
    expect(mask("connect db-host:5432/postgres refused"))
      .toBe("connect db-host:5432/postgres refused")
  })

  it("tab is a field boundary, not path continuation (documented residue)", () => {
    // tab-delimited log columns after a path must survive; the bare relative
    // fragment after the tab is the documented undecidable-fragment boundary
    expect(mask("/Users/jdoe/client\tsecret/models/a.sql")).toBe("<path> secret/models/a.sql")
  })

  it("three or more spaces stay a column boundary", () => {
    expect(mask("read /opt/data/x.sql    404 NotFound")).toBe("read <path> 404 NotFound")
  })
})

describe("maskString paths — composition with the rest of the masking chain", () => {
  it("composes with the earlier rules in the chain", () => {
    // credential first, then the path
    expect(mask("sk-abcdefghijklmnopqrstuvwx leaked into /Users/jdoe/log.txt"))
      .toBe("sk-*** leaked into <path>")
    // quoted path still collapses via the quote rule — no leak either way
    expect(mask("open '/Users/jdoe/x.sql' failed")).not.toContain("jdoe")
  })
})

// Every quantified unit is space- or separator-anchored with disjoint
// inner classes (unambiguous parse => linear time); proof scans are
// bounded by the filesystem's 255-byte component limit; the nested-
// quantifier ReDoS shape is banned.
describe("maskString paths — performance — growth rates, not wall clocks", () => {
  // A single-size wall-clock budget cannot distinguish O(n) from O(n^2) and
  // flakes on loaded runners. Each adversarial shape is timed at two sizes;
  // 8x the input must cost < 16x the time (linear ~8x, quadratic ~64x).
  // per-call cost measured over enough repetitions that BOTH sizes are real
  // milliseconds — a floor on the small side would silently turn the ratio
  // back into a single-size wall clock (median of 3 batches vs scheduler)
  const perCall = (s: string, reps: number) => {
    const xs = [0, 0, 0].map(() => {
      const a = performance.now()
      for (let i = 0; i < reps; i++) mask(s)
      return (performance.now() - a) / reps
    })
    return xs.sort((x, y) => x - y)[1]
  }
  const growth = (gen: (n: number) => string) => {
    const small = gen(1000), large = gen(8000)
    mask(small); mask(large) // warmup
    return perCall(large, 12) / perCall(small, 100)
  }

  it("drive-colon runs grow linearly (was quadratic: v:col SQL stalled seconds)", () => {
    expect(growth(n => "a:".repeat(n / 2))).toBeLessThan(16)
  })

  it("delimiter runs grow linearly", () => {
    expect(growth(n => "C:\\a\\b" + ")".repeat(n) + "\\c")).toBeLessThan(16)
  })

  it("interleaved delimiters grow linearly", () => {
    expect(growth(n => ")a".repeat(n / 2) + "/x")).toBeLessThan(16)
  })

  it("spaced word runs after a path grow linearly", () => {
    expect(growth(n => "/a/b, " + "word ".repeat(n / 5))).toBeLessThan(16)
  })

  it("separator-free word runs grow linearly (email rule boundary)", () => {
    expect(growth(n => "x".repeat(n))).toBeLessThan(16)
  })

  it("backslash runs grow linearly", () => {
    expect(growth(n => '"' + "\\".repeat(n) + '"')).toBeLessThan(16)
  })

  it("entry truncation makes cost flat beyond 8 KB — every pass runs on the window", () => {
    const gen = (n: number) => "a:".repeat(n / 2)
    mask(gen(20000))
    // 8x more input past the cap must cost ~1x, never scale with length
    expect(perCall(gen(160000), 12) / perCall(gen(20000), 12)).toBeLessThan(3)
  })
})
