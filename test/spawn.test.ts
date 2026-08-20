import { test, expect } from "bun:test"
import { spawnOne } from "../src/engine/spawn"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Job, Decision, WorkItem } from "../src/types"

const BASE = "/b"
const item = (n: number): WorkItem => ({ id: `issue:${n}`, number: n, title: "t", state: "OPEN", labels: [] })

function ctxWith(log: Decision[], agents: any[] = [], o: { live?: boolean; onWorktrees?: () => void } = {}) {
  return makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/w/journal.md",
      herdrWorkspace: "acme", worktreeBase: BASE, repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: {
      accounts: [{ id: "loop", provider: "claude", configDir: "~/.a", reserve: 0 }],
      maxConcurrentPerAccount: 4, minFreeMb: 3000, usageMax: 90, releaseBefore: 120,
      maxSpawnsPerDay: 200, blockedTimeoutMin: 180, workerRateSeed: 0.05, workspaces: [],
    } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: o.live ?? false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {} as any,
    gitFor: () => ({
      worktrees: async () => {
        o.onWorktrees?.()
        return []
      },
    }) as any,
    herdr: { agents: async () => agents, panes: async () => [], protocol: async () => 19 } as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({
      readable: true,
      windows: [{
        kind: "session", group: "g", percent: 0,
        resetsAt: new Date("2026-08-19T13:00:00Z"),
        windowMinutes: 300, observedAt: new Date("2026-08-19T09:00:00Z"),
      }],
    }),
    memAvailableMb: async () => 8000,
    sink: (d) => log.push(d),
  })
}

function job(name: string, o: Partial<Job> & { items?: WorkItem[]; inFlight?: WorkItem[] } = {}): Job {
  return {
    name, dir: `/j/${name}`, workload: "builder", repo: "web", slots: o.slots ?? 1,
    admit: o.admit,
    guard: o.guard,
    discover: async () => o.items ?? [],
    discoverClaimed: async () => o.inFlight ?? [],
    key: async (_c, i) => `b${i.number}`,
    done: async () => false,
    brief: async () => "go",
  } as Job
}

test("under live the first spawnable item of the first job wins and the walk stops", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log, [], { live: true }), [
    job("build", { items: [item(7), item(9)] }),
    job("other", { items: [item(1)] }),
  ])
  expect(out.filter((d) => d.pass === "spawn" && d.action === "spawn")).toEqual([
    { pass: "spawn", job: "build", key: "b7", action: "spawn", account: "loop", reason: expect.any(String) },
  ])
  expect(out.some((d) => d.pass === "spawn" && d.job === "other")).toBe(false)
})

// Nothing is spawned and no dry mark survives the tick, so stopping at the
// first due item would hide every job behind it for as long as it stays due,
// which for a routine in a shadow week is the whole week.
test("without live the walk continues, so every job reports what it would do", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [
    job("build", { items: [item(7), item(9)] }),
    job("other", { items: [item(1)] }),
  ])
  expect(out.flatMap((d) => (d.pass === "spawn" && d.action === "spawn" ? [[d.job, d.key]] : []))).toEqual([
    ["build", "b7"],
    ["other", "b1"],
  ])
})

test("discover order is preserved and never re-sorted", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [job("build", { items: [item(90), item(2)] })])
  expect(out[0]).toMatchObject({ key: "b90", action: "spawn" })
})

test("admit returning a reason skips the job and names the reason", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [
    job("build", { items: [item(7)], admit: async () => "review debt 4 >= 3" }),
    job("other", { items: [item(1)] }),
  ])
  expect(out[0]).toEqual({ pass: "spawn", job: "build", key: "", action: "skip", reason: "review debt 4 >= 3" })
  expect(out[1]).toMatchObject({ job: "other", action: "spawn" })
})

test("a job at its slot limit skips", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [
    job("build", { items: [item(7)], inFlight: [item(3)], slots: 1 }),
  ])
  expect(out[0]).toMatchObject({ action: "skip", reason: "slots 1/1 in flight" })
})

