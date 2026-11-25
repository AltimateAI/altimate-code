import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildCliContext } from "../../../src/altimate/plugin/altimate"
import { ModelsDev } from "../../../src/provider/models"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-mid-"))
const encoded = await buildCliContext(path.join(dir, "machine-id"))
const context = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
await ModelsDev.refresh(true)
console.log(JSON.stringify({ hasMachineId: "machine_id" in context }))
