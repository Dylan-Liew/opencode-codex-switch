# OpenCode **Codex Switch**

Switch between saved OpenAI OAuth accounts inside OpenCode with a native TUI dialog through `/switch-codex`.

## Install

Recommended:

```bash
opencode plugin -g opencode-codex-switch
```

Manual install:

For a global manual install, add the plugin to both `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`.

`~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-codex-switch"],
  "codex-switch": {
    "probeOpenAIAuthHook": true
  }
}
```

`~/.config/opencode/tui.json`

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-codex-switch"]
}
```

`probeOpenAIAuthHook` enables the browser-based add-account flow for OpenAI inside the plugin.

## Use It

Open the account switcher with either:

- `/switch-codex`
- Command palette -> `Switch Codex Account`

Inside the dialog:

- `Enter` switches to the selected saved account
- `a` starts the browser flow to add another OpenAI account
- `Ctrl+D` deletes the selected saved account

Each row shows the account email when available, and falls back to the OpenAI account ID when email is unavailable.

## Workflow

The plugin has two parts that work together:

- Server plugin: intercepts `/switch-codex` and exposes the OpenAI auth hook used for adding accounts
- TUI plugin: renders the account picker and handles switching, adding, and deleting accounts

Saved accounts are stored in the local OpenCode data directory and the active account is applied through OpenCode's auth client when you switch.

## Notes

- OpenAI-only: this plugin is currently built for OpenAI OAuth account switching
- Local storage: saved accounts are written to OpenCode's local data directory
- Browser required for add-account: adding a new account uses the OpenAI OAuth browser flow

## License

MIT
