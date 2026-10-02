// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { redactSecrets, hasSecretPattern } from "../../../src/altimate/learn/digest"
import { curate, lint, verificationWarning } from "../../../src/altimate/learn/curator"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { validateCandidate, verificationWarnings } from "../../../src/altimate/learn/store"

// Frozen inputs from review-findings.md through review7-findings.md and the
// review-redaction, verification-lint, and sensitive-data test tables. Keep cases
// when adding a rule: each detected credential must fail all three lesson entry points.
// Review7 recognizes tool names in prose; quoted names and option values are
// excluded, and each command's arguments stop at shell or sentence boundaries.
// Repeated citations are deduplicated; generated command/flag cases are expanded.
// Credentials includes PII, matching the existing sensitive-data guardrail.
const crossing = (cap: number) =>
  "x".repeat(cap - " https://alice:hunter2".length) + " https://alice:hunter2@localhost/db"
const longPassword = (cap: number) => `https://alice:hunter2${"x".repeat(cap)}@localhost/db`

const credentials: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "No: connect with sqlcmd -S prod -U sa -P hunter2 and email ops@acme.com before changing staging models.",
    ["hunter2", "ops@acme.com"],
  ],
  ["MYSQL_HOST=warehouse mysql -phunter2", ["hunter2"]],
  ["(mysql -phunter2)", ["hunter2"]],
  ["command mysql -phunter2", ["hunter2"]],
  ["docker exec mysql mysql -phunter2", ["hunter2"]],
  ["Authorization: Bearer token.hunter2", ["token.hunter2"]],
  ["Authorization: Bearer token", ["Bearer token"]],
  ["Bearer token.hunter2", ["token.hunter2"]],
  ["Bearer token.", ["token."]],
  ["password=4096", ["4096"]],
  ["api_key=123456789", ["123456789"]],
  ["sqlcmd -S mysql -P hunter2", ["hunter2"]],
  ["mysql -p mysql", ["-p mysql"]],
  ["Use sqlcmd -P hunter2 to authenticate.", ["hunter2"]],
  ["Use redis-cli or sqlcmd -P hunter2 to connect.", ["hunter2"]],
  ["Use mysql or redis-cli -a hunter2 to connect.", ["hunter2"]],
  ["Use sqlcmd or mysql -phunter2 to connect.", ["hunter2"]],
  ["Use mysql or mysql -phunter2 to connect.", ["hunter2"]],
  ["Use curl or sshpass -p hunter2 ssh host.", ["hunter2"]],
  ["redis-cli \\\n  sqlcmd -P hunter2", ["hunter2"]],
  ["Use mysql or git log -p before merging.", ["-p before"]],
  ["Use mysql or psql -p 5432 to connect.", ["5432"]],
  ["Use mariadb or mkdir -p models.", ["-p models"]],
  ["docker login -u analyst -p warehouse_secret", ["warehouse_secret"]],
  ["docker login -u x -p y", ["-p y"]],
  ["docker login -u x --password y", ["--password y"]],
  ["curl -u alice:hunter2", ["hunter2"]],
  ["curl --user alice:hunter2", ["hunter2"]],
  ['curl --user="alice:two words"', ["two words"]],
  ["curl -ualice:hunter2", ["hunter2"]],
  ["curl --proxy-user alice:hunter2", ["hunter2"]],
  ["--proxy-user u:p", ["u:p"]],
  ['curl --proxy-user="alice:two words"', ["two words"]],
  ["api key: hunter2", ["hunter2"]],
  ["api key: x", ["x"]],
  ["API key: hunter2", ["hunter2"]],
  ["api_key=hunter2", ["hunter2"]],
  ["api_key=x", ["x"]],
  ["token: hunter2", ["hunter2"]],
  ["token: x", ["x"]],
  ["secret: hunter2", ["hunter2"]],
  ["secret: x", ["x"]],
  ["password: |\n  hunter2", ["hunter2"]],
  ['password: "first\nhunter2\nlast"', ["hunter2"]],
  ["password: 'first\nhunter2\nlast'", ["hunter2"]],
  ['password: "first\\"hunter2\nlast"', ["hunter2"]],
  ['client --password "first\nhunter2\nlast"', ["hunter2"]],
  ['mysql -p"first\nhunter2\nlast"', ["hunter2"]],
  ["ｐａｓｓｗｏｒｄ: hunter2", ["hunter2"]],
  ["pass​word: hunter2", ["hunter2"]],
  ["to‍ken: hunter2", ["hunter2"]],
  ["Authorization: Basic YWxpY2U6cHc=", ["YWxpY2U6cHc="]],
  ["Authorization: Basic x", ["Basic x"]],
  ["Authorization: Bearer x", ["Bearer x"]],
  ["Authorization: Bearer !@#$%^*", ["!@#$%^*"]],
  ["Bearer hunter2", ["hunter2"]],
  ["redis://alice:hunter2@localhost/db", ["hunter2"]],
  ["redis://:hunter2@localhost/db", ["hunter2"]],
  ["postgres://alice:hunter2@localhost/db", ["hunter2"]],
  ["postgres://:hunter2@localhost/db", ["hunter2"]],
  ["mysql://alice:hunter2@localhost/db", ["hunter2"]],
  ["mysql://:hunter2@localhost/db", ["hunter2"]],
  ["mongodb://alice:hunter2@localhost/db", ["hunter2"]],
  ["mongodb://:hunter2@localhost/db", ["hunter2"]],
  ["mongodb+srv://alice:hunter2@localhost/db", ["hunter2"]],
  ["mongodb+srv://:hunter2@localhost/db", ["hunter2"]],
  ["amqp://alice:hunter2@localhost/db", ["hunter2"]],
  ["amqp://:hunter2@localhost/db", ["hunter2"]],
  ["https://alice:hunter2@localhost/db", ["hunter2"]],
  ["https://:hunter2@localhost/db", ["hunter2"]],
  ["custom+db://alice:hunter2@localhost/db", ["hunter2"]],
  ["custom+db://:hunter2@localhost/db", ["hunter2"]],
  ["sqlcmd -S example -U sa -P hunter2", ["hunter2"]],
  ["mysql -phunter2", ["hunter2"]],
  ["mysql -p hunter2", ["hunter2"]],
  ["mongosh -u admin -p hunter2", ["hunter2"]],
  ["mongo -p hunter2", ["hunter2"]],
  ["sshpass -p hunter2 ssh host", ["hunter2"]],
  ["redis-cli -a hunter2", ["hunter2"]],
  ["sqlcmd -P=hunter2", ["hunter2"]],
  ["client --password hunter2", ["hunter2"]],
  ['client --password="two words"', ["two words"]],
  ["client --token=short-token", ["short-token"]],
  ["client --secret short-secret", ["short-secret"]],
  ["client --api-key short-key", ["short-key"]],
  ["password=hunter2", ["hunter2"]],
  ["pwd=hunter2", ["hunter2"]],
  ["PASSWORD = 'two words'", ["two words"]],
  ["Server=example;Uid=sa;Pwd={two;words}", ["two;words"]],
  ["postgres://alice:hunter2@example/db", ["hunter2"]],
  ["Contact alice@example.com", ["alice@example.com"]],
  ["SSN 123-45-6789", ["123-45-6789"]],
  ["SSN 123 45 6789", ["123 45 6789"]],
  ["SSN 123456789", ["123456789"]],
  ["mysql -S example -p hunter2", ["hunter2"]],
  ["mysql -S example -phunter2", ["hunter2"]],
  ["mysql -S example -p=hunter2", ["hunter2"]],
  ['mysql -S example -p "hunter2 two words"', ["hunter2"]],
  ["mariadb -S example -p hunter2", ["hunter2"]],
  ["mariadb -S example -phunter2", ["hunter2"]],
  ["mariadb -S example -p=hunter2", ["hunter2"]],
  ['mariadb -S example -p "hunter2 two words"', ["hunter2"]],
  ["mysqldump -S example -p hunter2", ["hunter2"]],
  ["mysqldump -S example -phunter2", ["hunter2"]],
  ["mysqldump -S example -p=hunter2", ["hunter2"]],
  ['mysqldump -S example -p "hunter2 two words"', ["hunter2"]],
  ["mysqladmin -S example -p hunter2", ["hunter2"]],
  ["mysqladmin -S example -phunter2", ["hunter2"]],
  ["mysqladmin -S example -p=hunter2", ["hunter2"]],
  ['mysqladmin -S example -p "hunter2 two words"', ["hunter2"]],
  ["mariadb-dump -S example -p hunter2", ["hunter2"]],
  ["mariadb-dump -S example -phunter2", ["hunter2"]],
  ["mariadb-dump -S example -p=hunter2", ["hunter2"]],
  ['mariadb-dump -S example -p "hunter2 two words"', ["hunter2"]],
  ["mysqlcheck -S example -p hunter2", ["hunter2"]],
  ["mysqlcheck -S example -phunter2", ["hunter2"]],
  ["mysqlcheck -S example -p=hunter2", ["hunter2"]],
  ['mysqlcheck -S example -p "hunter2 two words"', ["hunter2"]],
  ["mysql-custom-tool -S example -p hunter2", ["hunter2"]],
  ["mysql-custom-tool -S example -phunter2", ["hunter2"]],
  ["mysql-custom-tool -S example -p=hunter2", ["hunter2"]],
  ['mysql-custom-tool -S example -p "hunter2 two words"', ["hunter2"]],
  ["mariadb-admin -S example -p hunter2", ["hunter2"]],
  ["mariadb-admin -S example -phunter2", ["hunter2"]],
  ["mariadb-admin -S example -p=hunter2", ["hunter2"]],
  ['mariadb-admin -S example -p "hunter2 two words"', ["hunter2"]],
  ["sqlcmd -S example -P hunter2", ["hunter2"]],
  ["sqlcmd -S example -Phunter2", ["hunter2"]],
  ["sqlcmd -S example -P=hunter2", ["hunter2"]],
  ['sqlcmd -S example -P "hunter2 two words"', ["hunter2"]],
  ["bcp -S example -P hunter2", ["hunter2"]],
  ["bcp -S example -Phunter2", ["hunter2"]],
  ["bcp -S example -P=hunter2", ["hunter2"]],
  ['bcp -S example -P "hunter2 two words"', ["hunter2"]],
  ["mongosh -S example -p hunter2", ["hunter2"]],
  ["mongosh -S example -phunter2", ["hunter2"]],
  ["mongosh -S example -p=hunter2", ["hunter2"]],
  ['mongosh -S example -p "hunter2 two words"', ["hunter2"]],
  ["mongo -S example -p hunter2", ["hunter2"]],
  ["mongo -S example -phunter2", ["hunter2"]],
  ["mongo -S example -p=hunter2", ["hunter2"]],
  ['mongo -S example -p "hunter2 two words"', ["hunter2"]],
  ["sshpass -phunter2 ssh host", ["hunter2"]],
  ["sshpass -p=hunter2 ssh host", ["hunter2"]],
  ['sshpass -p "hunter2 two words" ssh host', ["hunter2"]],
  ["redis-cli -S example -a hunter2", ["hunter2"]],
  ["redis-cli -S example -ahunter2", ["hunter2"]],
  ["redis-cli -S example -a=hunter2", ["hunter2"]],
  ['redis-cli -S example -a "hunter2 two words"', ["hunter2"]],
  ["sshpass -p hunter2 ssh -p 2222 host", ["hunter2"]],
  ["mysqladmin \\\n  -p hunter2", ["hunter2"]],
  ["mysqladmin -p \\\n  hunter2", ["hunter2"]],
  ["mariadb-dump \\\n  -p hunter2", ["hunter2"]],
  ["mariadb-dump -p \\\n  hunter2", ["hunter2"]],
  ["sqlcmd \\\n  -P hunter2", ["hunter2"]],
  ["sqlcmd -P \\\n  hunter2", ["hunter2"]],
  ["client \\\n  --password hunter2", ["hunter2"]],
  ["client --password \\\n  hunter2", ["hunter2"]],
  ["password: |\n  first\n  hunter2\nnext: keep", ["hunter2"]],
  ['password: "first\nhunter2"\nnext: keep', ["hunter2"]],
  ["password: 'first\nhunter2'\nnext: keep", ["hunter2"]],
  ["mysql -p!", ["!"]],
  ["mysql -p?", ["?"]],
  ["mysql -p.", ["."]],
  ["mysql -phunter2!", ["hunter2!"]],
  ["mysql -phunter2?", ["hunter2?"]],
  ["mysql -h db.example. -phunter2", ["hunter2"]],
  ["sqlcmd -S db.example. -P hunter2", ["hunter2"]],
  ["Contact bob@corp.com for details", ["bob@corp.com"]],
  ["redis://:hunter2@localhost:6379/0", ["hunter2"]],
  ["mysqladmin -phunter2 ping", ["hunter2"]],
  ["mariadb-dump -phunter2 db", ["hunter2"]],
  ["sqlcmd \\\n -P hunter2", ["hunter2"]],
  [
    "Use sqlcmd -P hunter2; contact alice@example.com; SSN 123-45-6789; password=another-secret",
    ["hunter2", "alice@example.com", "123-45-6789", "another-secret"],
  ],
  ["Authenticate with password=hunter2.", ["hunter2"]],
  ["authorization: Basic private-auth", ["private-auth"]],
  ['client --password="quoted secret"', ["quoted secret"]],
  ["Use redis-cli or sqlcmd -P hunter2; mysql -psecond-secret", ["hunter2", "second-secret"]],
  ["sqlcmd -P first-secret && redis-cli -a second-secret", ["first-secret", "second-secret"]],
  ["redis-cli -a first-secret\nsqlcmd -P second-secret", ["first-secret", "second-secret"]],
  ["mysql -pfirst-secret or mysql -psecond-secret", ["first-secret", "second-secret"]],
  ["password=Bearer hunter2", ["hunter2"]],
  ["token=Authorization: Basic hunter2", ["hunter2"]],
  ["password=sqlcmd -P hunter2", ["sqlcmd"]],
  ["password=curl -u alice:hunter2", ["curl"]],
  ["redis-cli -a hunter2 sqlcmd -P second-secret mysql -pthird-secret", ["hunter2", "second-secret", "third-secret"]],
  [
    "sqlcmd -P hunter2; redis-cli -a second-secret | mysql -pthird-secret",
    ["hunter2", "second-secret", "third-secret"],
  ],
  ["redis-cli\n  sqlcmd -P hunter2", ["hunter2"]],
  // All distinct redaction-before-clipping inputs from review-redaction.test.ts.
  [crossing(400), ["hunter2"]],
  [crossing(500), ["hunter2"]],
  [crossing(1_498), ["hunter2"]],
  [crossing(2_000), ["hunter2"]],
  [crossing(3_000), ["hunter2"]],
  [crossing(12_000), ["hunter2"]],
  [longPassword(4_000), ["hunter2"]],
  [longPassword(20_000), ["hunter2"]],
]

