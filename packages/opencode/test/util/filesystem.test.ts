import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("filesystem", () => {
  describe("exists()", () => {
    test("returns true for existing file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      expect(await Filesystem.exists(filepath)).toBe(true)
    })

    test("returns false for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.txt")

      expect(await Filesystem.exists(filepath)).toBe(false)
    })

    test("returns true for existing directory", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "subdir")
      await fs.mkdir(dirpath)

      expect(await Filesystem.exists(dirpath)).toBe(true)
    })
  })

  describe("isDir()", () => {
    test("returns true for directory", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "testdir")
      await fs.mkdir(dirpath)

      expect(await Filesystem.isDir(dirpath)).toBe(true)
    })

    test("returns false for file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      expect(await Filesystem.isDir(filepath)).toBe(false)
    })

    test("returns false for non-existent path", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist")

      expect(await Filesystem.isDir(filepath)).toBe(false)
    })
  })

  describe("size()", () => {
    test("returns file size", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"
      await fs.writeFile(filepath, content, "utf-8")

      expect(await Filesystem.size(filepath)).toBe(content.length)
    })

    test("returns 0 for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.txt")

      expect(await Filesystem.size(filepath)).toBe(0)
    })

    test("returns directory size", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "testdir")
      await fs.mkdir(dirpath)

      // Directories have size on some systems
      const size = await Filesystem.size(dirpath)
      expect(typeof size).toBe("number")
    })
  })

  describe("readText()", () => {
    test("reads file content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"
      await fs.writeFile(filepath, content, "utf-8")

      expect(await Filesystem.readText(filepath)).toBe(content)
    })

    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.txt")

      await expect(Filesystem.readText(filepath)).rejects.toThrow()
    })

    test("reads UTF-8 content correctly", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "unicode.txt")
      const content = "Hello 世界 🌍"
      await fs.writeFile(filepath, content, "utf-8")

      expect(await Filesystem.readText(filepath)).toBe(content)
    })
  })

  describe("readJson()", () => {
    test("reads and parses JSON", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.json")
      const data = { key: "value", nested: { array: [1, 2, 3] } }
      await fs.writeFile(filepath, JSON.stringify(data), "utf-8")

      const result: typeof data = await Filesystem.readJson(filepath)
      expect(result).toEqual(data)
    })

    test("throws for invalid JSON", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "invalid.json")
      await fs.writeFile(filepath, "{ invalid json", "utf-8")

      await expect(Filesystem.readJson(filepath)).rejects.toThrow()
    })

    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.json")

      await expect(Filesystem.readJson(filepath)).rejects.toThrow()
    })

    test("returns typed data", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "typed.json")
      interface Config {
        name: string
        version: number
      }
      const data: Config = { name: "test", version: 1 }
      await fs.writeFile(filepath, JSON.stringify(data), "utf-8")

      const result = await Filesystem.readJson<Config>(filepath)
      expect(result.name).toBe("test")
      expect(result.version).toBe(1)
    })
  })

  describe("readBytes()", () => {
    test("reads file as buffer", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"
      await fs.writeFile(filepath, content, "utf-8")

      const buffer = await Filesystem.readBytes(filepath)
      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.toString("utf-8")).toBe(content)
    })

    test("throws for non-existent file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "does-not-exist.bin")

      await expect(Filesystem.readBytes(filepath)).rejects.toThrow()
    })
  })

  describe("write()", () => {
    test("writes text content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      const content = "Hello, World!"

      await Filesystem.write(filepath, content)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes buffer content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.bin")
      const content = Buffer.from([0x00, 0x01, 0x02, 0x03])

      await Filesystem.write(filepath, content)

      const read = await fs.readFile(filepath)
      expect(read).toEqual(content)
    })

    test("writes with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "protected.txt")
      const content = "secret"

      await Filesystem.write(filepath, content, 0o600)

      const stats = await fs.stat(filepath)
      // Check permissions on Unix
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    })

    test("creates parent directories", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "nested", "deep", "file.txt")
      const content = "nested content"

      await Filesystem.write(filepath, content)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })
  })

  describe("writeJson()", () => {
    test("writes JSON data", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "data.json")
      const data = { key: "value", number: 42 }

      await Filesystem.writeJson(filepath, data)

      const content = await fs.readFile(filepath, "utf-8")
      expect(JSON.parse(content)).toEqual(data)
    })

    test("writes formatted JSON", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "pretty.json")
      const data = { key: "value" }

      await Filesystem.writeJson(filepath, data)

      const content = await fs.readFile(filepath, "utf-8")
      expect(content).toContain("\n")
      expect(content).toContain("  ")
    })

    test("writes with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "config.json")
      const data = { secret: "data" }

      await Filesystem.writeJson(filepath, data, 0o600)

      const stats = await fs.stat(filepath)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    })
  })

  describe("mimeType()", () => {
    test("returns correct MIME type for JSON", () => {
      expect(Filesystem.mimeType("test.json")).toContain("application/json")
    })

    test("returns correct MIME type for JavaScript", () => {
      expect(Filesystem.mimeType("test.js")).toContain("javascript")
    })

    test("returns MIME type for TypeScript (or video/mp2t due to extension conflict)", () => {
      const mime = Filesystem.mimeType("test.ts")
      // .ts is ambiguous: TypeScript vs MPEG-2 TS video
      expect(mime === "video/mp2t" || mime === "application/typescript" || mime === "text/typescript").toBe(true)
    })

    test("returns correct MIME type for images", () => {
      expect(Filesystem.mimeType("test.png")).toContain("image/png")
      expect(Filesystem.mimeType("test.jpg")).toContain("image/jpeg")
    })

    test("returns default for unknown extension", () => {
      expect(Filesystem.mimeType("test.unknown")).toBe("application/octet-stream")
    })

    test("handles files without extension", () => {
      expect(Filesystem.mimeType("Makefile")).toBe("application/octet-stream")
    })
  })

  describe("windowsPath()", () => {
    test("converts Git Bash paths", () => {
      if (process.platform === "win32") {
        expect(Filesystem.windowsPath("/c/Users/test")).toBe("C:/Users/test")
        expect(Filesystem.windowsPath("/d/dev/project")).toBe("D:/dev/project")
      } else {
        expect(Filesystem.windowsPath("/c/Users/test")).toBe("/c/Users/test")
      }
    })

    test("converts Cygwin paths", () => {
      if (process.platform === "win32") {
        expect(Filesystem.windowsPath("/cygdrive/c/Users/test")).toBe("C:/Users/test")
        expect(Filesystem.windowsPath("/cygdrive/x/dev/project")).toBe("X:/dev/project")
      } else {
        expect(Filesystem.windowsPath("/cygdrive/c/Users/test")).toBe("/cygdrive/c/Users/test")
      }
    })

    test("converts WSL paths", () => {
      if (process.platform === "win32") {
        expect(Filesystem.windowsPath("/mnt/c/Users/test")).toBe("C:/Users/test")
        expect(Filesystem.windowsPath("/mnt/z/dev/project")).toBe("Z:/dev/project")
      } else {
        expect(Filesystem.windowsPath("/mnt/c/Users/test")).toBe("/mnt/c/Users/test")
      }
    })

    test("ignores normal Windows paths", () => {
      expect(Filesystem.windowsPath("C:/Users/test")).toBe("C:/Users/test")
      expect(Filesystem.windowsPath("D:\\dev\\project")).toBe("D:\\dev\\project")
    })
  })

  describe("writeStream()", () => {
    test("writes from Web ReadableStream", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "streamed.txt")
      const content = "Hello from stream!"
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes from Node.js Readable stream", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "node-streamed.txt")
      const content = "Hello from Node stream!"
      const { Readable } = await import("stream")
      const stream = Readable.from([content])

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes binary data from Web ReadableStream", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "binary.dat")
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff])
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(binaryData)
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      const read = await fs.readFile(filepath)
      expect(Buffer.from(read)).toEqual(Buffer.from(binaryData))
    })

    test("writes large content in chunks", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "large.txt")
      const chunks = ["chunk1", "chunk2", "chunk3", "chunk4", "chunk5"]
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(chunks.join(""))
    })

    test("creates parent directories", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "nested", "deep", "streamed.txt")
      const content = "nested stream content"
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream)

      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })

    test("writes with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "protected-stream.txt")
      const content = "secret stream content"
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream, 0o600)

      const stats = await fs.stat(filepath)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o600)
      }
    })

    test("writes executable with permissions", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "script.sh")
      const content = "#!/bin/bash\necho hello"
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content))
          controller.close()
        },
      })

      await Filesystem.writeStream(filepath, stream, 0o755)

      const stats = await fs.stat(filepath)
      if (process.platform !== "win32") {
        expect(stats.mode & 0o777).toBe(0o755)
      }
      expect(await fs.readFile(filepath, "utf-8")).toBe(content)
    })
  })

  describe("resolve()", () => {
    test("resolves slash-prefixed drive paths on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const forward = tmp.path.replaceAll("\\", "/")
      expect(Filesystem.resolve(`/${forward}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves slash-prefixed drive roots on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toUpperCase()
      expect(Filesystem.resolve(`/${drive}:`)).toBe(Filesystem.resolve(`${drive}:/`))
    })

    test("resolves Git Bash and MSYS2 paths on Windows", async () => {
      // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      const rest = tmp.path.slice(2).replaceAll("\\", "/")
      expect(Filesystem.resolve(`/${drive}${rest}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves Git Bash and MSYS2 drive roots on Windows", async () => {
      // Git Bash and MSYS2 both use /<drive> paths on Windows.
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      expect(Filesystem.resolve(`/${drive}`)).toBe(Filesystem.resolve(`${drive.toUpperCase()}:/`))
    })

    test("resolves Cygwin paths on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      const rest = tmp.path.slice(2).replaceAll("\\", "/")
      expect(Filesystem.resolve(`/cygdrive/${drive}${rest}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves Cygwin drive roots on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      expect(Filesystem.resolve(`/cygdrive/${drive}`)).toBe(Filesystem.resolve(`${drive.toUpperCase()}:/`))
    })

    test("resolves WSL mount paths on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      const rest = tmp.path.slice(2).replaceAll("\\", "/")
      expect(Filesystem.resolve(`/mnt/${drive}${rest}`)).toBe(Filesystem.normalizePath(tmp.path))
    })

    test("resolves WSL mount roots on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const drive = tmp.path[0].toLowerCase()
      expect(Filesystem.resolve(`/mnt/${drive}`)).toBe(Filesystem.resolve(`${drive.toUpperCase()}:/`))
    })

    test("resolves symlinked directory to canonical path", async () => {
      await using tmp = await tmpdir()
      const target = path.join(tmp.path, "real")
      await fs.mkdir(target)
      const link = path.join(tmp.path, "link")
      await fs.symlink(target, link)
      expect(Filesystem.resolve(link)).toBe(Filesystem.resolve(target))
    })

    test("returns unresolved path when target does not exist", async () => {
      await using tmp = await tmpdir()
      const missing = path.join(tmp.path, "does-not-exist-" + Date.now())
      const result = Filesystem.resolve(missing)
      expect(result).toBe(Filesystem.normalizePath(path.resolve(missing)))
    })

    test("throws ELOOP on symlink cycle", async () => {
      await using tmp = await tmpdir()
      const a = path.join(tmp.path, "a")
      const b = path.join(tmp.path, "b")
      await fs.symlink(b, a)
      await fs.symlink(a, b)
      expect(() => Filesystem.resolve(a)).toThrow()
    })

    // Windows: chmod(0o000) is a no-op, so EACCES cannot be triggered
    test("throws EACCES on permission-denied symlink target", async () => {
      if (process.platform === "win32") return
      if (process.getuid?.() === 0) return // skip when running as root
      await using tmp = await tmpdir()
      const dir = path.join(tmp.path, "restricted")
      await fs.mkdir(dir)
      const link = path.join(tmp.path, "link")
      await fs.symlink(dir, link)
      await fs.chmod(dir, 0o000)
      try {
        expect(() => Filesystem.resolve(path.join(link, "child"))).toThrow()
      } finally {
        await fs.chmod(dir, 0o755)
      }
    })

    // Windows: traversing through a file throws ENOENT (not ENOTDIR),
    // which resolve() catches as a fallback instead of rethrowing
    test("rethrows non-ENOENT errors", async () => {
      if (process.platform === "win32") return
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "not-a-directory")
      await fs.writeFile(file, "x")
      expect(() => Filesystem.resolve(path.join(file, "child"))).toThrow()
    })
  })

  describe("findUp()", () => {
    test("finds file at start directory", async () => {
      await using tmp = await tmpdir()
      const target = path.join(tmp.path, "AGENTS.md")
      await fs.writeFile(target, "root instructions")

      const results = await Filesystem.findUp("AGENTS.md", tmp.path)
      expect(results).toEqual([target])
    })

    test("finds files at multiple levels walking upward", async () => {
      await using tmp = await tmpdir()
      // Create nested dirs: root/a/b/c
      const dirA = path.join(tmp.path, "a")
      const dirB = path.join(tmp.path, "a", "b")
      const dirC = path.join(tmp.path, "a", "b", "c")
      await fs.mkdir(dirC, { recursive: true })

      // Place AGENTS.md at root and at a/b (but not at a or a/b/c)
      await fs.writeFile(path.join(tmp.path, "AGENTS.md"), "root")
      await fs.writeFile(path.join(dirB, "AGENTS.md"), "mid")

      // Start from a/b/c, walk up to root
      const results = await Filesystem.findUp("AGENTS.md", dirC, tmp.path)
      // Should find mid-level first (closer to start), then root
      expect(results).toEqual([
        path.join(dirB, "AGENTS.md"),
        path.join(tmp.path, "AGENTS.md"),
      ])
    })

    test("stop directory is inclusive (file at stop level is found)", async () => {
      await using tmp = await tmpdir()
      const child = path.join(tmp.path, "child")
      await fs.mkdir(child)
      await fs.writeFile(path.join(tmp.path, "AGENTS.md"), "at stop level")

      const results = await Filesystem.findUp("AGENTS.md", child, tmp.path)
      expect(results).toEqual([path.join(tmp.path, "AGENTS.md")])
    })

    test("returns empty when file does not exist anywhere", async () => {
      await using tmp = await tmpdir()
      const child = path.join(tmp.path, "nested")
      await fs.mkdir(child)

      const results = await Filesystem.findUp("AGENTS.md", child, tmp.path)
      expect(results).toEqual([])
    })

    test("does not traverse past stop directory", async () => {
      await using tmp = await tmpdir()
      const stopDir = path.join(tmp.path, "stop")
      const startDir = path.join(tmp.path, "stop", "deep")
      await fs.mkdir(startDir, { recursive: true })

      // Place file above the stop directory — should NOT be found
      await fs.writeFile(path.join(tmp.path, "AGENTS.md"), "above stop")

      const results = await Filesystem.findUp("AGENTS.md", startDir, stopDir)
      expect(results).toEqual([])
    })
  })

  describe("globUp()", () => {
    test("finds files matching glob pattern at multiple levels", async () => {
      await using tmp = await tmpdir()
      const child = path.join(tmp.path, "sub")
      await fs.mkdir(child)

      await fs.writeFile(path.join(tmp.path, "notes.md"), "root notes")
      await fs.writeFile(path.join(child, "readme.md"), "sub readme")

      const results = await Filesystem.globUp("*.md", child, tmp.path)
      // Child level first, then root level
      expect(results.length).toBe(2)
      expect(results).toContain(path.join(child, "readme.md"))
      expect(results).toContain(path.join(tmp.path, "notes.md"))
    })

    test("wildcard matches multiple files at one level", async () => {
      await using tmp = await tmpdir()
      await fs.writeFile(path.join(tmp.path, "a.md"), "a")
      await fs.writeFile(path.join(tmp.path, "b.md"), "b")
      await fs.writeFile(path.join(tmp.path, "c.txt"), "c")

      const results = await Filesystem.globUp("*.md", tmp.path, tmp.path)
      expect(results.length).toBe(2)
      expect(results.some((r) => r.endsWith("a.md"))).toBe(true)
      expect(results.some((r) => r.endsWith("b.md"))).toBe(true)
    })

    test("returns empty when no matches exist", async () => {
      await using tmp = await tmpdir()
      const results = await Filesystem.globUp("*.md", tmp.path, tmp.path)
      expect(results).toEqual([])
    })

    test("does not traverse past stop directory", async () => {
      await using tmp = await tmpdir()
      const stopDir = path.join(tmp.path, "stop")
      const startDir = path.join(tmp.path, "stop", "deep")
      await fs.mkdir(startDir, { recursive: true })

      await fs.writeFile(path.join(tmp.path, "notes.md"), "above stop")

      const results = await Filesystem.globUp("*.md", startDir, stopDir)
      expect(results).toEqual([])
    })
  })

  describe("overlaps()", () => {
    test("same path overlaps with itself", () => {
      expect(Filesystem.overlaps("/a/b", "/a/b")).toBe(true)
    })

    test("parent and child overlap", () => {
      expect(Filesystem.overlaps("/a", "/a/b")).toBe(true)
      expect(Filesystem.overlaps("/a/b", "/a")).toBe(true)
    })

    test("sibling directories do not overlap", () => {
      expect(Filesystem.overlaps("/a/b", "/a/c")).toBe(false)
    })

    test("unrelated paths do not overlap", () => {
      expect(Filesystem.overlaps("/foo", "/bar")).toBe(false)
    })

    test("path that is a string prefix but not an ancestor does not overlap", () => {
      // /foo/bar and /foo/barbaz — "barbaz" starts with "bar" but is a sibling
      expect(Filesystem.overlaps("/foo/bar", "/foo/barbaz")).toBe(false)
    })

    test("trailing slash does not affect result", () => {
      expect(Filesystem.overlaps("/a/b/", "/a/b")).toBe(true)
      expect(Filesystem.overlaps("/a/b", "/a/b/")).toBe(true)
    })

    test("root overlaps with everything", () => {
      expect(Filesystem.overlaps("/", "/any/path")).toBe(true)
      expect(Filesystem.overlaps("/any/path", "/")).toBe(true)
    })
  })
})
