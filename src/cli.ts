#!/usr/bin/env bun
import { loadConfig } from "./config"
import { discover } from "./discover"
import { KINDS, describeKind, kindSchema } from "./kinds"
import { runCheck } from "./check"
import { TESTED_PROTOCOL } from "./adapters/herdr"
import { agentLoopHome } from "./paths"
import { pausedJobs, pauseMarker } from "./cli-pause"
import { openState } from "./state"
import { makeCtx } from "./ctx"
import { fileLock } from "./lock"
import { makeGh } from "./adapters/gh"
import { makeGit } from "./adapters/git"
import { makeHerdr } from "./adapters/herdr"
import { makeRunners } from "./adapters/run"
import { runTick } from "./engine/tick"
import { renderDecision } from "./render"
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs"
import { openGlobalState } from "./globalstate"
import { makeClaudeReader, liveClaudeDeps } from "./router/providers/claude"
import { makeCodexReader, liveCodexDeps } from "./router/providers/codex"
import { grokReader } from "./router/providers/grok"
import type { Provider, UsageReader, WorkspaceConfig } from "./types"
import { dirname } from "node:path"
import { renderStatus } from "./status"
import { adopt, renderMarks } from "./adopt"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// The one positional argument (a job name), which can appear anywhere
// after the command, not just right after it: skip every flag and, for the
// flags that take one, its value too.
const FLAGS_WITH_VALUE = ["--workspace", "--config", "--state-dir", "--global-state"]
function positionals(): string[] {
  const out: string[] = []
  const rest = process.argv.slice(3)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (FLAGS_WITH_VALUE.includes(a)) { i++; continue }
    if (a.startsWith("--")) continue
    out.push(a)
  }
  return out
}
const jobArg = (): string | undefined => positionals()[0]

const cmd = process.argv[2]
const live = process.argv.includes("--live")

if (!["tick", "check", "kinds", "pause", "resume", "status", "adopt"].includes(cmd ?? "")) {
  console.error(
    "usage: agent-loop <tick|check|kinds|status|pause|resume|adopt> [--workspace <name>]\n" +
    "                  [--config <path>] [--state-dir <path>] [--global-state <path>]\n" +
    "                  [--live] [<job>] [<key>]\n" +
    "       agent-loop adopt <job> [<key>] --workspace <name>   record a spawned mark\n" +
    "       agent-loop adopt --list --workspace <name>          print this workspace's marks",
  )
  process.exit(2)
}

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z")
// The whole process, config load and discovery included. One cron line covers
// every workspace on the box, so the interval has to cover the sum: 4.2's
// cadence rule read against one workspace's share under-sizes it in
// proportion to how many workspaces are on the box.
const processStarted = Date.now()

if (cmd === "kinds") {
  const names = Object.keys(KINDS)
  const want = jobArg()
  const chosen = want ? [KINDS[want]].filter(Boolean) : names.map((n) => KINDS[n]!)
  if (want && !chosen.length) {
    console.error(`unknown kind "${want}"; known: ${names.join(", ")}`)
    process.exit(2)
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(Object.fromEntries(chosen.map((k) => [k!.name, kindSchema(k!)])), null, 2))
  } else {
    for (const k of chosen) for (const line of describeKind(k!)) console.log(line)
  }
  process.exit(0)
}

if (cmd === "check") {
  const positional = jobArg()
  const { lines, ok } = await runCheck({
    configPath: arg("config") ?? `${agentLoopHome()}/config.yml`,
    workspaceDir: positional,
    kinds: KINDS,
    deps: {
      which: (b) => Bun.which(b),
      ghAuth: async () => makeRunners(false).runText(["gh", "auth", "status"]).then(() => true, () => false),
      protocol: () => makeHerdr(makeRunners(false).runJson).protocol(),
      herdrWorkspaces: async () =>
        (await makeHerdr(makeRunners(false).runJson).workspaces()).map((w) => w.label),
      readConfig: async (p) => (await Bun.file(p).exists()) ? Bun.file(p).text() : null,
    },
  })
  for (const line of lines) console.log(line)
  process.exit(ok ? 0 : 1)
}

// Below the read-only commands on purpose. `kinds` and `check` perform no
// writes (spec 3.5), and the README sells `agent-loop check .` as a service
// repository's CI check, where a writable home is not a given: opening the
// store above would create ~/.agent-loop/state.db for a command that only
// reads, and die with a raw EACCES stack trace before validating anything.
const globalPath = arg("global-state") ?? `${agentLoopHome()}/state.db`
mkdirSync(dirname(globalPath), { recursive: true })
const global = openGlobalState(globalPath)

const configPath = arg("config") ?? `${agentLoopHome()}/config.yml`
const config = await loadConfig(configPath)

const { workspaces: found, errors } = discover(config, {
  kinds: KINDS,
  accounts: config.accounts,
  checkSelectors: true,
})
// Reported every tick, never once: a workspace that stops ticking silently is
// the failure nobody notices.
for (const reason of errors) console.log(`${stamp()} ${renderDecision({ pass: "error", where: "workspace", workspace: "-", reason })}`)

const wsName = arg("workspace")
if (wsName && !found.some((w) => w.name === wsName)) {
  console.error(`unknown workspace "${wsName}"`)
  process.exit(2)
}
const selected = wsName ? found.filter((w) => w.name === wsName) : found

if (arg("state-dir") && selected.length !== 1) {
  console.error("--state-dir applies to one workspace; pass --workspace too")
  process.exit(2)
}

const stateDirFor = (name: string) => arg("state-dir") ?? `${agentLoopHome()}/${name}`

