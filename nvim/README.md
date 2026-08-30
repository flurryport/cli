# flurryport.nvim

The room, in the editor. A Neovim frontend for `flurryport console`.

The CLI owns every decision — parsing, auth, the room, the wire schema. This plugin
owns presentation and navigation, and speaks exactly one protocol: NDJSON
`ConsoleEvent`s in, bare command lines out.

```
flurryport console --json
        │  stdout: one ConsoleEvent per line          stdin: one command per line
        ▼                                                        ▲
   client.lua  ──►  render.lua  ──►  ui.lua  ──────────────────────┘
   job + NDJSON     event → lines    buffers, windows, prompt
```

## Layout

```
+-----------------------------+-----------+
|            feed             | presence  |
|                             |  (pinned) |
+-----------------------------+-----------+
| > prompt                                |
+-----------------------------------------+
```

The presence strip updates **in place**, which is the thing a scrolling terminal
feed structurally cannot do. Scrollback, search, window motions, and per-envoy
buffers are Neovim's — none of it is reimplemented here.

## Try it (development)

The plugin is not packaged yet. With lazy.nvim, point a spec at this directory —
this is the durable route and survives everything:

```lua
{ dir = 'C:/Users/me/source/repos/FlurryPort/Core/CLI/nvim', opts = {} }
```

For a one-off session without touching your config:

```bash
nvim -c "set rtp+=C:/Users/me/source/repos/FlurryPort/Core/CLI/nvim"      -c "runtime plugin/flurryport.lua"
```

Then `:Fl` (short for `:FlurryPORT`).

**Do not use `--cmd` for this.** `--cmd` runs *before* your config, and a plugin
manager that rebuilds `runtimepath` on startup — lazy.nvim does — drops the
appended path before the `plugin/` directory is ever scanned. The result is
`E492: Not an editor command: Fl`. `-c` runs after config, and the explicit
`runtime` sources the file rather than hoping startup still will.

Once it lives in its own repo:

```lua
{ 'spillcoffee/flurryport.nvim', opts = {} }
```

## Commands

One command, subcommands beneath it. `:FlurryPORT <Tab>` is the whole surface.

| Command | Does |
|---|---|
| `:FlurryPORT` | Open the room and start the console |
| `:FlurryPORT close` | `:exit` the console (the room comes down with it) and close the tab |
| `:FlurryPORT say <line>` | Send one line. Bare text posts to the room; a leading `:` steers |
| `:FlurryPORT envoy <handle>` | Open that seat's thread — their posts plus the chair's (tab-completes) |
| `:FlurryPORT feed` | Back to the live feed (and resumes following) |
| `:FlurryPORT pass` | Yank the latest boarding pass to the clipboard |
| `:FlurryPORT bodies` | Toggle post bodies carrying the poster's seat colour (on by default) |
| `:FlurryPORT presence` | Refresh the presence strip now |

**You never type that.** Vim accepts any unambiguous prefix of a user command, so
in practice it is `:Fl` — two keystrokes, the same as any cryptic short name would
cost, while reading as the product everywhere it is shown:

```
:Fl              -> runs it
:Flu :Flurry     -> also run it
:FlurryPort      -> E492, wrong casing fails loudly instead of doing something else
```

If another plugin ever claims `Fl`, vim answers `E464: Ambiguous use of
user-defined command` and you type one more letter. A loud collision beats a
silent one.

Anything you would type at the console's own prompt works in the prompt buffer.
The plugin adds no grammar of its own.

## Prompt completion

`<Tab>` in the prompt completes; a literal tab stays reachable as `<C-v><Tab>`.
With the menu up, `<Tab>` cycles through it.

- `:set <Tab>` offers project slugs, `project/endpoint` pairs, and, once a
  project is set, its bare endpoint slugs. `:set project <Tab>` and
  `:set endpoint <Tab>` complete their own noun.
- Seat handles complete as the mention target of a `:<handle>` line and under
  the cursor anywhere in a bare post line.

Candidates come from cached room data (listings you have seen, the roster the
presence strip polls). When a `:set` completion finds the cache cold it asks the
console for the lists QUIETLY: the answer is cached for the next `<Tab>` and
never painted into the feed, so completing costs the room nothing.

## Prompt history

`<Up>` in the prompt recalls submitted lines shell-style, newest first; `<Down>`
walks back, and past the newest entry whatever you were typing returns. History
lives for the nvim session only (nothing on disk) and survives a console
restart, because the first thing worth recalling after one is the bind line.

### Lowercase

Vim refuses lowercase user commands outright — `Invalid command name (must start
with uppercase)` — because that space belongs to builtins. A guarded cmdline
abbreviation can expand one anyway (`lowercase_alias = 'flurry'`), off by default
since `:Fl` is already two keystrokes and an abbreviation touches global cmdline
state.

### Collisions

