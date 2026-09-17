import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

function ctxFor(o: {
  now?: Date
  worktrees?: { path: string; branch: string | null }[]
  calls?: any[][]
  journalPath?: string
  marks?: ReturnType<typeof openState>
} = {}): Ctx {
  return makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: o.journalPath ?? "/j/journal.md",
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
    marks: o.marks ?? openState(":memory:"),
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

// A pane as it really looks when a run dies: the error is four lines from the
// top and everything under it is the input box. Slicing the last five lines,
// which is what every FAIL line captured until now, yields the box and nothing
// else.
const TUI_TAIL = [
  "● Running the digest build",
  "  ⎿  bun run build",
  "",
  "⏺ Error: connect ECONNREFUSED 127.0.0.1:27017",
  "    at Socket.<anonymous> (/w/src/db.ts:41:11)",
  "    at TCP.done (node:net:1234:7)",
  "",
  "✻ Crunching… (12s · ↑ 1.4k tokens · esc to interrupt)",
  "╭─────────────────╮",
  "│ > ▊              │",
  "╰─────────────────╯",
  "  ⏵⏵ accept edits on      ? for shortcuts",
].join("\n")

const TIDY_TAIL = [
  "● Wrote the digest to out/20260819-0910.md",
  "",
  "✻ Polishing… (4s · ↑ 900 tokens · esc to interrupt)",
  "╭───────────╮",
  "│ >          │",
  "╰───────────╯",
  "  ⏵⏵ accept edits on      ? for shortcuts",
].join("\n")

// A temp state directory per test, so the journal and the tail file land
// somewhere the suite may write and nowhere the operator's own state lives.
function failbed() {
  const dir = mkdtempSync(join(tmpdir(), "al-routine-fail-"))
  return {
    dir,
    journalPath: join(dir, "journal.md"),
    marks: openState(":memory:"),
    line: () => readFileSync(join(dir, "journal.md"), "utf8").trim(),
    tailFile: (key: string) => readFileSync(join(dir, "fails", `digest-${key}.log`), "utf8"),
  }
}

const occurrence = (key: string) =>
  ({ id: `key:${key}`, number: 0, title: "digest", state: "OPEN", labels: [] }) as WorkItem

test("a failed occurrence is discoverable again, but not on the very next tick", async () => {
  const bed = failbed()
  const p = job()
  const ctx = () => ctxFor({ now: at(9, 30), marks: bed.marks, journalPath: bed.journalPath })
  try {
    bed.marks.set("digest", "20260819-0910", "spawned")
    await p.onFail!(ctx(), occurrence("20260819-0910"), TUI_TAIL)

    // The mark discover() reads as "this occurrence has run" is gone.
    expect(bed.marks.has("digest", "20260819-0910", "spawned")).toBe(false)
    // The backoff still holds it: the account that ran out of quota at 09:30
    // has not got any back by 09:32.
    expect(await p.discover(ctx())).toEqual([])
    bed.marks.backdate("digest", "20260819-0910", "fail-1", 10)
    expect((await p.discover(ctx())).map((i) => i.id)).toEqual(["key:20260819-0910"])
  } finally {
    rmSync(bed.dir, { recursive: true, force: true })
  }
})

// The retry ladder, one attempt at a time: the whole point of the cap is that a
// job broken rather than unlucky stops spawning workers against it.
test("the retry gives up after two attempts and leaves the occurrence failed for good", async () => {
  const bed = failbed()
  const p = job()
  const key = "20260819-0910"
  const ctx = () => ctxFor({ now: at(9, 30), marks: bed.marks, journalPath: bed.journalPath })
  try {
    for (const [attempt, waited] of [[1, 10], [2, 30]] as const) {
      bed.marks.set("digest", key, "spawned")
      await p.onFail!(ctx(), occurrence(key), TUI_TAIL)
      expect(bed.marks.has("digest", key, "spawned")).toBe(false)
      bed.marks.backdate("digest", key, `fail-${attempt}`, waited)
      expect((await p.discover(ctx())).map((i) => i.id)).toEqual([`key:${key}`])
    }

    // Third failure, third spawn: no attempts left, so the mark stays put.
    bed.marks.set("digest", key, "spawned")
    await p.onFail!(ctx(), occurrence(key), TUI_TAIL)
    expect(bed.marks.has("digest", key, "spawned")).toBe(true)
    expect(bed.line().split("\n").pop()).toContain("attempt 3 of 3, no retries left")

    // And the cap holds on its own, not only through the mark left behind: an
    // operator clearing it by hand does not buy a fourth spawn.
    bed.marks.clear("digest", key, "spawned")
    bed.marks.backdate("digest", key, "fail-3", 600)
    expect(await p.discover(ctx())).toEqual([])
  } finally {
    rmSync(bed.dir, { recursive: true, force: true })
  }
})

// A retry exists to produce the window's output, and it cannot produce it late.
// Without this a permanently broken job spins: every occurrence it touches
// arrives with a fresh budget of three spawns.
test("a failure whose occurrence has already rolled is not retried", async () => {
  const bed = failbed()
  const p = job()
  try {
    bed.marks.set("digest", "20260819-0910", "spawned")
    // 21:30, so the occurrence in flight is 21:10 and the 09:10 one is history.
    const ctx = ctxFor({ now: at(21, 30), marks: bed.marks, journalPath: bed.journalPath })
    await p.onFail!(ctx, occurrence("20260819-0910"), TUI_TAIL)
    expect(bed.marks.has("digest", "20260819-0910", "spawned")).toBe(true)
    expect(bed.line()).toContain("occurrence no longer current")
  } finally {
    rmSync(bed.dir, { recursive: true, force: true })
  }
})

// The failure is above the chrome, and the chrome is what the old slice took.
test("the FAIL line carries the error from the middle of the tail, not the input box", async () => {
  const bed = failbed()
  try {
    const ctx = ctxFor({ now: at(9, 30), marks: bed.marks, journalPath: bed.journalPath })
    await job().onFail!(ctx, occurrence("20260819-0910"), TUI_TAIL)
    const line = bed.line()

    expect(line.split("\n")).toHaveLength(1)
    expect(line).toContain("FAIL digest 20260819-0910: ")
    expect(line).toContain("ECONNREFUSED 127.0.0.1:27017")
    expect(line).toContain("db.ts:41:11")
    for (const chrome of ["? for shortcuts", "accept edits", "Crunching", "esc to interrupt", "│", "╭", "─"]) {
      expect(line).not.toContain(chrome)
    }
  } finally {
    rmSync(bed.dir, { recursive: true, force: true })
  }
})

test("a tail with no error-shaped line says so rather than quoting ordinary output", async () => {
  const bed = failbed()
  try {
    const ctx = ctxFor({ now: at(9, 30), marks: bed.marks, journalPath: bed.journalPath })
    await job().onFail!(ctx, occurrence("20260819-0910"), TIDY_TAIL)
    const line = bed.line()

    expect(line).toContain("no error-shaped line found")
    expect(line).toContain("Wrote the digest to out/20260819-0910.md")
    expect(line).not.toContain("? for shortcuts")
    expect(line).toContain(join(bed.dir, "fails", "digest-20260819-0910.log"))
  } finally {
    rmSync(bed.dir, { recursive: true, force: true })
  }
})

// The journal line is one line on purpose, so the rest of the post-mortem has
// to survive somewhere an operator can open.
test("the whole tail lands in a file beside the journal, one entry per failure", async () => {
  const bed = failbed()
  try {
    const ctx = () => ctxFor({ now: at(9, 30), marks: bed.marks, journalPath: bed.journalPath })
    await job().onFail!(ctx(), occurrence("20260819-0910"), TUI_TAIL)
    expect(bed.tailFile("20260819-0910")).toContain(TUI_TAIL)
    expect(bed.line()).toContain(join(bed.dir, "fails", "digest-20260819-0910.log"))

    // The second attempt's failure does not overwrite the first attempt's
    // transcript, which is usually the one that explains the third.
    await job().onFail!(ctx(), occurrence("20260819-0910"), TIDY_TAIL)
    const both = bed.tailFile("20260819-0910")
    expect(both).toContain(TUI_TAIL)
    expect(both).toContain(TIDY_TAIL)
  } finally {
    rmSync(bed.dir, { recursive: true, force: true })
  }
})
