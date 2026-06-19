import os from "os"
import path from "path"
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: process.env.OPENCODE_DB_URL || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
  },
})