import { test, expect } from "bun:test"
import { monitorJob, monitorAll } from "../src/engine/monitor"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Job, Decision, WorkItem, AgentStatus } from "../src/types"
import type { State } from "../src/state"

const BASE = "/b"
const item = (n: number, state: "OPEN" | "CLOSED" | "MERGED" = "OPEN"): WorkItem => ({
  id: `pr:${n}`, number: n, title: "t", state, labels: ["agent-wip"], headRef: `build/b${n}`,
  // The executors derive the forge repo slug from the item's own url.
  url: `https://example.test/acme/web/pull/${n}`,
})

function harness(o: {
  claimed: WorkItem[]
  done?: boolean
  agents?: { cwd: string; status: AgentStatus; paneId: string }[]
  panes?: { cwd: string; paneId: string; tabId: string }[]
  marks?: [string, string][]
  blockedAgeMin?: number
  live?: boolean
}) {
  const log: Decision[] = []
  const calls: any[][] = []
  const marks = openState(":memory:")
  for (const [key, mark] of o.marks ?? []) marks.set("review", key, mark)
  if (o.blockedAgeMin !== undefined) marks.backdate("review", "80", "blocked", o.blockedAgeMin)
  const ctx = makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/w/journal.md",
      herdrWorkspace: "acme", worktreeBase: BASE, repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: { blockedTimeoutMin: 180 } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: o.live ?? false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: { label: async (r: string, k: string, n: number, x: any) => { calls.push(["label", r, k, n, x]) } } as any,
    gitFor: () => ({}) as any,
    herdr: {
      agents: async () => o.agents ?? [],
      panes: async () => o.panes ?? [],
      protocol: async () => 19,
      notify: async (title: string, body: string) => { calls.push(["notify", title, body]) },
    } as any,
    marks,
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "not used by this test" }),
    memAvailableMb: async () => 8000,
    sink: (d) => log.push(d),
  })
  const p: Job = {
    name: "review", dir: "/j/review", workload: "reviewer", repo: "web",
    discover: async () => [],
    discoverClaimed: async () => o.claimed,
    key: async (_c, i) => String(i.number),
    done: async () => o.done ?? false,
    brief: async () => "go",
  }
  return { ctx, p, marks, calls, log }
}

const only = async (h: { ctx: any; p: Job }) => (await monitorJob(h.ctx, h.p))[0]!

test("a closed item resolves as done before anything else is consulted", async () => {
  const h = harness({ claimed: [item(80, "MERGED")], agents: [{ cwd: `${BASE}/wt-review-80`, status: "working", paneId: "p" }] })
  expect(await only(h)).toMatchObject({ action: "done", reason: "state MERGED" })
})

test("done() true with a spawned mark resolves as done", async () => {
  const h = harness({ claimed: [item(80)], done: true, marks: [["80", "spawned"]] })
  expect(await only(h)).toMatchObject({ action: "done" })
})

test("done() true with no spawned mark resolves as external", async () => {
  const h = harness({ claimed: [item(80)], done: true })
  expect(await only(h)).toMatchObject({ action: "external" })
})

test("a working agent holds the slot", async () => {
  const h = harness({ claimed: [item(80)], agents: [{ cwd: `${BASE}/wt-review-80`, status: "working", paneId: "p" }] })
  expect(await only(h)).toMatchObject({ action: "busy" })
})

test("a blocked agent notifies once, then escalates after the timeout", async () => {
  const first = harness({ claimed: [item(80)], agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }] })
  expect(await only(first)).toMatchObject({ action: "blocked" })
  const later = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }],
    marks: [["80", "blocked"]],
    blockedAgeMin: 200,
  })
  expect(await only(later)).toMatchObject({ action: "escalate" })
})

test("a blocked agent inside the timeout keeps holding", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }],
    marks: [["80", "blocked"]],
    blockedAgeMin: 30,
  })
  expect(await only(h)).toMatchObject({ action: "hold" })
})

test("a live pane with no agent is restarted, not failed", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [],
    panes: [{ cwd: `${BASE}/wt-review-80`, paneId: "w1:p1", tabId: "t1" }],
  })
  expect(await only(h)).toMatchObject({ action: "restart" })
})

test("an idle agent is nudged once, then failed", async () => {
  const first = harness({ claimed: [item(80)], agents: [{ cwd: `${BASE}/wt-review-80`, status: "idle", paneId: "p" }] })
  expect(await only(first)).toMatchObject({ action: "nudge" })
  const second = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "idle", paneId: "p" }],
    marks: [["80", "nudged"]],
  })
  expect(await only(second)).toMatchObject({ action: "fail" })
})

test("no agent and no pane fails without a nudge", async () => {
  const h = harness({ claimed: [item(80)], agents: [], panes: [] })
  expect(await only(h)).toMatchObject({ action: "fail" })
})

// F1
test("an agent with an unrecognized status holds, and is neither nudged nor failed", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "missing", paneId: "p" }],
  })
  const d = await only(h)
  expect(d).toMatchObject({ pass: "monitor", action: "hold" })
  if (d.pass === "monitor") {
    expect(d.action).not.toBe("nudge")
    expect(d.action).not.toBe("fail")
  }
})

// T1
test("one harness visited twice: nudge writes the mark the next visit reads, then fails", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "idle", paneId: "p" }],
  })
  expect(await only(h)).toMatchObject({ action: "nudge" })
  expect(h.ctx.marks.has("review", "80", "nudged")).toBe(true)
  expect(await only(h)).toMatchObject({ action: "fail" })
})

