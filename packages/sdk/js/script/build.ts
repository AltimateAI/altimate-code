#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const opencode = path.resolve(dir, "../../opencode")

await $`bun dev generate > ${dir}/openapi.json`.cwd(opencode)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

// altimate_change start — upstream_fix: re-apply the JSON-parse guard after codegen
// Re-apply the JSON-parse guard: `clean: true` above wipes src/v2/gen, so an
// edit inside client.gen.ts alone would be deleted on every release build
// (script/publish.ts runs this file in prepareReleaseFiles). A 200 whose body
// is an HTML error page from a proxy/gateway/CDN otherwise crashes with a raw
// "JSON Parse error: Unrecognized token '<'".
const jsonGuardPath = "./src/v2/gen/client/client.gen.ts"
const jsonGuardFile = Bun.file(jsonGuardPath)
const jsonGuardSource = await jsonGuardFile.text()
const jsonGuardNeedle = "          data = text ? JSON.parse(text) : {};"
const jsonGuardBlock = [
  "          // altimate_change start — upstream_fix: guard JSON parse against non-JSON (HTML) response bodies",
  "          // A 200 whose body is an HTML error page from a proxy/gateway/CDN otherwise crashes with a",
  "          // raw \"JSON Parse error: Unrecognized token '<'\". Surface an actionable error instead.",
  "          // Re-applied by script/build.ts after codegen (clean: true wipes this tree); edit it THERE.",
  "          try {",
  "            data = text ? JSON.parse(text) : {}",
  "          } catch (cause) {",
  "            throw new Error(",
  "              \`Expected a JSON response from \${request.method} \${new URL(request.url).pathname} but the body was not JSON \` +",
  "                \`(HTTP \${response.status}, content-type \${response.headers.get(\"content-type\") ?? \"unset\"}). \` +",
  "                \`This is usually a proxy or gateway error page, not the API.\`,",
  "              { cause: { parseError: cause, status: response.status, body: text.slice(0, 200) } },",
  "            )",
  "          }",
  "          // altimate_change end",
].join("\n")
const jsonGuardPatched = jsonGuardSource.replace(jsonGuardNeedle, jsonGuardBlock)
if (jsonGuardPatched === jsonGuardSource) {
  throw new Error(`json-guard patch did not apply; @hey-api/client-fetch output may have changed (${jsonGuardPath})`)
}
await Bun.write(jsonGuardPath, jsonGuardPatched)
// altimate_change end

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
