import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { KINDS, describeKind, kindSchema } from "../src/kinds"
import { loadWorkspace } from "../src/discover"
import { runTick } from "../src/engine/tick"
import { makeCtx } from "../src/ctx"
import { openState } from "../src/state"
import { openGlobalState } from "../src/globalstate"
import { memoryLock } from "../src/lock"
import type { AccountConfig, Decision, WorkItem } from "../src/types"

const accounts: AccountConfig[] = [{ id: "loop", provider: "claude", configDir: "/c", reserve: 0 }]

const WS = `
name: acme
herdrWorkspace: acme
worktreeBase: ..
repos:
  web: ../web
naming:
  labels: { claim: agent-wip, failed: agent-failed, park: needs-human, priority: [bug] }
  mergeMethod: squash
`

function tree(jobs: Record<string, string>): string {
  const root = mkdtempSync(`${tmpdir()}/al-reg-`)
  const dir = `${root}/agent-loop`
  mkdirSync(dir)
  writeFileSync(`${dir}/workspace.yml`, WS)
  for (const [name, yml] of Object.entries(jobs)) {
    mkdirSync(`${dir}/${name}`)
    writeFileSync(`${dir}/${name}/job.yml`, yml)
  }
  return dir
}

test("all three kinds are registered and describe themselves", () => {
  expect(Object.keys(KINDS).sort()).toEqual(["builder", "reviewer", "routine"])
  for (const k of Object.values(KINDS)) {
    expect(describeKind(k)[0]).toContain(k.name)
    expect((kindSchema(k) as any).additionalProperties).toBe(false)
  }
})

test("a realistic tree of all three kinds loads", () => {
  const dir = tree({
    build: "kind: builder\nrepo: web\norder: 20\noptions:\n  base: origin/develop\n  reviewDebt: 6\n",
    review: "kind: reviewer\nrepo: web\norder: 10\noptions:\n  identity: closing-issue\n  rounds: 3\n  filing: { queue: build, maxOpen: 40, perRound: 2, dedupeBy: path }\n",
    digest: "kind: routine\nrepo: web\norder: 5\noptions:\n  at: ['09:10']\n",
  })
  const { ws, errors } = loadWorkspace(dir, { kinds: KINDS, accounts, checkSelectors: true })
  expect(errors).toEqual([])
  // Order carries meaning: the routine and the reviewer walk before the builder.
  expect(ws!.jobs.map((j) => j.name)).toEqual(["digest", "review", "build"])
  expect(ws!.jobs.find((j) => j.name === "review")!.filing)
    .toEqual({ queue: "build", maxOpen: 40, perRound: 2, dedupeBy: "path" })
})

test("a typo in a reviewer's filing block is caught at load time", () => {
  const dir = tree({
    review: "kind: reviewer\nrepo: web\noptions:\n  filing: { queue: build, maxopen: 40, perRound: 2, dedupeBy: path }\n",
  })
  const { errors } = loadWorkspace(dir, { kinds: KINDS, accounts, checkSelectors: true })
  expect(errors.join("\n")).toContain('did you mean "maxOpen"?')
})

test("a tick over the shipped kinds sweeps, monitors and spawns against fakes", async () => {
  const dir = tree({
    build: "kind: builder\nrepo: web\norder: 20\n",
    review: "kind: reviewer\nrepo: web\norder: 10\n",
  })
  const { ws } = loadWorkspace(dir, { kinds: KINDS, accounts, checkSelectors: true })
  const issue = (n: number, labels: string[] = []): WorkItem => ({
    id: `issue:${n}`, number: n, title: "t", state: "OPEN", labels,
    url: `https://example.test/acme/web/issues/${n}`,
  })
  const log: Decision[] = []
  const ctx = makeCtx({
    workspace: ws!,
    config: { accounts: [], blockedTimeoutMin: 180 } as any,
    now: new Date("2026-08-19T09:00:00Z"),
    live: false,
    sleep: async () => {},
    lock: memoryLock(),
    gh: {
      issueList: async () => [issue(4), issue(5, ["agent-wip"])],
      prList: async () => [],
      prView: async () => ({}),
    } as any,
    gitFor: () => ({ remoteSlug: async () => "acme/web", worktrees: async () => [] }) as any,
    herdr: { agents: async () => [], panes: async () => [] } as any,
    marks: openState(":memory:"),
    global: openGlobalState(":memory:"),
    usageFor: async () => ({ readable: false, reason: "no usage in this test" }),
    memAvailableMb: async () => 8000,
    sink: (d) => log.push(d),
  })
  const out = await runTick(ctx, ws!.jobs, { paused: false })
  expect(out.some((d) => d.pass === "error")).toBe(false)
  // The reviewer walks first and has nothing; the builder reaches the router,
  // which has no readable account here, so the item is STARVED rather than lost.
  expect(out.some((d) => d.pass === "spawn" && d.job === "build")).toBe(true)
})
