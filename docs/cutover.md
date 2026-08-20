# Cutover

The command list. The reasoning behind the order is in the README.

Every phase is reversible. The bash script stays on disk and its cron line stays
one `#` from restoration until the last phase has survived a week.

## Phase 0: freeze what the old pipelines know

```
agent-loop check
```

It resolves `gh`, `git` and `herdr`, checks that `gh` is authenticated, warns
when herdr's protocol number is not the tested one, and validates every
discovered workspace. Give the existing bash directories a private git remote so
they are recoverable independently of the box, and delete worktrees whose pull
requests already closed: adopting a bash-era worktree is worth less than
deleting it.

## Phase 1: a shadow week

One cron line, no `--live`, its own log:

```cron
*/2 * * * * PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin flock -n ~/.agent-loop/tick.lock agent-loop tick >>~/.agent-loop/shadow.log 2>&1
```

Spell `PATH` out: cron's own does not carry `bun`, so the command dies in its
shebang before the loop runs, and it does not carry `herdr` either, so a tick
that starts still fails every pass that touches an agent.

A tick without `--live` performs every read, refuses every write at the gate in
`src/adapters/run.ts`, and leaves its own marks database alone as well, so a
week of shadow ticks records nothing the loop did not do. The one thing it does
write is a usage sample per account per tick in the global database.

Two things the week does not buy, both following from the same fact that it
spawns nothing. The router's worker rate is not measured during it: a sample
needs at least one worker in flight over the interval, so the rate stays at
`workerRateSeed` until the first live day, and the pacing model has no evidence
behind it on the day it starts deciding. And because a dry tick's marks do not
survive it, a routine that is due stays due on every tick of the week; the
spawn pass keeps walking the jobs without `--live` for exactly that reason, so
every job still reports, but the first one reports the same occurrence all
week rather than a sequence of them.

Read it back with

```
grep -E "WOULD|SKIP|IDLE|ERROR" ~/.agent-loop/shadow.log
```

and compare against the bash logs for the same minutes. Only the ticks where
either side acted are worth reading. The criterion is a full week where the
intended decisions match line for line.

## Phase 2: the routines

A routine's occurrence stamp is the one piece of state that is not derived from
the outside world, so it is the one thing that has to be imported. Without it a
routine re-runs an occurrence the old pipeline already finished, and anything
with outbound side effects does that visibly.

For each routine, record the occurrence that is running right now:

```
agent-loop adopt <job> --workspace <name>
```

For an older occurrence, name its key, which is the slot's date and time:

```
agent-loop adopt <job> 20260820-0910 --workspace <name>
```

Check the import, then check what the loop makes of it:

```
agent-loop adopt --list --workspace <name>
agent-loop tick --workspace <name>
```

The spawn line for that job must read `IDLE <job>`, which is the loop saying the
occurrence is already accounted for. Anything else on that line, a
`WOULD spawn` or a `SKIP` naming an account or a cap, means the occurrence is
still due and the stamp you wrote is not the one the loop computes. Keys are the
slot as `<YYYYMMDD>-<HHMM>`, in the box's own timezone, and an occurrence runs
from its slot until the next one begins, so the occurrence running at 08:00 with
slots at 09:10 and 21:10 is yesterday's `21:10`.

Then comment out the bash cron line and watch two occurrences.

## Phase 3: the one live reviewer

Its state is labels plus worktrees keyed by pull request, both derived, so there
is nothing to import. Pause the phase in bash, and let this one run. Both are
installed, and exactly one is unpaused.

## Phase 4: the paused service

From a clean slate. Let its remaining workers finish or remove them by hand, so
the new system starts with no inherited worktrees.

## Phase 5: the remaining build and review phases

Same shape as phase 3, one job at a time.

## Stopping

```
agent-loop pause <job> --workspace <name>     stop spawning that job
agent-loop pause --workspace <name>           stop spawning anything here
agent-loop resume <job> --workspace <name>
```

Pause takes effect on the next tick and needs no crontab edit. Sweep and monitor
keep running while a job is paused, which is deliberate: the monitor is what
takes a claim label off finished work, and a pause that froze it would
manufacture claims that lie. To stop a workspace altogether, remove its path
from `workspaces` in `~/.agent-loop/config.yml`.
