// altimate_change - new file
import { expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { bootstrap } from "../../../src/cli/bootstrap"
import { Config } from "../../../src/config/config"

test("local run bootstrap preserves the instance context for learning config", async () => {
  await using dir = await tmpdir({ git: true, config: { learn: { capture: true, auto_reflect: true } } })
  const learn = await bootstrap(dir.path, async () => (await Config.get()).learn)
  expect(learn).toMatchObject({ capture: true, auto_reflect: true })
})