test("guard false drops a candidate and the next one is taken", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [
    job("build", { items: [item(7), item(9)], guard: async (_c, i) => i.number !== 7 }),
  ])
  expect(out[0]).toMatchObject({ key: "b9", action: "spawn" })
})

test("no candidates logs idle, not throttled", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [job("build", { items: [] })])
  expect(out[0]).toMatchObject({ action: "skip", reason: "idle" })
})

test("every candidate guarded out logs a distinct reason", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [
    job("build", { items: [item(7)], guard: async () => false }),
  ])
  expect(out[0]).toMatchObject({ action: "skip", reason: "all 1 candidates guarded out" })
})

// F5
test("a job whose discoverClaimed throws is treated as declining, and the next job still spawns", async () => {
  const log: Decision[] = []
  const bad: Job = {
    name: "bad", dir: "/j/bad", workload: "builder", repo: "web", slots: 1,
    discover: async () => [item(1)],
    discoverClaimed: async () => { throw new Error("boom") },
    key: async (_c, i) => `b${i.number}`,
    done: async () => false,
    brief: async () => "go",
  }
  const out = await spawnOne(ctxWith(log), [bad, job("other", { items: [item(9)] })])
  expect(out).toContainEqual({ pass: "error", job: "bad", where: "spawn", reason: "Error: boom" })
  expect(out.some((d) => d.pass === "spawn" && d.job === "other" && d.action === "spawn")).toBe(true)
})

test("a spawn decision names the account the router picked", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [job("build", { items: [item(7)] })])
  expect(out).toEqual([
    { pass: "spawn", job: "build", key: "b7", action: "spawn", account: "loop", reason: expect.any(String) },
  ])
})

test("a starved job skips and the walk continues to the next job", async () => {
  const log: Decision[] = []
  // No account satisfies this job's requires, but the next job is fine.
  const out = await spawnOne(ctxWith(log), [
    { ...job("build", { items: [item(7)] }), requires: ["codex"] },
    job("review", { items: [item(9)] }),
  ])
  expect(out.filter((d) => d.pass === "spawn").map((d) => [d.job, d.action])).toEqual([
    ["build", "skip"],
    ["review", "spawn"],
  ])
})

test("a paused job skips without discovering or spawning", async () => {
  const log: Decision[] = []
  const out = await spawnOne(ctxWith(log), [job("build", { items: [item(7)] })], ["build"])
  expect(out).toEqual([{ pass: "spawn", job: "build", key: "", action: "skip", reason: "paused" }])
})

test("a global refusal stops the walk", async () => {
  const log: Decision[] = []
  const ctx = ctxWith(log)
  ctx.config.maxSpawnsPerDay = 0
  const out = await spawnOne(ctx, [
    job("build", { items: [item(7)] }),
    job("review", { items: [item(9)] }),
  ])
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({ job: "build", action: "skip" })
  expect((out[0] as any).reason).toContain("CAP")
})

// F5: the ctx.live branch is the only thing between a dry run and applySpawn's
// filesystem writes and the job's own prepare() hook.
test("under live the executor runs, and a throw becomes an error decision", async () => {
  const log: Decision[] = []
  let ran = 0
  const ctx = ctxWith(log, [], {
    live: true,
    onWorktrees: () => {
      ran++
      throw new Error("git is unhappy")
    },
  })
  const out = await spawnOne(ctx, [job("build", { items: [item(7)] })])
  // pre-clean's worktree listing is applySpawn's first read.
  expect(ran).toBe(1)
  expect(out[0]).toMatchObject({ pass: "spawn", action: "spawn", key: "b7" })
  expect(out[1]).toMatchObject({ pass: "error", job: "build", where: "spawn" })
  expect(String((out[1] as any).reason)).toContain("git is unhappy")
})

test("without live the executor never runs", async () => {
  const log: Decision[] = []
  let ran = 0
  const ctx = ctxWith(log, [], { onWorktrees: () => { ran++ } })
  const out = await spawnOne(ctx, [job("build", { items: [item(7)] })])
  expect(ran).toBe(0)
  expect(out.some((d) => d.pass === "error")).toBe(false)
})
