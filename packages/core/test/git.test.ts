import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Git, localGitEnv } from "@opencode-ai/core/git"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { branch, commit, gitRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Git.defaultLayer)

describe("Git", () => {
  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = path.join(fixture.root, "checkout")
        const result = yield* git.clone({ remote: fixture.remote, target })

        expect(result.exitCode).toBe(0)
        expect(yield* git.origin(target)).toBe(fixture.remote)
        expect(yield* git.head(target)).toBeString()
        expect(yield* git.branch(target)).toBe("main")
        expect(yield* git.remoteHead(target)).toBe("origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("offline rejects clone and fetch while preserving local metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = path.join(fixture.root, "checkout")
        expect((yield* git.clone({ remote: fixture.remote, target })).exitCode).toBe(0)
        const previous = process.env.ALTIMATE_OFFLINE
        process.env.ALTIMATE_OFFLINE = "1"
        try {
          expect(yield* git.head(target)).toBeString()
          const rejected = path.join(fixture.root, "rejected")
          expect((yield* git.clone({ remote: fixture.remote, target: rejected })).stderr).toContain("online run")
          expect((yield* git.fetch(target)).stderr).toContain("online run")
          expect((yield* git.fetchBranch(target, "main")).stderr).toContain("online run")
        } finally {
          if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
          else process.env.ALTIMATE_OFFLINE = previous
        }
      }),
    ),
  )

  // Offline Git must not download LFS objects, but objects already in the local cache still check out.
  const hasLfs = Bun.spawnSync(["git", "lfs", "version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  const liveIfLfs = hasLfs ? it.live : it.live.skip
  liveIfLfs("offline checkout keeps cached LFS content and refuses uncached objects", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "offline-lfs-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const gitIn = (args: string[], env?: Record<string, string>) =>
        Bun.spawnSync(["git", ...args], { cwd: tmp, env: { ...process.env, ...env }, stderr: "pipe", stdout: "pipe" })
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "t"],
        ["lfs", "install", "--local"],
        ["lfs", "track", "*.bin"],
        ["remote", "add", "origin", "https://example.invalid/repo.git"],
      ]) expect(gitIn(args).exitCode).toBe(0)
      yield* Effect.promise(() => fs.writeFile(path.join(tmp, "a.bin"), "cached-content"))
      expect(gitIn(["add", ".gitattributes", "a.bin"]).exitCode).toBe(0)
      expect(gitIn(["commit", "-qm", "lfs"]).exitCode).toBe(0)

      const previous = process.env.ALTIMATE_OFFLINE
      process.env.ALTIMATE_OFFLINE = "1"
      try {
        const env = localGitEnv()!
        yield* Effect.promise(() => fs.rm(path.join(tmp, "a.bin")))
        expect(gitIn(["checkout", "--", "a.bin"], env).exitCode).toBe(0)
        expect(yield* Effect.promise(() => fs.readFile(path.join(tmp, "a.bin"), "utf8"))).toBe("cached-content")

        yield* Effect.promise(() => fs.rm(path.join(tmp, "a.bin")))
        yield* Effect.promise(() => fs.rm(path.join(tmp, ".git", "lfs", "objects"), { recursive: true, force: true }))
        const missing = gitIn(["checkout", "--", "a.bin"], env)
        expect(missing.exitCode).not.toBe(0)
        expect(missing.stderr.toString()).toContain("127.0.0.1:9")
      } finally {
        if (previous === undefined) delete process.env.ALTIMATE_OFFLINE
        else process.env.ALTIMATE_OFFLINE = previous
      }
    }),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = path.join(fixture.root, "checkout")
        yield* git.clone({ remote: fixture.remote, target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        expect((yield* git.fetch(target)).exitCode).toBe(0)
        expect((yield* git.reset(target, "origin/main")).exitCode).toBe(0)
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        expect((yield* git.fetchBranch(target, "feature/docs")).exitCode).toBe(0)
        expect((yield* git.checkout(target, "feature/docs")).exitCode).toBe(0)
        expect((yield* git.reset(target, "origin/feature/docs")).exitCode).toBe(0)
        expect(yield* git.branch(target)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = { directory, store: AbsolutePath.make(path.join(directory, ".git")) }

      yield* git.worktreeCreate({ repo, directory: worktree })

      expect((yield* git.worktreeList(repo)).some((entry) => entry.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.find(worktree)
      expect(linked?.directory).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.store).toBe(repo.store)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktreeRemove({ repo: linked, directory: worktree, force: false })
      expect((yield* git.worktreeList(repo)).some((entry) => entry.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})