const benign = [
  "mysql failed. Retry with psql -p 5432.",
  "In CI, skip dependency installation on cache hits.",
  "Do not run full refresh in CI.",
  "SELECT * FROM orders WHERE order_id = 123456789;",
  "Set max_tokens=4096 for the model.",
  "Use bearer token to authenticate.",
  "Use bearer token",
  'Use "mysql -phunter2" as an example.',
  "Use 'mysql -phunter2' as an example.",
  "Filter with --exclude test accounts.",
  "Filter with -x test accounts.",
  "Exclude test accounts from revenue calculations.",
  "Exclude build artifacts from version control.",
  "Exclude test data from revenue calculations.",
  "Exclude test rows from revenue calculations.",
  "Exclude test records from revenue calculations.",
  "Exclude test artifacts from version control.",
  "Exclude test fixtures from version control.",
  "Exclude test files from version control.",
  "Exclude test users from revenue calculations.",
  "Skip duplicate rows. Run tests before merging.",
  "Use bearer tokens to authenticate.",
  "Run unit tests before committing",
  "Run CI checks and code review before merging.",
  "Run unit tests before committing.",
  "Run git log -p before merging.",
  "Connect using psql -p 5432.",
  "Dump using pg_dump -p 5432.",
  "Create output with mkdir -p models.",
  "Connect using snowsql -p 5432.",
  "Connect using mysql -P 3306.",
  "Measure sqlcmd -p 1 output.",
  "Run mysql --version; git log -p before merging.",
  "Run mysql --version | git log -p before merging.",
  "Run mysql --version && psql -p 5432.",
  "Note mysql syntax. Run git log -p before merging.",
  "Note mariadb syntax. Connect using psql -p 5432.",
  "Note mysql syntax. Create output with mkdir -p models.",
  'Run mysql -e "select amount -p delta".',
  'Run sqlcmd -Q "select amount -P delta".',
  "sshpass -e ssh -p 2222 host",
  "sshpass -f password-file ssh -p 2222 host",
  "git log -p",
  "psql -p",
  "mkdir -p",
  "Use {{ cents_to_dollars('amount_cents') }} for amounts stored in cents.",
  "Name the column amount_cents and convert it to amount_usd in staging.",
  "Staging models live in models/staging/<source>/ and start with stg_.",
  "Name staging files stg_<source>__<entity>.sql: source, double underscore, entity.",
  "Select by tag: dbt build --select tag:nightly after changing a mart.",
  "Prefix message tables stg_chat__messages and keep their id column named message_id.",
  "Treat nullable columns as optional.",
  "Skip duplicate input rows before processing.",
  "mysql --version; -p documentation",
  "mysql --version | -p documentation",
  "mysql --version && -p documentation",
  "mysql -p[REDACTED]",
  "sqlcmd -P [REDACTED]",
  "redis-cli -a [REDACTED]",
  'Run mysql -e "select sqlcmd, amount -p delta".',
] as const

