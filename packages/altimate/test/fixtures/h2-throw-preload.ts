import "../../script/identity-preload"

globalThis.__OPENCODE_HOST_PLUGINS__ = {
  ...globalThis.__OPENCODE_HOST_PLUGINS__!,
  server: [
    {
      id: "altimate",
      protected: true,
      plugin: async () => ({
        default: {
          id: "altimate",
          setup() {
            throw new Error("H2 deliberate Altimate setup failure")
          },
        },
      }),
    },
  ],
}
