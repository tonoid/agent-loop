import { test, expect } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { routine, occurrenceKey } from "../src/kinds/routine"
import { validateOptions } from "../src/kinds"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import { claim, unclaim } from "../src/effects/spawn"
import type { Ctx, WorkItem } from "../src/types"

// A fixed local clock: "HH:MM" is read in the box's own timezone, so the test
// builds its instants the same way rather than in UTC.
const at = (h: number, m: number) => new Date(2026, 7, 19, h, m, 0)

function job(options: Record<string, unknown> = { at: ["09:10", "21:10"] }) {
  const { errors, value } = validateOptions(routine, options)
  expect(errors).toEqual([])
  return routine.build({ name: "digest", dir: "/j/digest", repo: "web", options: value })
}

function ctxFor(o: { now?: Date; worktrees?: { path: string; branch: string | null }[]; calls?: any[][] } = {}): Ctx {
  return makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/j/journal.md",
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: { accounts: [] } as any,
    now: o.now ?? at(9, 30),
    live: true,
    sleep: async () => {},
    lock: memoryLock(),
    gh: { label: async (...a: any[]) => { o.calls?.push(["label", ...a]) }, labelsOf: async () => [] } as any,
    gitFor: () => ({
      remoteSlug: async () => "acme/web",
      worktrees: async () => o.worktrees ?? [],
    }) as any,
    herdr: {} as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "unused" }),
    memAvailableMb: async () => 8000,
    sink: () => {},
  })
}

test("the occurrence is the slot the clock is inside, until the next one begins", () => {
  const slots = ["09:10", "21:10"]
  expect(occurrenceKey(at(9, 9), slots)).toBe("20260818-2110")
  expect(occurrenceKey(at(9, 10), slots)).toBe("20260819-0910")
  expect(occurrenceKey(at(20, 59), slots)).toBe("20260819-0910")
  expect(occurrenceKey(at(21, 10), slots)).toBe("20260819-2110")
})

test("a slot missed to a reboot fires once on the first tick back inside its window", async () => {
  const p = job()
  const ctx = ctxFor({ now: at(11, 0) })
  expect((await p.discover(ctx)).map((i) => i.id)).toEqual(["key:20260819-0910"])
  ctx.marks.set("digest", "20260819-0910", "spawned")
  expect(await p.discover(ctx)).toEqual([])
})

test("the next occurrence fires even though the last one is marked", async () => {
  const p = job()
  const ctx = ctxFor({ now: at(21, 30) })
  ctx.marks.set("digest", "20260819-0910", "spawned")
  expect((await p.discover(ctx)).map((i) => i.id)).toEqual(["key:20260819-2110"])
})

test("the claimed set is the worktrees on disk, which is where the claim really lives", async () => {
  const p = job()
  const ctx = ctxFor({ worktrees: [
    { path: "/b/wt-digest-20260819-0910", branch: "digest/20260819-0910" },
    { path: "/b/wt-review-r80", branch: "review/r80" },
  ] })
  const claimed = await p.discoverClaimed(ctx)
  expect(claimed.map((i) => i.id)).toEqual(["key:20260819-0910"])
  expect(await p.key(ctx, claimed[0]!)).toBe("20260819-0910")
  // Still running, so not done: the monitor supervises it like any other item.
  expect(await p.done(ctx, claimed[0]!)).toBe(false)
})

test("an occurrence that is no longer due is swept, and the current one is not", async () => {
  const p = job()
  const ctx = ctxFor({ now: at(9, 30) })
  expect(await p.sweepOk!(ctx, "20260819-0910")).toBe(false)
  expect(await p.sweepOk!(ctx, "20260818-2110")).toBe(true)
})

test("a routine item is never labelled, because nothing tracks it", async () => {
  const calls: any[][] = []
  const ctx = ctxFor({ calls })
  const item: WorkItem = { id: "key:20260819-0910", number: 0, title: "digest", state: "OPEN", labels: [] }
  expect(await claim(ctx, job(), item)).toBe(true)
  await unclaim(ctx, item)
  expect(calls).toEqual([])
})

test("the brief names the occurrence and resolves every variable", async () => {
  const text = await job().brief(ctxFor(), { id: "key:20260819-0910", number: 0, title: "digest", state: "OPEN", labels: [] })
  expect(text).toContain("20260819-0910")
  expect(text).toContain("Never force-push")
  expect(text).not.toContain("{{")
})

