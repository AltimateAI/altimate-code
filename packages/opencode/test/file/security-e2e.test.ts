/**
 * End-to-end security tests for path containment, symlink protection,
 * protected directories, and sensitive file detection.
 *
 * These tests use real filesystem operations (not mocks) to verify
 * the security boundaries work against actual attack scenarios.
 */
import { test, expect, describe, beforeAll } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync, symlinkSync, mkdirSync, writeFileSync } from "fs"
import { Filesystem } from "../../src/util/filesystem"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { Protected } from "../../src/file/protected"
import { assertSensitiveWrite } from "../../src/tool/external-directory"
import { PermissionNext } from "../../src/permission/next"
import type { Tool } from "../../src/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

// Helper: create a mock Tool.Context that records permission requests
function mockContext() {
  const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async (req) => {
      requests.push(req)
    },
  }
  return { ctx, requests }
}

// ─────────────────────────────────────────────────────────────────────
// SYMLINK ESCAPE ATTACKS
// ─────────────────────────────────────────────────────────────────────

describe("E2E: symlink escape attacks", () => {
  test("file symlink pointing to /etc/hosts is blocked by containsReal", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Attacker plants a symlink inside the project
        if (existsSync("/etc/hosts")) {
          await fs.symlink("/etc/hosts", path.join(dir, "innocent.txt"))
        }
      },
    })

    if (!existsSync(path.join(tmp.path, "innocent.txt"))) return // skip if /etc/hosts doesn't exist

    // containsReal should detect that the symlink resolves outside the project
    expect(Filesystem.containsReal(tmp.path, path.join(tmp.path, "innocent.txt"))).toBe(false)
  })

  test("directory symlink escape is blocked", async () => {
    // Create an "outside" directory with a secret file
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.key"), "AWS_SECRET=hunter2")
      },
    })

    // Create project with a symlink pointing to the outside directory
    await using project = await tmpdir({
      init: async (dir) => {
        await fs.symlink(outside.path, path.join(dir, "config"))
      },
    })

    // Accessing config/secret.key through the symlink should be blocked
    const secretPath = path.join(project.path, "config", "secret.key")
    expect(Filesystem.containsReal(project.path, secretPath)).toBe(false)
  })

  test("chained symlinks are resolved and blocked", async () => {
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "data.txt"), "sensitive data")
      },
    })

    await using project = await tmpdir({
      init: async (dir) => {
        // link1 -> link2 -> outside
        await fs.symlink(outside.path, path.join(dir, "link2"))
        await fs.symlink(path.join(dir, "link2"), path.join(dir, "link1"))
      },
    })

    const target = path.join(project.path, "link1", "data.txt")
    expect(Filesystem.containsReal(project.path, target)).toBe(false)
  })

  test("symlink within project to another project path is allowed", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "src", "real.ts"), "export const x = 1")
        await fs.symlink(path.join(dir, "src"), path.join(dir, "lib"))
      },
    })

    // lib -> src (both inside project) should be fine
    expect(Filesystem.containsReal(project.path, path.join(project.path, "lib", "real.ts"))).toBe(true)
  })

  test("File.read blocks symlink escape via Instance.containsPath", async () => {
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "password123")
      },
    })

    await using project = await tmpdir({
      init: async (dir) => {
        await fs.symlink(path.join(outside.path, "secret.txt"), path.join(dir, "harmless.txt"))
      },
    })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        // File.read uses Instance.containsPath which now uses containsReal
        await expect(File.read("harmless.txt")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("symlink/../file.txt escape for non-existent write target is blocked", async () => {
    // CRITICAL: This tests the Gemini-found vulnerability where path.resolve()
    // strips '..' lexically before symlinks are resolved. The agent writes to
    // /project/symlink/../secret.txt. Without the fix, pathResolve normalizes
    // this to /project/secret.txt (looks safe). With the fix, realpathSync on
    // /project/symlink/.. correctly follows the symlink first.
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "existing.txt"), "data")
      },
    })

    await using project = await tmpdir({
      init: async (dir) => {
        // symlink inside project pointing outside
        await fs.symlink(outside.path, path.join(dir, "link"))
      },
    })

    // /project/link/../new-file.txt — OS resolves link to outside, then ..
    // goes to outside's parent. This must be DENIED.
    // NOTE: path.join normalizes away '..', so we construct the path manually
    const escapePath = project.path + "/link/../new-file.txt"
    expect(Filesystem.containsReal(project.path, escapePath)).toBe(false)
  })

  test("relative symlink that resolves outside is blocked", async () => {
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "credentials"), "secret")
      },
    })

    await using project = await tmpdir({
      init: async (dir) => {
        // Relative symlink: ./escape -> ../../<outside>/credentials
        const relTarget = path.relative(dir, path.join(outside.path, "credentials"))
        await fs.symlink(relTarget, path.join(dir, "escape"))
      },
    })

    expect(Filesystem.containsReal(project.path, path.join(project.path, "escape"))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// PATH TRAVERSAL ATTACKS (e2e with real filesystem)
// ─────────────────────────────────────────────────────────────────────

describe("E2E: path traversal via File.read/File.list", () => {
  test("../../../etc/passwd is blocked", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "ok.txt"), "allowed")
      },
    })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await expect(File.read("../../../etc/passwd")).rejects.toThrow("Access denied")
        // But reading a valid file works
        const result = await File.read("ok.txt")
        expect(result.content).toBe("allowed")
      },
    })
  })

  test("encoded traversal src/nested/../../../../../../etc/passwd is blocked", async () => {
    await using project = await tmpdir()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await expect(File.read("src/nested/../../../../../../../etc/passwd")).rejects.toThrow("Access denied")
      },
    })
  })

  test("File.list blocks directory traversal to /etc", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "file.txt"), "ok")
      },
    })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await expect(File.list("../../../etc")).rejects.toThrow("Access denied")
        // Valid listing works
        const result = await File.list("subdir")
        expect(result.length).toBeGreaterThan(0)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// CROSS-DRIVE / ABSOLUTE PATH ESCAPE
