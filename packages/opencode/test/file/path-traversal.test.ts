import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util/filesystem"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { Protected } from "../../src/file/protected"
import { tmpdir } from "../fixture/fixture"

describe("Filesystem.contains", () => {
  test("allows paths within project", () => {
    expect(Filesystem.contains("/project", "/project/src")).toBe(true)
    expect(Filesystem.contains("/project", "/project/src/file.ts")).toBe(true)
    expect(Filesystem.contains("/project", "/project")).toBe(true)
  })

  test("blocks ../ traversal", () => {
    expect(Filesystem.contains("/project", "/project/../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/project/src/../../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
  })

  test("blocks absolute paths outside project", () => {
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
    expect(Filesystem.contains("/project", "/tmp/file")).toBe(false)
    expect(Filesystem.contains("/home/user/project", "/home/user/other")).toBe(false)
  })

  test("handles prefix collision edge cases", () => {
    expect(Filesystem.contains("/project", "/project-other/file")).toBe(false)
    expect(Filesystem.contains("/project", "/projectfile")).toBe(false)
  })
})

describe("Filesystem.containsReal", () => {
  test("allows paths within project (no symlinks)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "content")
      },
    })
    expect(Filesystem.containsReal(tmp.path, path.join(tmp.path, "file.txt"))).toBe(true)
  })

  test("blocks symlink pointing outside project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create a symlink inside project that points to /tmp (outside project)
        await fs.symlink("/tmp", path.join(dir, "escape-link"))
      },
    })
    // The symlink target resolves to /tmp, which is outside the project
    expect(Filesystem.containsReal(tmp.path, path.join(tmp.path, "escape-link"))).toBe(false)
  })

  test("blocks directory symlink escape", async () => {
    await using outside = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "secret data")
      },
    })
    await using project = await tmpdir({
      init: async (dir) => {
        // Symlink inside project pointing to a directory outside
        await fs.symlink(outside.path, path.join(dir, "linked-dir"))
      },
    })
    // Path through symlink should be rejected
    expect(Filesystem.containsReal(project.path, path.join(project.path, "linked-dir", "secret.txt"))).toBe(false)
  })

  test("allows symlink within project pointing to another project path", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "real", "file.txt"), "content")
        await fs.symlink(path.join(dir, "real"), path.join(dir, "link-to-real"))
      },
    })
    // Symlink target is still within the project — should be allowed
    expect(Filesystem.containsReal(tmp.path, path.join(tmp.path, "link-to-real", "file.txt"))).toBe(true)
  })

  test("allows write to non-existent file in valid directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "src"), { recursive: true })
      },
    })
    // File doesn't exist yet but parent dir is valid and inside project
    expect(Filesystem.containsReal(tmp.path, path.join(tmp.path, "src", "new-file.ts"))).toBe(true)
  })

  test("falls back to lexical check when parent does not exist", () => {
    // When the parent dir itself doesn't exist, containsReal falls back to lexical contains()
    expect(Filesystem.containsReal("/nonexistent-project-dir", "/nonexistent-project-dir/sub/file.txt")).toBe(true)
    // But escape attempts still fail even in fallback mode
    expect(Filesystem.containsReal("/nonexistent-project-dir", "/etc/passwd")).toBe(false)
  })
})

describe("Protected.isSensitiveWrite", () => {
  test("detects .git directory", () => {
    expect(Protected.isSensitiveWrite(".git/config")).toBe(".git")
    expect(Protected.isSensitiveWrite(".git/hooks/pre-commit")).toBe(".git")
    expect(Protected.isSensitiveWrite("subdir/.git/config")).toBe(".git")
  })

  test("detects .ssh directory", () => {
    expect(Protected.isSensitiveWrite(".ssh/id_rsa")).toBe(".ssh")
    expect(Protected.isSensitiveWrite(".ssh/authorized_keys")).toBe(".ssh")
  })

  test("detects .aws directory", () => {
    expect(Protected.isSensitiveWrite(".aws/credentials")).toBe(".aws")
  })

  test("detects .env files", () => {
    expect(Protected.isSensitiveWrite(".env")).toBe(".env")
    expect(Protected.isSensitiveWrite(".env.local")).toBe(".env.local")
    expect(Protected.isSensitiveWrite(".env.production")).toBe(".env.production")
    expect(Protected.isSensitiveWrite("config/.env")).toBe(".env")
  })

  test("detects credential files", () => {
    expect(Protected.isSensitiveWrite("credentials.json")).toBe("credentials.json")
    expect(Protected.isSensitiveWrite("service-account.json")).toBe("service-account.json")
  })

  test("allows normal files", () => {
    expect(Protected.isSensitiveWrite("src/index.ts")).toBeUndefined()
    expect(Protected.isSensitiveWrite("README.md")).toBeUndefined()
    expect(Protected.isSensitiveWrite("package.json")).toBeUndefined()
    expect(Protected.isSensitiveWrite("models/schema.sql")).toBeUndefined()
  })
})

/*
 * Integration tests for File.read() and File.list() path traversal protection.
 *
 * These tests verify the HTTP API code path is protected. The HTTP endpoints
 * in server.ts (GET /file/content, GET /file) call File.read()/File.list()
 * directly - they do NOT go through ReadTool or the agent permission layer.
 *
 * This is a SEPARATE code path from ReadTool, which has its own checks.
 */
describe("File.read path traversal protection", () => {
  test("rejects ../ traversal attempting to read /etc/passwd", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "allowed.txt"), "allowed content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(File.read("../../../etc/passwd")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("rejects deeply nested traversal", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(File.read("src/nested/../../../../../../../etc/passwd")).rejects.toThrow(
          "Access denied: path escapes project directory",
        )
      },
    })
  })

  test("allows valid paths within project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "valid.txt"), "valid content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.read("valid.txt")
        expect(result.content).toBe("valid content")
      },
    })
  })
})

describe("File.list path traversal protection", () => {
  test("rejects ../ traversal attempting to list /etc", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(File.list("../../../etc")).rejects.toThrow("Access denied: path escapes project directory")
      },
    })
  })

  test("allows valid subdirectory listing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "file.txt"), "content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.list("subdir")
        expect(Array.isArray(result)).toBe(true)
      },
    })
  })
})

describe("Instance.containsPath", () => {
  test("returns true for path inside directory", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "foo.txt"))).toBe(true)
        expect(Instance.containsPath(path.join(tmp.path, "src", "file.ts"))).toBe(true)
      },
    })
  })

  test("returns true for path inside worktree but outside directory (monorepo subdirectory scenario)", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: () => {
        // .opencode at worktree root, but we're running from packages/lib
        expect(Instance.containsPath(path.join(tmp.path, ".opencode", "state"))).toBe(true)
        // sibling package should also be accessible
        expect(Instance.containsPath(path.join(tmp.path, "packages", "other", "file.ts"))).toBe(true)
        // worktree root itself
        expect(Instance.containsPath(tmp.path)).toBe(true)
      },
    })
  })

  test("returns false for path outside both directory and worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other-project")).toBe(false)
      },
    })
  })

  test("returns false for path with .. escaping worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "..", "escape.txt"))).toBe(false)
      },
    })
  })

  test("handles directory === worktree (running from repo root)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.directory).toBe(Instance.worktree)
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
      },
    })
  })

  test("non-git project does not allow arbitrary paths via worktree='/'", async () => {
    await using tmp = await tmpdir() // no git: true

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        // worktree is "/" for non-git projects, but containsPath should NOT allow all paths
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other")).toBe(false)
      },
    })
  })
})