test("one harness visited twice: blocked writes the mark the next visit reads, then escalates", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }],
  })
  expect(await only(h)).toMatchObject({ action: "blocked" })
  expect(h.ctx.marks.has("review", "80", "blocked")).toBe(true)
  ;(h.ctx.marks as State).backdate("review", "80", "blocked", 200)
  expect(await only(h)).toMatchObject({ action: "escalate" })
})

// F5
test("a job whose discoverClaimed rejects yields an error decision without blocking the next job", async () => {
  const h = harness({ claimed: [] })
  const bad: Job = {
    name: "bad", dir: "/j/bad", workload: "reviewer", repo: "web",
    discover: async () => [],
    discoverClaimed: async () => { throw new Error("boom") },
    key: async (_c, i) => String(i.number),
    done: async () => false,
    brief: async () => "go",
  }
  const good: Job = {
    name: "good", dir: "/j/good", workload: "reviewer", repo: "web",
    discover: async () => [],
    discoverClaimed: async () => [item(80, "MERGED")],
    key: async (_c, i) => String(i.number),
    done: async () => false,
    brief: async () => "go",
  }
  const out = await monitorAll(h.ctx, [bad, good])
  expect(out).toContainEqual({ pass: "error", job: "bad", where: "monitor", reason: "Error: boom" })
  expect(out.some((d) => d.pass === "monitor" && d.job === "good" && d.action === "done")).toBe(true)
})

// F3: spec 11 restarts a dead agent in a live pane once. No mark meant every
// tick restarted it again, off the spawns table and outside maxSpawnsPerDay.
test("a live pane with no agent is restarted only once, then failed", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [],
    panes: [{ cwd: `${BASE}/wt-review-80`, paneId: "w1:p1", tabId: "t1" }],
  })
  expect(await only(h)).toMatchObject({ action: "restart" })
  expect(h.ctx.marks.has("review", "80", "restarted")).toBe(true)
  expect(await only(h)).toMatchObject({ action: "fail", reason: "agent gone again after a restart" })
})

// F1: discoverClaimed reads --state all, so a finished item that keeps its
// claim label counts against the job's slots forever.
test("a finished item has its claim removed under live, and is left alone otherwise", async () => {
  const live = harness({ claimed: [item(80, "MERGED")], live: true })
  expect(await only(live)).toMatchObject({ action: "done" })
  expect(live.calls).toEqual([["label", "acme/web", "pr", 80, { remove: ["agent-wip"] }]])

  const external = harness({ claimed: [item(80)], done: true, live: true })
  expect(await only(external)).toMatchObject({ action: "external" })
  expect(external.calls).toEqual([["label", "acme/web", "pr", 80, { remove: ["agent-wip"] }]])

  const dry = harness({ claimed: [item(80, "MERGED")] })
  expect(await only(dry)).toMatchObject({ action: "done" })
  expect(dry.calls).toEqual([])
})

// F5: the ctx.live branch itself, which is what stands between a dry run and
// every write the executors make.
test("under live an executor that throws becomes an error decision and the pass goes on", async () => {
  const h = harness({
    claimed: [item(80), item(81)],
    agents: [
      { cwd: `${BASE}/wt-review-80`, status: "idle", paneId: "p" },
      { cwd: `${BASE}/wt-review-81`, status: "idle", paneId: "q" },
    ],
    panes: [],
    live: true,
  })
  const out = await monitorJob(h.ctx, h.p)
  // applyNudge resolves the pane by cwd and there is none, so it threw: the
  // executor ran.
  expect(out.filter((d) => d.pass === "error" && /no pane/.test(d.reason)).length).toBe(2)
  expect(out.filter((d) => d.pass === "monitor" && d.action === "nudge").length).toBe(2)
})

test("without live no executor runs at all", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "idle", paneId: "p" }],
    panes: [],
  })
  const out = await monitorJob(h.ctx, h.p)
  expect(out).toEqual([expect.objectContaining({ action: "nudge" })])
})

// The shadow week of the cutover: a tick that only intended to nudge must not
// leave a stamp saying it did, or the next tick fails the item and the first
// live tick inherits the lie.
test("a dry tick leaves the marks database exactly as it found it", async () => {
  const h = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "idle", paneId: "p" }],
  })
  expect(await only(h)).toMatchObject({ action: "nudge" })
  expect(h.marks.has("review", "80", "nudged")).toBe(false)
})

// The one moment a human is wanted. Gated by the blocked mark, so a worker
// sitting on a question for an hour is one notification and not thirty.
test("a blocked worker pings once, and only under live", async () => {
  const first = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }],
    live: true,
  })
  await only(first)
  expect(first.calls.filter((c) => c[0] === "notify")).toHaveLength(1)
  expect(first.calls.find((c) => c[0] === "notify")?.[1]).toContain("blocked")

  // Second sighting inside the timeout: the mark is already there, so no ping.
  const again = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }],
    marks: [["80", "blocked"]],
    live: true,
  })
  await only(again)
  expect(again.calls.filter((c) => c[0] === "notify")).toEqual([])

  // A dry tick tells you what it would do and pings nobody.
  const dry = harness({
    claimed: [item(80)],
    agents: [{ cwd: `${BASE}/wt-review-80`, status: "blocked", paneId: "p" }],
  })
  await only(dry)
  expect(dry.calls.filter((c) => c[0] === "notify")).toEqual([])
})
