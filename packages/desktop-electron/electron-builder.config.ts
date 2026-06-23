import type { Configuration } from "electron-builder"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "altimate-code-electron-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    },
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Altimate Code",
    schemes: ["altimate"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "ai.altimate.code.desktop.dev",
        productName: "Altimate Code Dev",
        rpm: { packageName: "altimate-code-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "ai.altimate.code.desktop.beta",
        productName: "Altimate Code Beta",
        protocols: { name: "Altimate Code Beta", schemes: ["altimate"] },
        publish: { provider: "github", owner: "AltimateAI", repo: "altimate-code-beta", channel: "latest" },
        rpm: { packageName: "altimate-code-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "ai.altimate.code.desktop",
        productName: "Altimate Code",
        protocols: { name: "Altimate Code", schemes: ["altimate"] },
        publish: { provider: "github", owner: "AltimateAI", repo: "altimate-code", channel: "latest" },
        rpm: { packageName: "altimate-code" },
      }
    }
  }
}

export default getConfig()