if (cmd === "pause" || cmd === "resume") {
  if (selected.length !== 1) {
    console.error("pause and resume apply to one workspace; pass --workspace")
    process.exit(2)
  }
  const ws = selected[0]!
  const job = jobArg()
  // Pause is the cutover and maintenance control: a typo'd job name must
  // not report success while leaving the loop free to keep spawning it.
  if (job && !ws.jobs.some((j) => j.name === job)) {
    console.error(`unknown job "${job}" in workspace "${ws.name}"`)
    process.exit(2)
  }
  const dir = stateDirFor(ws.name)
  mkdirSync(dir, { recursive: true })
  const marker = pauseMarker(dir, job)
  if (cmd === "pause") writeFileSync(marker, "")
  else if (existsSync(marker)) unlinkSync(marker)
  console.log(`${cmd}d ${job ?? "the whole workspace"}`)
  process.exit(0)
}

// status is inspection-only regardless of --live: only a tick's own spawn may
// cause a token write-back.
const readers: Record<Provider, UsageReader> = {
  claude: makeClaudeReader(liveClaudeDeps(cmd === "tick" && live)),
  codex: makeCodexReader(liveCodexDeps()),
  grok: grokReader,
}

const { runText: rt, runJson: rj } = makeRunners(live)

// Shared by the tick loop and by adopt, which needs a context only to ask a
// routine which occurrence is due right now.
const ctxFor = (ws: WorkspaceConfig, marks: ReturnType<typeof openState>) =>
  makeCtx({
    workspace: ws,
    // The full discovered list, not `selected`: concurrency is an
    // account-scoped fact across the whole box (spec 6.3 and 7), so a
    // `--workspace` run ticking one workspace must still see live workers
    // under every other one, or it over-admits against the account's ceiling.
    workspaces: found,
    config,
    now: new Date(),
    live,
    sleep: (ms) => Bun.sleep(ms),
    lock: fileLock(),
    gh: makeGh(rj, rt),
    gitFor: (repo) => makeGit(rt, repo),
    herdr: makeHerdr(rj),
    marks,
    global,
    usageFor: (a, at) => readers[a.provider](a, at),
    memAvailableMb,
    sink: (d) => console.log(`${stamp()} ${renderDecision(d, live)}`),
  })

if (cmd === "status") {
  // One instant for the whole render: "resets in Xm" must be relative to the
  // same now as the usage read that produced it.
  const now = new Date()
  const lines = await renderStatus({
    now,
    accounts: config.accounts,
    usageFor: (a) => readers[a.provider](a, now),
    refreshExpiryFor: async (a) => {
      if (a.provider !== "claude") return null
      const creds = await liveClaudeDeps(false).readCreds(a.configDir)
      return creds?.refreshTokenExpiresAt ? new Date(creds.refreshTokenExpiresAt) : null
    },
    spawnsToday: global.spawnsSince(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    workspaces: selected.map((ws) => ({
      name: ws.name,
      paused: pausedJobs(stateDirFor(ws.name), ws.jobs.map((j) => j.name)),
    })),
  })
  for (const line of lines) console.log(line)
  global.close()
  process.exit(0)
}

// Below status and above the tick: adopt is the cutover's import path
// (docs/cutover.md phase 2), so it writes the marks database on purpose and without
// --live. It touches nothing else, and no process at all.
if (cmd === "adopt") {
  if (selected.length !== 1) {
    console.error("adopt applies to one workspace; pass --workspace")
    process.exit(2)
  }
  const ws = selected[0]!
  const dir = stateDirFor(ws.name)
  mkdirSync(dir, { recursive: true })
  const marks = openState(`${dir}/state.db`)
  try {
    if (process.argv.includes("--list")) {
      for (const line of renderMarks(marks.all(), new Date())) console.log(line)
    } else {
      const [name, wanted] = positionals()
      const job = ws.jobs.find((j) => j.name === name)
      if (!job) throw new Error(`unknown job "${name ?? ""}" in workspace "${ws.name}"`)
      const { key, already } = await adopt(ctxFor(ws, marks), marks, job, wanted)
      console.log(already ? `${job.name} ${key} was already recorded` : `adopted ${job.name} ${key}`)
    }
  } catch (e) {
    console.error(String(e).replace(/^Error: /, ""))
    marks.close()
    global.close()
    process.exit(2)
  }
  marks.close()
  global.close()
  process.exit(0)
}

// MemAvailable is the kernel's own estimate of what a new process can get
// without swapping, which is the question being asked. Treat an unreadable
// /proc as unlimited rather than blocking the loop on a parse failure.
async function memAvailableMb(): Promise<number> {
  try {
    const m = (await Bun.file("/proc/meminfo").text()).match(/^MemAvailable:\s+(\d+) kB/m)
    return m ? Math.round(Number(m[1]) / 1024) : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const protocol = await makeHerdr(rj).protocol().catch(() => -1)
if (protocol !== TESTED_PROTOCOL) {
  console.log(`${stamp()} WARN herdr protocol ${protocol}, tested ${TESTED_PROTOCOL}`)
}

for (const ws of selected) {
  const stateDir = stateDirFor(ws.name)
  mkdirSync(stateDir, { recursive: true })
  const marks = openState(`${stateDir}/state.db`)
  try {
    const ctx = ctxFor(ws, marks)
    const names = ws.jobs.map((j) => j.name)
    const paused = pausedJobs(stateDir, names)
    await runTick(ctx, ws.jobs, { paused: paused.length === names.length, pausedJobs: paused })
  } catch (e) {
    // One service mid-edit or one unreachable remote must not stop the rest of
    // the box for the next two minutes.
    console.log(`${stamp()} ${renderDecision({ pass: "error", where: "workspace", workspace: ws.name, reason: String(e) })}`)
  } finally {
    marks.close()
  }
}
console.log(`${stamp()} ${renderDecision({ pass: "tick", workspace: "total", ms: Date.now() - processStarted })}`)
global.close()
