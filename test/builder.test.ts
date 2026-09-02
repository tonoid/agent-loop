import { test, expect } from "bun:test"
import { builder } from "../src/kinds/builder"
import { validateOptions } from "../src/kinds"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Ctx, WorkItem } from "../src/types"

const issue = (n: number, labels: string[] = [], state: "OPEN" | "CLOSED" = "OPEN"): WorkItem => ({
  id: `issue:${n}`, number: n, title: `t${n}`, state, labels,
  url: `https://example.test/acme/web/issues/${n}`,
})
const pr = (n: number, head: string, state: "OPEN" | "MERGED" | "CLOSED" = "OPEN"): WorkItem => ({
  id: `pr:${n}`, number: n, title: `p${n}`, state, labels: [], headRef: head,
  url: `https://example.test/acme/web/pull/${n}`,
})

function job(options: Record<string, unknown> = {}) {
  const { errors, value } = validateOptions(builder, options)
  expect(errors).toEqual([])
  return builder.build({ name: "build", dir: "/j/build", repo: "web", options: value })
}

function ctxFor(o: { issues?: WorkItem[]; prs?: WorkItem[] } = {}): Ctx {
  return makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/j/journal.md",
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: ["bug"] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: { accounts: [] } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {
      issueList: async () => o.issues ?? [],
      prList: async () => o.prs ?? [],
    } as any,
    gitFor: () => ({ remoteSlug: async () => "acme/web" }) as any,
    herdr: {} as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "unused" }),
    memAvailableMb: async () => 8000,
    sink: () => {},
  })
}

test("candidates are priority-labelled first, then oldest first", async () => {
  const ctx = ctxFor({ issues: [issue(3), issue(4, ["bug"]), issue(1)] })
  expect((await job().discover(ctx)).map((i) => i.number)).toEqual([4, 1, 3])
})

test("claimed, failed and parked issues are never candidates", async () => {
  const ctx = ctxFor({ issues: [issue(1, ["agent-wip"]), issue(2, ["agent-failed"]), issue(3, ["needs-human"]), issue(4)] })
  expect((await job().discover(ctx)).map((i) => i.number)).toEqual([4])
})

test("issueLabel narrows the queue to one label", async () => {
  const ctx = ctxFor({ issues: [issue(1), issue(2, ["ready"])] })
  expect((await job({ issueLabel: "ready" }).discover(ctx)).map((i) => i.number)).toEqual([2])
})

test("the claimed set is state-agnostic, so a closed claimed issue is still seen", async () => {
  const ctx = ctxFor({ issues: [issue(1, ["agent-wip"], "CLOSED"), issue(2)] })
  expect((await job().discoverClaimed(ctx)).map((i) => i.number)).toEqual([1])
})

test("the key names the branch, and done is a pull request from it", async () => {
  const p = job()
  const ctx = ctxFor({ prs: [pr(9, "build/b7")] })
  expect(await p.key(ctx, issue(7))).toBe("b7")
  expect(await p.done(ctx, issue(7))).toBe(true)
  expect(await p.done(ctx, issue(8))).toBe(false)
})

test("sweepOk waits for that pull request to be finished, not merely open", async () => {
  const p = job()
  expect(await p.sweepOk!(ctxFor({ prs: [pr(9, "build/b7")] }), "b7")).toBe(false)
  expect(await p.sweepOk!(ctxFor({ prs: [pr(9, "build/b7", "MERGED")] }), "b7")).toBe(true)
  expect(await p.sweepOk!(ctxFor({ prs: [pr(9, "build/b7", "MERGED"), pr(11, "build/b7")] }), "b7")).toBe(false)
})

// A builder that fails opens no pull request, so the predicate above has
// nothing to find and answers false forever. Six worktrees accumulated that way
// on one box in a day: the workers had run, labelled their issue agent-failed
// for a human and exited, and the sweep held every one of them because a hold
// never kills. The park and failed labels are the two states a human owns, and
// a human owning the item is exactly when the machine should let go of the
// worktree.
test("sweepOk releases a worktree whose issue a human now owns", async () => {
  const p = job()
  const failed = ctxFor({ issues: [issue(7, ["agent-failed"])] })
  const parked = ctxFor({ issues: [issue(7, ["needs-human"])] })
  expect(await p.sweepOk!(failed, "b7")).toBe(true)
  expect(await p.sweepOk!(parked, "b7")).toBe(true)
})

// The pull request still decides whenever there is one. A failed label on an
// issue whose pull request is open is a reviewer's round that found something,
// and tearing that worktree down destroys the branch the next round works in.
test("an open pull request outranks the failed label on its issue", async () => {
  const p = job()
  const ctx = ctxFor({ issues: [issue(7, ["agent-failed"])], prs: [pr(9, "build/b7")] })
  expect(await p.sweepOk!(ctx, "b7")).toBe(false)
})

// Unless the label is on the pull request itself, which is the monitor
// tombstoning the review rather than a round asking for changes. A failed pull
// request is out of the reviewer's discovery, so nothing will ever move it
// again, and both worktrees waited on a state change only a human could cause:
// two pairs sat 19 and 21 hours holding 1.4GB of live worker processes.
test("sweepOk releases a worktree whose pull request a human now owns", async () => {
  const p = job()
  const failed = ctxFor({ prs: [{ ...pr(9, "build/b7"), labels: ["agent-failed"] }] })
  const parked = ctxFor({ prs: [{ ...pr(9, "build/b7"), labels: ["needs-human"] }] })
  expect(await p.sweepOk!(failed, "b7")).toBe(true)
  expect(await p.sweepOk!(parked, "b7")).toBe(true)
})

