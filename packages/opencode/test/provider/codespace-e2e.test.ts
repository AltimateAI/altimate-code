/**
 * End-to-end + adversarial tests for Codespaces / CI provider detection.
 *
 * These tests verify that machine-scoped GITHUB_TOKEN (Codespaces, GitHub Actions)
 * is NOT used to auto-enable github-models or github-copilot providers, while
 * still allowing explicit user-provided tokens.
 *
 * Official GitHub Codespace env vars (from GitHub docs):
 *   CODESPACES=true            — always set in a Codespace
 *   CODESPACE_NAME=...         — name of the Codespace
 *   GITHUB_TOKEN=ghu_...       — machine-scoped token for repo operations
 *   GITHUB_USER=...            — user who created the Codespace
 *   GITHUB_REPOSITORY=...      — owner/repo
 *   GITHUB_API_URL=...         — API URL
 *   GITHUB_SERVER_URL=...      — Server URL
 *
 * Official GitHub Actions env vars:
 *   GITHUB_ACTIONS=true        — always set in Actions
 *   CI=true                    — always set in Actions
 *   GITHUB_TOKEN=ghs_...       — machine-scoped token for the workflow
 */
import { test, expect, describe } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"
import { SessionRetry } from "../../src/session/retry"

// Machine environment vars that may leak from CI into tests.
// These must be explicitly removed when testing "clean" environments.
const MACHINE_ENV_VARS = ["CODESPACES", "CODESPACE_NAME", "GITHUB_ACTIONS", "CI", "GITHUB_TOKEN", "GH_TOKEN"]

// Helper: create a minimal config dir and run a test with given env vars.
// Removes all machine-env vars first to isolate tests from CI environment.
async function withEnv(envVars: Record<string, string>, fn: () => Promise<void>) {
  await using tmp = await tmpdir({ config: {} })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      // Remove machine-env vars that may leak from CI
      for (const k of MACHINE_ENV_VARS) {
        Env.remove(k)
      }
      // Set the test-specific env vars
      for (const [k, v] of Object.entries(envVars)) {
        Env.set(k, v)
      }
    },
    fn,
  })
}

// ─────────────────────────────────────────────────────────────
// 1. GITHUB CODESPACES ENVIRONMENT
// ─────────────────────────────────────────────────────────────

