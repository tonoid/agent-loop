import { test, expect } from "bun:test"
import { reviewer } from "../src/kinds/reviewer"
import { validateOptions } from "../src/kinds"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { Ctx, Decision, Job, WorkItem } from "../src/types"

const pr = (n: number, o: Partial<WorkItem> = {}): WorkItem => ({
  id: `pr:${n}`, number: n, title: `p${n}`, state: "OPEN", labels: [],
  headRef: `build/b${n}`, url: `https://example.test/acme/web/pull/${n}`, ...o,
})
const issue = (n: number, state: "OPEN" | "CLOSED" = "OPEN"): WorkItem => ({
  id: `issue:${n}`, number: n, title: `t${n}`, state, labels: [],
  url: `https://example.test/acme/web/issues/${n}`,
})

function job(options: Record<string, unknown> = {}) {
  const { errors, value } = validateOptions(reviewer, options)
  expect(errors).toEqual([])
  return reviewer.build({ name: "review", dir: "/j/review", repo: "web", options: value })
}

function ctxFor(o: {
  prs?: WorkItem[]
  issues?: WorkItem[]
  view?: any
  jobs?: Job[]
  log?: Decision[]
} = {}): Ctx {
  return makeCtx({
    workspace: {
      name: "acme", dir: "/w", journalPath: "/j/journal.md",
      herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" },
      naming: { labels: { claim: "agent-wip", failed: "agent-failed", park: "needs-human", priority: [] }, mergeMethod: "squash" },
      jobs: o.jobs ?? [],
    },
    config: { accounts: [] } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {
      // Honors the requested state, unlike a flat stub, because discoverClaimed's
      // whole point (spec 4.5) is that it asks for "all" and a merged pull
      // request with the claim label still comes back; a stub that ignores the
      // argument could not catch a regression to "open".
      prList: async (a: any) => {
        const items = o.prs ?? []
        return a?.state === "open" ? items.filter((p) => p.state === "OPEN") : items
      },
      issueList: async () => o.issues ?? [],
      prView: async () => o.view ?? {},
    } as any,
    gitFor: () => ({ remoteSlug: async () => "acme/web" }) as any,
    herdr: {} as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "unused" }),
    memAvailableMb: async () => 8000,
    sink: (d) => o.log?.push(d),
  })
}

test("candidates are open pull requests, first in first out", async () => {
  const ctx = ctxFor({ prs: [pr(9), pr(4), pr(6, { labels: ["agent-wip"] })] })
  expect((await job().discover(ctx)).map((i) => i.number)).toEqual([4, 9])
})

test("a passed pull request is no longer a candidate and is done", async () => {
  const passed = pr(4, { labels: ["reviewed"] })
  const ctx = ctxFor({ prs: [passed] })
  const p = job({ passLabel: "reviewed" })
  expect(await p.discover(ctx)).toEqual([])
  expect(await p.done(ctx, passed)).toBe(true)
  expect(await p.done(ctx, pr(5))).toBe(false)
})

test("identity pr keys on the pull request number", async () => {
  expect(await job().key(ctxFor(), pr(80))).toBe("r80")
})

test("identity closing-issue keys on the issue the pull request closes", async () => {
  const ctx = ctxFor({ view: { closingIssuesReferences: [{ number: 12 }] } })
  expect(await job({ identity: "closing-issue" }).key(ctx, pr(80))).toBe("r12")
})

test("a pull request that closes nothing falls back to its own number and warns", async () => {
  const log: Decision[] = []
  const ctx = ctxFor({ view: { closingIssuesReferences: [] }, log })
  expect(await job({ identity: "closing-issue" }).key(ctx, pr(80))).toBe("r80")
  expect(log.some((d) => d.pass === "warn")).toBe(true)
})

test("identity head-ref-issue reads the issue out of the head branch", async () => {
  const p = job({ identity: "head-ref-issue" })
  expect(await p.key(ctxFor(), pr(80, { headRef: "build/b12" }))).toBe("r12")
  expect(await p.key(ctxFor(), pr(80, { headRef: "build/b12-a-slug" }))).toBe("r12")
  expect(await p.key(ctxFor(), pr(80, { headRef: "somebodys-branch" }))).toBe("r80")
})

test("the round counter matches on the prefix and ignores it inside a fenced block", async () => {
  const ctx = ctxFor({
    view: { comments: [
      { body: "Review round 1\n\nfindings" },
      { body: "```\nReview round 1\n```\nquoted transcript" },
    ] },
  })
  expect(await job({ rounds: 3 }).attempt!(ctx, pr(80))).toBe(2)
})