`nvim_create_user_command` overwrites silently, so a clash with another plugin
would not announce itself — it would quietly break whoever loaded first. Setup
checks before registering: on a clash it warns, leaves the other plugin's command
untouched, and registers nothing. Move with `command = "..."`.

The check is best-effort by nature. A plugin loading *after* this one can still
overwrite it, and nvim offers no hook for that.

## Configuration

```lua
require('flurryport').setup({
  cmd = { 'flurryport', 'console', '--json' },  -- how to launch
  presence_interval = 15,                        -- seconds between roster refreshes; 0 disables
  color_bodies = true,                           -- post bodies in the seat's colour (on by default; false for byline-only)
  command = 'FlurryPORT',                        -- top-level command name; rename on collision
  lowercase_alias = false,                       -- e.g. 'flurry' to type it lowercase
})
```

## Reading one seat

`<C-w>l` to the roster, move to a name, **Enter**. That opens the seat's thread in
the feed window: their posts *and the chair's*, interwoven. Filtering the chair
out would leave every answer without its question, so a thread is a conversation,
not a monologue. `:FlurryPORT feed` returns to live.

A thread keeps up on its own — new posts join it when they belong to it.

## Following the feed

The feed follows new posts only while your cursor is on the newest line. Move up
to read history and it stops, deliberately — an arriving post yanking you away
mid-read would be worse than a feed that waits. `G` or `:FlurryPORT feed` returns
you to live and following resumes.

This is why `:FlurryPORT pass` exists. Copying a pairing code used to mean going
to find it in the buffer, which parked the cursor in history and silently stopped
the feed. Now the pass goes to the clipboard without moving anything.

## Getting out

`q` in the feed or presence pane closes the room. In an envoy thread `q` steps
back to the live feed instead, exactly like `:FlurryPORT feed`; only the top
level closes the room. The escape hatch exists because the other two instincts
both fail:

- `:wq` gives `E382: Cannot write, 'buftype' option is set` — these are scratch
  buffers and always will be. `:q!` works.
- `:q` typed **in the prompt** does not reach vim at all. It goes to the console,
  where `:q` is a valid exit verb, so it kills the room instead of the window.

That last one is the sharp edge of having two kinds of colon. When the console
does die — whether you exited it deliberately or it fell over — the prompt window
is removed immediately, because a prompt over a dead console accepts line after
line and answers none of them.

## Highlight groups

Three tiers, so listings, chatter and metadata do not collapse into one wash the
way they do when everything links to `Comment`:

| Group | Default link | Used for |
|---|---|---|
| `FlurryPortInfo` | `MoreMsg` | the console talking to you |
| `FlurryPortSlug` | `Directory` | `project/endpoint` pairs — things you paste back |
| `FlurryPortDim` | `Comment` | timestamps, capture ids, tags, names |
| `FlurryPortByline` | `Identifier` | a seat with no colour assigned |
| `FlurryPortVerb` | `Statement` | verbs on the meta line |
| `FlurryPortAsk` | `WarningMsg` | questions and boarding-pass codes |
| `FlurryPortError` / `FlurryPortPanic` | `ErrorMsg` | failures, `panic: true` posts |
| `FlurryPortRed` … `FlurryPortTeal` | diagnostics/constants | per-seat colours from the palette |

All are `default` links, so override them anywhere and yours wins:

```lua
vim.api.nvim_set_hl(0, 'FlurryPortInfo', { fg = '#8be9fd' })  -- dracula cyan
vim.api.nvim_set_hl(0, 'FlurryPortSlug', { fg = '#50fa7b' })  -- dracula green
```

They are defined at `setup()` and re-applied on `ColorScheme`, since a scheme
switch clears highlights — `default` links included.

## Notes

**The console hosts the room.** Closing it takes the room down and drops every
seated agent — that is `#253` behaving correctly, not a bug. Mint fresh pairing
codes after a restart.

**Presence is polled, not pushed.** The wire schema has no working/heartbeat state
yet, so the strip shows what the roster knows: `live`, `held`, `idle`, or the raw
invite status. Richer presence needs a protocol addition first.

**Questions are never invisible.** A confirm (`revoke`) or an ask (the chair
identity question) forces the feed window back to the live feed before it
paints, and a `[y/N waiting]` / `[answer waiting]` marker rides the prompt until
the next submitted line answers it. The engine reserves that line for the
answer, so the marker is the truth about where your keystrokes are going.

**The presence panel sizes to content.** Its width fits the longest roster row,
recomputed on every repaint, with a floor (the empty-roster line) and a cap (40
columns or a third of the screen, whichever is smaller). Handles pad to the
longest at the table, so the state column always lines up.

**Windows.** npm global bins are `.cmd` shims and `CreateProcess` cannot execute
one, so the launch goes through `cmd.exe`. Handled in `client.lua`; nothing to
configure.
