import { test, expect } from "bun:test"
import { startTab, paneAt } from "../src/effects/spawn"
import type { AccountConfig, Ctx, Job, WorkItem } from "../src/types"

const item: WorkItem = {
  id: "issue:7", number: 7, title: "t", state: "OPEN", labels: [],
  url: "https://example.test/acme/web/issues/7",
}

const account = (o: Partial<AccountConfig> = {}): AccountConfig =>
  ({ id: "loop", provider: "claude", configDir: "/home/x/.claude-loop", reserve: 0, ...o })

function ctxWith(o: { workspaces?: any[]; panesEventually?: any[][] } = {}) {
  const calls: any[][] = []
  let paneReads = 0
  const panePages = o.panesEventually ?? [[{ cwd: "/b/wt-build-b7", paneId: "p1", tabId: "w6:t2" }]]
  const ctx = {
    workspace: { herdrWorkspace: "acme", worktreeBase: "/b", repos: { web: "/r" } },
    config: { accounts: [account()] },
    live: true,
    sleep: async (ms: number) => { calls.push(["sleep", ms]) },
    herdr: {
      workspaces: async () => o.workspaces ?? [{ id: "w6", label: "acme" }],
      tabCreate: async (a: any) => { calls.push(["tabCreate", a.workspaceId, a.cwd, a.label, JSON.stringify(a.env)]) },
      panes: async () => panePages[Math.min(paneReads++, panePages.length - 1)]!,
      agentStart: async (a: any) => { calls.push(["agentStart", a.pane, a.kind, a.name, ...a.args]) },
      agentPrompt: async (t: string, text: string) => { calls.push(["agentPrompt", t, text]) },
      agentStatus: async () => "working",
      agentSendKeys: async () => { calls.push(["enter"]) },
    },
    cache: <T,>(_k: string, fn: () => Promise<T>) => fn(),
  } as unknown as Ctx
  return { ctx, calls }
}

const job = (o: Partial<Job> = {}): Job =>
  ({ name: "build", workload: "builder", repo: "web", brief: async () => "the brief", ...o }) as Job

test("the tab carries the account's config dir and the worker starts in its pane", async () => {
  const { ctx, calls } = ctxWith()
  await startTab(ctx, job(), item, "b7", account({ agentKind: "claude", startArgs: ["--yolo"] }))
  expect(calls[0]).toEqual([
    "tabCreate", "w6", "/b/wt-build-b7", "build-b7",
    JSON.stringify({ CLAUDE_CONFIG_DIR: "/home/x/.claude-loop" }),
  ])
  expect(calls.at(-2)).toEqual(["agentStart", "p1", "claude", "build-b7", "--yolo"])
  expect(calls.at(-1)).toEqual(["agentPrompt", "p1", "the brief"])
})

test("each provider gets its own config variable, and an account may override it", async () => {
  const codex = ctxWith()
  await startTab(codex.ctx, job(), item, "b7", account({ provider: "codex", configDir: "/home/x/.codex" }))
  expect(codex.calls[0]![4]).toBe(JSON.stringify({ CODEX_HOME: "/home/x/.codex" }))

  const custom = ctxWith()
  await startTab(custom.ctx, job(), item, "b7", account({ configEnv: "OTHER_HOME" }))
  expect(custom.calls[0]![4]).toBe(JSON.stringify({ OTHER_HOME: "/home/x/.claude-loop" }))
})

test("the workspace is resolved by label, and a missing one is a clear failure", async () => {
  const { ctx } = ctxWith({ workspaces: [{ id: "w9", label: "other" }] })
  await expect(startTab(ctx, job(), item, "b7", account())).rejects.toThrow(/labelled "acme"/)
})

test("a pane that has not appeared yet is waited for, not given up on", async () => {
  const { ctx, calls } = ctxWith({
    panesEventually: [[], [], [{ cwd: "/b/wt-build-b7", paneId: "p1", tabId: "w6:t2" }]],
  })
  expect(await paneAt(ctx, "/b/wt-build-b7")).toBe("p1")
  expect(calls.filter((c) => c[0] === "sleep")).toHaveLength(2)
})

test("a pane that never appears fails rather than starting an agent nowhere", async () => {
  const { ctx } = ctxWith({ panesEventually: [[]] })
  await expect(paneAt(ctx, "/b/wt-build-b7")).rejects.toThrow(/no pane appeared/)
})