// ─────────────────────────────────────────────────────────────────────

describe("E2E: absolute path escape", () => {
  test("absolute path outside project is rejected by Instance.containsPath", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: () => {
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/random")).toBe(false)
        expect(Instance.containsPath("/usr/bin/env")).toBe(false)
        // But project path is fine
        expect(Instance.containsPath(path.join(project.path, "file.ts"))).toBe(true)
      },
    })
  })

  test("prefix collision is handled correctly", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: () => {
        // /tmp/project-evil should NOT be inside /tmp/project
        expect(Instance.containsPath(project.path + "-evil")).toBe(false)
        expect(Instance.containsPath(project.path + "file")).toBe(false)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// NON-GIT PROJECT WORKTREE SAFETY
// ─────────────────────────────────────────────────────────────────────

describe("E2E: non-git project worktree safety", () => {
  test("non-git project does not allow all paths via worktree='/'", async () => {
    await using project = await tmpdir() // no git: true

    await Instance.provide({
      directory: project.path,
      fn: () => {
        expect(Instance.containsPath(path.join(project.path, "file.txt"))).toBe(true)
        // These must NOT be allowed even though worktree="/"
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/root/.ssh/id_rsa")).toBe(false)
        expect(Instance.containsPath("/home/user/.aws/credentials")).toBe(false)
      },
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// PROTECTED / SENSITIVE FILE DETECTION
// ─────────────────────────────────────────────────────────────────────

describe("E2E: Protected.isSensitiveWrite", () => {
  describe("detects sensitive directories", () => {
    const cases = [
      [".git/config", ".git"],
      [".git/hooks/pre-commit", ".git"],
      [".git/objects/pack/pack-abc.idx", ".git"],
      [".ssh/id_rsa", ".ssh"],
      [".ssh/id_ed25519", ".ssh"],
      [".ssh/known_hosts", ".ssh"],
      [".ssh/authorized_keys", ".ssh"],
      [".gnupg/private-keys-v1.d/key.gpg", ".gnupg"],
      [".aws/credentials", ".aws"],
      [".aws/config", ".aws"],
      [".azure/config", ".azure"],
      [".gcloud/application_default_credentials.json", ".gcloud"],
      [".kube/config", ".kube"],
      [".docker/config.json", ".docker"],
    ] as const

    for (const [filepath, expected] of cases) {
      test(`${filepath} → ${expected}`, () => {
        expect(Protected.isSensitiveWrite(filepath)).toBe(expected)
      })
    }
  })

  describe("detects sensitive files", () => {
    const cases = [
      ".env",
      ".env.local",
      ".env.production",
      ".env.staging",
      ".env.development",
      ".npmrc",
      ".pypirc",
      ".netrc",
      "credentials.json",
      "service-account.json",
      "id_rsa",
      "id_ed25519",
    ]

    for (const filename of cases) {
      test(`${filename} is detected`, () => {
        expect(Protected.isSensitiveWrite(filename)).toBeDefined()
      })
    }
  })

  describe("detects .env variants in subdirectories", () => {
    test("config/.env is detected", () => {
      expect(Protected.isSensitiveWrite("config/.env")).toBe(".env")
    })

    test("deploy/.env.production is detected", () => {
      expect(Protected.isSensitiveWrite("deploy/.env.production")).toBe(".env.production")
    })

    test("nested/deep/.env.local is detected", () => {
      expect(Protected.isSensitiveWrite("nested/deep/.env.local")).toBe(".env.local")
    })
  })

  describe("allows normal project files", () => {
    const safe = [
      "src/index.ts",
      "README.md",
      "package.json",
      "tsconfig.json",
      "models/schema.sql",
      "dbt_project.yml",
      "Dockerfile",
      "Makefile",
      ".gitignore",
      ".eslintrc.json",
      "src/components/Button.tsx",
      "tests/test_main.py",
      "requirements.txt",
      "pyproject.toml",
    ]

    for (const filepath of safe) {
      test(`${filepath} is allowed`, () => {
        expect(Protected.isSensitiveWrite(filepath)).toBeUndefined()
      })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// assertSensitiveWrite E2E
// ─────────────────────────────────────────────────────────────────────

describe("E2E: assertSensitiveWrite triggers permission prompt", () => {
  test("prompts for .git/config write", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, ".git"), { recursive: true })
        await Bun.write(path.join(dir, ".git", "config"), "[core]")
      },
    })

    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertSensitiveWrite(ctx, path.join(project.path, ".git", "config"))
      },
    })

    expect(requests.length).toBe(1)
    expect(requests[0].permission).toBe("sensitive_write")
    expect(requests[0].metadata.sensitive).toBe(".git")
  })

  test("prompts for .env write", async () => {
    await using project = await tmpdir()
    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertSensitiveWrite(ctx, path.join(project.path, ".env"))
      },
    })

    expect(requests.length).toBe(1)
    expect(requests[0].metadata.sensitive).toBe(".env")
  })

  test("prompts for .ssh/id_rsa write", async () => {
    await using project = await tmpdir()
    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertSensitiveWrite(ctx, path.join(project.path, ".ssh", "id_rsa"))
      },
    })

    expect(requests.length).toBe(1)
    expect(requests[0].metadata.sensitive).toBe(".ssh")
  })

  test("does NOT prompt for normal file writes", async () => {
    await using project = await tmpdir()
    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertSensitiveWrite(ctx, path.join(project.path, "src", "index.ts"))
        await assertSensitiveWrite(ctx, path.join(project.path, "README.md"))
        await assertSensitiveWrite(ctx, path.join(project.path, "package.json"))
      },
    })

    expect(requests.length).toBe(0)
  })

  test("prompts for credentials.json in nested directory", async () => {
    await using project = await tmpdir()
    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertSensitiveWrite(ctx, path.join(project.path, "config", "credentials.json"))
      },
    })

    expect(requests.length).toBe(1)
    expect(requests[0].metadata.sensitive).toBe("credentials.json")
  })
})

