# Awake - keep the machine up while Claude Code works

> **Use a stable, well-ventilated surface, not a closed bag.** A machine that
> has been told not to sleep keeps running at full speed with the lid shut, and
> a laptop in a bag has nowhere to put that heat. Recovery can fail, and a
> running timer is not a safety guarantee.
> ([Apple's ventilation guidance](https://support.apple.com/en-us/102336))

A long Claude Code run is exactly the kind of work a machine naps through: no
keyboard, no mouse, nothing on screen moving. **Awake** holds the machine up
while any session is running or waiting on you, and/or for a timer you set, and
releases it the moment that stops being true.

The safety design here is adapted from
[Insomnia](https://github.com/krishhgg/Insomnia) (MIT), a macOS menu-bar app
for timed awake sessions: the recovery journal, the backstop that undoes it
with no app running, the battery and thermal floors, the hard session ceiling,
and reading a disable back because `pmset` can exit 0 while something else puts
the bit straight back. The design, not the code - every line here is this
project's, and the journal shape, the CLI and the panels are its own.

## Install it

```bash
./install.sh awake          # the CLI, the panel section, the recovery backstop
./install.sh awakelid       # closed-lid mode as well (EXPERIMENTAL, see below)
```

Both are opt-in and never auto-detected. `awake` installs `claudectl` if it is
missing, schedules `scripts/awake-backstop.sh` every minute (a launchd agent on
macOS, a systemd user timer on Linux, cron as a fallback) and turns the panel
section on. `./install.sh --uninstall awake` reverses it, ending any session
first.

## Use it

```bash
claudectl awake on --for 2h            # a timer
claudectl awake on --while-sessions    # hold while Claude Code is running or waiting
claudectl awake on --for 8h --while-sessions   # whichever lasts longer, up to the cap
claudectl awake status                 # what holds it, until when, what is owed
claudectl awake extend --for 30m       # push the deadline out
claudectl awake off                    # end it and give the machine back
claudectl awake recover --force        # undo what a crashed session left behind
```

`--for` takes `2h`, `90m`, `1h30m`, `1d2h`, `45s` or a bare number of minutes.
A bare `claudectl awake on` is an hour: a session with no end is the one thing
this feature must never create.

In the panels: the **Awake** section has the presets, a *While sessions* hold,
`+30m`, `Off` and - when a past session left something behind - `Recover`. The
top bar / menu bar shows the countdown while a session is held. Off by default
(`awake-enabled` / `awakeEnabled`); `./install.sh awake` turns it on.

The MCP `awake` tool reads the state and can start or stop a session in
conversation ("keep this machine awake while you work on the migration"). It
deliberately **cannot** switch closed-lid mode on.

The status line can show `awake 1:04:12` with `--segments=…,awake`. It is
silent when nothing is held, and loud (`awake? sleepDisabled`) when a session
ended without giving a setting back.

## What is actually holding the machine

A **child process**, on purpose:

| | |
| --- | --- |
| macOS | `caffeinate -i -w <holder pid>` |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block --who=claude-usage-panel --why=… sleep <n>` |

The kernel releases the assertion when that child exits, so a holder that
crashes, is force-quit or is `SIGKILL`ed cannot leave a laptop awake. The Linux
child is bounded by its own `sleep`, so even an orphan expires on time.

One holder at a time, recorded in `session.json` with its pid and host. A
second starter sees the live owner and refuses rather than double-holding.

## When a session ends

A session ends on the first of:

- **its deadline** - every session has one, always;
- **the last Claude Code session going away**, for a `--while-sessions` hold
  with no `--for` of its own (a session parked on a permission prompt still
  counts: an unanswered prompt is exactly when the machine must not drop off);
- **the hard ceiling**, 12 hours, measured from *now* on every extension - so
  no chain of `+30m` can walk a laptop through the night;
- **a battery or thermal floor** (below);
- **you**, through `claudectl awake off`, the panel's `Off`, or the MCP tool.

## Battery and thermal floors

Holding a laptop awake on battery is the one case where this feature can do
real harm, so the rules end the session rather than warn about it.

| Reading | What happens |
| --- | --- |
| Battery below the **low-power floor** (default 40%) on battery power | Low Power Mode on (macOS) |
| Battery below the **end floor** (default 10%) on battery power | the session ends |
| A battery that is **present but unreadable** twice in a row, on battery power | the session ends - a floor cannot be applied to a level nobody can read |
| Thermal state **serious** | Low Power Mode on |
| Thermal state **critical** | the session ends |
| Charger connected / back above the floor / cooled down | Low Power Mode off again, if we were the ones who switched it on |

A desktop has no battery and therefore no floor. Setting the end floor to 0
turns the battery end off; the two floors cannot cross (the low-power one is
raised out of the way, because the end floor is the one that protects the
machine).

Linux has no single "Low Power Mode" to switch, so there the floors end a
session but never change a power mode. The thermal state comes from the hottest
`/sys/class/thermal/thermal_zone*/temp` (serious at 85 °C, critical at 95 °C -
a heuristic: there is no portable "serious" bit), and on macOS from what the
system itself reports, with `pmset -g therm` as a fallback.

The floors live in the preferences (GNOME: *Integrations ▸ Awake*; macOS:
*Settings ▸ Sessions ▸ Awake*) and are written to
`<state dir>/claude-usage-panel/awake/config.json`, which is where the holder,
the CLI and the MCP tool read them - so one machine has one set of floors
whichever surface started the session.

## Closed-lid mode

**Experimental, off by default, and a separate install step.** With sleep
disabled, closing the lid no longer suspends the machine: it keeps running at
full speed, in a space with no airflow, with the display and keyboard backlight
left to the OS. Read the warning at the top of this page before you turn it on.

`claudectl awake on --for 2h --lid`, or the panel's `Awake` controls while
*Keep running with the lid closed* is on in the preferences. It is **never
implied by a click**: turning the section on does not turn lid mode on, and the
MCP tool cannot reach it at all.

### macOS

`./install.sh awakelid` writes `/etc/sudoers.d/claude-usage-panel-awake`,
validated with `visudo -c` and then *proven* with `sudo -n -l` before anything
trusts it. It grants your account exactly four commands and nothing else:

```text
<you> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1
<you> ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0
<you> ALL=(root) NOPASSWD: /usr/bin/pmset -b lowpowermode 1
<you> ALL=(root) NOPASSWD: /usr/bin/pmset -b lowpowermode 0
```

Every call is `sudo -n`, which never prompts: without the rule it fails fast
with a readable error instead of hanging a menu bar on a password prompt. The
grant is not exclusive to this project - any process running as your account
can invoke those four commands too. `./install.sh --uninstall awakelid` removes
the file, after giving sleep back.

A disable is **read back** five seconds later. `pmset` can exit 0 while another
process puts `SleepDisabled` straight to 0 again (another keep-awake tool doing
exactly that is how Insomnia found a closed lid sleeping a Mac mid-session), so
a lid mode that cannot be proven on is reported as failed rather than trusted.

### Linux

Nothing privileged at all: a `systemd-logind` inhibitor,
`systemd-inhibit --what=handle-lid-switch --mode=block`, taken as your own
user. It needs no root, changes no system file, and goes away with the holder.

polkit allows `org.freedesktop.login1.inhibit-handle-lid-switch` for a local,
active session by default. If yours refuses it (a hardened policy, or a remote
session), the holder logs `lid mode NOT on` and the ordinary idle/sleep hold
still works - closing the lid will suspend the machine. Granting it is a policy
decision for your machine; see `man 8 systemd-logind` and your distribution's
polkit rules.

**No `logind.conf` drop-in is installed.** Editing `HandleLidSwitch` would
change how the lid behaves for every program and every future session, and
would survive a crash of ours; an inhibitor cannot. That trade is not worth
making while the inhibitor works.

## Recovery: what happens if it all goes wrong

Everything above is built so that *nothing persistent is changed where that can
be avoided*. On Linux it never is - both inhibitors are child processes, so the
recovery journal there is always clean and every backstop run is a no-op.

macOS closed-lid mode and Low Power Mode are real system settings, so they get
the full treatment:

1. **The journal is written first.** Before `pmset` is run,
   `<state dir>/claude-usage-panel/awake/journal.json` records that the setting
   is about to be owned, with the session's deadline.
2. **A flag is cleared only after its undo succeeded.** A failed undo leaves
   the claim standing, so the next run retries it.
3. **The backstop repairs it with nothing of ours running.**
   `scripts/awake-backstop.sh` runs every minute and needs no node, no Swift
   and no panel: it reads the journal, and if the session it belongs to has
   been over for two minutes, runs the two `sudo -n pmset` undos itself. A run
   that cannot take the lock does nothing and exits 75; the next minute retries.
4. **Nothing is ever left silently.** While a journal is dirty and its session
   is over, the GNOME dropdown, the macOS popup and the status line all say so,
   with a `Recover` button next to it.

The store, all mode 0600 in a 0700 directory:

| File | What it holds |
| --- | --- |
| `session.json` | what is being held, by whom (pid + host), until when |
| `journal.json` | what the machine owes back |
| `config.json` | the floors and the ceiling, written by the panels |
| `.hold.lock` | the mutex the holder and the backstop share around "read, decide, change, write" |
| `awake.log` | what the holder did, one line per event |

Check it any time:

```bash
scripts/awake-backstop.sh --status     # what the journal says; changes nothing
claudectl awake status                 # the same, plus what is holding it
```

## Troubleshooting

**`claudectl awake on` says "the holder did not start".** The detached holder
writes `session.json` under the lock; if it never appears, its log says why.
`cat "$(claudectl awake status --json | grep -o '\.\.\./awake')/awake.log"` is
awkward - just look in `~/.local/state/claude-usage-panel/awake/awake.log`
(macOS: `~/Library/Application Support/claude-usage-panel/awake/awake.log`).

**"lid mode NOT on (command-failed): sudo: a password is required".** The
sudoers rule is not installed: run `./install.sh awakelid`. The ordinary hold
is unaffected.

**"lid mode NOT on (reverted)".** `pmset` accepted the change and something put
it back within five seconds. Another keep-awake tool with a root helper is the
usual cause; the session continues without lid mode, which is the honest
outcome.

**The machine still slept.** An inhibitor blocks *idle* sleep and the lid, not
a sleep you ask for, a low-battery emergency sleep, or a thermal shutdown. On
Linux, `systemd-inhibit --list` shows whether the hold is actually registered.

**A session ended by itself.** `claudectl awake status` names the reason
(`timer`, `sessions`, `max-session`, `battery`, `battery-unreadable`,
`thermal`, `user`), and `awake.log` has the line.