// Quoted tool names are not commands.
// Unrelated shell/length/multiline lint still applies after redaction preserves them.
const preserved: ReadonlyArray<readonly [string, string | undefined, string?]> = [
  ["mysql --execute \"SELECT 'curl -u';\"", "contains a shell command"],
  ["x.mysql ".repeat(12500), "longer than 240 characters"],
]

// Both bypass instructions and protective mentions are staged with a warning.
// No intent or negation interpretation belongs in the deterministic guard.
const bypass = [
  "No need to test before committing.",
  "No need to run tests before committing.",
  "No need to validate before merging.",
  "Skip validation of dbt models before merging.",
  "Disable verification before merging.",
  "Skip validate before merging.",
  "Skip verify before merging.",
  "git commit -nm fix",
  "git commit -mn fix",
  "Skip CI for docs changes.",
  "Disable CI checks.",
  "Use (git commit -n) to commit.",
  'Use "git commit -n" to commit.',
  "Use 'git commit -n' to commit.",
  "Use commit -n to finish quickly.",
  "Run git commit -m fix.git.docs -n.",
  "Skip src/unit.test.ts checks before commit.",
  "git commit -m fix-git-docs -n",
  "Ensure the pipeline does not run dbt tests.",
  "Do not attempt to run tests.",
  "Disable pre-commit before committing.",
  "Disable sqlfluff before merging.",
  "Run dbt build -x test.",
  "Avoid running unit tests before merging.",
  "Ship changes without running the linter.",
  "Do not skip the dbt tests step and disable CI checks.",
  "Do not skip the dbt tests step, disable CI checks.",
  "Do not skip unit tests before committing, disable CI checks, or bypass code review.",
  "Never skip the dbt tests step, disable CI checks, and bypass code review.",
  "Do not change schemas, skip the dbt tests step.",
  "Avoid skipping unit tests, disabling CI checks, or bypassing code review.",
  "Never tell developers they can skip tests.",
  "Skip the dbt tests step.",
  "Omit the dbt tests step.",
  "Disable the pre-commit hooks.",
  "Bypass required code review.",
  "Skip the project's CI checks.",
  "Run dbt test --exclude test.",
  "Run dbt build --exclude test.",
  "Run dbt build --exclude=test_type:generic.",
  "Disable dbt contracts before building.",
  "Disable all quality gates.",
  "Disable testing before merging.",
  "Do not run unit tests before merging.",
  "Run dbt build --exclude resource_type:test.",
  "Skip `dbt test` before committing.",
  "Do not skip tests; disable CI checks instead.",
  "Never skip unit tests, but bypass code review.",
  "Don't disable CI checks. Skip lint instead.",
  "Do not skip tests and disable CI checks instead.",
  "Do not skip tests instead disable CI checks.",
  "Do not skip tests then disable CI checks.",
  "Never skip unit tests yet bypass code review.",
  "Do not change schemas, you must skip unit tests before merging.",
  "Avoid changing schemas, you should skip unit tests before merging.",
  "Avoid CI failures by skipping unit tests.",
  "Avoid merge delays by disabling CI checks.",
  "Do not skip tests or change schemas or disable CI checks.",
  "Do not skip tests or you must disable CI checks.",
  "Excluded unit tests before merging.",
  "Ignoring CI checks speeds merging.",
  "Turned off pre-commit hooks.",
  "Treat code review as optional.",
  "Commit changes without running tests.",
  "There is no need to run tests.",
  "Run git commit -n.",
  "Use git -n commit.",
  "Never use git commit -n and use git commit --no-verify.",
  "Never use git commit -n; use git commit --no-verify.",
  "Skip all unit tests and code review for migrations.",
  "Treat tests as optional and commit with git commit -n.",
  "Omit integration tests before merging.",
  "Skip required CI checks for migrations.",
  "Treat lint checks as optional.",
  "Disable CI for migrations.",
  "Commit using git commit --amend -n.",
  "Commit changes with --no-verify.",
  "Never run tests before merge",
  "Ignore required CI checks.",
  "Exclude integration tests before merging.",
  "Turn off required quality gates.",
  'Commit with git commit -m "fix tests and lint" -n.',
  'Commit with git commit -m "update git docs" -n.',
  'Run dbt build --vars "{topic: git}" --exclude resource_type:test.',
  "Run dbt build --vars '{topic: git}' --exclude resource_type:test.",
] as const

