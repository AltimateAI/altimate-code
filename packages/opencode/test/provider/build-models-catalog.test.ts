import { describe, expect, test } from "bun:test"
import path from "node:path"
import { assertUsableCatalog, catalogDiagnosticOrigin, formatCatalogSummary } from "../../script/models-catalog"

const diagnosticOrigin = "https://catalog.example.com"

type MutableCatalog = Record<
  string,
  {
    id: unknown
    env?: unknown
    api?: unknown
    npm?: unknown
    models: Record<
      string,
      {
        id: unknown
        provider?: unknown
        limit: Record<string, unknown>
        modalities: Record<string, unknown>
      }
    >
  }
>

function customCatalog(): MutableCatalog {
  return {
    acme: {
      id: "acme",
      env: ["ACME_API_KEY"],
      api: "https://api.example.com/v1",
      npm: "@ai-sdk/openai-compatible",
      models: {
        "acme-one": {
          id: "acme-one",
          limit: { context: 128_000, input: 120_000, output: 8_000 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  }
}

function strictCatalog(): MutableCatalog {
  return Object.fromEntries(
    ["anthropic", "openai", "google", ...Array.from({ length: 47 }, (_, index) => `provider-${index}`)].map(
      (provider) => {
        const model = `${provider}-model`
        return [
          provider,
          {
            id: provider,
            models: {
              [model]: {
                id: model,
                limit: { context: 128_000, output: 8_000 },
                modalities: {},
              },
            },
          },
        ]
      },
    ),
  )
}

describe("build models catalog validation", () => {
  test("accepts a small custom catalog without applying the release floor", () => {
    const summary = assertUsableCatalog(JSON.stringify(customCatalog()), diagnosticOrigin, false)

    expect(summary).toEqual({
      providerCount: 1,
      requiredModelCounts: { anthropic: 0, openai: 0, google: 0 },
      strict: false,
    })
    expect(formatCatalogSummary(summary, diagnosticOrigin)).toBe(
      "models.dev catalog from https://catalog.example.com: 1 providers (custom catalog, size floor not applied)",
    )
  })

  test("accepts the release fixture in strict mode", async () => {
    const fixture = await Bun.file(new URL("../tool/fixtures/models-api.json", import.meta.url)).text()
    const summary = assertUsableCatalog(fixture, "release fixture", true)

    expect(summary.providerCount).toBeGreaterThanOrEqual(50)
    expect(summary.requiredModelCounts.anthropic).toBeGreaterThan(0)
    expect(summary.requiredModelCounts.openai).toBeGreaterThan(0)
    expect(summary.requiredModelCounts.google).toBeGreaterThan(0)
  })

  for (const [label, body, message] of [
    ["non-JSON", "<html>bad gateway</html>", "is not valid JSON"],
    ["an array", "[]", "is not a provider object"],
    ["an empty object", "{}", "is empty"],
    ["an object-shaped error", '{"error":"bad gateway"}', "error (not an object)"],
  ] as const) {
    test(`rejects ${label}`, () => {
      expect(() => assertUsableCatalog(body, diagnosticOrigin, false)).toThrow(message)
    })
  }

  const malformedCases: ReadonlyArray<{
    label: string
    mutate: (catalog: MutableCatalog) => void
    message: string
  }> = [
    {
      label: "a provider ID that differs from its catalog key",
      mutate: (catalog) => (catalog.acme.id = "other"),
      message: "acme (id does not match catalog key)",
    },
    {
      label: "a model without a string ID",
      mutate: (catalog) => (catalog.acme.models["acme-one"].id = 42),
      message: "acme/acme-one (no non-empty string id)",
    },
    {
      label: "a model ID that differs from its catalog key",
      mutate: (catalog) => (catalog.acme.models["acme-one"].id = "other"),
      message: "acme/acme-one (id does not match catalog key)",
    },
    {
      label: "a non-array provider env",
      mutate: (catalog) => (catalog.acme.env = "ACME_API_KEY"),
      message: "acme.env is not a string array",
    },
    {
      label: "a provider env containing a non-string",
      mutate: (catalog) => (catalog.acme.env = [42]),
      message: "acme.env is not a string array",
    },
    {
      label: "a non-string provider API URL",
      mutate: (catalog) => (catalog.acme.api = 42),
      message: "acme.api is not a string",
    },
    {
      label: "an empty provider npm package",
      mutate: (catalog) => (catalog.acme.npm = ""),
      message: "acme.npm is empty",
    },
    {
      label: "a non-string model provider API URL",
      mutate: (catalog) => (catalog.acme.models["acme-one"].provider = { api: 42 }),
      message: "acme/acme-one.provider.api is not a string",
    },
    {
      label: "a model without an output limit",
      mutate: (catalog) => delete catalog.acme.models["acme-one"].limit.output,
      message: "acme/acme-one (limit.output is not a number)",
    },
    {
      label: "a non-numeric optional input limit",
      mutate: (catalog) => (catalog.acme.models["acme-one"].limit.input = "many"),
      message: "acme/acme-one (limit.input is not a number)",
    },
    {
      label: "non-array model input modalities",
      mutate: (catalog) => (catalog.acme.models["acme-one"].modalities.input = {}),
      message: "acme/acme-one.modalities.input is not a string array",
    },
    {
      label: "model output modalities containing a non-string",
      mutate: (catalog) => (catalog.acme.models["acme-one"].modalities.output = [42]),
      message: "acme/acme-one.modalities.output is not a string array",
    },
  ]

  for (const { label, mutate, message } of malformedCases) {
    test(`rejects ${label} in every mode`, () => {
      const catalog = customCatalog()
      mutate(catalog)
      const body = JSON.stringify(catalog)

      expect(() => assertUsableCatalog(body, diagnosticOrigin, false)).toThrow(message)
      expect(() => assertUsableCatalog(body, diagnosticOrigin, true)).toThrow(message)
    })
  }

  test("applies the provider floor only in strict mode", () => {
    const body = JSON.stringify(customCatalog())
    expect(() => assertUsableCatalog(body, diagnosticOrigin, true)).toThrow("has only 1 providers")
    expect(() => assertUsableCatalog(body, diagnosticOrigin, false)).not.toThrow()
  })

  test("requires every major provider to carry models in strict mode", () => {
    const catalog = strictCatalog()
    catalog.openai.models = {}

    expect(() => assertUsableCatalog(JSON.stringify(catalog), "release fixture", true)).toThrow(
      "has no usable models for: openai",
    )
  })
})

describe("build models catalog diagnostics", () => {
  test("keeps only the URL origin", () => {
    const source =
      "https://catalog-user:catalog-password@catalog.example.com:8443/private/token/api.json?key=query-secret#hash-secret"
    const diagnostic = catalogDiagnosticOrigin(source, "url")

    expect(diagnostic).toBe("https://catalog.example.com:8443")
    for (const secret of ["catalog-user", "catalog-password", "private", "token", "query-secret", "hash-secret"])
      expect(diagnostic).not.toContain(secret)
  })

  test("does not expose local catalog paths", () => {
    expect(catalogDiagnosticOrigin("/private/catalog/token/models.json", "file")).toBe("local catalog file")
  })

  test("build fetch failures do not print URL secrets or a native cause", async () => {
    const packageDir = path.resolve(import.meta.dir, "../..")
    const source = "http://catalog-user:catalog-password@127.0.0.1:9/private-token"
    const proc = Bun.spawn([process.execPath, "run", "script/build.ts", "--single", "--skip-install"], {
      cwd: packageDir,
      env: {
        ...process.env,
        MODELS_DEV_API_JSON: "",
        OPENCODE_MODELS_URL: source,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = stdout + stderr

    expect(exitCode).not.toBe(0)
    expect(output).toContain("models.dev fetch from http://127.0.0.1:9 failed")
    for (const secret of ["catalog-user", "catalog-password", "private-token"]) expect(output).not.toContain(secret)
    expect(output).not.toContain("cause:")
  })
})
