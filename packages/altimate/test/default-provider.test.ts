import { expect, test } from "bun:test"
import { join } from "node:path"
import { gateway } from "../src/gateway"
import { createFixture, createHost } from "./lib/host"

const tenantFile = (dir: string) => join(dir, "altimate.json")

async function withTenant(dir: string) {
  await Bun.write(
    tenantFile(dir),
    JSON.stringify({ altimateUrl: "https://tenant.example.invalid", altimateInstanceName: "team", altimateApiKey: "k" }),
  )
}

function plugin(dir: string) {
  return gateway({
    credentialsPath: tenantFile(dir),
    baseCredentialsPath: join(dir, "absent-base.json"),
    env: {},
  })
}

async function defaultModel(dir: string, model: string | null) {
  await using host = await createHost({ directory: dir, altimate: false, model, plugins: [plugin(dir)] })
  return (await host.opencode.model.default({ location: { directory: dir } })).data
}

test("with tenant credentials and no configured model, the default is the Altimate gateway model", async () => {
  await using fixture = await createFixture()
  await withTenant(fixture.path)
  expect(await defaultModel(fixture.path, null)).toMatchObject({
    providerID: "altimate-backend",
    id: "altimate-default",
  })
}, 30_000)

test("an explicit user model wins over the Altimate default", async () => {
  await using fixture = await createFixture()
  await withTenant(fixture.path)
  const model = await defaultModel(fixture.path, "scripted/scripted")
  expect(model).toMatchObject({ providerID: "scripted" })
}, 30_000)

test("without credentials the default does not select the gateway and startup succeeds", async () => {
  await using fixture = await createFixture()
  const model = await defaultModel(fixture.path, null)
  expect(model?.providerID).not.toBe("altimate-backend")
  expect(model?.providerID).not.toBe("altimate-free")
}, 30_000)

test("OpenCode's anonymous free models are not offered by default", async () => {
  await using fixture = await createFixture()
  await using host = await createHost({ directory: fixture.path, model: null })
  const models = (await host.opencode.model.list({ location: { directory: fixture.path } })).data
  expect(models.filter((model) => model.providerID === "opencode")).toEqual([])
}, 30_000)
