import { test, expect } from "bun:test"
import { adopt, renderMarks } from "../src/adopt"
import { KINDS, validateOptions } from "../src/kinds"
import { makeCtx } from "../src/ctx"
import { openState, type State } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Ctx, Job } from "../src/types"

// Slot times are read in the box's own timezone, so the test builds its
// instants the same way rather than in UTC.
const at = (h: number, m: number) => new Date(2026, 7, 20, h, m, 0)

function build(kind: string, name: string, options: Record<string, unknown>): Job {
  const { errors, value } = validateOptions(KINDS[kind]!, options)
  expect(errors).toEqual([])
  return KINDS[kind]!.build({ name, dir: `/j/${name}`, repo: "web", options: value })
}

function harness(now = at(9, 30)): { ctx: Ctx; marks: State } {
  const marks = openState(":memory:")
  const ctx = makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/w/journal.md",
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: { accounts: [] } as any,
    now,
    // The command runs outside a tick and writes on purpose, which is exactly
    // why it is handed the database rather than reaching through the context.
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {} as any,
    gitFor: () => ({}) as any,
    herdr: {} as any,
    marks,
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "unused" }),
    memAvailableMb: async () => 8000,
    sink: () => {},
  })
  return { ctx, marks }
}

test("adopting a routine with no key names the occurrence that is due right now", async () => {
  const { ctx, marks } = harness()
  const digest = build("routine", "digest", { at: ["09:10", "21:10"] })
  expect(await adopt(ctx, marks, digest)).toEqual({ key: "20260820-0910", already: false })
  expect(marks.has("digest", "20260820-0910", "spawned")).toBe(true)
  marks.close()
})

// The cutover's own check, spec Appendix A phase 2: after the import, one dry
// run must read the current occurrence as done rather than as due.
test("the adopted occurrence is no longer discovered", async () => {
  const { ctx, marks } = harness()
  const digest = build("routine", "digest", { at: ["09:10", "21:10"] })
  expect((await digest.discover(ctx)).length).toBe(1)
  await adopt(ctx, marks, digest)
  expect(await digest.discover(ctx)).toEqual([])
  marks.close()
})

test("adopting twice reports the stamp was already there and keeps its timestamp", async () => {
  const { ctx, marks } = harness()
  const digest = build("routine", "digest", { at: ["09:10"] })
  await adopt(ctx, marks, digest)
  marks.backdate("digest", "20260820-0910", "spawned", 90)
  expect(await adopt(ctx, marks, digest)).toEqual({ key: "20260820-0910", already: true })
  expect(marks.age("digest", "20260820-0910", "spawned")).toBe(90)
  marks.close()
})

test("an explicit key is taken as given, for an occurrence older than the current one", async () => {
  const { ctx, marks } = harness()
  const digest = build("routine", "digest", { at: ["09:10"] })
  expect(await adopt(ctx, marks, digest, "20260819-0910")).toEqual({ key: "20260819-0910", already: false })
  expect(marks.has("digest", "20260819-0910", "spawned")).toBe(true)
  marks.close()
})

// Every other kind keys on an item, so there is no such thing as the key it
// would use right now, and guessing one would stamp a real issue as done.
test("adopting a builder with no key refuses and says to name one", async () => {
  const { ctx, marks } = harness()
  const builder = build("builder", "build", { base: "origin/main" })
  expect(adopt(ctx, marks, builder)).rejects.toThrow(/name the key/)
  marks.close()
})

test("renderMarks prints one line per mark, and says so when there are none", () => {
  const now = at(9, 30)
  expect(renderMarks([], now)).toEqual(["no marks recorded"])
  expect(renderMarks([{ job: "digest", key: "20260820-0910", mark: "spawned", at: now.getTime() - 20 * 60000 }], now))
    .toEqual(["digest 20260820-0910 spawned 20m ago"])
})