// Neither a pull request nor a human-owned label: a worker that is still
// working, which the hold exists for.
test("sweepOk still holds a worktree with no pull request and no verdict", async () => {
  expect(await job().sweepOk!(ctxFor({ issues: [issue(7)] }), "b7")).toBe(false)
})

test("admit throttles on review debt and says so", async () => {
  const deep = ctxFor({ prs: [pr(1, "build/b1"), pr(2, "build/b2"), pr(3, "build/b3")] })
  expect(await job({ reviewDebt: 3 }).admit!(deep)).toBe("review debt 3/3")
  expect(await job({ reviewDebt: 4 }).admit!(deep)).toBe(null)
  expect(await job().admit!(deep)).toBe(null)
})

test("review debt excludes parked and failed pull requests, or two parks deadlock the pipeline", async () => {
  const parked = { ...pr(2, "build/b2"), labels: ["needs-human"] }
  const failed = { ...pr(3, "build/b3"), labels: ["agent-failed"] }
  const ctx = ctxFor({ prs: [pr(1, "build/b1"), parked, failed] })
  expect(await job({ reviewDebt: 3 }).admit!(ctx)).toBe(null)
})

test("a claimed pull request is review debt, not an exemption", async () => {
  const parked = { ...pr(2, "build/b2"), labels: ["needs-human"] }
  const failed = { ...pr(3, "build/b3"), labels: ["agent-failed"] }
  const claimed = { ...pr(4, "build/b4"), labels: ["agent-wip"] }
  const ctx = ctxFor({ prs: [pr(1, "build/b1"), parked, failed, claimed] })
  expect(await job({ reviewDebt: 2 }).admit!(ctx)).toBe("review debt 2/2")
})

// Critical: done() releases the claim when the pull request opens, the issue
// stays open until the merge closes it, and discover() filters on labels only.
// Without the guard the same issue is re-picked every tick and the spawn's
// pre-clean destroys the worktree the reviewer is still working in.
test("an issue whose pull request is open is guarded out of the pick", async () => {
  const p = job()
  expect(await p.guard!(ctxFor({ prs: [pr(9, "build/b7")] }), issue(7))).toBe(false)
  expect(await p.guard!(ctxFor({ prs: [pr(9, "build/b7", "MERGED")] }), issue(7))).toBe(false)
})

test("a closed unmerged pull request is a retry, and no pull request is a first build", async () => {
  const p = job()
  expect(await p.guard!(ctxFor({ prs: [pr(9, "build/b7", "CLOSED")] }), issue(7))).toBe(true)
  expect(await p.guard!(ctxFor({ prs: [pr(9, "build/b8")] }), issue(7))).toBe(true)
  expect(await p.guard!(ctxFor(), issue(7))).toBe(true)
})

// The runaway of 2026-09-02, and the reason the three predicates share one
// reading of a closed pull request. done() answered "a pull request exists" and
// guard() answered "a closed one is a retry", so a retry lost its claim the tick
// after it spawned and the next tick picked the same issue again: 41 workers on
// one issue in 82 minutes, and the day's whole spawn budget with them.
test("a retry is not finished the moment it spawns, or the same issue respawns every tick", async () => {
  const p = job()
  const closed = ctxFor({ prs: [pr(9, "build/b7", "CLOSED")] })
  expect(await p.guard!(closed, issue(7))).toBe(true)
  expect(await p.done(closed, issue(7))).toBe(false)
})

test("a human-owned closed pull request ends the run instead of retrying it", async () => {
  const p = job()
  for (const label of ["agent-failed", "needs-human"]) {
    const ctx = ctxFor({ prs: [{ ...pr(9, "build/b7", "CLOSED"), labels: [label] }] })
    expect(await p.guard!(ctx, issue(7))).toBe(false)
    expect(await p.done(ctx, issue(7))).toBe(true)
    expect(await p.sweepOk!(ctx, "b7")).toBe(true)
  }
})

// sweepIgnoresWorking is on for builders, so this predicate is the only thing
// between a retry and a worktree deleted out from under its worker.
test("sweepOk holds the worktree a retry is going to work in", async () => {
  const p = job()
  const closed = pr(9, "build/b7", "CLOSED")
  expect(await p.sweepOk!(ctxFor({ issues: [issue(7)], prs: [closed] }), "b7")).toBe(false)
  const parked = ctxFor({ issues: [issue(7, ["needs-human"])], prs: [closed] })
  expect(await p.sweepOk!(parked, "b7")).toBe(true)
  const gone = ctxFor({ issues: [issue(7, [], "CLOSED")], prs: [closed] })
  expect(await p.sweepOk!(gone, "b7")).toBe(true)
})

test("a pass-labelled pull request is not review debt, because the reviewer is done with it", async () => {
  const passed = { ...pr(2, "build/b2"), labels: ["reviewed"] }
  const ctx = ctxFor({ prs: [pr(1, "build/b1"), passed] })
  expect(await job({ reviewDebt: 2, debtIgnoreLabels: ["reviewed"] }).admit!(ctx)).toBe(null)
  expect(await job({ reviewDebt: 2 }).admit!(ctx)).toBe("review debt 2/2")
})

test("the brief carries the issue, the closing line, and the account", async () => {
  const ctx = ctxFor()
  const text = await job().brief(ctx, issue(7))
  expect(text).toContain("Closes #7")
  expect(text).toContain("built-by: unknown")
  expect(text).toContain("Never force-push")
  expect(text).not.toContain("{{")
})

test("the base is the option, and the shipped defaults match the spec", async () => {
  const p = job({ base: "origin/develop" })
  expect(await p.base!(ctxFor(), issue(7))).toBe("origin/develop")
  expect(p.deleteRemote).toBe(true)
  expect(p.sweepIgnoresWorking).toBe(true)
  expect(p.workload).toBe("builder")
})