test("at is required and its entries must be times", () => {
  expect(validateOptions(routine, {}).errors[0]).toContain("options.at is required")
  expect(routine.check!({ name: "digest", dir: "/j/digest", repo: "web", options: { at: ["9am"] } }))
    .toEqual(['options.at: "9am" is not a time of day like 09:10'])
})

test("days confines the run to the weekdays it names, by the occurrence's own day", async () => {
  // 2026-08-22 is a Saturday, 2026-08-21 a Friday.
  const weekdays = { at: ["04:15"], days: ["mon", "tue", "wed", "thu", "fri"] }
  const p = job(weekdays)
  const sat = (h: number, m: number) => new Date(2026, 7, 22, h, m, 0)

  // Saturday after the slot: Saturday's occurrence, never due.
  expect(await p.discover(ctxFor({ now: sat(8, 0) }))).toEqual([])
  // Saturday before it: Friday's occurrence is the one still running, and it was.
  expect((await p.discover(ctxFor({ now: sat(2, 0) }))).map((i) => i.id)).toEqual(["key:20260821-0415"])
  // No days at all is every day.
  expect((await job({ at: ["04:15"] }).discover(ctxFor({ now: sat(8, 0) }))).map((i) => i.id))
    .toEqual(["key:20260822-0415"])
})

test("days rejects anything that is not a weekday", () => {
  expect(routine.check!({ name: "digest", dir: "/j/digest", repo: "web", options: { at: ["04:15"], days: ["mon", "funday"] } }))
    .toEqual(['options.days: "funday" is not a weekday like mon'])
})

// Without a completion marker the only signal a routine has is its worktree
// disappearing, and that waits for the next slot: a run that finished at 09:38
// is nudged at 09:40 and failed at 09:42 for having succeeded.
test("doneWhen ends the occurrence when the run's own artifact appears", async () => {
  const dir = `${import.meta.dir}/../.tmp-routine-done`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const p = job({ at: ["09:10", "21:10"], doneWhen: `${dir}/{{key}}.md` })
  const wt = [{ path: "/b/wt-digest-20260819-0910", branch: "digest/20260819-0910" }]
  const item = { id: "key:20260819-0910" } as any

  // Worktree still there and no artifact: the run is live, so not done.
  expect(await p.done(ctxFor({ worktrees: wt }), item)).toBe(false)
  // The artifact lands while the worktree is still there: done anyway.
  writeFileSync(`${dir}/20260819-0910.md`, "report")
  expect(await p.done(ctxFor({ worktrees: wt }), item)).toBe(true)
  // Another occurrence's artifact is not this one's: give 21:10 a live
  // worktree so the worktree path cannot answer, and only the file decides.
  const both = [...wt, { path: "/b/wt-digest-20260819-2110", branch: "digest/20260819-2110" }]
  expect(await p.done(ctxFor({ worktrees: both }), { id: "key:20260819-2110" } as any)).toBe(false)

  rmSync(dir, { recursive: true, force: true })
  // With no doneWhen at all, the worktree is still the whole signal.
  const bare = job({ at: ["09:10", "21:10"] })
  expect(await bare.done(ctxFor({ worktrees: wt }), item)).toBe(false)
  expect(await bare.done(ctxFor({ worktrees: [] }), item)).toBe(true)
})

// The occurrence's window is six hours; the run took twenty minutes. Holding
// its checkout and its herdr tab for the remaining five is just clutter.
test("doneWhen also releases the worktree, without waiting for the window to close", async () => {
  const dir = `${import.meta.dir}/../.tmp-routine-sweep`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const p = job({ at: ["09:10", "21:10"], doneWhen: `${dir}/{{key}}.md` })
  const ctx = ctxFor({ now: at(9, 30) })

  // The current occurrence, still running: not sweepable.
  expect(await p.sweepOk!(ctx, "20260819-0910")).toBe(false)
  // Its marker lands: sweepable now, not at 21:10.
  writeFileSync(`${dir}/20260819-0910.md`, "report")
  expect(await p.sweepOk!(ctx, "20260819-0910")).toBe(true)
  // An older occurrence is sweepable with or without one, as before.
  expect(await p.sweepOk!(ctx, "20260818-2110")).toBe(true)

  rmSync(dir, { recursive: true, force: true })
  expect(await job({ at: ["09:10", "21:10"] }).sweepOk!(ctx, "20260819-0910")).toBe(false)
})
