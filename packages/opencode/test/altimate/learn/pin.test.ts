// altimate_change - new file
import { expect, test } from "bun:test"
import { curate } from "../../../src/altimate/learn/curator"
import * as Playbook from "../../../src/altimate/learn/playbook"
import { DEFAULT_LIMITS, selectStart } from "../../../src/altimate/learn/select"
import * as Store from "../../../src/altimate/learn/store"
import { tmpdir } from "../../fixture/fixture"

const NAME = "team-playbook"

test("an approved pin stays in core and survives cap eviction; unpin permits eviction", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  const initial = Playbook.withBullets(await Store.loadCandidate(root, NAME), [
    { id: "L-0001", text: "Keep timestamps in UTC.", helpful: 0, harmful: 10 },
    { id: "L-0002", text: "Use precise decimal amounts.", helpful: 20, harmful: 0 },
  ])
  await Store.saveCandidate(root, NAME, initial)
  await Store.promote(root, NAME)
  await Store.setPinned(root, NAME, "L-0001", true)

  const selected = selectStart(await Store.loadApproved(root, NAME), "decimal amounts", {
    ...DEFAULT_LIMITS, core_lessons: 1, retrieved_lessons: 1,
  })
  expect(selected.lessons.map(({ lesson, tier }) => [lesson.id, tier])).toEqual([
    ["L-0001", "core"], ["L-0002", "retrieved"],
  ])

  const candidate = await Store.loadCandidate(root, NAME)
  const eviction = curate(Playbook.bullets(candidate), [], { maxStored: 1 })
  expect(eviction.next).toEqual([expect.objectContaining({ id: "L-0001", pinned: true })])
  expect(eviction.applied).toEqual([expect.objectContaining({ op: "REMOVE", id: "L-0002", note: "cap eviction" })])
  await Store.saveCandidate(root, NAME, Playbook.withBullets(candidate, eviction.next), eviction.applied)
  await Store.promote(root, NAME)
  expect(await Store.loadApproved(root, NAME)).toEqual([expect.objectContaining({ id: "L-0001", pinned: true })])

  await Store.setPinned(root, NAME, "L-0001", false)
  const unpinned = Playbook.bullets(await Store.loadCandidate(root, NAME))
  expect(unpinned[0].pinned).not.toBe(true)
  expect(curate(unpinned, [], { maxStored: 0 }).next).toEqual([])
})

test("pin and unpin update an existing candidate without losing its staged edits", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  const initial = Playbook.withBullets(await Store.loadCandidate(root, NAME), [
    { id: "L-0001", text: "Keep timestamps in UTC.", helpful: 0, harmful: 0 },
    { id: "L-0002", text: "Use precise decimal amounts.", helpful: 20, harmful: 0 },
  ])
  await Store.saveCandidate(root, NAME, initial)
  await Store.promote(root, NAME)
  const edited = Playbook.bullets(initial).map((bullet) => bullet.id === "L-0001"
    ? { ...bullet, text: "Preserve event timestamps in UTC." }
    : bullet)
  await Store.saveCandidate(root, NAME, Playbook.withBullets(initial, edited))

  await Store.setPinned(root, NAME, "L-0001", true)
  const pinned = Playbook.bullets(await Store.loadCandidate(root, NAME))
  expect(pinned[0]).toMatchObject({ id: "L-0001", text: "Preserve event timestamps in UTC.", pinned: true })
  expect((await Store.loadApproved(root, NAME))[0].text).toBe("Keep timestamps in UTC.")
  expect(curate(pinned, [], { maxStored: 1 }).next.map((bullet) => bullet.id)).toEqual(["L-0001"])

  await Store.setPinned(root, NAME, "L-0001", false)
  const unpinned = Playbook.bullets(await Store.loadCandidate(root, NAME))
  expect(unpinned[0]).toMatchObject({ id: "L-0001", text: "Preserve event timestamps in UTC.", pinned: false })
  expect(curate(unpinned, [], { maxStored: 1 }).next.map((bullet) => bullet.id)).toEqual(["L-0002"])
})
