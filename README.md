# claude-code-mods

A home for my Claude Code mods: small plugins that change how Claude Code's
own interface behaves. One folder per mod, no build step, no dependencies.

## Mods

| Mod | What it does |
| --- | --- |
| [progress-band](progress-band/) | Replaces the stream of tool output with a live progress panel above the prompt: Claude's step list, a roster of subagents with token counts, tool rows condensed to one line, spoken alerts when an agent fails or Claude has a question. |

Each mod's own README covers what it shows, its commands, and its files.

## Loading a mod

Every session, with no flag: name the mod folder in the `env` block of
`~/.claude/settings.json` (several folders are colon-separated):

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-mods/progress-band" }
```

One session only:

```
claude --plugin-dir /path/to/claude-code-mods/progress-band
```

Either way the folder is watched, so saving a file hot-reloads the mod.

## Checking a mod

```
claude plugin validate /path/to/claude-code-mods/progress-band
claude plugin test /path/to/claude-code-mods/progress-band
```

## Layout

- `<mod>/.claude-plugin/plugin.json`: manifest
- `<mod>/hooks/hooks.json`: names the hooks module
- `<mod>/hooks/register.tsx`: the hooks
- `<mod>/types/index.d.ts`: the mod's state contract
- `<mod>/tests/`: kit tests

## Requirements

A Claude Code build that supports function-hook plugins (the `hooks.json` plus
`register.tsx` format). Spoken alerts rely on the host's speech support and are
tested on macOS only.
