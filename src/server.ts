import type { Hooks, PluginInput, PluginModule } from "@opencode-ai/plugin";

const PLUGIN_ID = "opencode-codex-switch";
const ACCOUNT_COMMAND_OPEN = "plugin.codex-switch.open";
const HANDLED_SENTINEL = "__CODEX_SWITCH_HANDLED__";

function isAccountCommand(command: string): boolean {
  const normalized = command.replace(/^\//, "");
  return normalized === "switch-codex";
}

export async function CodexSwitchPlugin(input: PluginInput): Promise<Hooks> {
  const client = input.client;

  return {
    "command.execute.before": async (input, output) => {
      if (!isAccountCommand(input.command)) {
        return;
      }

      const result = await client.tui.executeCommand({
        body: { command: ACCOUNT_COMMAND_OPEN },
      });

      if (result.error || result.data !== true) {
        throw new Error("Codex account dialog unavailable. Ensure the TUI plugin is loaded.");
      }

      void output;
      throw new Error(HANDLED_SENTINEL);
    },
  };
}

const module: PluginModule & { id: string } = {
  id: PLUGIN_ID,
  server: CodexSwitchPlugin,
};

export default module;