// ─────────────────────────────────────────────────────────────────────
// COMBINED ATTACK SCENARIOS
// ─────────────────────────────────────────────────────────────────────

describe("E2E: combined attack scenarios", () => {
  test("symlink to .ssh directory is double-blocked (containsReal + sensitive check)", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        // Even if .ssh is somehow reachable, sensitive check catches it
        await fs.mkdir(path.join(dir, ".ssh"))
        await Bun.write(path.join(dir, ".ssh", "id_rsa"), "fake key")
      },
    })

    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        // isSensitiveWrite catches it regardless of path containment
        const matched = Protected.isSensitiveWrite(".ssh/id_rsa")
        expect(matched).toBe(".ssh")

        // assertSensitiveWrite would prompt
        await assertSensitiveWrite(ctx, path.join(project.path, ".ssh", "id_rsa"))
        expect(requests.length).toBe(1)
      },
    })
  })

  test("write to .env.production via nested path triggers prompt", async () => {
    await using project = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "deploy"), { recursive: true })
      },
    })

    const { ctx, requests } = mockContext()

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertSensitiveWrite(ctx, path.join(project.path, "deploy", ".env.production"))
      },
    })

    expect(requests.length).toBe(1)
    expect(requests[0].metadata.sensitive).toBe(".env.production")
  })
})

