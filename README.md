# OpenCode **Codex Switch**

Switch between saved OpenAI OAuth accounts inside OpenCode with a native TUI dialog through `/switch-codex`.

> [!IMPORTANT]
> Version 1.x supports OpenCode v2 only. OpenCode v1 is no longer supported; use the final 0.x release if you must remain on v1.

## Install

Recommended:

```bash
opencode plugin -g opencode-codex-switch
```

Manual install:

For a global manual install, add the plugin to `~/.config/opencode/opencode.json`.

`~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-codex-switch"]
}
```

The add-account flow uses OpenCode's built-in OpenAI/Codex OAuth methods.

## Use It

Open the account switcher with either:

- `/switch-codex`
- Command palette -> `Switch Codex Account`

Inside the dialog:

- `Enter` switches to the selected saved account
- `a` starts OpenCode's OpenAI/Codex OAuth flow to add another account
- `Ctrl+D` deletes the selected saved account

Each row shows the account email when available, and falls back to the OpenAI account ID when email is unavailable.

## Workflow

The plugin has two parts that work together:

- Server plugin: intercepts `/switch-codex` and forwards it to the TUI command
- TUI plugin: renders the account picker and handles switching, adding, and deleting accounts through OpenCode's built-in OAuth flow

Saved accounts are stored in OpenCode v2's credential store and the active account is applied through its integration API when you switch.

## Notes

- OpenAI-only: this plugin is currently built for OpenAI OAuth account switching
- Local storage: saved accounts are written to OpenCode's local data directory
- Browser required for add-account: adding a new account uses OpenCode's OpenAI/Codex OAuth browser flow

## License

MIT
