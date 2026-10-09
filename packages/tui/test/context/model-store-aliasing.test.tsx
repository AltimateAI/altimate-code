// Opening a conversation hands the model store that conversation's recorded model, an object owned
// by the sync store's message record. The model store must never write into it: a Solid store keeps
// the first object set at a path by reference and merges later sets into it, so storing the record
// itself let opening a second conversation rewrite the first one's recorded model.
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { directory } from "../fixture/tui-sdk"
import { BASE, OWN, mount, waitUntil } from "../fixture/local-model"

const SESSION_A = "ses_alias_a"
const SESSION_B = "ses_alias_b"

function userMessage(sessionID: string, id: string, model: { providerID: string; modelID: string }) {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${id}`,
      type: "message.updated",
      properties: {
        sessionID,
        info: { id, sessionID, role: "user", agent: "build", model: { ...model }, time: { created: 1 } },
      },
    },
  } as never
}

test("switching conversations keeps each conversation's recorded model and restores it on return", async () => {
  const originalStateHome = process.env.OPENCODE_TEST_STATE_HOME
  await using isolatedState = await tmpdir()
  process.env.OPENCODE_TEST_STATE_HOME = isolatedState.path
  const { local, sync, emit, cleanup } = await mount()
  try {
    await waitUntil(() => local.model.ready)
    emit(userMessage(SESSION_A, "msg_a", OWN))
    emit(userMessage(SESSION_B, "msg_b", BASE))
    await waitUntil(() => !!sync.data.message[SESSION_A]?.[0] && !!sync.data.message[SESSION_B]?.[0])
    const recordedA = () => sync.data.message[SESSION_A]![0] as { model: { providerID: string; modelID: string } }
    const recordedB = () => sync.data.message[SESSION_B]![0] as { model: { providerID: string; modelID: string } }

    // Exactly what the prompt does on opening a conversation: restore its last user message's model.
    local.model.restoreSession(recordedA().model)   // open conversation A
    local.model.restoreSession(recordedB().model)   // open conversation B

    // Back to conversation A: the prompt restores A's recorded model again.
    local.model.restoreSession(recordedA().model)
    expect({ ...recordedA().model }).toMatchObject(OWN) // A was recorded on OWN
    expect(local.model.current()).toMatchObject(OWN)
  } finally {
    await cleanup()
    if (originalStateHome === undefined) delete process.env.OPENCODE_TEST_STATE_HOME
    else process.env.OPENCODE_TEST_STATE_HOME = originalStateHome
  }
})