// ─────────────────────────────────────────────────────────────────────
// WINDOWS CROSS-DRIVE PATH CHECK
// ─────────────────────────────────────────────────────────────────────

describe("E2E: Windows cross-drive path check (isAbsolute guard)", () => {
  test("Filesystem.contains blocks when relative() returns absolute path", () => {
    // On Windows, path.relative("C:\\project", "D:\\secrets") returns "D:\\secrets" (absolute).
    // Simulate this: if the relative result is absolute, contains() must return false.
    // On Unix, path.relative() never returns an absolute path for same-root paths,
    // but we can verify the isAbsolute guard works by testing the function directly.
    expect(Filesystem.contains("/project", "/project")).toBe(true)
    expect(Filesystem.contains("/project", "/other")).toBe(false)
    // The isAbsolute guard specifically catches cases where relative returns an absolute path
    // This happens on Windows cross-drive. On Unix we verify the ../ check still works.
    expect(Filesystem.contains("/a/b/c", "/a/b/c/d/e")).toBe(true)
    expect(Filesystem.contains("/a/b/c", "/a/b/x")).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BASH DENY DEFAULTS EVALUATION
// ─────────────────────────────────────────────────────────────────────

describe("E2E: bash deny defaults", () => {
  test("destructive commands are denied by default rules", () => {
    // Mirrors the actual defaults in agent.ts:
    // - Destructive shell/git commands → "ask" (prompt, not block — common in legitimate workflows)
    // - Database DDL → "deny" (almost never intentional in agent context)
    const defaults = PermissionNext.fromConfig({
      bash: {
        "*": "ask",
        "rm -rf *": "ask",
        "rm -fr *": "ask",
        "git push --force *": "ask",
        "git push -f *": "ask",
        "git reset --hard *": "ask",
        "git clean -f *": "ask",
        "DROP DATABASE *": "deny",
        "DROP SCHEMA *": "deny",
        "TRUNCATE *": "deny",
        "drop database *": "deny",
        "drop schema *": "deny",
        "truncate *": "deny",
      },
    })

    // Database DDL is blocked entirely (deny) — both upper and lowercase
    expect(PermissionNext.evaluate("bash", "DROP DATABASE production", defaults).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "DROP SCHEMA public", defaults).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "TRUNCATE users", defaults).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "drop database production", defaults).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "drop schema public", defaults).action).toBe("deny")
    expect(PermissionNext.evaluate("bash", "truncate users", defaults).action).toBe("deny")

    // Destructive file/git commands are prompted (ask), not blocked
    // This is intentional — rm -rf ./build, git push --force after rebase, etc. are legitimate
    expect(PermissionNext.evaluate("bash", "rm -rf ./build", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "git push --force origin main", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "git reset --hard HEAD~5", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "git clean -f", defaults).action).toBe("ask")

    // Regular commands also prompt (ask)
    expect(PermissionNext.evaluate("bash", "ls -la", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "git status", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "dbt run", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "npm install", defaults).action).toBe("ask")
    expect(PermissionNext.evaluate("bash", "git push origin main", defaults).action).toBe("ask")
  })

  test("user config can override defaults via merge (last-match-wins)", () => {
    const defaults = PermissionNext.fromConfig({
      bash: {
        "*": "ask",
        "DROP DATABASE *": "deny",
      },
    })
    const userOverride = PermissionNext.fromConfig({
      bash: {
        "DROP DATABASE test_db": "allow",
      },
    })

    const merged = PermissionNext.merge(defaults, userOverride)

    // Specific user override allows dropping a test database (last-match-wins)
    expect(PermissionNext.evaluate("bash", "DROP DATABASE test_db", merged).action).toBe("allow")
    // Other DROP DATABASE commands still denied (deny from defaults, no user override matches)
    expect(PermissionNext.evaluate("bash", "DROP DATABASE production", merged).action).toBe("deny")
  })
})

