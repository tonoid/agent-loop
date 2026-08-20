import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { render, unresolved, loadBrief, briefPath, briefVars } from "../src/brief"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Job, WorkItem } from "../src/types"

const item: WorkItem = {
  id: "pr:80", number: 80, title: "the title", state: "OPEN", labels: [],
  headRef: "build/b12", url: "https://example.test/acme/web/pull/80",
}

function ctxFor() {
  return makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/j/journal.md",
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: [],
    },
    config: { accounts: [] } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {} as any,
    gitFor: () => ({}) as any,
    herdr: {} as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "unused" }),
    memAvailableMb: async () => 8000,
    sink: () => {},
  })
}

const job: Job = {
  name: "review", dir: "/j/review", workload: "reviewer", repo: "web",
  discover: async () => [], discoverClaimed: async () => [],
  key: async () => "r80", done: async () => false, brief: async () => "",
  base: async () => "origin/build/b12",
  attempt: async () => 2,
}

test("render substitutes known variables and leaves unknown ones alone", () => {
  expect(render("a {{key}} b {{nope}}", { key: "r80" })).toBe("a r80 b {{nope}}")
  expect(unresolved("a {{key}} b {{nope}}")).toEqual(["key", "nope"])
})

test("briefVars carries the whole documented contract", async () => {
  const vars = await briefVars(ctxFor(), job, item, "r80", { filingBudget: 2, openQueue: 7 })
  expect(vars).toMatchObject({
    item: "#80",
    number: 80,
    title: "the title",
    itemUrl: "https://example.test/acme/web/pull/80",
    key: "r80",
    worktree: "/b/wt-review-r80",
    branch: "review/r80",
    headRef: "build/b12",
    base: "origin/build/b12",
    attempt: 2,
    repoSlug: "acme/web",
    journal: "/j/journal.md",
    mergeMethod: "squash",
    "labels.claim": "agent-wip",
    "labels.failed": "agent-failed",
    "labels.park": "needs-human",
    filingBudget: 2,
    openQueue: 7,
    account: "unknown",
  })
})

test("a brief name outside the shipped tree is refused", () => {
  expect(() => briefPath("../../etc/passwd")).toThrow()
  expect(() => briefPath("default/nope")).toThrow()
})

test("layers are core, then the role, then optionals, then the user append", () => {
  const dir = mkdtempSync(`${tmpdir()}/al-brief-`)
  writeFileSync(`${dir}/append.md`, "PROJECT PROSE")
  const text = loadBrief({ extends: "default/build", optional: ["journal"], append: `${dir}/append.md` })
  expect(text.indexOf("Fences")).toBeLessThan(text.indexOf("PROJECT PROSE"))
  expect(text).toContain("PROJECT PROSE")
  expect(text).toContain("{{journal}}")
})
