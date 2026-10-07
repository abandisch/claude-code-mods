# progress-band

A Claude Code mod that replaces the stream of tool output with a live progress
panel above the prompt.

## What it shows

- **Header**: a state badge (`▶ Working`, `‖ Needs you`, `✔ All done`,
  `⊘ Stopped`, `✗ Failed`), the step Claude is on, and the clock. While
  agents from this turn run it counts them by role instead
  (`Scouting: 2 of 5 scouts done`). A background agent still running after
  the turn ends keeps the band working and the clock counting;
  `Waiting for 1 agent` shows only for agents left over from an earlier
  turn. A live agent the engine stops listing for over 10 s is taken as
  finished.
- **Steps**: Claude's step list (the mod's `steps` tool, or TaskCreate /
  TaskUpdate / TodoWrite) as rows
  with a bar and a word: `Done`, `Working`, `Next`, `Up next`. When the band
  runs out of rows, finished steps fold into one line and the window keeps
  the step in progress in view (`+N more steps` marks steps cut at the tail).
  While Claude works, a dim `↳ Tool: label` line under the active step names
  its latest tool call; it is the first thing dropped when rows are short.
  The list holds at most 50 steps, titles cut to 120 characters.
- **Agents**: one row per subagent (the `/orchestrate` waves): description
  led by a dim role (`scout`, `implementer`, `reviewer`, `fixer`, `scribe`,
  read from the description, else the type and model tier), type and model
  tier (`general/opus`), status, elapsed time, tokens (`4.2k tok`: uncached
  input plus output, added when each of the agent's turns ends, so a running
  agent shows `0 tok` until then), tool-call count. Live agents first,
  clustered by role, finished ones dimmed below. Up to 12 rows; when the band
  is short of rows the last one reads `+N more · /progress agents`. Widths
  are the band's usable width (body columns minus 2): under 70 the
  type/model and calls columns drop; under 50, the time too; the role prefix
  drops when the description gets narrow. The section header adds the
  roster's token total.
- **Needs you** in two cases: Claude's answer asks you something (its last
  line, ignoring a final `🔊` speech line, ends in `?`, or, failing that, a
  small classifier call on the answer's tail says it is a question; a
  classifier answer that arrives after the next turn started is dropped), or
  the turn ended with steps still open (`Stopped with N steps left`).
- **Collapse**: 20 s after the turn and its agents finish, the band shrinks
  to one row (badge, summary, clock) with a `Show` button that expands it.
  To press it, focus the band (ctrl+x then tab, or click it) and press `s`
  or Enter on the button; `/progress show` expands it too. The next turn
  expands it again.
- **Tool rows** in the transcript condense to one dim line each
  (`✓ Bash: Run the test suite`). Errors keep the full row. Ctrl+O still shows
  everything. The mod's own `steps` calls draw no row at all.
- **Labels are redacted**: Bash shows its description, else the first 60
  characters of the command; WebFetch shows the URL without credentials or
  query; tools the mod does not know show their name only. Bearer tokens,
  `*KEY*/*TOKEN*/*SECRET*/*PASSWORD*/*AUTH*=…` values and `--token`-style
  flags are masked as `•••`, and control characters are stripped.
- **Spinner** says the active step's present-continuous form.
- **Toast and voice**, for two events only: an agent failing
  (`Agent failed: <description>`, spoken "Sir, an agent has failed.") and
  Claude asking you a question through AskUserQuestion (spoken "Sir, Claude
  has a question for you."). Speech is fixed phrases only. At most one alert
  per kind every 10 s; later ones are dropped. Nothing is spoken at turn end.

The mod registers its own tool, `mcp__progress-band__steps`, which Claude
calls to plan the steps of a multi-step request and mark each one
in_progress and completed. It answers with the list as plain text
(`Steps:` then `1. [in_progress] Check the balance`, one per line). A short
system-prompt section asks Claude to use it. The panel also reads
TaskCreate / TaskUpdate / TodoWrite when a session offers those tools.

Running the `orchestrate` skill seeds a nine-step wave (Scout the code and
facts, Get the owner's rulings, Brief the implementer, Re-verify the
implementation, Run the review gate, Adjudicate the findings, Batch-fix the
findings, Finders re-verify the fixes, Bank the wave and hand off) when no
unfinished step list is open.

## Commands

| Command | Effect |
| --- | --- |
| `/progress` | toggle the panel (any other word prints the usage line) |
| `/progress hide` / `show` | hide or show it |
| `/progress quiet` / `verbose` | condense tool rows, or draw them in full |
| `/progress clear` | forget the current steps and agents |
| `/progress agents` | open the Agents pane |

The **Agents pane** lists every agent in the roster, live first. Per agent:
the description with its role, then type and full model id (the short tier
when the id does not fit), then status, elapsed time, calls and tokens, then `↳` its latest tool call, then the first line
of its last reply in quotes. Escape closes it.

## Loading it

Every session, with no flag: name the folder in the `env` block of
`~/.claude/settings.json` (several folders are colon-separated):

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/progress-band" }
```

One session only:

```
claude --plugin-dir /path/to/progress-band
```

Either way the folder is watched: saving a file hot-reloads the mod.

Check and test:

```
claude plugin validate /path/to/progress-band
claude plugin test /path/to/progress-band
```

## Files

- `.claude-plugin/plugin.json`: manifest
- `hooks/hooks.json`: names the hooks module
- `hooks/register.tsx`: the hooks
- `types/index.d.ts`: the `$.state` contract
- `tests/progress-band.test.tsx`: kit tests
