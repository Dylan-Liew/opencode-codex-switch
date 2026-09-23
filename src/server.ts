import { Plugin } from "@opencode/plugin";
import { Credential } from "@opencode/schema/credential";
import { Rpc } from "@opencode/plugin/rpc";
import { readStore } from "./store.ts";
import { normalizeOAuthRecord } from "./utils/auth.ts";

export const accountRpc = Rpc.define({
  id: "opencode-codex-switch",
  methods: { active: { input: { type: "object", additionalProperties: false }, output: { type: ["string", "null"] } } },
  events: {},
});

export default Plugin.define({
  id: "opencode-codex-switch",
  async setup(ctx) {
    await ctx.rpc.register(accountRpc, {
      active: async () => {
        const connection = await ctx.integration.connection.active("openai");
        return connection?.type === "credential" ? connection.id : null;
      },
    });
    // Offer saved V1 accounts as explicit imports; preserve the original store.
    const store = await readStore();
    await ctx.integration.transform((editor) => {
      for (const account of store.accounts) {
        const auth = normalizeOAuthRecord(account.auth);
        if (!auth) continue;
        editor.method.update({
          integrationID: "openai",
          method: { id: `codex-switch-import-${account.id}`, type: "oauth", label: `Import saved V1 account: ${account.email ?? auth.accountId ?? account.id}` },
          authorize: async () => ({
            mode: "auto",
            url: "",
            instructions: "Importing the selected saved account into OpenCode V2.",
            callback: Promise.resolve(Credential.OAuth.make({
              type: "oauth",
              methodID: "chatgpt-browser" as Credential.OAuth["methodID"],
              access: auth.access, refresh: auth.refresh, expires: auth.expires,
              metadata: { ...(auth.accountId ? { accountID: auth.accountId } : {}) },
            })),
          }),
          label: () => account.email ?? auth.accountId ?? "Imported Codex account",
        });
      }
    });
  },
});
