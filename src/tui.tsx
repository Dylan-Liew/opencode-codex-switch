/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import type { ConnectionCredentialInfo } from "@opencode/client";
import { Rpc } from "@opencode/plugin/rpc";

const accountRpc = Rpc.define({
  id: "opencode-codex-switch",
  methods: { active: { input: { type: "object", additionalProperties: false }, output: { type: ["string", "null"] } } },
  events: {},
});

export async function addAccount(context: Context): Promise<void> {
  const integration = (await context.client.integration.get({ integrationID: "openai", location: context.location })).data;
  const methods = integration.methods.filter((method) => method.type === "oauth");
  const methodID = await context.ui.dialog.select({
    title: "Add Codex account",
    options: methods.map((method) => ({ title: method.label, value: method.id })),
  });
  if (!methodID) return;
  const input = { integrationID: "openai", location: context.location };
  const attempt = (await context.client.integration.oauth.connect({ ...input, methodID })).data;
  const request = { ...input, attemptID: attempt.attemptID };
  let completed = false;
  try {
    if (attempt.mode === "code") {
      const code = await context.ui.dialog.prompt({ title: "Authorize Codex account", description: `${attempt.instructions}\n${attempt.url}`, placeholder: "Authorization code" });
      if (code === undefined) return;
      await context.client.integration.oauth.complete({ ...request, code });
    } else if (attempt.url) {
      // The link remains usable when the terminal is on a remote machine.
      const proceed = await context.ui.dialog.confirm({ title: "Authorize Codex account", message: `${attempt.instructions}\n\n${attempt.url}\n\nContinue after authorizing in your browser.`, label: { confirm: "Check authorization", cancel: "Cancel" } });
      if (!proceed) return;
    }
    while (Date.now() < attempt.time.expires) {
      const status = (await context.client.integration.oauth.status(request)).data;
      if (status.status === "complete") { completed = true; break; }
      if (status.status === "failed") throw new Error(status.message);
      if (status.status === "expired") throw new Error("Authorization expired");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!completed) throw new Error("Authorization expired");
    context.ui.toast.show({ message: "Codex account added", variant: "success" });
  } finally {
    if (!completed) await context.client.integration.oauth.cancel(request).catch(() => {});
  }
}

export async function openAccounts(context: Context): Promise<void> {
  try {
    const integration = (await context.client.integration.get({ integrationID: "openai", location: context.location })).data;
    const active = await context.client.rpc(accountRpc).active({}, { location: context.location });
    const accounts = integration.connections.filter((entry): entry is ConnectionCredentialInfo => entry.type === "credential" && entry.method === "oauth");
    const selected = await context.ui.dialog.select({
      title: "Codex accounts",
      options: [
        ...accounts.map((account) => ({ title: account.label, value: account.id, description: account.id === active ? "Active account" : undefined })),
        { title: "Add or import account", value: "add" },
      ],
    });
    if (!selected) return;
    if (selected === "add") { await addAccount(context); return openAccounts(context); }
    const account = accounts.find((entry) => entry.id === selected)!;
    const action = await context.ui.dialog.select({
      title: account.label,
      options: [
        { title: "Switch to this account", value: "switch" },
        { title: "Rename", value: "rename" },
        { title: "Remove from OpenCode", value: "remove" },
      ],
    });
    if (action === "switch") {
      await context.client.credential.activate({ credentialID: selected });
      context.ui.toast.show({ message: `Switched to ${account.label}`, variant: "success" });
    } else if (action === "rename") {
      const label = await context.ui.dialog.prompt({ title: "Account label", value: account.label });
      if (label?.trim()) await context.client.credential.update({ credentialID: selected, label: label.trim() });
    } else if (action === "remove" && await context.ui.dialog.confirm({ title: "Remove account", message: `Remove ${account.label} from OpenCode? Your saved V1 account file is retained.` })) {
      await context.client.credential.remove({ credentialID: selected });
    }
  } catch (error) {
    context.ui.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" });
  }
}

function Commands(props: { context: Context }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [{ id: "plugin.codex-switch.open", title: "Switch Codex account", group: "Plugin", palette: true, slash: { name: "switch-codex" }, run: () => openAccounts(props.context) }],
  }));
  return null;
}

export default Plugin.define({
  id: "opencode-codex-switch",
  setup(context) {
    return context.ui.slot({ append: "app", render: () => <Commands context={context} /> });
  },
});
