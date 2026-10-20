# peak-guard · dsh-peak-guard

A DeepSeek Harness plugin that **freezes thinking during DeepSeek peak-rate hours**: no model
request, no tokens spent, until you say "continue" or the off-peak window starts. A dedicated
sidebar panel toggles the guard, shows its state and lets you **edit the peak windows**.

Default schedule follows DeepSeek's published time-of-day pricing (Beijing time, UTC+8):

| Window | Rule |
|---|---|
| Peak | Monday–Friday (except public holidays), **09:00–12:00 and 14:00–18:00** |
| Off-peak | everything else: 12:00–14:00, 18:00–next 09:00, weekends, public holidays |

Intervals are half-open: 09:00 sharp is peak, 12:00 sharp is off-peak.

## How it freezes

The guard hooks `agent/pre-step` — the moment a turn claims its inbox before each step. During a
peak window it returns `{ kind: 'reject' }`, so `agent-loop` closes the turn as `blocked` and
**never issues a model request**. Nothing is spent.

Messages that were already claimed are put back into the inbox (`next-step`, de-duplicated by id),
so your input is not swallowed — it is processed once the guard resumes.

## Three ways to resume

1. **Just say it**: the next message is exactly `继续` / `继续任务` / `继续吧` / `峰时继续` /
   `强制继续` / `resume` / `continue` (case- and whitespace-insensitive, up to 24 characters).
   That turn runs, and the current peak window is exempted.
2. **Wait for off-peak**: while frozen, a timer is armed for the end of the window +1s; when it
   fires, every idle session that still holds input gets a wake-up message and continues by itself.
3. **Manually**: the panel's *Resume now*, the status strip above the composer, or `/peak resume`.

## UI

A dial icon sits in the sidebar (**peak-guard**); it opens the plugin's own main panel, not a
Settings row:

- **Master switch** — turning it off immediately releases every frozen turn; peak hours then run
  like any other hour.
- **Peak windows** — edit which daily ranges count as peak, in 30-minute steps (default
  `09:00–12:00`, `14:00–18:00`). Add, remove, change, reset to defaults; nothing applies until you
  press *Save*, and invalid input (empty, reversed, overlapping, more than 8 windows) is rejected by
  the host with a reason.
- **Current state** — peak or off-peak, the active window, next peak, how many turns and messages
  are held, the exemption deadline, the state file location.
- **Actions** — *Resume now* (exempt this window), *Clear exemption*.

A status strip above the composer appears only while frozen or exempt.

Both faces share a store polling every 20s: `GET /plugins/peak-guard/state` and
`POST /plugins/peak-guard/action` (`set-enabled` / `set-windows` / `resume` / `clear-override`)
on the host's own origin.

## Slash commands

| Command | Effect |
|---|---|
| `/peak` | print the current state |
| `/peak on` / `/peak off` | toggle the guard (turning it off releases frozen turns) |
| `/peak resume` | resume now and exempt the current peak window |
| `/peak freeze` | clear the exemption and freeze again |

## Configuration

Defaults live in `cordis.patch.yml` and can be overridden from the plugin config:

```yaml
enabled: true          # initial master switch
autoResume: true       # wake sessions when off-peak starts
offsetMinutes: 480     # timezone offset (480 = UTC+8)
windows:               # peak windows, [start hour, end hour); fractional hours allowed (9.5)
  - [9, 12]
  - [14, 18]
holidays:              # public holidays: 'YYYY-MM-DD' or a repeating 'MM-DD'
  - '2026-10-01'
```

`holidays` is empty by default, and **empty means "conservative": treat every weekday as peak**.
Weekends are always off-peak (even make-up workdays), no configuration needed.

State is stored in `$DSH_HOME/peak-guard/state.json` (switch, **windows saved from the panel**,
exemption deadline, pause counter) and survives restarts. Windows saved in the panel win over
`windows` in `cordis.patch.yml`.

## Limits

- Freezing is per **turn and step**: the generation already in flight finishes normally.
- Only new steps are blocked; tool calls already queued will run.
- Messages you send while frozen stay queued and are **not written to the transcript** (the turn is
  closed as `blocked`, so no `user/message` is appended). They survive a page refresh in the queue,
  but don't send something important once and refresh the page.
- A process restart keeps the switch and the windows, but the frozen queue and timers do not carry
  over.
- Day boundaries are computed from a fixed `offsetMinutes`, not the IANA database; timezones with
  DST need `offsetMinutes` adjusted by hand.
- **Host-half changes require restarting DSH**: a running host never hot-swaps an already loaded
  Host module (the Web half only needs a page refresh). The panel detects an old host and makes the
  window editor read-only with a hint.

## Install / uninstall

```powershell
# install from this directory
dsh plugin install .

# or point at any path
dsh plugin install /path/to/dsh-peak-guard
```

Inside the Harness you can also point `plugin_manager install_bundle` at this directory. Then refresh
the page: the sidebar icon, the panel and the composer strip appear. Uninstall from
*Settings → Plugins*.

## Development

```powershell
node tests/smoke.mjs    # host logic: reject / inbox restore / exemption / switch / routes / windows
node tests/client.mjs   # web half: three slot registrations, panel render, edit + save, dock
```

Both suites run the real code against a fake ctx / fake browser; DSH does not need to be running.

Files: `host.js` (Host half, zero dependencies, Node builtins only), `client.js` (Web half, a
`window.__ModuleLoader__` factory), `locale/`, `icon.svg`, `cordis.patch.yml`.

## License

MIT
