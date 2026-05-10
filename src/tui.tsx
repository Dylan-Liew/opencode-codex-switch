/** @jsxImportSource @opentui/solid */
import { spawn } from "child_process";
import { RGBA, TextAttributes, type KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { getAccountByID, readStore, removeAccount, setActiveAccount, syncCurrentAuth, writeStore } from "./store.ts";
import type { AccountView, StoredAccount } from "./types.ts";
import { getCurrentOpenAIOAuth, sameOAuthRecord } from "./utils/auth.ts";

const PLUGIN_ID = "opencode-codex-switch";
const ACCOUNT_COMMAND_OPEN = "plugin.codex-switch.open";
const OPENAI_BROWSER_METHOD_LABEL = "ChatGPT Pro/Plus (browser)";

function describeAccount(account: StoredAccount): string {
  return account.email ?? account.auth.accountId ?? "Email unavailable";
}

async function getAccountViews(): Promise<AccountView[]> {
  const [store, currentAuth] = await Promise.all([readStore(), getCurrentOpenAIOAuth()]);
  const currentStore = syncCurrentAuth(store, currentAuth, { activate: false });
  if (currentStore !== store) {
    await writeStore(currentStore);
  }

  return currentStore.accounts.map((account) => ({
    account,
    isActive:
      (currentStore.activeAccountID ? account.id === currentStore.activeAccountID : false) ||
      sameOAuthRecord(account.auth, currentAuth),
  }));
}

async function switchAccount(api: TuiPluginApi, accountID: string): Promise<void> {
  const store = await readStore();
  const account = getAccountByID(store, accountID);
  if (!account) {
    api.ui.toast({ message: "Account not found", variant: "error", duration: 2500 });
    return;
  }

  const result = await api.client.auth.set({
    providerID: "openai",
    auth: account.auth,
  });

  if (result.error) {
    api.ui.toast({ message: "Failed to switch account", variant: "error", duration: 3000 });
    return;
  }

  await writeStore(setActiveAccount(store, account.id));
}

async function deleteSelectedAccount(api: TuiPluginApi, account: StoredAccount, onDone: () => void): Promise<void> {
  const DialogConfirm = api.ui.DialogConfirm;
  api.ui.dialog.replace(() => (
    <DialogConfirm
      title="Delete account"
      message={`Remove ${describeAccount(account)}?`}
      onCancel={onDone}
      onConfirm={async () => {
        const store = await readStore();
        const nextStore = removeAccount(store, account.id);
        await writeStore(nextStore);

        if (store.activeAccountID === account.id) {
          const nextAccount = getAccountByID(nextStore, nextStore.activeAccountID);
          if (nextAccount) {
            const result = await api.client.auth.set({ providerID: "openai", auth: nextAccount.auth });
            if (result.error) {
              api.ui.toast({ message: "Removed account, but failed to switch active auth", variant: "error", duration: 3500 });
            }
          } else {
            const result = await api.client.auth.remove({ providerID: "openai" });
            if (result.error) {
              api.ui.toast({ message: "Removed account, but failed to clear active auth", variant: "error", duration: 3500 });
            }
          }
        }

        onDone();
      }}
    />
  ));
}

function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const [commandName, ...args] = command;

  return new Promise((resolve, reject) => {
    const child = spawn(commandName!, args, { stdio: "ignore", detached: true }) as import("child_process").ChildProcess;
    let settled = false;
    child.once("error", reject);
    child.unref();
    setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    }, 50);
  });
}

async function reopenAccountsDialog(api: TuiPluginApi): Promise<void> {
  api.ui.dialog.replace(() => <AccountsDialog api={api} />);
}

async function saveCurrentOpenAIAccount(): Promise<boolean> {
  const currentAuth = await getCurrentOpenAIOAuth();
  if (!currentAuth) {
    return false;
  }

  await writeStore(syncCurrentAuth(await readStore(), currentAuth));
  return true;
}