const protective = [
  "Ensure the pipeline does not skip tests.",
  "Never use the --no-verify flag.",
  "Do not skip unit tests before committing.",
  "Never skip the dbt tests step.",
  "Don't disable CI checks.",
  "Do not ever bypass code review.",
  "Never omit lint checks.",
  "Don't turn off pre-commit hooks.",
  "Do not run dbt build --exclude test.",
  "Never use git commit --no-verify.",
  "Never use `git commit --no-verify`.",
  "Do not treat code review as optional.",
  "Do not skip tests or disable CI checks.",
  "Do not skip the dbt tests step or disable CI checks.",
  "Do not skip unit tests and always run lint before committing.",
  "Do not always skip unit tests.",
  "Avoid skipping unit tests.",
  "Do not skip or disable tests.",
  "Do not skip, or disable tests.",
  "Never skip nor omit unit tests.",
  "Do not skip tests, or disable CI checks.",
  "Do not skip tests or disable CI checks nor bypass code review.",
  "You must not disable CI checks.",
  "You should not exclude unit tests.",
  "No skipping unit tests.",
  "Do not deliberately bypass code review.",
  "Never run git commit -n.",
  "Never use git commit -n --no-verify.",
  "Never use git commit --no-verify --no-verify.",
  "Never use git commit -n -m changes --no-verify.",
  "Never use git commit -n or use git commit --no-verify.",
  "Do not use --no-verify.",
  "Do not skip the dbt tests step",
  "Do not skip tests nor disable CI checks.",
  "You must not ever bypass code review.",
  "You should not omit tests.",
  'Never use git commit -m "fix tests and lint" --no-verify.',
  'Never use git commit -m "update git docs" -n.',
  'Do not run dbt build --vars "{topic: git}" --exclude resource_type:test.',
  "Do not run dbt build --vars '{topic: git}' --exclude resource_type:test.",
] as const

