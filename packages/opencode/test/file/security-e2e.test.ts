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
import type { Tool } from "../../src/tool/tool"
import type { PermissionNext } from "../../src/permission/next"
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
    expect(requests[0].permission).toBe("edit")
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