async function getOpenAIMethod(api: TuiPluginApi): Promise<{ index: number; label: string } | undefined> {
  const result = await api.client.provider.auth();
  const methods = result.data?.openai;
  if (result.error || !methods) {
    return undefined;
  }

  const browserIndex = methods.findIndex((method) => method.type === "oauth" && method.label === OPENAI_BROWSER_METHOD_LABEL);
  if (browserIndex >= 0) {
    return { index: browserIndex, label: methods[browserIndex]!.label };
  }

  const oauthIndex = methods.findIndex((method) => method.type === "oauth");
  return oauthIndex >= 0 ? { index: oauthIndex, label: methods[oauthIndex]!.label } : undefined;
}

function AddAccountAutoMethod(props: {
  api: TuiPluginApi;
  methodIndex: number;
  methodLabel: string;
  url: string;
  instructions: string;
}) {
  const theme = props.api.theme.current;

  onMount(async () => {
    const result = await props.api.client.provider.oauth.callback({
      providerID: "openai",
      method: props.methodIndex,
    });

    if (result.error) {
      props.api.ui.toast({ message: "Failed to add account", variant: "error", duration: 3000 });
    } else if (!(await saveCurrentOpenAIAccount())) {
      props.api.ui.toast({ message: "Added auth, but failed to save account", variant: "error", duration: 3000 });
    }

    await reopenAccountsDialog(props.api);
  });

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.methodLabel}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.primary}>{props.url}</text>
      <text fg={theme.textMuted}>{props.instructions}</text>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
    </box>
  );
}

async function startAddAccountFlow(api: TuiPluginApi): Promise<void> {
  const method = await getOpenAIMethod(api);
  if (!method) {
    api.ui.toast({ message: "OpenAI OAuth add-account method is unavailable", variant: "error", duration: 3000 });
    return;
  }

  const result = await api.client.provider.oauth.authorize({
    providerID: "openai",
    method: method.index,
  });

  if (result.error || !result.data?.url) {
    api.ui.toast({ message: "Failed to start account authorization", variant: "error", duration: 3000 });
    return;
  }

  try {
    await openBrowser(result.data.url);
  } catch {
    api.ui.toast({ message: "Failed to open browser", variant: "error", duration: 3000 });
    return;
  }

  if (result.data.method === "auto") {
    api.ui.dialog.replace(() => (
      <AddAccountAutoMethod
        api={api}
        methodIndex={method.index}
        methodLabel={method.label}
        url={result.data!.url}
        instructions={result.data!.instructions}
      />
    ));
    return;
  }

  const DialogPrompt = api.ui.DialogPrompt;
  api.ui.dialog.replace(() => (
    <DialogPrompt
      title={method.label}
      placeholder="Authorization code"
      onCancel={() => {
        void reopenAccountsDialog(api);
      }}
      onConfirm={async (value) => {
        const callback = await api.client.provider.oauth.callback({
          providerID: "openai",
          method: method.index,
          code: value,
        });

        if (callback.error) {
          api.ui.toast({ message: "Invalid authorization code", variant: "error", duration: 3000 });
          return;
        }

        if (!(await saveCurrentOpenAIAccount())) {
          api.ui.toast({ message: "Added auth, but failed to save account", variant: "error", duration: 3000 });
          return;
        }

        await reopenAccountsDialog(api);
      }}
      description={() => (
        <box gap={1}>
          <text fg={api.theme.current.textMuted}>{result.data!.instructions}</text>
          <text fg={api.theme.current.primary}>{result.data!.url}</text>
        </box>
      )}
    />
  ));
}

