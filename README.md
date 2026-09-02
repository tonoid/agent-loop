# agent-loop: run coding agents on a schedule, across accounts, unattended

Runs autonomous coding agents against your repositories on a schedule,
unattended, across several provider accounts, without exhausting any of them
and without starving the humans who share those accounts.

**agent-loop is built on [herdr](https://herdr.dev), and not incidentally.**
herdr is where the workers live. This project never starts a process of its
own: every worker is a herdr agent running in a herdr pane, and herdr is the
only thing that can tell the loop whether that worker is still working, is
blocked on a question, or is gone. Take herdr away and nothing here has
anywhere to run. If you are looking for something that shells out to an agent
binary and waits on an exit code, this is not it, and [the section
below](#how-it-uses-herdr) is the fastest way to find that out.

Built against **herdr 0.8.0, protocol 19**.

[![npm](https://img.shields.io/npm/v/@tonoid/agent-loop?logo=npm)](https://www.npmjs.com/package/@tonoid/agent-loop)
[![License MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/tonoid/agent-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/tonoid/agent-loop/actions/workflows/ci.yml)

**Who it's for**: anyone already running coding agents by hand who wants them
to run overnight instead, across more than one provider account, without a
human deciding which account and without waking up to an exhausted quota.

**Keywords**: unattended Claude Code, autonomous coding agent scheduler, run
Claude Code on cron, multiple Claude accounts, agent orchestration, git
worktree per agent, GitHub issue to pull request automation, AI code review
bot, quota-aware agent router, self-hosted agent runner, herdr.

> ⚠️ **Disclaimer**: the code in this project was generated with
> [Claude Code](https://claude.com/claude-code) (Anthropic), then **tested and
> reviewed manually** by a human. It is provided as is, without warranty.
> Before pointing it at a repository you care about: read the Safety and
> Limitations sections below in full, give it its own provider account, and run
> it without `--live` first, which performs every read and refuses every write.
> A loop you have never watched dry-run is a loop you do not know. Issues and
> PRs welcome.

```
$ agent-loop status

loop: session 1.0% resets in 275m, weekly_all 46.0% resets in 4235m, weekly_scoped 14.0% resets in 4235m
loop: refresh token expires in 25d
main: session 8.0% resets in 175m, weekly_all 95.0% resets in 4475m, weekly_scoped 29.0% resets in 4475m
main: refresh token expires in 13d
spawns today: 3
acme: paused nothing
```

A tick is one pass over every workspace. This is the whole operator view, and
what cron writes to the log every two minutes:

```
$ agent-loop tick --live

SPAWN build b412 on loop (session 13.0% of 90.0 with 156m left -> 1 workers, 0 in flight)
BUSY digest 20260820-0610 (agent working)
HOLD review r408 (blocked 12m < 180m)
DONE digest 20260820-0610 (done() true)
SWEEP build /home/u/projects/acme/wt-build-b397 (done(b397))
IDLE review
TICK acme 2949ms
TICK total 2987ms
```

Without `--live` every one of those verbs reads `WOULD spawn`, `WOULD sweep`,
and nothing is written: the gate in `src/adapters/run.ts` refuses any command
outside the read allowlist.

## Install

```
npm i -g @tonoid/agent-loop
agent-loop kinds     # prints the job kinds: enough to prove the install
```

npm is the delivery mechanism, not the runtime. The package ships its
TypeScript sources rather than a bundle, nothing is compiled at install time,
and there are no runtime dependencies to fetch: the tarball is the `src/` tree,
the `briefs/` the engine reads at spawn time, and the docs. The CLI's shebang is
`#!/usr/bin/env bun`, so **bun has to be on the PATH of whoever runs it**. On a
box without bun the install succeeds and the first run fails with
`env: bun: No such file or directory`.

To run a checkout as the real command instead, see [Development](#development).

## Prerequisites

- [herdr](https://herdr.dev) (`curl -fsSL https://herdr.dev/install.sh | sh`),
  running, with a workspace whose label matches each `herdrWorkspace` you
  configure. This is the hard dependency: see above. The npm package named
  `herdr` is an unrelated placeholder.
- `gh`, authenticated, against a GitHub repository with issues and labels
  enabled. Labels are the state machine. There is no GitLab support.
- `bun`, `git`, `cron`, and `flock`.
- Each account's agent must already trust the directory worktrees are created
  in. A fresh worktree is a path the agent has never seen, so it opens on a
  trust prompt, reports itself idle while it waits there, and swallows the brief
  it is then sent. Trusting `worktreeBase` once per account config directory
  covers every worktree made under it. For Claude Code that is
  `projects["<worktreeBase>"].hasTrustDialogAccepted` in
  `$CLAUDE_CONFIG_DIR/.claude.json`; trust is inherited by descendants, so the
  base is enough and each new worktree needs nothing. `agent-loop check`
  warns for any account missing it.

## Commands

```
agent-loop tick [--workspace <name>] [--live]   one pass over every workspace
agent-loop check [<workspace folder>]           validate config and jobs
agent-loop kinds [<kind>] [--json]              a kind's options, or its schema
agent-loop status [--workspace <name>]          accounts, quota, paused jobs
agent-loop pause|resume [<job>] --workspace <n> stop spawning; sweep and
                                                monitor keep running
agent-loop adopt <job> [<key>] --workspace <n>  record a spawned mark without
                                                spawning: the cutover's import
agent-loop adopt --list --workspace <n>         this workspace's marks
```

`agent-loop check .` needs no `~/.agent-loop/config.yml`, so a service
repository can run it in its own CI and catch a broken `job.yml` at the commit
that broke it.

## Configure

One machine file, never versioned:

```yaml
# ~/.agent-loop/config.yml
accounts:
  - { id: loop, provider: claude, configDir: ~/.claude-loop, reserve: 0 }
  - { id: main, provider: claude, configDir: ~/.claude, reserve: 40 }

workspaces:
  - ~/projects/acme/loops
```

Four knobs govern how much of an account the loop is willing to spend.

| Field | What it does |
|---|---|
| `reserve` | The share of the account's quota the loop will never claim, so a human sharing it always has that much left. |
| `reservePerWeekday` | Holds back that much for each weekday the human still has before the window resets, so the reserve shrinks as the week burns down. The flat `reserve` is the floor under it. |
| `weekendWeight` | What an hour of a weekend is worth against an hour of a weekday, `0.25` by default, so a weekend keeps a small assignment instead of none. |
| `soleConsumer` | That loop workers are the only thing spending this account, so its usage deltas measure a worker rather than a person. |

`reservePerWeekday` is integrated by the hour rather than counted in whole days,
so it eases off through the day instead of dropping at midnight, and a weekly
quota resetting on Sunday is one working day away rather than three. Keep the
flat `reserve` for short windows: five hours is a twelfth of a weekday, so the
curve prices a session window at almost nothing.

Set `soleConsumer` only where it is true. The worker rate is an EWMA per
provider, not per account, so a single sample taken while a human was typing
teaches every account that a worker costs several times what it does, and the
whole box starves at once. A zero `reserve` does not imply it: that says nothing
is held back, not that nobody else is spending.

One folder per service, versioned with the service it drives. Name it for what
it holds rather than for this engine: `agent-loop` is the thing that runs, and
a folder of that name sitting beside a service's repositories reads like a
checkout of it.

```
~/projects/acme/loops/
  workspace.yml
  build/    job.yml  brief.md
  review/   job.yml  brief.md
```

```yaml
# workspace.yml
name: acme
herdrWorkspace: acme      # the LABEL of a herdr workspace that must exist
worktreeBase: ..          # worktrees land beside the repos
repos:
  web: ../web
naming:
  labels: { claim: agent-wip, failed: agent-failed, park: needs-human, priority: [bug] }
  mergeMethod: squash
```

```yaml
# build/job.yml
kind: builder             # see `agent-loop kinds`
repo: web
slots: 1
order: 20                 # reviewers before builders
model: sonnet             # optional; the agent's own alias or full model id
brief: { extends: default/build, append: ./brief.md }
options:
  base: origin/develop
```

`model` belongs to the job, not the account, because the router picks the
account by headroom: the same job has to run the same model wherever it lands.
Spend it where an error is unrecoverable or unreviewed, and save it where
something downstream checks the work.

Three kinds ship. `agent-loop kinds` prints their options.

```yaml
# review/job.yml
kind: reviewer
repo: web
slots: 2
order: 10                 # reviewers before builders
distinctFrom: true        # not the account that built it
brief: { extends: default/review, append: ./brief.md }
options:
  identity: closing-issue
  rounds: 3
  headRef: build/            # only branches this job's builder opens
  filing: { queue: build, maxOpen: 40, perRound: 2, dedupeBy: path }
```

Set `headRef` on any reviewer whose repository also carries pull requests from
people. Without it the reviewer discovers every open one, and the first thing it
does to a candidate is claim it, so a human's branch ends up behind the claim
label until somebody notices.

```yaml
# digest/job.yml
kind: routine
repo: web
order: 5
ignoresSpawnCap: true     # a scheduled slot is not what the cap is aimed at
brief: { extends: default/routine, append: ./brief.md }
options:
  at: ["09:10", "21:10"]
  days: [mon, tue, wed, thu, fri]  # optional; every day when unset
  doneWhen: ~/reports/{{key}}.md   # the artifact that ends the occurrence
```

`ignoresSpawnCap` exempts a job from `maxSpawnsPerDay`, the box-wide runaway
breaker. Set it on the jobs that spawn a handful of times a day on a schedule:
the cap is sized for whichever workspace on the box actually loops, and when
one of those spends the day's budget in an hour, a routine that shares the box
misses its slot for something it has nothing to do with. Exempt spawns are
still counted, so they show in the day's total and shorten what the capped jobs
have left. The account's own `reserve`, `usageMax` and `maxConcurrent` still
pace an exempt job.

Give a routine a `doneWhen` whenever its run produces one. Without it the only
signal a routine has is its worktree disappearing, and that waits for the next
slot: a run that finished at 09:38 is nudged at 09:40 and failed at 09:42 for
having succeeded.

`filing` is backpressure. The budget is computed from the depth of the queue
the reviewer files into, so it closes on its own when the builder falls behind
and reopens when it catches up. The brief carries the budget to the worker, and
the loop audits what was actually filed when the run is swept, logging
`OVERFILED` with the numbers.

A routine is due across a window, from its slot until the next one begins, so a
slot missed to a reboot fires once on the first tick back inside its window and
never fires stale. Backlog consolidation is a routine rather than engine code: point its `brief.append` at the clustering procedure
you already use.

Paths in these two files resolve against the file's own folder, and neither
holds a secret, so the folder checks out on another box and works. The folder
name is the job name, and it names the branches and worktrees that job owns.

Check it before you schedule it:

```
agent-loop check
```

That resolves every repo path, verifies each `herdrWorkspace` label against the
workspaces herdr actually has, and warns for any account that has not yet
trusted the worktree base. All three are things that otherwise surface as a
failure per due item, every two minutes, at four in the morning.

## Run

One cron line for the whole box. Workspaces arrive by discovery, so this line
is installed once and never edited again:

```cron
*/2 * * * * PATH=/home/you/.bun/bin:/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin flock -n ~/.agent-loop/tick.lock agent-loop tick >>~/.agent-loop/tick.log 2>&1 || echo "$(date -Is) tick did not run: lock held or command failed" >>~/.agent-loop/tick.log
```

`PATH` is set on the line because cron's own is short. `agent-loop` is a bun
script, so its shebang needs `bun` on the path to run at all, and the loop then
shells out to `herdr`, `gh` and `git`, which have to be found too. Point it at
wherever `which bun` and `which herdr` say. The failure message is deliberately
vague: `flock` exits 1 for a lock it could not take, and so does a command that
was simply broken, so a line claiming "previous still running" would hide the
second case.

Without `--live`, a tick performs every read and logs every intended write
without making one: the gate in `src/adapters/run.ts` refuses any command
outside the read allowlist. Run it that way for a week first.

Two minutes is a starting point, not a law. Keep the interval at four times
the p95 of the `TICK total <ms>` lines in your log or more. That line is the
whole process, every discovered workspace included, which is what the interval
has to cover. The `TICK <workspace> <ms>` line above it is one workspace's
share, useful for finding which service is slow and wrong to size the
interval against.

Moving existing cron-driven pipelines onto this loop has an order that keeps
every step reversible: `docs/cutover.md`.

## How it uses herdr

A tick decides what ought to be running. Everything it then does to a worker,
it does through the `herdr` CLI:

| What the loop needs | herdr call |
|---|---|
| the workspace a job's tabs belong in | `workspace list`, matched on the `herdrWorkspace` label |
| a worker | `tab create --workspace <id> --cwd <worktree> --label <job>-<key> --env <VAR>=<account config dir> --no-focus` |
| the pane that tab just opened | `pane list`, matched on cwd |
| the agent itself | `agent start <name> --kind <provider> --pane <id> -- <account startArgs>` |
| the brief delivered | `agent prompt <pane> <brief> --wait --until working` |
| whether they are alive | `agent list` for the whole fleet, `agent get <pane>` for one |
| why it is stuck | `agent read <pane> --source recent-unwrapped --lines <n>` |
| a composer holding unsent text | `agent send-keys <pane> Enter` |
| the worker gone | `tab close <tab>` |
| you, when a worker is blocked | `notification show <title> --body <text>` |
| a supported herdr | `api schema --json` for the protocol number |

Three consequences worth knowing before you read the code, because each one
shaped it:

**`agent_status` is the whole lifecycle.** A worker has no exit code and no pid
here. `working`, `blocked` and `idle` are the only states the loop can observe,
and every decision the monitor makes is built from one of those, the pane still
being listed, and the worktree still being on disk. `blocked` notifies you once
and then escalates on a timer; an agent that has vanished while its pane is
still up is restarted exactly once, and one whose pane went with it has failed.
A status herdr does not recognise becomes `missing`, which deliberately does
nothing at all: holding cannot kill a live agent or tombstone an item, so a
herdr that adds or renames a state stalls this loop rather than damaging
anything with it.

**`tab create` is the only verb that accepts `--env`.** That single flag is the
entire channel by which the router's account choice reaches a worker, which is
why the account is decided before the tab exists and can never be changed
after. It is also why `configEnv` is an account-level setting: `CLAUDE_CONFIG_DIR`
for Claude Code, `CODEX_HOME` for Codex.

**herdr ids are not stable.** A pane id changes between rounds of the same
logical worker, and a workspace id lasts until the herdr server restarts and
then names somebody else's workspace. Nothing here caches one: the workspace is
looked up by label and the pane by cwd, on every single spawn.

Six of those verbs are reads: `workspace list`, `pane list`, `agent list`,
`agent get`, `agent read` and `api schema`. Every other one is a write. Without
`--live` the gate in `src/adapters/run.ts` permits exactly those six and refuses
the rest by name, so a dry tick can survey your entire fleet and is incapable of
touching it.

`agent-loop check` compares your herdr's protocol number against the one this
was tested on and warns when they differ. It never refuses to run on a
mismatch: a newer herdr is usually fine, and a loop that stops dead at 2am
because a dependency was upgraded is worse than one that says so and carries on.

## Workers

A worker starts in the account's own config directory, so it inherits whatever
lives there, including hooks written for a human at a keyboard. Those fire on
every session start, every turn end and every session exit, which for an
unattended fleet is only noise. Start workers with the user settings source
excluded and the parts you still want passed back explicitly:

```yaml
startArgs:
  - "--dangerously-skip-permissions"
  - "--setting-sources"
  - "project,local"
  - "--settings"
  - "/home/you/.agent-loop/worker-settings.json"
```

Excluding a source drops all of it, permission rules included, so
`worker-settings.json` has to carry those back. Copy the `permissions` block
from the account's own settings into it and leave the hooks behind.

That leaves one signal. When a worker blocks on a question nobody is going to
answer, the loop sends a `herdr` notification, once per item rather than once
per tick, and only under `--live`. It is the only thing the loop will interrupt
you for, which is what makes it worth reading.

## Limitations

- GitHub only. Labels are the state machine and every read goes through `gh`,
  so there is no GitLab, Gitea or Forgejo support and adding one is not a small
  change.
- Workers run unsandboxed as you, with permission prompts disabled. That is
  what makes them autonomous. Give the loop its own account and its own
  worktree base, and read `briefs/default/core.md`, which is the contract every
  worker works under.
- One box. State lives in `~/.agent-loop/`, the daily spawn cap and the
  in-flight count are per machine, and two machines sharing one provider
  account do not know about each other.
- The `grok` provider is wired but unverified: set `configEnv` on the account
  before routing real work to it. `claude` and `codex` are the tested ones.
- The herdr protocol is pinned to one tested number. A newer herdr warns and
  runs; a herdr that renames `agent_status` stalls the monitor rather than
  breaking it.

## Reading the source

Comments cite a numbered design document (`spec 3.5`, `spec 7`, `spec 4.2`).
That document is the specification this was written against and is not carried
in the repository. The numbers are stable and nothing in the code needs it: the
README and `agent-loop kinds` are the current reference, and every rule the
spec states is enforced by a test that names it.

## Development

```
git clone https://github.com/tonoid/agent-loop
cd agent-loop
bun install
bun test
```

The suite is hermetic: no network, no `gh`, no herdr, no writes outside a
temporary directory. `bun run test:live` opts in to a real herdr and is skipped
unless `AGENT_LOOP_LIVE_HERDR=1`. CI runs `bun run typecheck` and `bun test` on
every push and pull request.

To run the checkout as the real command, so `git pull` updates the loop:

```
bun link          # puts agent-loop in ~/.bun/bin
```

That is worth knowing before you edit anything: with the checkout linked, cron
runs your working tree, so an unfinished edit is live within one tick.

## Releasing

Versions come from the commit messages, so land work on `main` with
[conventional commits](https://www.conventionalcommits.org):

| Prefix | Effect |
|---|---|
| `fix: ...` | patch, 1.0.0 to 1.0.1 |
| `feat: ...` | minor, 1.0.0 to 1.1.0 |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major, 1.0.0 to 2.0.0 |
| `docs:`, `chore:`, `test:`, `refactor:` | no release |

The `release` workflow runs release-please on every push to `main`. It keeps a
single release PR open ("chore(main): release X.Y.Z") holding the version bump
and the new `CHANGELOG.md` section. Nothing publishes while that PR sits there.
Merging it tags `vX.Y.Z`, cuts the GitHub release, and triggers the publish job,
which runs the typecheck and the suite and then `npm publish` with the
`NPM_TOKEN` repository secret.

`.release-please-manifest.json` is the source of truth for what ships next, so
let release-please edit it rather than bumping `package.json` by hand.

Published releases carry npm [provenance](https://docs.npmjs.com/generating-provenance-statements),
which links the tarball to the workflow run that built it. That needs the
`id-token: write` permission the publish job already declares, and a **public
repository**: the registry rejects a provenance bundle built from a private one,
and it does so after the tag and the GitHub release already exist.

When herdr changes its protocol, bump `TESTED_PROTOCOL` in
`src/adapters/herdr.ts` and the version named at the top of this file. A
mismatch is a warning from `agent-loop check`, never a refusal to run, so this
is bookkeeping: the point is that a warning which is always on is worth nothing.

## Contributing

Issues and pull requests are welcome:
[github.com/tonoid/agent-loop/issues](https://github.com/tonoid/agent-loop/issues).

A new job kind is the most useful thing you can add. Kinds are a closed
registry rather than a plugin system (`src/kinds/`): implement `check`, `build`
and `validateOptions`, register it, and `agent-loop kinds` documents it for
free. Land work with [conventional commits](https://www.conventionalcommits.org)
so the release notes write themselves, and run `bun run typecheck && bun test`
before opening the pull request.

## Safety

This tool starts AI coding agents and lets them work unattended, so read this
before pointing it at anything you care about.

Workers run with permission prompts disabled, as your user, with no sandbox.
They create branches, push them, open pull requests, apply labels, leave
comments, and depending on the job's `mergeMode` they merge. Nobody approves
any of that at the time it happens: that is the entire point of the loop, and
it is also the risk. Everything they produce is machine-generated and has had
no human review unless you review it.

They also spend real quota on real accounts. The router holds back whatever
`reserve` you configure and stops at `maxSpawnsPerDay`, but a misconfigured
loop can still burn a week's allowance in an afternoon.

Give it its own provider account and its own worktree base, keep it away from
repositories where an unreviewed merge would matter, and treat the pull
requests it opens as drafts from a fast, tireless colleague who is sometimes
confidently wrong. The MIT warranty disclaimer is not a formality here.

Not affiliated with Anthropic, OpenAI, xAI or GitHub. Claude, Claude Code,
Codex and Grok are trademarks of their respective owners.

## Credits

**Created and maintained by [tonoid](https://www.tonoid.com)** - A microstartup
studio building services like [2sync.com](https://2sync.com) or
[refurb.me](https://www.refurb.me).

| | |
|---|---|
| 💼 All tonoïd projects | [tonoid.com/projects](https://www.tonoid.com/projects) |
| 📬 Contact | hello@tonoid.com |
| 🐙 GitHub | [github.com/tonoid](https://github.com/tonoid) |

## License

[MIT](./LICENSE) © [tonoid.com](https://tonoid.com).

---

**GitHub topics**: `claude-code` `codex` `ai-agents` `autonomous-agents` `agent-orchestration` `herdr` `cron` `scheduler` `git-worktree` `github-automation` `devops` `typescript` `bun` `self-hosted`
