// A stale keyless-Zen entry at the front of `recent` is shown as Altimate Base by
// `currentModel()`. `cycle()` must resolve that entry the same way, or the repaired current model
// is missing from its order and cycling does nothing.
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { OWN, STALE_ZEN, BASE, mount, waitUntil } from "../fixture/local-model"

test("cycle() still moves off an explicitly chosen keyless-Zen model", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  // The agent's own configured model is explicit, so `currentModel()` keeps it as Zen.
  const { local, cleanup } = await mount({ ...STALE_ZEN })
  try {
    await waitUntil(() => local.model.ready)
    await waitUntil(() => local.model.current()?.providerID === STALE_ZEN.providerID)
    await Bun.sleep(100)
    expect(local.model.current()?.providerID).toBe(STALE_ZEN.providerID)
    local.model.cycle(1)
    await waitUntil(() => local.model.current()?.modelID === OWN.modelID)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

test("cycle() moves off a Base model that replaced a stale keyless-Zen recent", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, cleanup } = await mount()
  try {
    // A session last run on keyless Zen is restored as Base: a repaired, non-explicit selection.
    await waitUntil(() => local.model.ready)
    local.model.restoreSession({ ...STALE_ZEN })
    await waitUntil(() => local.model.current()?.modelID === BASE.modelID)
    local.model.cycle(1)
    await waitUntil(() => local.model.current()?.modelID === OWN.modelID)
    local.model.cycle(1)
    // Back to Base, never onto the keyless-Zen entry the order was built from.
    await waitUntil(() => local.model.current()?.modelID === BASE.modelID)
    expect(local.model.current()?.providerID).toBe(BASE.providerID)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

test("an explicit keyless-Zen selection, as --model hands it over, is not replaced by Base", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, cleanup } = await mount()
  try {
    await waitUntil(() => local.model.ready)
    // The same call app.tsx makes for `--model`, and the pickers make for a deliberate choice.
    local.model.set({ ...STALE_ZEN }, { recent: true })
    await waitUntil(() => local.model.current()?.providerID === STALE_ZEN.providerID)
    await Bun.sleep(100)
    expect(local.model.current()).toMatchObject(STALE_ZEN)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

test("an explicit keyless-Zen pick survives switching conversations and back", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, cleanup } = await mount()
  try {
    await waitUntil(() => local.model.ready)
    local.model.set({ ...STALE_ZEN }, { recent: true })
    await waitUntil(() => local.model.current()?.providerID === STALE_ZEN.providerID)
    // Open another conversation recorded on the user's own model, then return to the Zen one.
    expect(local.model.restoreSession({ ...OWN })).toMatchObject(OWN)
    await waitUntil(() => local.model.current()?.modelID === OWN.modelID)
    expect(local.model.restoreSession({ ...STALE_ZEN })).toMatchObject(STALE_ZEN)
    await waitUntil(() => local.model.current()?.providerID === STALE_ZEN.providerID)
    expect(local.model.current()).toMatchObject(STALE_ZEN)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

test("an explicit keyless-Zen pick carries to another agent without its own model", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, cleanup } = await mount()
  try {
    await waitUntil(() => local.model.ready)
    local.model.set({ ...STALE_ZEN }, { recent: true })
    await waitUntil(() => local.model.current()?.providerID === STALE_ZEN.providerID)
    const from = local.agent.current()?.name
    local.agent.move(1)
    await waitUntil(() => local.agent.current()?.name !== from)
    // The other agent has no pick of its own, so it inherits the most recent one: the Zen choice.
    await Bun.sleep(100)
    expect(local.model.current()).toMatchObject(STALE_ZEN)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})