test("the base is the pull request's own head, because the builder holds that branch", async () => {
  expect(await job().base!(ctxFor(), pr(80, { headRef: "build/b12" }))).toBe("origin/build/b12")
})

test("sweepOk waits for the pull request to be finished", async () => {
  const p = job()
  expect(await p.sweepOk!(ctxFor({ prs: [pr(80)] }), "r80")).toBe(false)
  expect(await p.sweepOk!(ctxFor({ prs: [pr(80, { state: "MERGED" })] }), "r80")).toBe(true)
})

test("under closing-issue identity sweepOk asks the issue, which the merge closes", async () => {
  const p = job({ identity: "closing-issue" })
  expect(await p.sweepOk!(ctxFor({ issues: [issue(12)] }), "r12")).toBe(false)
  expect(await p.sweepOk!(ctxFor({ issues: [issue(12, "CLOSED")] }), "r12")).toBe(true)
})

test("under head-ref-issue identity sweepOk takes the newest pull request naming the issue", async () => {
  const p = job({ identity: "head-ref-issue" })
  const olderDone = pr(80, { headRef: "build/b12", state: "MERGED" })
  const newerOpen = pr(81, { headRef: "build/b12" })
  expect(await p.sweepOk!(ctxFor({ prs: [olderDone, newerOpen] }), "r12")).toBe(false)
  const olderOpen = pr(80, { headRef: "build/b12" })
  const newerDone = pr(81, { headRef: "build/b12", state: "MERGED" })
  expect(await p.sweepOk!(ctxFor({ prs: [olderOpen, newerDone] }), "r12")).toBe(true)
})

// key() falls back to the pull request's own number when the identity cannot
// be resolved, and sweepOk cannot know that happened. Judging such a key as an
// issue that does not exist held the worktree, the branch and the tab forever.
test("a key that resolved through the closing-issue fallback sweeps as a pull request number", async () => {
  const p = job({ identity: "closing-issue" })
  const orphan = pr(80, { headRef: "somebodys-branch" })
  expect(await p.sweepOk!(ctxFor({ issues: [], prs: [orphan] }), "r80")).toBe(false)
  expect(await p.sweepOk!(ctxFor({ issues: [], prs: [{ ...orphan, state: "MERGED" }] }), "r80")).toBe(true)
})

test("a key that resolved through the head-ref-issue fallback sweeps as a pull request number", async () => {
  const p = job({ identity: "head-ref-issue" })
  const human = pr(80, { headRef: "somebodys-branch" })
  expect(await p.key(ctxFor(), human)).toBe("r80")
  expect(await p.sweepOk!(ctxFor({ prs: [human] }), "r80")).toBe(false)
  expect(await p.sweepOk!(ctxFor({ prs: [{ ...human, state: "MERGED" }] }), "r80")).toBe(true)
})

test("discoverClaimed reads --state all, so a claim label survives a merge", async () => {
  const claimed = pr(4, { labels: ["agent-wip"], state: "MERGED" })
  const unclaimed = pr(5)
  const ctx = ctxFor({ prs: [claimed, unclaimed] })
  const numbers = (await job().discoverClaimed(ctx)).map((i) => i.number)
  expect(numbers).toContain(4)
  expect(numbers).not.toContain(5)
})

test("the brief carries the budget the queue leaves and the merge method", async () => {
  const consumer: Job = {
    name: "build", dir: "/j/build", workload: "builder", repo: "web",
    discover: async () => [issue(1), issue(2)],
    discoverClaimed: async () => [], key: async () => "b1",
    done: async () => false, brief: async () => "",
  }
  const p = job({ filing: { queue: "build", maxOpen: 3, perRound: 2, dedupeBy: "path" } })
  const ctx = ctxFor({ jobs: [consumer, p] })
  const text = await p.brief(ctx, pr(80))
  const flat = text.replace(/\s+/g, " ")
  expect(flat).toContain("filing budget of 1")
  expect(flat).toContain("There are 2 items already open")
  expect(text).toContain("squash")
  expect(text).toContain("Review round")
  expect(text).not.toContain("{{")
  expect(p.filing).toEqual({ queue: "build", maxOpen: 3, perRound: 2, dedupeBy: "path" })
})

