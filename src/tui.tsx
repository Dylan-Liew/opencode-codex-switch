/** @jsxImportSource @opentui/solid */
import { spawn } from "child_process";
import { MouseButton, RGBA, TextAttributes, type KeyEvent, type MouseEvent, type Renderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
  const [hoveredAction, setHoveredAction] = createSignal<string | undefined>();
  const handledKeys = new WeakSet<KeyEvent>();
  let root: Renderable | undefined;

  const selected = createMemo(() => views()[selectedIndex()]);

  const moveSelection = (direction: number) => {
    setSelectedIndex((current) => Math.max(0, Math.min(current + direction, Math.max(0, views().length - 1))));
  };

  const switchStoredAccount = (account: StoredAccount | undefined) => {
    if (!account || busy()) {
      return;
    }

    setBusy(true);
    void switchAccount(props.api, account.id)
      .then(() => reopenAccountsDialog(props.api))
      .finally(() => setBusy(false));
  };

  const switchCurrentAccount = () => switchStoredAccount(selected()?.account);

  const addAccount = () => {
    if (busy()) {
      return;
    }

    setBusy(true);
    void startAddAccountFlow(props.api).finally(() => setBusy(false));
  };

  const deleteStoredAccount = (account: StoredAccount | undefined) => {
    if (!account || busy()) {
      return;
    }

    void deleteSelectedAccount(props.api, account, () => {
      void reopenAccountsDialog(props.api);
    });
  };

  const deleteCurrentAccount = () => deleteStoredAccount(selected()?.account);

  const clickPrimary = (event: MouseEvent): boolean => {
    if (event.button !== MouseButton.LEFT) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const loadViews = async () => {
    const result = await getAccountViews();
    setViews(result);
    setSelectedIndex((current) => Math.max(0, Math.min(current, Math.max(0, result.length - 1))));
  };

  onMount(() => {
    void loadViews();
    setTimeout(() => {
      if (!root || root.isDestroyed) {
        return;
      }

      root.focus();
    }, 25);
  });

  createEffect(() => {
    props.api.ui.dialog.setSize(dimensions().width >= 120 ? "large" : "medium");
  });

  const handleKeyDown = (event: KeyEvent) => {
    if (handledKeys.has(event)) {
      return;
    }

    if (event.eventType !== "press" || busy()) {
      return;
    }

    const key = event.name.toLowerCase();

    if (!event.ctrl && !event.meta && !event.option && key === "a") {
      if (event.repeated) {
        return;
      }

      handledKeys.add(event);
      event.preventDefault();
      event.stopPropagation();
      addAccount();
      return;
    }

    if (event.ctrl && key === "d") {
      if (event.repeated) {
        return;
      }

      handledKeys.add(event);
      event.preventDefault();
      event.stopPropagation();
      deleteCurrentAccount();
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    if (key === "down" || key === "arrowdown") {
      handledKeys.add(event);
      event.preventDefault();
      event.stopPropagation();
      moveSelection(1);
      return;
    }

    if (key === "up" || key === "arrowup") {
      handledKeys.add(event);
      event.preventDefault();
      event.stopPropagation();
      moveSelection(-1);
      return;
    }

    if (key === "return" || key === "enter") {
      if (event.repeated) {
        return;
      }

      handledKeys.add(event);
      event.preventDefault();
      event.stopPropagation();
      switchCurrentAccount();
      return;
    }

    return;
  };

  const disposeKeybinds = props.api.keymap.registerLayer({
    priority: 10,
    commands: [
      {
        name: "dialog.select.prev",
        title: "Previous Codex account",
        category: "Dialog",
        run: () => moveSelection(-1),
      },
      {
        name: "dialog.select.next",
        title: "Next Codex account",
        category: "Dialog",
        run: () => moveSelection(1),
      },
      {
        name: "dialog.select.submit",
        title: "Select Codex account",
        category: "Dialog",
        run: switchCurrentAccount,
      },
      {
        name: `${ACCOUNT_COMMAND_OPEN}.add`,
        title: "Add Codex account",
        category: "Dialog",
        run: addAccount,
      },
      {
        name: `${ACCOUNT_COMMAND_OPEN}.delete`,
        title: "Delete Codex account",
        category: "Dialog",
        run: deleteCurrentAccount,
      },
    ],
    bindings: [
      ...props.api.tuiConfig.keybinds.gather("dialog.select", [
        "dialog.select.prev",
        "dialog.select.next",
        "dialog.select.submit",
      ]),
      { key: "a", cmd: `${ACCOUNT_COMMAND_OPEN}.add`, desc: "Add Codex account" },
      { key: "ctrl+d", cmd: `${ACCOUNT_COMMAND_OPEN}.delete`, desc: "Delete Codex account" },
    ],
  });
  onCleanup(disposeKeybinds);

  useKeyboard(handleKeyDown);

  return (
    <box width="100%" flexDirection="column" gap={0} focusable focused onKeyDown={handleKeyDown} ref={(value) => (root = value)}>
      <box paddingLeft={4} paddingRight={4} paddingBottom={1} flexDirection="column" gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="column" gap={0}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Switch Codex Account
            </text>
            <text fg={theme.textMuted}>enter select · a add · ctrl+d delete</text>
          </box>
          <box flexDirection="row" gap={2}>
            <text
              fg={hoveredAction() === "add" ? theme.text : theme.primary}
              onMouseOver={() => setHoveredAction("add")}
              onMouseOut={() => setHoveredAction(undefined)}
              onMouseUp={(event) => {
                if (clickPrimary(event)) {
                  addAccount();
                }
              }}
            >
              add
            </text>
            <text
              fg={hoveredAction() === "esc" ? theme.text : theme.textMuted}
              onMouseOver={() => setHoveredAction("esc")}
              onMouseOut={() => setHoveredAction(undefined)}
              onMouseUp={() => props.api.ui.dialog.clear()}
            >
              esc
            </text>
          </box>
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
                    onMouseMove={() => setSelectedIndex(index())}
                    onMouseOver={() => setSelectedIndex(index())}
                    onMouseDown={(event) => {
                      if (clickPrimary(event)) {
                        setSelectedIndex(index());
                      }
                    }}
                    onMouseUp={(event) => {
                      if (clickPrimary(event)) {
                        setSelectedIndex(index());
                        switchStoredAccount(view.account);
                      }
                    }}
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
                      <box flexDirection="row" gap={2}>
                        <Show when={view.isActive}>
                          <text fg={theme.primary}>active</text>
                        </Show>
                        <text
                          fg={hoveredAction() === `delete:${view.account.id}` ? theme.text : theme.textMuted}
                          onMouseOver={() => setHoveredAction(`delete:${view.account.id}`)}
                          onMouseOut={() => setHoveredAction(undefined)}
                          onMouseUp={(event) => {
                            if (clickPrimary(event)) {
                              setSelectedIndex(index());
                              deleteStoredAccount(view.account);
                            }
                          }}
                        >
                          delete
                        </text>
                      </box>
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
  const disposeCommands = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: ACCOUNT_COMMAND_OPEN,
        title: "Switch Codex Account",
        category: "Plugin",
        slashName: "switch-codex",
        run: () => {
          void openAccountsDialog(api);
        },
      },
    ],
  });
  api.lifecycle.onDispose(disposeCommands);
};

const module: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default module;