function validate(text: string) {
  const name = "guardrail-corpus"
  const candidate = Playbook.withBullets(Playbook.create({ name }), [{ id: "L-0001", text, helpful: 0, harmful: 0 }])
  return validateCandidate(name, Playbook.serialize(candidate))
}

function accepts(text: string) {
  expect(redactSecrets(text)).toBe(text)
  expect(hasSecretPattern(text)).toBe(false)
  expect(lint(text)).toBeUndefined()
  expect(curate([], [{ op: "ADD", text, reason: "frozen guardrail corpus" }]).next).toHaveLength(1)
  expect(validate(text)).toBeUndefined()
}

// Stable row numbers make comparison against a copied previous revision readable,
// including the large clipping-boundary inputs whose full text would swamp logs.
function label(category: string, index: number, text: string) {
  return `${category} ${index + 1}: ${JSON.stringify(text).slice(0, 140)}`
}

describe("frozen learn guardrail corpus", () => {
  for (const [index, [text, secrets]] of credentials.entries()) {
    test(label("credentials", index, text), () => {
      const redacted = redactSecrets(text)
      for (const secret of secrets) expect(redacted).not.toContain(secret)
      expect(redacted).toContain("[REDACTED]")
      expect(redactSecrets(redacted)).toBe(redacted)
      expect(hasSecretPattern(text)).toBe(true)
      expect(verificationWarning(text)).toBeUndefined()
      expect(lint(text)).toBeDefined()
      expect(curate([], [{ op: "ADD", text, reason: "frozen guardrail corpus" }]).next).toEqual([])
      expect(validate(text)).toBeDefined()
    })
  }
  for (const [index, text] of benign.entries()) test(label("benign", index, text), () => {
    accepts(text)
    expect(verificationWarning(text)).toBeUndefined()
  })
  for (const [index, [text, rejection, normalized]] of preserved.entries()) {
    test(label("preserved command mentions", index, text), () => {
      expect(redactSecrets(text)).toBe(normalized ?? text)
      expect(hasSecretPattern(text)).toBe(false)
      expect(verificationWarning(text)).toBeUndefined()
      expect(lint(text)).toBe(rejection)
      const result = curate([], [{ op: "ADD", text, reason: "frozen guardrail corpus" }])
      expect(result.next).toHaveLength(rejection ? 0 : 1)
      if (rejection) expect(validate(text)).toBeDefined()
      else expect(validate(text)).toBeUndefined()
    })
  }
  for (const [category, rows] of [["bypass", bypass], ["protective", protective]] as const) {
    for (const [index, text] of rows.entries()) test(label(category, index, text), () => {
      accepts(text)
      expect(verificationWarning(text)).toBe("mentions skipping or disabling verification")
    })
  }

  test("review7 unchecked long bullet warning scans stay below 200 ms", () => {
    const text = "commit ".repeat(14286).slice(0,100000)
    const candidate = Playbook.serialize(Playbook.withBullets(Playbook.create({ name: "guardrail-corpus" }), [
      { id: "L-0001", text, helpful: 0, harmful: 0 },
    ]))

    const helperStart = performance.now()
    const warning = verificationWarning(text)
    const helperElapsed = performance.now() - helperStart
    expect(warning).toBeUndefined()
    expect(helperElapsed).toBeLessThan(200)

    const storeStart = performance.now()
    const warnings = verificationWarnings(candidate)
    const storeElapsed = performance.now() - storeStart
    expect(warnings).toEqual([])
    expect(storeElapsed).toBeLessThan(200)

    expect(redactSecrets(text)).toBe(text)
    expect(hasSecretPattern(text)).toBe(false)
    expect(lint(text)).toBe("longer than 240 characters")
    expect(curate([], [{ op: "ADD", text, reason: "frozen guardrail corpus" }]).next).toEqual([])
    expect(validate(text)).toBeDefined()
  })
})