function AccountsDialog(props: { api: TuiPluginApi }) {
  const theme = props.api.theme.current;
  const dimensions = useTerminalDimensions();
  const [views, setViews] = createSignal<AccountView[]>([]);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [busy, setBusy] = createSignal(false);

  const selected = createMemo(() => views()[selectedIndex()]);

  const loadViews = async () => {
    const result = await getAccountViews();
    setViews(result);
    setSelectedIndex((current) => Math.max(0, Math.min(current, Math.max(0, result.length - 1))));
  };

  onMount(() => {
    void loadViews();
  });

  createEffect(() => {
    props.api.ui.dialog.setSize(dimensions().width >= 120 ? "large" : "medium");
  });

  const handleKeyDown = (event: KeyEvent) => {
    if (event.eventType !== "press" || event.repeated || busy()) {
      return;
    }

    const key = event.name.toLowerCase();

    if (key === "down" || key === "arrowdown") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex((current) => Math.min(current + 1, Math.max(0, views().length - 1)));
      return;
    }

    if (key === "up" || key === "arrowup") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (key === "return" || key === "enter") {
      const current = selected()?.account;
      if (!current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setBusy(true);
      void switchAccount(props.api, current.id)
        .then(() => reopenAccountsDialog(props.api))
        .finally(() => setBusy(false));
      return;
    }

    if (!event.ctrl && !event.meta && !event.option && key === "a") {
      event.preventDefault();
      event.stopPropagation();
      setBusy(true);
      void startAddAccountFlow(props.api).finally(() => setBusy(false));
      return;
    }

    if (event.ctrl && key === "d") {
      const current = selected()?.account;
      if (!current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void deleteSelectedAccount(props.api, current, () => {
        void reopenAccountsDialog(props.api);
      });
    }
  };

  return (
    <box width="100%" flexDirection="column" gap={0} focusable focused onKeyDown={handleKeyDown}>
      <box paddingLeft={4} paddingRight={4} paddingBottom={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="column" gap={0}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Switch Codex Account
            </text>
            <text fg={theme.textMuted}>enter select · a add · ctrl+d delete</text>
          </box>
          <text fg={theme.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
            esc
          </text>
        </box>

        <Show when={busy()}>
          <text fg={theme.warning}>Working...</text>
        </Show>
      </box>

      <scrollbox paddingLeft={4} paddingRight={4} maxHeight={Math.max(10, Math.floor(dimensions().height * 0.45))}>
        <Show
          when={views().length > 0}
          fallback={
            <box
              paddingLeft={2}
              paddingRight={2}
              paddingTop={2}
              paddingBottom={2}
              borderStyle="rounded"
              borderColor={theme.border}
              backgroundColor={RGBA.fromInts(0, 0, 0, 0)}
              flexDirection="column"
              gap={1}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                No saved accounts yet
              </text>
              <text fg={theme.textMuted}>Press a to add a new account through the OpenAI browser flow.</text>
            </box>
          }
        >
          <box flexDirection="column" gap={1}>
            <For each={views()}>
              {(view, index) => {
                const isSelected = () => index() === selectedIndex();
                const cardBackground = () => (isSelected() ? theme.backgroundElement : theme.backgroundPanel);
                return (
                  <box
                    paddingLeft={0}
                    paddingRight={0}
                    paddingTop={0}
                    paddingBottom={0}
                    flexDirection="row"
                  >
                    <box width={1} backgroundColor={isSelected() ? theme.primary : theme.borderSubtle} />
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      paddingTop={1}
                      paddingBottom={1}
                      flexDirection="row"
                      justifyContent="space-between"
                      alignItems="center"
                      flexGrow={1}
                      backgroundColor={cardBackground()}
                    >
                      <text fg={isSelected() ? theme.text : theme.textMuted}>{describeAccount(view.account)}</text>
                      <Show when={view.isActive}>
                        <text fg={theme.primary}>active</text>
                      </Show>
                    </box>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
      </scrollbox>
    </box>
  );
}

async function openAccountsDialog(api: TuiPluginApi): Promise<void> {
  api.ui.dialog.replace(() => <AccountsDialog api={api} />);
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Switch Codex Account",
      value: ACCOUNT_COMMAND_OPEN,
      category: "Plugin",
      slash: { name: "switch-codex" },
      onSelect: () => {
        void openAccountsDialog(api);
      },
    },
  ]);
};

const module: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default module;
