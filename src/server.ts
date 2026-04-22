import type { Hooks, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin";
import { getOpenAIAuthProbe, type CodexSwitchOptions } from "./auth-probe.ts";

const PLUGIN_ID = "opencode-codex-switch";
const ACCOUNT_COMMAND_OPEN = "plugin.codex-switch.open";
const HANDLED_SENTINEL = "__CODEX_SWITCH_HANDLED__";

function isAccountCommand(command: string): boolean {
  const normalized = command.replace(/^\//, "");
  return normalized === "switch-codex";
}

export async function CodexSwitchPlugin(
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> {
  const client = input.client;
  const authProbe = getOpenAIAuthProbe(input, options as CodexSwitchOptions | undefined);

  return {
    ...(authProbe ? { auth: authProbe } : {}),
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