describe("Codespace provider detection", () => {
  // --- Core behavior: machine GITHUB_TOKEN should NOT auto-enable ---

  test("github-models is excluded in Codespace with only GITHUB_TOKEN", async () => {
    await withEnv(
      { CODESPACES: "true", CODESPACE_NAME: "test-codespace", GITHUB_TOKEN: "test-codespace-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
      },
    )
  })

  test("github-copilot is excluded in Codespace with only GITHUB_TOKEN", async () => {
    await withEnv(
      { CODESPACES: "true", CODESPACE_NAME: "test-codespace", GITHUB_TOKEN: "test-codespace-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-copilot"]).toBeUndefined()
      },
    )
  })

  // --- GH_TOKEN (gh CLI alias) should also be treated as machine-scoped ---

  test("github-models is excluded when only GH_TOKEN is set in Codespace", async () => {
    await withEnv(
      { CODESPACES: "true", GH_TOKEN: "test-gh-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
      },
    )
  })

  // --- Both GITHUB_TOKEN and GH_TOKEN set (both machine-scoped) ---

  test("github-models excluded when both GITHUB_TOKEN and GH_TOKEN are machine-scoped", async () => {
    await withEnv(
      { CODESPACES: "true", GITHUB_TOKEN: "test-machine-token", GH_TOKEN: "test-machine-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
      },
    )
  })

  // --- Non-Codespace: GITHUB_TOKEN works normally ---

  test("github-models is available outside Codespace with GITHUB_TOKEN", async () => {
    await withEnv(
      { GITHUB_TOKEN: "test-personal-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeDefined()
      },
    )
  })

  test("github-copilot is not blocked by machine-env detection outside Codespace", async () => {
    await withEnv(
      { GITHUB_TOKEN: "test-personal-token" },
      async () => {
        const providers = await Provider.list()
        // github-copilot has autoload: false (needs OAuth), but env detection
        // still registers it when GITHUB_TOKEN is set outside machine environments.
        // The custom loader adds model-loading options on top.
        expect(providers["github-copilot"]).toBeDefined()
        expect(providers["github-copilot"].source).toBe("env")
      },
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 2. GITHUB ACTIONS ENVIRONMENT
// ─────────────────────────────────────────────────────────────

describe("GitHub Actions provider detection", () => {
  test("github-models is excluded in GitHub Actions with GITHUB_TOKEN", async () => {
    await withEnv(
      { GITHUB_ACTIONS: "true", CI: "true", GITHUB_TOKEN: "test-actions-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
      },
    )
  })

  test("github-copilot is excluded in GitHub Actions with GITHUB_TOKEN", async () => {
    await withEnv(
      { GITHUB_ACTIONS: "true", CI: "true", GITHUB_TOKEN: "test-actions-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-copilot"]).toBeUndefined()
      },
    )
  })

  // CI=true alone (generic CI) should NOT block — only GITHUB_ACTIONS matters
  test("github-models is available in generic CI (CI=true without GITHUB_ACTIONS)", async () => {
    await withEnv(
      { CI: "true", GITHUB_TOKEN: "test-personal-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeDefined()
      },
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 3. ADVERSARIAL / EDGE CASES
// ─────────────────────────────────────────────────────────────

describe("Adversarial: Codespace edge cases", () => {
  // --- CODESPACES value variations ---

  test("CODESPACES=false does NOT trigger Codespace detection", async () => {
    // Some users might set CODESPACES=false in local dev — strict === "true" check ignores it
    await withEnv(
      { CODESPACES: "false", GITHUB_TOKEN: "test-personal-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeDefined()
      },
    )
  })

  test("CODESPACES='' (empty) does NOT trigger Codespace detection", async () => {
    await withEnv(
      { CODESPACES: "", GITHUB_TOKEN: "test-personal-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeDefined()
      },
    )
  })

  // --- Token prefix adversarial tests ---
  // Codespace tokens start with ghu_, Actions tokens with ghs_,
  // personal tokens with ghp_, fine-grained with github_pat_
  // We don't check prefixes — the env var NAME is what matters

  test("works regardless of token prefix (ghu_, ghs_, ghp_, github_pat_)", async () => {
    const prefixes = ["test-token-a", "test-token-b", "test-token-c", "test-token-d"]
    for (const token of prefixes) {
      await withEnv(
        { CODESPACES: "true", GITHUB_TOKEN: token },
        async () => {
          const providers = await Provider.list()
          expect(providers["github-models"]).toBeUndefined()
        },
      )
    }
  })

  // --- Explicit override: user sets a DIFFERENT env var ---

  test("disabled_providers can re-block even with explicit token", async () => {
    await using tmp = await tmpdir({
      config: { disabled_providers: ["github-models"] },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        for (const k of MACHINE_ENV_VARS) Env.remove(k)
        Env.set("GITHUB_TOKEN", "test-real-personal-token")
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
      },
    })
  })

  // --- Config-based override: user explicitly enables in config ---

  test("config-based provider override works even in Codespace", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          "github-models": {
            options: {
              apiKey: "test-explicit-config-token",
            },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        Env.set("CODESPACES", "true")
        Env.set("GITHUB_TOKEN", "test-machine-token")
      },
      fn: async () => {
        const providers = await Provider.list()
        // Config-based providers are loaded AFTER env-based ones (line 1162+)
        // so explicit config should still work even in Codespace
        expect(providers["github-models"]).toBeDefined()
      },
    })
  })

  // --- No env vars at all ---

  test("github-models is absent when no GitHub token env vars exist", async () => {
    await withEnv({}, async () => {
      const providers = await Provider.list()
      expect(providers["github-models"]).toBeUndefined()
    })
  })

  // --- Multiple machine environments simultaneously ---

  test("both CODESPACES and GITHUB_ACTIONS set blocks providers", async () => {
    await withEnv(
      { CODESPACES: "true", GITHUB_ACTIONS: "true", GITHUB_TOKEN: "test-machine-token" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
      },
    )
  })

  // --- Other providers unaffected ---

  test("anthropic provider is NOT blocked in Codespace", async () => {
    await withEnv(
      { CODESPACES: "true", GITHUB_TOKEN: "test-machine-token", ANTHROPIC_API_KEY: "test-anthropic-key" },
      async () => {
        const providers = await Provider.list()
        expect(providers["anthropic"]).toBeDefined()
      },
    )
  })

  test("openai provider is NOT blocked in Codespace", async () => {
    await withEnv(
      { CODESPACES: "true", GITHUB_TOKEN: "test-machine-token", OPENAI_API_KEY: "test-openai-key" },
      async () => {
        const providers = await Provider.list()
        expect(providers["openai"]).toBeDefined()
      },
    )
  })
})

// ─────────────────────────────────────────────────────────────
// 4. RETRY LIMITS
// ─────────────────────────────────────────────────────────────

describe("Retry limits", () => {
  test("RETRY_MAX_ATTEMPTS is exactly 5", () => {
    expect(SessionRetry.RETRY_MAX_ATTEMPTS).toBe(5)
  })

  test("delay at max attempts is bounded", () => {
    // At attempt 5 (the last allowed retry), delay should be bounded
    const delay = SessionRetry.delay(SessionRetry.RETRY_MAX_ATTEMPTS)
    expect(delay).toBeLessThanOrEqual(SessionRetry.RETRY_MAX_DELAY_NO_HEADERS)
    expect(delay).toBeGreaterThan(0)
  })

  test("delay with retry-after header is respected even at max attempts", () => {
    const error = {
      name: "APIError",
      data: {
        message: "rate limited",
        isRetryable: true,
        responseHeaders: { "retry-after": "60" },
      },
    } as any
    const delay = SessionRetry.delay(SessionRetry.RETRY_MAX_ATTEMPTS, error)
    expect(delay).toBe(60000) // 60 seconds in ms
  })
})

// ─────────────────────────────────────────────────────────────
// 5. ADVERSARIAL: RETRY BEHAVIOR
// ─────────────────────────────────────────────────────────────

describe("Adversarial: retry edge cases", () => {
  test("retryable detects GitHub scraping rate limit message", () => {
    // This is the exact error format from the screenshot
    const error = {
      name: "UnknownError",
      data: {
        message: JSON.stringify({
          type: "error",
          error: { type: "too_many_requests" },
        }),
      },
    } as any
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("retryable detects rate_limit code", () => {
    const error = {
      name: "UnknownError",
      data: {
        message: JSON.stringify({
          type: "error",
          error: { code: "rate_limit_exceeded" },
        }),
      },
    } as any
    expect(SessionRetry.retryable(error)).toBe("Rate Limited")
  })

  test("retryable returns undefined for non-retryable errors", () => {
    const error = {
      name: "UnknownError",
      data: { message: "not json" },
    } as any
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retryable handles malformed JSON gracefully", () => {
    const error = {
      name: "UnknownError",
      data: { message: "{broken json" },
    } as any
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retryable handles null/undefined data gracefully", () => {
    const error = { name: "UnknownError", data: {} } as any
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("delay never returns negative or zero for positive attempts", () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      expect(SessionRetry.delay(attempt)).toBeGreaterThan(0)
    }
  })

  test("delay is monotonically increasing up to cap", () => {
    let prev = 0
    for (let attempt = 1; attempt <= 10; attempt++) {
      const d = SessionRetry.delay(attempt)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
  })
})

// ─────────────────────────────────────────────────────────────
// 6. FULL CODESPACE ENVIRONMENT SIMULATION
// ─────────────────────────────────────────────────────────────

describe("Full Codespace environment simulation", () => {
  // Simulate ALL env vars that a real Codespace sets
  const FULL_CODESPACE_ENV = {
    CODESPACES: "true",
    CODESPACE_NAME: "user-literate-space-parakeet-abc123",
    GITHUB_TOKEN: "test-full-codespace-token",
    GITHUB_USER: "testuser",
    GITHUB_REPOSITORY: "testorg/test-repo",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
    GIT_COMMITTER_EMAIL: "testuser@users.noreply.github.com",
    GIT_COMMITTER_NAME: "testuser",
  }

  test("full Codespace env: github-models is excluded", async () => {
    await withEnv(FULL_CODESPACE_ENV, async () => {
      const providers = await Provider.list()
      expect(providers["github-models"]).toBeUndefined()
    })
  })

  test("full Codespace env: github-copilot is excluded", async () => {
    await withEnv(FULL_CODESPACE_ENV, async () => {
      const providers = await Provider.list()
      expect(providers["github-copilot"]).toBeUndefined()
    })
  })

  test("full Codespace env: opencode free tier still works", async () => {
    await withEnv(FULL_CODESPACE_ENV, async () => {
      const providers = await Provider.list()
      // The opencode provider should still be available (it auto-enables with public key)
      expect(providers["opencode"]).toBeDefined()
    })
  })

  test("full Codespace env + explicit Anthropic key: both work", async () => {
    await withEnv(
      { ...FULL_CODESPACE_ENV, ANTHROPIC_API_KEY: "test-anthropic-key" },
      async () => {
        const providers = await Provider.list()
        expect(providers["github-models"]).toBeUndefined()
        expect(providers["anthropic"]).toBeDefined()
        expect(providers["opencode"]).toBeDefined()
      },
    )
  })
})
