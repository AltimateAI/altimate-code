import { createSignal } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useTheme } from "../context/theme"
import { AltimateApi } from "@/altimate/api/client"
import { Filesystem } from "@/util/filesystem"

export function DialogAltimateLogin() {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()
  const [step, setStep] = createSignal<"url" | "tenant" | "key">("url")
  const [url, setUrl] = createSignal("https://api.myaltimate.com")
  const [tenant, setTenant] = createSignal("")

  async function saveAndConnect(apiKey: string) {
    const creds = {
      altimateUrl: url(),
      altimateInstanceName: tenant(),
      altimateApiKey: apiKey,
    }
    await Filesystem.writeJson(AltimateApi.credentialsPath(), creds, 0o600)
    // Refresh providers to pick up the new altimate-backend
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    // Auto-select the altimate model
    local.model.set({ providerID: "altimate-backend", modelID: "altimate-default" }, { recent: true })
    dialog.clear()
  }

  return (
    <>
      {step() === "url" && (
        <DialogPrompt
          title="Altimate Backend URL"
          placeholder="https://api.myaltimate.com"
          value="https://api.myaltimate.com"
          description={() => (
            <text fg={theme.textMuted}>Enter the URL of your Altimate backend server</text>
          )}
          onConfirm={(value) => {
            if (value) setUrl(value)
            setStep("tenant")
          }}
        />
      )}
      {step() === "tenant" && (
        <DialogPrompt
          title="Instance Name"
          placeholder="your-tenant"
          description={() => (
            <text fg={theme.textMuted}>Enter your Altimate instance (tenant) name</text>
          )}
          onConfirm={(value) => {
            if (!value) return
            setTenant(value)
            setStep("key")
          }}
        />
      )}
      {step() === "key" && (
        <DialogPrompt
          title="API Key"
          placeholder="your-api-key"
          description={() => (
            <text fg={theme.textMuted}>Enter your Altimate API key</text>
          )}
          onConfirm={async (value) => {
            if (!value) return
            await saveAndConnect(value)
          }}
        />
      )}
    </>
  )
}
