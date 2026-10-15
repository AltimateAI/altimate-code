import type { Contributions } from "@opencode/plugin/host-contributions"

export default {
  server: [{ id: "altimate", protected: true, plugin: () => import("./src/server") }],
  tui: [{ id: "altimate", protected: true, plugin: () => import("./src/tui") }],
} satisfies Contributions
