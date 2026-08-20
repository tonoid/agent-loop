import { test, expect } from "bun:test"
import { runTick } from "../src/engine/tick"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import { renderDecision } from "../src/render"
import type { Job, Decision, WorkItem } from "../src/types"

const BASE = "/b"
const item = (n: number, state: "OPEN" | "MERGED" = "OPEN"): WorkItem => ({
  id: `pr:${n}`, number: n, title: "t", state, labels: ["agent-wip"],
  url: `https://example.test/acme/web/pull/${n}`,
})

function build(log: Decision[], paused = false, o: {
  live?: boolean
  claimed?: WorkItem[]
  items?: WorkItem[]
  worktrees?: { path: string; branch: string | null }[]
} = {}) {
  const calls: any[][] = []
  const ctx = makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/w/journal.md",
      herdrWorkspace: "acme", worktreeBase: BASE, repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: { blockedTimeoutMin: 180, accounts: [] } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: o.live ?? false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: { label: async (r: string, k: string, n: number, x: any) => { calls.push(["label", r, k, n, x]) } } as any,
    gitFor: () => ({
      worktrees: async () => o.worktrees ?? [{ path: `${BASE}/wt-review-r80`, branch: "review/r80" }],
      lsRemote: async () => [],
    }) as any,
    herdr: { agents: async () => [], panes: async () => [], protocol: async () => 19 } as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "not used by this test" }),
    memAvailableMb: async () => 8000,
    sink: (d) => log.push(d),
  })
  const p: Job = {
    name: "review", dir: "/j/review", workload: "reviewer", repo: "web", slots: 2,
    discover: async () => o.items ?? [item(9)],
    discoverClaimed: async () => o.claimed ?? [item(5)],
    key: async (_c, i) => `r${i.number}`,
    done: async () => true,
    brief: async () => "go",
  }
  return { ctx, p, paused, calls }
}

test("passes run in order: gc, sweep, monitor, spawn", async () => {
  const log: Decision[] = []
  const h = build(log)
  const out = await runTick(h.ctx, [h.p], { paused: false })
  const order = out.map((d) => d.pass)
  expect(order).toEqual(["gc", "sweep", "monitor", "spawn", "tick"])
})

test("pause blocks spawn but not sweep or monitor", async () => {
  const log: Decision[] = []
  const h = build(log)
  const out = await runTick(h.ctx, [h.p], { paused: true })
  expect(out.some((d) => d.pass === "sweep")).toBe(true)
  expect(out.some((d) => d.pass === "spawn" && d.action === "spawn")).toBe(false)
})

test("every decision reaches the sink", async () => {
  const log: Decision[] = []
  const h = build(log)
  const out = await runTick(h.ctx, [h.p], { paused: false })
  expect(log.length).toBe(out.length)
})

// T2
test("every decision runTick produces renders to a real line, never undefined", async () => {
  const log: Decision[] = []
  const h = build(log)
  const out = await runTick(h.ctx, [h.p], { paused: false })
  expect(out.length).toBeGreaterThan(0)
  for (const d of out) {
    const line = renderDecision(d)
    expect(line).not.toBeUndefined()
    expect(typeof line).toBe("string")
    expect(line.length).toBeGreaterThan(0)
    expect(line.startsWith("undefined")).toBe(false)
  }
})

// F1: the regression that matters. discoverClaimed queries --state all so the
// engine can strip the label from a finished item; with the claim left on, the
// job's slots stay full and it never spawns again.
test("a live tick removes the claim label from an item that came back merged", async () => {
  const log: Decision[] = []
  const h = build(log, false, {
    live: true,
    claimed: [item(5, "MERGED")],
    items: [],
    worktrees: [],
  })
  const out = await runTick(h.ctx, [h.p], { paused: false })
  expect(out).toContainEqual(expect.objectContaining({ pass: "monitor", action: "done", key: "r5" }))
  expect(h.calls).toEqual([["label", "acme/web", "pr", 5, { remove: ["agent-wip"] }]])
  expect(out.some((d) => d.pass === "error")).toBe(false)
})