test("dedupeBy defaults to path and is what the filing rule dedupes on", async () => {
  const consumer: Job = {
    name: "build", dir: "/j/build", workload: "builder", repo: "web",
    discover: async () => [], discoverClaimed: async () => [], key: async () => "b1",
    done: async () => false, brief: async () => "",
  }
  const p = job({ filing: { queue: "build", maxOpen: 3, perRound: 2 } })
  expect(p.filing).toEqual({ queue: "build", maxOpen: 3, perRound: 2, dedupeBy: "path" })
  const text = await p.brief(ctxFor({ jobs: [consumer, p] }), pr(80))
  expect(text.replace(/\s+/g, " ")).toContain("Dedupe on the cited path, not on the title")

  const bySymbol = job({ filing: { queue: "build", maxOpen: 3, perRound: 2, dedupeBy: "symbol" } })
  const other = await bySymbol.brief(ctxFor({ jobs: [consumer, bySymbol] }), pr(80))
  expect(other.replace(/\s+/g, " ")).toContain("Dedupe on the cited symbol, not on the title")
})

// Spec 5.1: "none" means a pass label is applied and CI owns the merge. The
// brief has no conditionals, so the kind writes the whole step; passing "none"
// through as the merge method told the worker to merge with the forge default.
test("under mergeMode none the brief never tells the worker to merge", async () => {
  const p = job({ mergeMode: "none", passLabel: "reviewed" })
  const text = await p.brief(ctxFor(), pr(80))
  expect(text).not.toContain("Merge with")
  expect(text).not.toContain("none")
  expect(text).toContain("The merge is not yours to make")
  expect(text).toContain("`reviewed`")
  expect(text).not.toContain("{{")
})

test("with no mergeMode the brief tells the worker to merge with the workspace method", async () => {
  const text = await job().brief(ctxFor(), pr(80))
  expect(text).toContain("Merge with `squash`")
  expect(text).toContain("keep polling")
  const explicit = await job({ mergeMode: "merge" }).brief(ctxFor(), pr(80))
  expect(explicit).toContain("Merge with `merge`")
})

test("the check hook rejects a bad enum and a malformed filing block", () => {
  const at = (options: Record<string, unknown>) =>
    reviewer.check!({ name: "review", dir: "/j/review", repo: "web", options })
  expect(at({ identity: "pr", mergeMode: "" })).toEqual([])
  expect(at({ identity: "prr", mergeMode: "" })).toEqual([
    'options.identity must be one of pr, closing-issue, head-ref-issue; did you mean "pr"?',
  ])
  expect(at({ identity: "pr", mergeMode: "rebase" })).toEqual([
    "options.mergeMode must be one of merge, squash, none, or empty for the workspace default",
  ])
  expect(at({ identity: "pr", mergeMode: "", filing: { queue: "build", maxOpen: 40, perRound: 2, dedupeBy: "path", maxopen: 9 } }))
    .toEqual(['options.filing: unknown key "maxopen"; did you mean "maxOpen"?'])
  expect(at({ identity: "pr", mergeMode: "", filing: { queue: "build", perRound: 2, dedupeBy: "path" } }))
    .toEqual(["options.filing.maxOpen is required and must be a number"])
})

// Nothing merges and nothing releases the claim, so the item is claimed for
// good and the slot never comes back.
test("the check hook rejects mergeMode none with no passLabel", () => {
  const at = (options: Record<string, unknown>) =>
    reviewer.check!({ name: "review", dir: "/j/review", repo: "web", options })
  expect(at({ identity: "pr", mergeMode: "none", passLabel: "" })).toEqual([
    "options.mergeMode none requires a passLabel, which is the only thing left that releases the item",
  ])
  expect(at({ identity: "pr", mergeMode: "none", passLabel: "reviewed" })).toEqual([])
})

// A repository holds work this job has no business reviewing. Without the
// filter the reviewer claims a human's pull request and holds it behind the
// claim label until someone notices.
test("headRef confines the reviewer to the branches it names, claimed ones too", async () => {
  const p = job({ identity: "pr", headRef: "content/run-" })
  const ctx = ctxFor({ prs: [
    pr(1, { headRef: "content/run-2026-08-20" }),
    pr(2, { headRef: "feature/somebody-elses-work" }),
    pr(3, { headRef: "content/run-2026-08-19", labels: ["agent-wip"] }),
    pr(4, { headRef: "hotfix/urgent", labels: ["agent-wip"] }),
  ] })
  expect((await p.discover(ctx)).map((i) => i.number)).toEqual([1])
  expect((await p.discoverClaimed(ctx)).map((i) => i.number)).toEqual([3])

  // Empty is every pull request, which is the default and the old behaviour.
  const all = job({ identity: "pr" })
  expect((await all.discover(ctx)).map((i) => i.number)).toEqual([1, 2])
})