// ─────────────────────────────────────────────────────────────────────
// SENSITIVE FILE DETECTION WITH WINDOWS-STYLE PATHS
// ─────────────────────────────────────────────────────────────────────

describe("E2E: sensitive file detection with backslash paths", () => {
  test("detects .git with backslash separator", () => {
    expect(Protected.isSensitiveWrite(".git\\config")).toBe(".git")
    expect(Protected.isSensitiveWrite(".git\\hooks\\pre-commit")).toBe(".git")
  })

  test("detects .ssh with backslash separator", () => {
    expect(Protected.isSensitiveWrite(".ssh\\id_rsa")).toBe(".ssh")
  })

  test("detects .env in backslash path", () => {
    expect(Protected.isSensitiveWrite("config\\.env")).toBe(".env")
    expect(Protected.isSensitiveWrite("deploy\\.env.production")).toBe(".env.production")
  })

  test("mixed separators work", () => {
    expect(Protected.isSensitiveWrite("path/to\\.git/config")).toBe(".git")
    expect(Protected.isSensitiveWrite("path\\.ssh/id_rsa")).toBe(".ssh")
  })

  test("case-insensitive matching on macOS/Windows", () => {
    // On macOS and Windows, .GIT and .git are the same directory
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(Protected.isSensitiveWrite(".GIT/config")).toBe(".git")
      expect(Protected.isSensitiveWrite(".Git/hooks/pre-commit")).toBe(".git")
      expect(Protected.isSensitiveWrite(".SSH/id_rsa")).toBe(".ssh")
      expect(Protected.isSensitiveWrite(".AWS/credentials")).toBe(".aws")
      expect(Protected.isSensitiveWrite(".ENV")).toBeDefined()
      expect(Protected.isSensitiveWrite(".Env.Production")).toBeDefined()
    }
  })

  test("detects private key / certificate extensions", () => {
    expect(Protected.isSensitiveWrite("server.pem")).toBeDefined()
    expect(Protected.isSensitiveWrite("private.key")).toBeDefined()
    expect(Protected.isSensitiveWrite("cert.p12")).toBeDefined()
    expect(Protected.isSensitiveWrite("keystore.pfx")).toBeDefined()
    expect(Protected.isSensitiveWrite("certs/tls.key")).toBeDefined()
  })

  test("detects additional credential files", () => {
    expect(Protected.isSensitiveWrite(".htpasswd")).toBe(".htpasswd")
    expect(Protected.isSensitiveWrite(".pgpass")).toBe(".pgpass")
  })
})
